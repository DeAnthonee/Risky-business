import { rankLeaderboard } from '@risk/engine';
import { updateExperience } from './experience.js';
import { addPersonalityMemory, withLearningLock } from './shared-memory.js';
import { copyFile, mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameOptions, GameView, PlayerId } from '@risk/engine';
import { getMap } from '@risk/engine';
import type { ChatResult, RiskApi } from '@risk/mcp';
import { condenseLearnings } from './commander.js';
import type { Deal, DealStats } from './deals.js';
import type { Llm } from './llm.js';
import { jaccard, tokens } from './similarity.js';

type ChatMsg = ChatResult['messages'][number];

export const BOT_START = '<!-- bot-findings:start -->';
export const BOT_END = '<!-- bot-findings:end -->';
export const BOT_HEADING = '## Findings from AI self-play games';
export const MAX_SECTION_CHARS = 12_000;
export const MAX_SECTION_BULLETS = 40;
/** At most this many new bullets (not near-duplicates of an existing one) per game. */
export const MAX_NEW_BULLETS = 3;
/** Token Jaccard at or above which two bullets count as the same advice. */
export const DUPLICATE_JACCARD = 0.6;
/** A "Challenges to earlier advice" bullet needs a pattern seen in at least this many games. */
export const MIN_CHALLENGE_GAMES = 3;

// ---------------------------------------------------------------------------
// Results (code only, no model)
// ---------------------------------------------------------------------------

/** One seat of a finished game, as the game itself reports it. */
export interface SeatInfo {
  name: string;
  characterId?: string;
  playerId: PlayerId;
  /** Deals made / kept / broken by this seat, when it kept a ledger. */
  deals?: DealStats;
}

export interface SeatResult {
  name: string;
  character: string | null;
  /** 1 = winner. Survivors rank by territories, then the later someone was eliminated the better. */
  placement: number;
  alive: boolean;
  eliminatedRound: number | null;
  eliminatedBy: string | null;
  eliminations?: number;
  territories: number;
  armies: number;
  capitals: number;
  heldBonus: boolean;
  bonuses: string[];
  deals?: DealStats;
}

export interface GameResult {
  gameId: string;
  date: string;
  map: string;
  options: GameOptions;
  winner: string | null;
  winnerCharacter: string | null;
  reason: 'capitals' | 'domination' | 'unfinished';
  rounds: number;
  turns: number;
  seats: SeatResult[];
}

/** Sees every view any seat gets and remembers when each player was first seen dead, plus mechanics telemetry. */
export class GameTracker {
  private out = new Map<PlayerId, { round: number; turn: number }>();
  private peakBonuses = new Map<PlayerId, Set<string>>();
  private peakCapitals = new Map<PlayerId, number>();
  private strandedTurns = new Map<PlayerId, number>();
  private lastTurnSeen = -1;

  observe(view: GameView) {
    for (const p of view.players) {
      if (!p.alive && !p.isNeutral && !this.out.has(p.id)) this.out.set(p.id, { round: view.round, turn: view.turnNumber });
      if (p.continents.length > 0) {
        const set = this.peakBonuses.get(p.id) ?? new Set<string>();
        for (const c of p.continents) set.add(c);
        this.peakBonuses.set(p.id, set);
      }
    }
    if (view.phase === 'fortify' && view.turnNumber !== this.lastTurnSeen) {
      this.lastTurnSeen = view.turnNumber;
      const map = getMap(view.options.map);
      const caps = new Set(Object.values(view.capitals ?? {}));
      const p = view.currentPlayer;
      if (p) {
        let myCaps = 0;
        let stranded = 0;
        for (const t of map.territoryIds) {
          const s = view.territories[t];
          if (!s || s.hidden || s.owner !== p) continue;
          if (caps.has(t)) myCaps++;
          else if (s.armies >= 4) {
            const hasHostile = map.adjacency[t].some((n) => {
              const ns = view.territories[n];
              return ns && !ns.hidden && ns.owner !== p && !view.blizzards.includes(n);
            });
            if (!hasHostile) stranded += s.armies - 1;
          }
        }
        this.peakCapitals.set(p, Math.max(this.peakCapitals.get(p) ?? 0, myCaps));
        if (stranded > 0) this.strandedTurns.set(p, (this.strandedTurns.get(p) ?? 0) + 1);
      }
    }
  }
  eliminated(id: PlayerId) {
    return this.out.get(id) ?? null;
  }
  mechanicsText(id: PlayerId): string {
    const bonuses = [...(this.peakBonuses.get(id) ?? [])];
    const peakCaps = this.peakCapitals.get(id) ?? 0;
    const stranded = this.strandedTurns.get(id) ?? 0;
    return `Mechanics telemetry: bonuses held at any point: ${bonuses.length ? bonuses.join(', ') : 'none'}; peak capitals held: ${peakCaps}; turns entering fortify with 4+ armies stranded on a non-capital interior pocket: ${stranded}.`;
  }
}

/** Build the result record from the finished game's view (spectator-complete: no fog once it is over). */
export function buildResult(final: GameView, seats: SeatInfo[], tracker: GameTracker, meta: { gameId: string; date?: Date }): GameResult {
  const map = getMap(final.options.map);
  const players = final.players.filter((p) => !p.isNeutral);
  const nameOf = (id: PlayerId | null | undefined) => players.find((p) => p.id === id)?.name ?? null;
  const capitalTerritories = Object.values(final.capitals ?? {});
  const stats = new Map<PlayerId, { territories: number; armies: number; capitals: number }>();
  for (const p of players) stats.set(p.id, { territories: 0, armies: 0, capitals: 0 });
  for (const t of map.territoryIds) {
    const s = final.territories[t];
    const st = s?.owner ? stats.get(s.owner) : undefined;
    if (!st) continue;
    st.territories++;
    st.armies += s.armies;
    if (capitalTerritories.includes(t)) st.capitals++;
  }
  const kills = new Map<PlayerId, number>();
  for (const p of final.players) {
    if (p.eliminatedBy) {
      kills.set(p.eliminatedBy, (kills.get(p.eliminatedBy) ?? 0) + 1);
    }
  }
  const winner = final.winner;
  const rank = [...players].sort((a, b) => {
    if (a.id === winner) return -1;
    if (b.id === winner) return 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) return stats.get(b.id)!.territories - stats.get(a.id)!.territories || stats.get(b.id)!.armies - stats.get(a.id)!.armies;
    return (tracker.eliminated(b.id)?.turn ?? -1) - (tracker.eliminated(a.id)?.turn ?? -1);
  });
  const rows: SeatResult[] = players.map((p) => {
    const info = seats.find((s) => s.playerId === p.id);
    const st = stats.get(p.id)!;
    return {
      name: p.name,
      character: info?.characterId ?? null,
      placement: rank.findIndex((x) => x.id === p.id) + 1,
      alive: p.alive,
      eliminatedRound: p.alive ? null : (tracker.eliminated(p.id)?.round ?? final.round),
      eliminatedBy: p.alive ? null : nameOf(p.eliminatedBy),
      eliminations: kills.get(p.id) ?? 0,
      territories: st.territories,
      armies: st.armies,
      capitals: st.capitals,
      heldBonus: p.continents.length > 0,
      bonuses: p.continents,
      ...(info?.deals ? { deals: info.deals } : {}),
    };
  });
  const others = players.filter((p) => p.alive && p.id !== winner).length;
  const reason: GameResult['reason'] = !winner ? 'unfinished' : final.options.capitals && others > 0 ? 'capitals' : 'domination';
  const winRow = rows.find((r) => r.name === nameOf(winner));
  return {
    gameId: meta.gameId,
    date: (meta.date ?? new Date()).toISOString(),
    map: final.options.map,
    options: final.options,
    winner: nameOf(winner),
    winnerCharacter: winRow?.character ?? null,
    reason,
    rounds: final.round,
    turns: final.turnNumber,
    seats: rows.sort((a, b) => a.placement - b.placement),
  };
}

/** Plain-language result of one seat. */
export function resultText(r: GameResult, seat: SeatResult): string {
  const of = `${seat.placement}${ordinal(seat.placement)} of ${r.seats.length}`;
  const kills = seat.eliminations ? `, ${seat.eliminations} elimination${seat.eliminations === 1 ? '' : 's'} (+${seat.eliminations} Elo)` : '';
  const holdings = `${seat.territories} territories, ${seat.armies} armies, ${seat.capitals} capital${seat.capitals === 1 ? '' : 's'}, ${seat.heldBonus ? `bonuses held: ${seat.bonuses.join(', ')}` : 'no bonus at the end'}${kills}`;
  if (r.winner === seat.name) {
    return `WON game ${r.gameId} in round ${r.rounds} (turn ${r.turns}) ${r.reason === 'capitals' ? 'by holding every capital' : 'by domination'}. Finished with ${holdings}.`;
  }
  if (!seat.alive) {
    return `Eliminated in round ${seat.eliminatedRound}${seat.eliminatedBy ? ` by ${seat.eliminatedBy}` : ''} in game ${r.gameId} (${of}). ${r.winner ? `${r.winner} won in round ${r.rounds}.` : ''}`.trim();
  }
  return `Survived game ${r.gameId}, ${of}${r.winner ? `; ${r.winner} won in round ${r.rounds}` : ''}. Finished with ${holdings}.`;
}

function ordinal(n: number) {
  return n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10] ?? 'th';
}

export async function appendResult(dir: string, result: GameResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
}

export async function readResults(dir: string): Promise<GameResult[]> {
  let text: string;
  try {
    text = await readFile(path.join(dir, 'results.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: GameResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as GameResult);
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderRow {
  key: string;
  games: number;
  wins: number;
  avgPlacement: number;
  points: number;
  losses: number;
  rank: number;
  eliminations: number;
}

export interface Leaderboard {
  games: number;
  byCharacter: LeaderRow[];
  byMap: { map: string; games: number; wins: Record<string, number> }[];
}

export function computeLeaderboard(results: GameResult[]): Leaderboard {
  results = [...new Map(results.filter(r => r.winner && r.reason !== 'unfinished').map(r => [r.gameId, r])).values()];
  const ratings = rankLeaderboard(results.map(r => ({
    gameId: r.gameId,
    seats: r.seats.map(s => ({
      key: s.character ?? s.name,
      name: s.name,
      placement: s.placement,
      eliminations: s.eliminations ?? 0,
    })),
  })));
  const chars = new Map<string, { games: number; wins: number; place: number }>();
  const maps = new Map<string, { games: number; wins: Record<string, number> }>();
  for (const r of results) {
    const m = maps.get(r.map) ?? { games: 0, wins: {} };
    m.games++;
    if (r.winner) {
      const w = r.seats.find((s) => s.name === r.winner);
      const key = w?.character ?? r.winner;
      m.wins[key] = (m.wins[key] ?? 0) + 1;
    }
    maps.set(r.map, m);
    for (const s of r.seats) {
      const key = s.character ?? s.name;
      const c = chars.get(key) ?? { games: 0, wins: 0, place: 0 };
      c.games++;
      c.place += s.placement;
      if (r.winner === s.name) c.wins++;
      chars.set(key, c);
    }
  }
  return {
    games: results.length,
    byCharacter: ratings.map(r => ({
      key: r.key,
      games: r.games,
      wins: r.wins,
      avgPlacement: r.avgPlacement,
      points: r.points,
      losses: r.losses,
      rank: r.rank,
      eliminations: r.eliminations ?? 0,
    })),
    byMap: [...maps].map(([map, m]) => ({ map, ...m })).sort((a, b) => b.games - a.games),
  };
}

export function formatLeaderboard(lb: Leaderboard): string {
  if (lb.games === 0) return 'Leaderboard: no games yet.';
  const lines = [`Leaderboard after ${lb.games} game${lb.games === 1 ? '' : 's'} (wins/games, average placement):`];
  for (const r of lb.byCharacter) lines.push(`  ${r.key}: ${r.wins}/${r.games}, avg place ${r.avgPlacement}, ${r.points} Elo points (${r.eliminations ?? 0} kills) (#${r.rank}), ${r.losses} losses, ${Math.round(r.wins / r.games * 1000) / 10}% win rate`);
  lines.push('By map:');
  for (const m of lb.byMap) lines.push(`  ${m.map}: ${m.games} game${m.games === 1 ? '' : 's'}; wins ${Object.entries(m.wins).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Seat notes
// ---------------------------------------------------------------------------

export interface SeatReport extends SeatInfo {
  observedDeals?: Deal[];
  /** The seat's private game log (commander entries), one line each. */
  privateLog: string[];
  /** The plan it ended with, in a few words. */
  strategy: string | null;
  /** Chat this seat could read. */
  chat: ChatMsg[];
  /** Event lines of this seat's deal ledger (made, kept, broken). */
  dealLog?: string[];
}

export const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'seat';

const stripFences = (s: string) => s.replace(/```(?:markdown|md)?/gi, '').trim();

/**
 * Make a model's note match the learnings format: a title, bullets, `## Result` and `## Top lessons`.
 * Missing parts are filled in from the code-computed result and the private log.
 */
export function normalizeNote(raw: string, name: string, gameId: string, result: string, logLines: string[]): string {
  const title = `# ${name} learnings ${gameId}`;
  let body = stripFences(raw).replace(/^#\s+.*\n?/, '').trim();
  const resultAt = body.search(/^## Result\b/im);
  const lessonsAt = body.search(/^## Top lessons\b/im);
  const bullets = (resultAt >= 0 ? body.slice(0, resultAt) : lessonsAt >= 0 ? body.slice(0, lessonsAt) : body).trim();
  let resultSection = '';
  let lessons = '';
  if (resultAt >= 0) {
    const end = lessonsAt > resultAt ? lessonsAt : body.length;
    resultSection = body.slice(resultAt, end).replace(/^## Result\b[^\n]*\n?/i, '').trim();
  }
  if (lessonsAt >= 0) {
    const end = resultAt > lessonsAt ? resultAt : body.length;
    lessons = body.slice(lessonsAt, end).replace(/^## Top lessons\b[^\n]*\n?/i, '').trim();
  }
  if (!resultSection) resultSection = result;
  if (!lessons) {
    const fromLog = logLines.slice(-3).map((l) => l.replace(/^- /, '- Plan: ').slice(0, 220));
    lessons = fromLog.length ? fromLog.join('\n') : '- (no lessons recorded: the model gave none)';
  }
  body = [title, bullets, '## Result', resultSection, '## Top lessons', lessons].filter(Boolean).join('\n\n');
  return `${body}\n`;
}

function fallbackNote(name: string, gameId: string, result: string, logLines: string[]): string {
  return normalizeNote('', name, gameId, result, logLines);
}

function statsTable(r: GameResult): string {
  return r.seats
    .map((s) => `${s.placement}. ${s.name}${s.character ? ` (${s.character})` : ''}: ${s.alive ? 'alive' : `out round ${s.eliminatedRound}${s.eliminatedBy ? ` by ${s.eliminatedBy}` : ''}`}, ${s.territories} territories, ${s.armies} armies, ${s.capitals} capitals, ${s.heldBonus ? 'held a bonus' : 'no bonus'}`)
    .join('\n');
}

export function extractWatchers(chat: SeatReport['chat']): { key: string; name: string; messages: string[] }[] {
  const byKey = new Map<string, { key: string; name: string; messages: string[] }>();
  for (const m of chat) {
    if (!m.spectator) continue;
    const name = m.name.trim();
    if (!name) continue;
    const key = `watcher:${name.toLowerCase()}`;
    const entry = byKey.get(key) ?? { key, name, messages: [] };
    entry.name = name;
    if (m.message.trim()) entry.messages.push(`${m.to !== undefined ? '(whisper) ' : ''}${m.message.trim()}`);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

async function writeNote(llm: Llm | null, r: GameResult, seat: SeatReport, board: string, learningsDir: string, log: (l: string) => void, mechanics = ''): Promise<{ name: string; text: string; file: string }> {
  const row = r.seats.find((s) => s.name === seat.name);
  const result = row ? resultText(r, row) : `Game ${r.gameId} ended.`;
  let text = fallbackNote(seat.name, r.gameId, result, seat.privateLog);
  if (llm && row) {
    const chat = seat.chat
      .slice(-30)
      .map((m) => `${m.spectator ? '[watcher] ' : ''}${m.name}${m.to !== undefined ? ' (whisper)' : ''}: ${m.message}`)
      .join('\n')
      .slice(-2000);
    try {
      const raw = await llm.chat(
        [
          {
            role: 'system',
            content: [
              `You are ${seat.name}, a Risk player, writing your post-game notes for the shared learnings folder so that future players (including you) play better.`,
              'Write Markdown in exactly this shape, no code fences, no JSON:',
              `# ${seat.name} learnings ${r.gameId}`,
              '- 3 to 6 bullets: what happened and what you noticed (concrete: settings, card values mode, territories, bonuses, capitals and capital placement on doorway choke points / blizzard bottlenecks with outward attack exits, attack order/routing, troop staging/interior pockets, card trades, mistakes, what the table did).',
              '## Result',
              'One or two lines: how it ended for you.',
              '## Top lessons',
              '- 3 to 5 bullets a future player can act on, each one specific to the game settings (e.g. fixed vs progressive vs exponential cards, fog vs non-fog, capital placement on doorway choke points with attack exits, blizzards, attack routing, troop staging).',
              'Each line of your private log may name your winPath and its plan (how you meant to win), plus tactical choices (placeOn, route, fortifyTo, moveCapitalStack). Judge in the notes whether that plan and routing worked, whether your initial capital placement on a choke point served as an effective doorway to defend bonuses with 3 dice while attacking outward in multiple directions (vs. getting buried in an interior pocket with no exits or trapped armies), whether any troops were stranded in interior pockets (4+ armies away from borders), how well you took/defended bonuses and capitals under these specific card and fog settings, and what you would pick instead.',
              'If you made deals, say in the notes which were kept or broken and what that cost or gained you.',
              'Use only the facts given below. Do not invent events, numbers or quotes.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Game ${r.gameId} on ${r.map}, ${r.rounds} rounds.`,
              `Your result: ${result}`,
              ...(mechanics ? [mechanics] : []),
              '',
              'Final standings:',
              statsTable(r),
              '',
              board,
              '',
              'Your private game log (your plan and notes, oldest first):',
              seat.privateLog.join('\n').slice(-6000) || '(none)',
              '',
              'Your deals this game (made / kept / broken), oldest first:',
              (seat.dealLog ?? []).join('\n').slice(-1500) || '(none)',
              '',
              'Chat you could read:',
              chat || '(none)',
            ].join('\n'),
          },
        ],
        { maxTokens: 700, temperature: 0.5, timeoutMs: 240_000 },
      );
      if (raw.trim()) text = normalizeNote(raw, seat.name, r.gameId, result, seat.privateLog);
    } catch (e) {
      log(`${seat.name}: note write-up failed (${(e as Error).message}); saved a plain summary`);
    }
  }
  const dir = path.join(learningsDir, 'learnings');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(seat.name)}-${r.gameId}.md`);
  await writeFile(file, text, 'utf8');
  return { name: seat.name, text, file };
}

/** Diary entry and relationship updates through the characters API. Never throws. */
async function saveCharacter(api: RiskApi, key: string, r: GameResult, seat: SeatReport, note: string, log: (l: string) => void) {
  if (!seat.characterId) return;
  const row = r.seats.find((s) => s.name === seat.name);
  if (!row) return;
  const outcome = r.winner === seat.name ? 'won' : row.alive ? 'lost' : 'eliminated';
  const label = (name: string) => r.seats.find((s) => s.name === name)?.character ?? name;
  try {
    await api.addDiaryEntry(
      seat.characterId,
      {
        title: `${outcome === 'won' ? 'Won' : outcome === 'eliminated' ? 'Eliminated in' : 'Lost'} ${r.gameId} on ${r.map}`.slice(0, 120),
        text: note.replace(/^#.*\n+/, '').slice(0, 3500),
        gameId: r.gameId,
        outcome,
        map: r.map,
        opponents: r.seats.filter((s) => s.name !== seat.name).map((s) => s.character ?? s.name),
        ...(seat.strategy ? { strategy: seat.strategy.slice(0, 120) } : {}),
        ...(r.winner && r.winner !== seat.name ? { winner: label(r.winner) } : {}),
      },
      key,
    );
    const rel: { with: string; change: number; note: string }[] = [];
    if (row.eliminatedBy) rel.push({ with: label(row.eliminatedBy), change: -15, note: `Eliminated me in round ${row.eliminatedRound} of ${r.gameId}.` });
    if (r.winner && r.winner !== seat.name && r.winner !== row.eliminatedBy) rel.push({ with: label(r.winner), change: -5, note: `Won ${r.gameId} (${r.reason}) while I placed ${row.placement}${ordinal(row.placement)}.` });
    for (const w of extractWatchers(seat.chat)) {
      const sample = w.messages.slice(-2).map((m) => m.slice(0, 100)).join(' | ');
      rel.push({ with: w.key, change: 0, note: `Watched ${r.gameId} as spectator${sample ? `: "${sample}"` : '.'}`.slice(0, 300) });
    }
    for (const u of rel) await api.updateRelationship(seat.characterId, { ...u, gameId: r.gameId }, key);
  } catch (e) {
    log(`${seat.name}: could not save diary/relationships (${(e as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Curator: the bot-managed section at the end of RISK_LEARNINGS.md
// ---------------------------------------------------------------------------

export interface SplitFile {
  /** Everything up to and including the start marker line: never touched. */
  above: string;
  /** The text between the markers. */
  section: string;
  /** Everything from the end marker on. */
  below: string;
  hasMarkers: boolean;
}

export function splitLearnings(text: string): SplitFile | null {
  const s = text.indexOf(BOT_START);
  if (s < 0) return { above: text, section: '', below: '', hasMarkers: false };
  const e = text.indexOf(BOT_END, s + BOT_START.length);
  if (e < 0) return null; // damaged: refuse to guess
  return { above: text.slice(0, s + BOT_START.length), section: text.slice(s + BOT_START.length, e).trim(), below: text.slice(e), hasMarkers: true };
}

/** Check and clean a model's new section; null = reject it (the old section stays). */
export function validateSection(raw: string): string | null {
  let t = stripFences(raw);
  t = t.replace(/^\s*##\s+Findings from AI self-play games\s*$/im, '').trim();
  if (!t || t.length > MAX_SECTION_CHARS) return null;
  if (t.includes('bot-findings') || t.includes('<!--')) return null;
  if (/^#{1,2}\s/m.test(t)) return null;
  const bullets = t.split(/\r?\n/).filter((l) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(l)).length;
  if (bullets === 0 || bullets > MAX_SECTION_BULLETS) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Curator rules, enforced in code (the prompt asks for the same things)
// ---------------------------------------------------------------------------

export interface Bullet {
  text: string;
  /** From the evidence tag `(N games, last GAMEID)`; null when the bullet has none. */
  games: number | null;
  last: string | null;
  /** Optional category or setting section, e.g. "Capitals Conquest", "Fog of War", etc. */
  category?: string | null;
  /** Under "### Challenges to earlier advice". */
  challenge: boolean;
}

const BULLET_LINE = /^\s*(?:[-*]|\d+\.)\s+(\S.*)$/;
const EVIDENCE_TAG = /\(\s*(\d+)\s+games?\s*,\s*last\s+([A-Za-z0-9_-]+)\s*\)/i;
export const CHALLENGES_HEADING = '### Challenges to earlier advice';

const withoutTag = (text: string) => text.replace(EVIDENCE_TAG, '').trim();

/** Bullets of a section or a whole file, with their evidence tags; wrapped lines join the bullet above. */
export function parseBullets(text: string): Bullet[] {
  const out: Bullet[] = [];
  let challenge = false;
  let category: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#{3,}\s/.test(line)) {
      challenge = /challenges to earlier advice/i.test(line);
      category = challenge ? null : line.replace(/^\s*#{3,}\s*/, '').trim();
      continue;
    }
    if (/^\s*#{1,2}\s/.test(line)) {
      challenge = false;
      category = null;
      continue;
    }
    const m = BULLET_LINE.exec(line);
    if (m) {
      out.push({ text: m[1].trim(), games: null, last: null, category, challenge });
    } else if (line.trim() && /^\s+\S/.test(line) && out.length > 0) {
      out[out.length - 1].text += ` ${line.trim()}`;
    }
  }
  for (const b of out) {
    const t = EVIDENCE_TAG.exec(b.text);
    if (t) {
      b.games = Number(t[1]);
      b.last = t[2];
    }
  }
  return out;
}

export function formatBullets(bullets: Bullet[]): string {
  const byCategory = new Map<string, Bullet[]>();
  const uncategorized: Bullet[] = [];
  for (const b of bullets) {
    if (b.challenge) continue;
    if (b.category) {
      const list = byCategory.get(b.category) ?? [];
      list.push(b);
      byCategory.set(b.category, list);
    } else {
      uncategorized.push(b);
    }
  }
  const parts: string[] = [];
  if (uncategorized.length > 0) {
    parts.push(uncategorized.map((b) => `- ${b.text}`).join('\n'));
  }
  for (const [cat, items] of byCategory) {
    if (items.length > 0) {
      parts.push(`### ${cat}\n${items.map((b) => `- ${b.text}`).join('\n')}`);
    }
  }
  const ch = bullets.filter((b) => b.challenge).map((b) => `- ${b.text}`);
  if (ch.length > 0) {
    parts.push(`${CHALLENGES_HEADING}\n${ch.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

/** The words before the first colon, full stop, semicolon or " - " (at most 8 words), markdown stripped. */
export function leadPhrase(text: string): string {
  const plain = withoutTag(text).replace(/[*_`]/g, '');
  const cut = plain.split(/[:.;]|\s-\s/)[0] ?? plain;
  return cut.split(/\s+/).slice(0, 8).join(' ').trim();
}

/** Headings and bullet lead phrases of the human-written text, for the curator prompt (so it can avoid repeats). */
export function humanOutline(text: string, max = 3500): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) out.push(line.trim());
    else {
      const m = BULLET_LINE.exec(line);
      if (m) out.push(`- ${leadPhrase(m[1])}`);
    }
  }
  return out.join('\n').slice(0, max);
}

const isDuplicate = (a: string, b: string) => jaccard(tokens(withoutTag(a)), tokens(withoutTag(b))) >= DUPLICATE_JACCARD;

/** A bullet that restates human-written advice: near-identical text, near-identical lead phrase, or starts with its lead. */
function restatesHuman(text: string, human: Bullet[]): boolean {
  const t = tokens(withoutTag(text));
  const lead = tokens(leadPhrase(text));
  for (const h of human) {
    if (jaccard(t, tokens(h.text)) >= DUPLICATE_JACCARD) return true;
    const hl = tokens(leadPhrase(h.text));
    if (lead.length >= 3 && hl.length >= 3 && jaccard(lead, hl) >= DUPLICATE_JACCARD) return true;
    if (hl.length >= 4 && t.length >= hl.length && t.slice(0, hl.length).join(' ') === hl.join(' ')) return true;
  }
  return false;
}

export interface CurationContext {
  gameId: string;
  /** The bot section as it is now. */
  previous: string;
  /** The human-written text of the file (above the start marker and below the end marker). */
  human: string;
  /** Seat names, characters and the map of this game: a new bullet must mention one of them, a round or a number. */
  names: string[];
  log?: (line: string) => void;
}

/** Concrete evidence from this game: a number, "round", or a seat/character/map name. */
function hasEvidence(text: string, names: string[]): boolean {
  const body = withoutTag(text);
  if (/\d/.test(body) || /\bround\b/i.test(body)) return true;
  const low = body.toLowerCase();
  return names.some((n) => n.length >= 3 && low.includes(n.toLowerCase()));
}

/**
 * The curator rules, in code. Starts from the structurally valid model reply and drops or repairs bullets:
 *  - a bullet that is a near-duplicate (Jaccard >= 0.6) of an existing bot bullet is that bullet seen again: its
 *    count never falls and rises by at most one (with the current game id);
 *  - any other bullet is NEW: it needs the tag `(1 game, last <this game>)` and concrete evidence from this
 *    game, must not restate the human-written advice and must not repeat another new bullet;
 *  - bullets under "Challenges to earlier advice" need N >= 3 games, otherwise they are dropped;
 *  - more than 3 new bullets: the old section is kept and only the first 3 new bullets are added;
 *  - more than 40 bullets in all: reject (null).
 * Null = reject the whole reply (the old section stays).
 */
export function enforceCuration(raw: string, ctx: CurationContext): string | null {
  const structural = validateSection(raw);
  if (!structural) return null;
  const note = (line: string) => ctx.log?.(`Curator: ${line}`);
  const old = parseBullets(ctx.previous);
  const human = parseBullets(ctx.human);
  const updatedOld: Bullet[] = [];
  const fresh: Bullet[] = [];
  for (const b of parseBullets(structural)) {
    const same = old.find((o) => isDuplicate(o.text, b.text));
    if (same) {
      const was = same.games ?? 1;
      const asked = b.games ?? was;
      const games = Math.min(Math.max(asked, was), was + 1);
      const last = games > was ? ctx.gameId : (same.last ?? ctx.gameId);
      const next: Bullet = { ...b, category: b.category ?? same.category, text: `${withoutTag(b.text)} (${games} game${games === 1 ? '' : 's'}, last ${last})`, games, last };
      if (b.challenge && games < MIN_CHALLENGE_GAMES) {
        note(`dropped a challenge seen in only ${games} game(s): ${leadPhrase(b.text)}`);
        continue;
      }
      if (updatedOld.some((k) => isDuplicate(k.text, next.text))) continue;
      updatedOld.push(next);
      continue;
    }
    if (b.challenge) {
      note(`dropped a new challenge (needs ${MIN_CHALLENGE_GAMES}+ games): ${leadPhrase(b.text)}`);
      continue;
    }
    if (b.games !== 1 || (b.last ?? '').toLowerCase() !== ctx.gameId.toLowerCase()) {
      note(`dropped a new bullet without the tag (1 game, last ${ctx.gameId}): ${leadPhrase(b.text)}`);
      continue;
    }
    if (!hasEvidence(b.text, ctx.names)) {
      note(`dropped a new bullet without concrete evidence: ${leadPhrase(b.text)}`);
      continue;
    }
    if (restatesHuman(b.text, human)) {
      note(`dropped a new bullet that restates the human-written advice: ${leadPhrase(b.text)}`);
      continue;
    }
    if (fresh.some((k) => isDuplicate(k.text, b.text)) || old.some((o) => isDuplicate(o.text, b.text))) continue;
    fresh.push(b);
  }
  const freshToAdd = fresh.slice(0, MAX_NEW_BULLETS);
  if (fresh.length > MAX_NEW_BULLETS) {
    note(`${fresh.length} new bullets; keeping existing findings plus the first ${MAX_NEW_BULLETS}`);
  }

  // Preserve all existing bullets in `old`. If an old bullet was matched and updated by the curator,
  // use the updated version; otherwise keep the original bullet untouched so historical learnings are never lost.
  const merged: Bullet[] = [];
  for (const o of old) {
    const updated = updatedOld.find((u) => isDuplicate(u.text, o.text));
    merged.push(updated ?? o);
  }
  for (const u of updatedOld) {
    if (!merged.some((m) => isDuplicate(m.text, u.text))) {
      merged.push(u);
    }
  }

  // Add the fresh bullets up to MAX_SECTION_BULLETS
  const room = Math.max(0, MAX_SECTION_BULLETS - merged.length);
  let result: Bullet[] = [...merged, ...freshToAdd.slice(0, room)];
  if (result.length > MAX_SECTION_BULLETS) {
    const challenges = result.filter((b) => b.challenge);
    const main = result.filter((b) => !b.challenge);
    main.sort((a, b) => (b.games ?? 1) - (a.games ?? 1));
    const allowedMain = Math.max(0, MAX_SECTION_BULLETS - challenges.length);
    result = [...main.slice(0, allowedMain), ...challenges];
  }
  if (result.length === 0 || result.length > MAX_SECTION_BULLETS) return null;
  const text = formatBullets(result);
  return text.length > MAX_SECTION_CHARS ? null : text;
}

/** New file text: the original up to the start marker is copied unchanged. Null when the file is damaged. */
export function applyBotSection(fileText: string, section: string): string | null {
  const split = splitLearnings(fileText);
  if (!split) return null;
  if (!split.hasMarkers) {
    const base = fileText.replace(/\s+$/, '');
    return `${base}\n\n${BOT_HEADING}\n${BOT_START}\n${section}\n${BOT_END}\n`;
  }
  return `${split.above}\n${section}\n${split.below}`;
}

export async function writeAtomic(file: string, content: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

export interface CurateInput {
  llm: Llm;
  /** Directory holding RISK_LEARNINGS.md. */
  learningsDir: string;
  gameId: string;
  notes: { name: string; text: string }[];
  leaderboard: string;
  /** Game options/settings of this game, used to categorize findings. */
  options?: GameOptions;
  /** This game's result (standings), for the prompt and the evidence check. */
  result?: GameResult;
  now?: () => Date;
  log: (line: string) => void;
}

/** One model call rewrites the bot section. Returns 'updated', or 'kept' when the old text stays. */
export async function curateLearnings(i: CurateInput): Promise<'updated' | 'kept'> {
  const file = path.join(i.learningsDir, 'RISK_LEARNINGS.md');
  let text = '';
  let exists = true;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    exists = false;
    text = '# Shared Risk learnings\n';
  }
  const split = splitLearnings(text);
  if (!split) {
    i.log(`RISK_LEARNINGS.md has a start marker without an end marker; left untouched`);
    return 'kept';
  }
  let raw: string;
  try {
    raw = await i.llm.chat(
      [
        {
          role: 'system',
          content: [
            'You are the curator of the bot-managed section "Findings from AI self-play games" at the end of the shared Risk learnings file, read by AI players before they play.',
            'Be strict and sparing: one game is thin evidence. Output ONLY the new body of that section: Markdown bullets, at most 40 in total.',
            'Categorize findings by the settings of the game using "###" headings: "### Fixed Cards (Continental Attrition & Border Defense)", "### Progressive Cards (Escalating Spoils & Chain Eliminations)", "### Exponential Cards (Personal Sequences & Surge Timing)", "### Attack Routing & Troop Staging (Spearheads & Interior Pocket Prevention)", "### Fog of War (Concealed Armies & Income Probing)", "### Non-Fog of War (Public Board & Coalition Counterplay)", "### Capitals Conquest", "### Eliminations & Leaderboard Climbing", "### Multi-Party Alliances & Global Coalitions".',
            'Focus heavily on deep tactical learning: capital placement (leveraging capitals on doorway choke points to guard bonuses with 3-dice defense while maintaining offensive attack exits in multiple directions vs buried interior pockets that trap armies), map geography and how blizzards alter chokepoints, attack patterns and sequential attack order, troop staging (concentrated spearhead placement, avoiding stranded interior armies with 4+ troops, end-of-turn fortify pullbacks to chokepoints), and clear strategic differentiation between game modes (fixed card attrition vs progressive card chains vs exponential personal surges, fog concealment vs public boards).',
            'Hard rules (code checks every one and throws away what breaks them):',
            `- At most ${MAX_NEW_BULLETS} NEW bullets this game. A bullet that says what an existing bullet says is not new: keep it and raise its count by one instead of adding a copy. If nothing new was learned, add nothing.`,
            `- Each bullet ends with its evidence tag "(N games, last GAMEID)". A new bullet is "(1 game, last ${i.gameId})" and must cite concrete evidence from this game's results: player names, rounds, territory or army numbers.`,
            '- Never restate advice that is already in the human-written part (its headings and bullet lead phrases are listed below). Do not copy its wording either.',
            `- "${CHALLENGES_HEADING}" is allowed only for a pattern seen in ${MIN_CHALLENGE_GAMES} or more games (N is ${MIN_CHALLENGE_GAMES}+). One game never challenges earlier advice. Quote the advice briefly and give the evidence.`,
            '- Weigh what the winners and the players who survived longest did over what early losers claim in their notes; losers often blame luck or others.',
            "You may merge, revise or remove your own bullets. Keep counts honest: raise a count only when this game's results support the bullet. Prefer concrete, testable advice; drop vague or contradicted bullets.",
            'No "#" or "##" headings, no code fences, no HTML comments.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Game just finished: ${i.gameId}.`,
            ...(i.options
              ? [
                  'Game settings for this game:',
                  `- Map: ${i.options.map}`,
                  `- Fog of War: ${i.options.fogOfWar ? 'ON (fogged territories/armies: opponents\' territory and army counts are strictly hidden; only turn reinforcement income and card count are public)' : 'OFF (public board, exact troop budgets, public all-chat coalitions)'}`,
                  `- Win Condition: ${i.options.capitals ? 'Capitals Conquest (hold all capitals to win)' : 'World Domination'}`,
                  `- Card values: ${i.options.cardValues} (${i.options.cardValues === 'fixed' ? 'FIXED 4-10 armies: continent bonuses and static border defenses dominate, no sudden card bailouts' : i.options.cardValues === 'exponential' ? 'EXPONENTIAL: personal trade sequences scale by 1.3x' : 'PROGRESSIVE: escalating table trades dominate, chain eliminations'})`,
                  `- Blizzards: ${i.options.blizzards}`,
                  '',
                ]
              : []),
            'Human-written part: headings and bullet lead phrases (read only; do not restate any of it):',
            humanOutline(`${split.above}\n${split.below}`) || '(none)',
            '',
            'Human-written part (read only, shortened):',
            condenseLearnings(split.above, 3500),
            '',
            ...(i.result ? ["This game's results (placement 1 = winner):", statsTable(i.result), ''] : []),
            'Current bot section:',
            split.section || '(empty)',
            '',
            "This game's notes from the players:",
            ...i.notes.map((n) => n.text.slice(0, 1800)),
            '',
            i.leaderboard,
            '',
            'Now write the full new section body.',
          ].join('\n'),
        },
      ],
      { maxTokens: 3500, temperature: 0.4, timeoutMs: 420_000 },
    );
  } catch (e) {
    i.log(`Curator call failed (${(e as Error).message}); learnings left as they were`);
    return 'kept';
  }
  const names = [...i.notes.map((n) => n.name), ...(i.result ? [i.result.map, ...i.result.seats.flatMap((s) => [s.name, ...(s.character ? [s.character.split('/').pop()!] : [])])] : [])];
  const section = enforceCuration(raw, { gameId: i.gameId, previous: split.section, human: `${split.above}\n${split.below}`, names, log: i.log });
  if (!section) {
    i.log('Curator reply failed validation; learnings left as they were');
    return 'kept';
  }
  const next = applyBotSection(text, section);
  // Invariant: nothing above the start marker may change.
  if (!next || (split.hasMarkers ? !next.startsWith(split.above) : !next.startsWith(text.replace(/\s+$/, '')))) {
    i.log('Curator result would change protected text; learnings left as they were');
    return 'kept';
  }
  if (next === text) return 'kept';
  if (exists) {
    const dir = path.join(i.learningsDir, 'learnings-history');
    await mkdir(dir, { recursive: true });
    const stamp = (i.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    await copyFile(file, path.join(dir, `RISK_LEARNINGS-${stamp}-${i.gameId}.md`));
  } else {
    await mkdir(i.learningsDir, { recursive: true });
  }
  await writeAtomic(file, next);
  return 'updated';
}

// ---------------------------------------------------------------------------
// Everything after a game
// ---------------------------------------------------------------------------

export interface PostGameInput {
  api: RiskApi;
  llm: Llm | null;
  learningsDir: string;
  final: GameView;
  gameId: string;
  seats: SeatReport[];
  tracker: GameTracker;
  charactersKey?: string;
  /** Pure mechanics training: skip character memory/experience/diary writes, write results to mechanics-results.jsonl, and focus LLM reflection on top finishers. */
  mechanicsOnly?: boolean;
  /** Skip running the curator on this game (e.g. when batching curation every N games). */
  skipCurate?: boolean;
  now?: () => Date;
  log: (line: string) => void;
}

export interface PostGameOutput {
  result: GameResult;
  leaderboard: Leaderboard;
  leaderboardText: string;
  curated: 'updated' | 'kept' | 'skipped';
}

export async function runPostGame(i: PostGameInput): Promise<PostGameOutput> {
  return withLearningLock(i.learningsDir, () => runPostGameLocked(i));
}

async function runPostGameLocked(i: PostGameInput): Promise<PostGameOutput> {
  const result = buildResult(i.final, i.seats, i.tracker, { gameId: i.gameId, date: i.now?.() });
  if (i.mechanicsOnly) {
    await mkdir(i.learningsDir, { recursive: true });
    await appendFile(path.join(i.learningsDir, 'mechanics-results.jsonl'), `${JSON.stringify(result)}\n`, 'utf8');
  } else {
    const existing = await readResults(i.learningsDir);
    if (!existing.some(r => r.gameId === result.gameId)) await appendResult(i.learningsDir, result);
  }
  const leaderboard = computeLeaderboard(await readResults(i.learningsDir));
  const leaderboardText = formatLeaderboard(leaderboard);

  const notes = await Promise.all(
    i.seats.map((s) => {
      const row = result.seats.find((r) => r.name === s.name);
      const seatLlm = i.skipCurate || (i.mechanicsOnly && row && row.placement > 2) ? null : i.llm;
      return writeNote(seatLlm, result, s, leaderboardText, i.learningsDir, i.log, i.tracker.mechanicsText(s.playerId));
    }),
  );
  i.log(`Wrote ${notes.length} notes to ${path.join(i.learningsDir, 'learnings')}`);

  if (!i.mechanicsOnly) {
    for (const seat of i.seats) {
      const note = notes.find(n => n.name === seat.name);
      if (seat.characterId && note) {
        await addPersonalityMemory(i.learningsDir, seat.characterId, i.gameId, note.text);
        const own = result.seats.find(s => s.character === seat.characterId)!;
        const opponents = result.seats.filter(s => s !== own).map(s => ({ key: s.character ?? 'player:' + s.name.toLowerCase(), name: s.name }));
        const watchers = extractWatchers(seat.chat);
        await updateExperience({ dir: i.learningsDir, id: seat.characterId, name: seat.name, gameId: i.gameId, note: note.text,
          ownWon: own.placement === 1, myPlacement: own.placement,
          opponentResults: Object.fromEntries(result.seats.filter(s=>s!==own).map(s=>[s.character ?? 'player:' + s.name.toLowerCase(), {won:s.placement===1,placement:s.placement}])),
          opponents, watchers, deals: seat.observedDeals ?? [], llm: i.llm, log: i.log });
      }
    }

    if (i.charactersKey) {
      await Promise.all(i.seats.map((s) => saveCharacter(i.api, i.charactersKey!, result, s, notes.find((n) => n.name === s.name)?.text ?? '', i.log)));
    } else {
      i.log('No --characters-key: server diary/relationship saves skipped; local character memories saved');
    }
  } else {
    i.log('Mechanics-only mode: character memories, experience, and server diaries skipped');
  }

  let curated: PostGameOutput['curated'] = 'skipped';
  if (i.llm && !i.skipCurate) {
    curated = await curateLearnings({ llm: i.llm, learningsDir: i.learningsDir, gameId: i.gameId, notes, leaderboard: leaderboardText, options: i.final.options, result, now: i.now, log: i.log });
    i.log(curated === 'updated' ? 'RISK_LEARNINGS.md bot section updated' : 'RISK_LEARNINGS.md unchanged');
  }
  return { result, leaderboard, leaderboardText, curated };
}
