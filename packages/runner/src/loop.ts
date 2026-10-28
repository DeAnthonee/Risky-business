import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readPersonalityMemory } from './shared-memory.js';
import { readExperience, describeExperience } from './experience.js';
import path from 'node:path';
import type { GameOptions, GameView } from '@risk/engine';
import type { RiskApi } from '@risk/mcp';
import { Commander, condenseLearnings, profileExcerpt } from './commander.js';
import { DealLedger, dealPrefixes } from './deals.js';
import { Diplomat } from './diplomat.js';
import type { Llm } from './llm.js';
import { buildResult, computeLeaderboard, formatLeaderboard, killList, readResults, GameTracker, runPostGame, type GameResult, type SeatReport } from './postgame.js';
import { gameOptions, pickLineup, pickMap, shuffled, type MapChoice, type PlayerCount, type RosterEntry } from './presets.js';
import { loadCharacter, type CharacterText } from './roster.js';
import { SeatRunner } from './seat.js';
import { createGame, leaveSeats, type SeatSpec } from './setup.js';

/** Two-stage stop: the first request finishes the current game and its write-ups, the second stops now. */
export class LoopControl {
  soft = false;
  hard = false;
  private runners: SeatRunner[] = [];
  private abandon: (() => Promise<void>) | null = null;
  /** Returns true when this request was the second one. */
  request(): boolean {
    if (this.soft) {
      this.hard = true;
      for (const r of this.runners) r.stop();
      return true;
    }
    this.soft = true;
    return false;
  }
  /** `abandon` makes the game's seats leave (called when the loop is stopped hard or the game is given up). */
  attach(runners: SeatRunner[], abandon?: () => Promise<void>) {
    this.runners = runners;
    this.abandon = abandon ?? null;
    if (this.hard) for (const r of runners) r.stop();
  }
  /** Leave the seats of the game in progress (if any). Never throws. */
  async leaveNow(): Promise<void> {
    try {
      await this.abandon?.();
    } catch {
      /* best effort */
    }
  }
}

export interface LoopOptions {
  api: RiskApi;
  /** Null: no model at all (planned bot only, plain-summary notes). */
  llm: Llm | null;
  /** Explicit seats (shuffled each game). Without them every game gets a random lineup from `roster`. */
  seats?: SeatSpec[];
  /** Characters a random lineup draws from (display names become seat names). */
  roster?: RosterEntry[];
  /** With a roster: how many seats per game, a number or 'random' (5 to 10 within the map). Default 'random'. */
  players?: PlayerCount;
  /** The repo AI folder, where profiles the server does not have are read from. */
  aiDir?: string | null;
  /** Per-game time cap: after it every seat leaves and the loop moves on. Default 120 minutes; 0 = no cap. */
  maxGameMs?: number;
  /** Games to play; 0 = forever. */
  games: number;
  learningsDir: string;
  map: MapChoice;
  /** Overrides on top of the default preset. */
  options?: Partial<GameOptions>;
  paceMs: number;
  /** How long moves wait for the commander. */
  planTimeoutMs: number;
  /** One model call per own turn sets the plan. */
  commander: boolean;
  /** Post-game results, notes and curation (and the scouting log). */
  learn: boolean;
  /** Table talk. */
  chat: boolean;
  maxChatPerTurn: number;
  /** Let the diplomats' own words through; default false (pings and bare deal tags only). */
  freeChat?: boolean;
  charactersKey?: string;
  /** Pure mechanics training mode: uses generic seats without character profiles, skips chat and character memory/diary writes, and updates only RISK_LEARNINGS.md. */
  mechanicsOnly?: boolean;
  /** Run the RISK_LEARNINGS.md curator once every N finished games (and on the final game). Default 1. */
  curationInterval?: number;
  /** Limit commander/LLM reasoning to the first N seats (e.g. 1 smart player vs remaining plain bots). */
  smartSeats?: number;
  /** Skip character grudge/rivalry memory loading and reflection to optimize test speed and avoid token bloat. Full match stats and leaderboard are still preserved. */
  skipRivalries?: boolean;
  /** Explicit generation tag for results (e.g. 'gen5', 'gen6'). */
  generation?: string;
  /** Whether the match is a knockout tournament table. */
  isTournament?: boolean;
  /** Seats to leave open in the lobby for external players; the host waits until the lobby fills before starting. */
  openSeats?: number;
  /** Printed in the "watch" line. */
  serverUrl?: string;
  control?: LoopControl;
  random?: () => number;
  log: (line: string) => void;
  /** Also log chat failures. */
  verbose?: boolean;
}

/** The commander profile text plus a short excerpt of the starting rapport, when there is one. */
function withRelationships(profile: string | null, relationships: string | null): string | null {
  if (!relationships) return profile;
  return `${profile ?? ''}\n\nStarting rapport with other players (data from your profile):\n${relationships.slice(0, 10000)}`.trim();
}

async function readLearnings(dir: string, log: (l: string) => void): Promise<string> {
  try {
    return await readFile(path.join(dir, 'RISK_LEARNINGS.md'), 'utf8');
  } catch {
    log(`No RISK_LEARNINGS.md in ${dir}: the commander plays without shared advice`);
    return '';
  }
}

const GENERIC_ROSTER: RosterEntry[] = Array.from({ length: 10 }, (_, i) => ({ id: '', name: `Bot${i + 1}` }));

/** Play games back to back, writing up each one. Resolves with the results of the games played. */
export async function runLoop(o: LoopOptions): Promise<GameResult[]> {
  const random = o.random ?? Math.random;
  const control = o.control ?? new LoopControl();
  const { api, log } = o;
  const session: GameResult[] = [];
  const roster = o.mechanicsOnly && (!o.roster || o.roster.length < 2) ? GENERIC_ROSTER : o.roster;

  if (!o.seats && (!roster || roster.length < 2)) throw new Error('runLoop needs seats or a roster of at least 2 characters');
  const maxGameMs = o.maxGameMs ?? 120 * 60_000;
  const skipRivalries = Boolean(o.skipRivalries || process.env.RISK_SKIP_RIVALRIES === '1' || (o.learningsDir && existsSync(path.join(o.learningsDir, '.skip-rivalries'))));
  if (skipRivalries && !o.mechanicsOnly) {
    log('Fast character mode: grudge/rivalry memory reflection bypassed for fast strategic execution; full match stats & leaderboard preserved.');
  }

  // Profiles are refreshed before each game: the server copy, else the local AI folder; a missing one plays the generic persona.
  const profiles = new Map<string, CharacterText | null>();
  const profileFor = async (characterId: string): Promise<CharacterText | null> => {
    const character = await loadCharacter(api, characterId, o.aiDir ?? null);
    if (skipRivalries) {
      profiles.set(characterId, character && { ...character, personalMemory: undefined, experience: undefined, relationships: null });
      return profiles.get(characterId) ?? null;
    }
    const memory = await readPersonalityMemory(o.learningsDir, characterId);
    profiles.set(characterId, character && { ...character, personalMemory: memory, experience: describeExperience(await readExperience(o.learningsDir, characterId)) });
    return profiles.get(characterId) ?? null;
  };

  let failures = 0;
  let lastMap: GameOptions['map'] | null = null;
  const openSeats = Math.max(0, o.openSeats ?? 0);
  for (let g = 0; (o.games === 0 || g < o.games) && !control.soft && !control.hard; g++) {
    profiles.clear(); // Refresh shared character lessons before every new game.
    let order: SeatSpec[];
    let map: GameOptions['map'];
    if (o.seats) {
      order = shuffled(o.seats, random);
      map = pickMap(o.map, order.length + openSeats, g, random, lastMap ?? undefined);
    } else {
      const lineup = pickLineup({ map: o.map, players: o.players ?? 'random', roster: roster!, index: g, random, excludeMap: lastMap ?? undefined });
      const total = Math.max(2 + openSeats, lineup.seats.length);
      order = shuffled(lineup.seats, random).slice(0, Math.max(2, total - openSeats));
      map = lineup.map;
    }
    lastMap = map;
    if (o.mechanicsOnly) {
      order = order.map((s) => ({ name: s.name }));
    }
    let rankingContext = '';
    if (!o.mechanicsOnly) {
      const localStandings = computeLeaderboard(await readResults(o.learningsDir));
      rankingContext = formatLeaderboard(localStandings);
      if (api.rankings) {
        try { const global = await api.rankings(); if (global.rankings.length) rankingContext = 'Server leaderboard (all-time):\n' + global.rankings.map(r => `#${r.rank} ${r.name} (${r.key}): ${r.points} points, ${r.wins} wins / ${r.losses} losses, ${r.winRate}% win rate, average place ${r.avgPlacement}, ${r.kills ?? 0} kills${killList(r.victims ?? {})}`).join('\n'); }
        catch (e) { log('Server rankings unavailable; using the local shared results ledger.'); }
      }
    }
    const personas = new Map<string, CharacterText | null>();
    if (o.llm && !o.mechanicsOnly) {
      for (const s of order) if (s.characterId) personas.set(s.name, await profileFor(s.characterId));
      const sources = [...personas.entries()].map(([name, c]) => `${name}: ${c ? (c.source === 'server' ? 'server' : 'local file') : 'generic persona'}`);
      if (sources.length > 0) log(`Profiles: ${sources.join(', ')}`);
    }
    const learnings = o.commander ? await readLearnings(o.learningsDir, log) : '';
    let modes: GameOptions['cardValues'][] = ['progressive', 'fixed', 'exponential'];
    if (api.cardModes) {
      try { modes = await api.cardModes(); }
      catch { modes = ['progressive', 'fixed']; log('Could not read server card modes; using fixed/progressive until the catalogue is available.'); }
      if (!modes.includes('exponential')) log('Server has not enabled exponential cards yet; randomizing among its supported modes.');
    }
    let setup;
    const totalSeats = order.length + openSeats;
    const roundOptions = gameOptions(totalSeats, map, o.options, random, modes);
    try {
      setup = await createGame(api, order, {
        gameName: o.generation
          ? `Generation ${o.generation.replace(/^gen/i, '')} Match ${g + 1}`
          : (o.mechanicsOnly ? 'Mechanics lab' : 'Bot table'),
        options: roundOptions,
        openSeats,
        onLobbyReady: (id) => {
          if (openSeats > 0) {
            log(`Lobby ${id} on ${map}: ${order.length} AI seated (${order.map((s) => s.name).join(', ')}), waiting for ${openSeats} open seat(s) to join before starting...`);
            if (o.serverUrl) log(`Join: ${o.serverUrl}/?game=${id}`);
          }
        },
      });
      failures = 0;
    } catch (e) {
      log(`Could not set up game ${g + 1}: ${(e as Error).message}`);
      if (++failures >= 5) throw new Error(`Giving up after ${failures} failed game setups`);
      await new Promise((r) => setTimeout(r, 3000));
      g--;
      continue;
    }
    const gameId = setup.gameId;
    log(`Game ${g + 1}${o.games ? `/${o.games}` : ''}: ${gameId} on ${map}, ${totalSeats} players (${order.map((s) => s.name).join(', ')}${openSeats > 0 ? ` + ${openSeats} joined` : ''})`);
    if (o.serverUrl) log(`Watch: ${o.serverUrl}/?game=${gameId}&spectate=1`);

    const tracker = new GameTracker();
    const scoutingDir = o.learn ? path.join(o.learningsDir, 'scouting') : null;
    const commanders = new Map<string, Commander>();
    const ledgers = new Map<string, DealLedger>();
    const prefixes = dealPrefixes(setup.identities.map((id) => id.name));
    const smartLimit = o.smartSeats !== undefined && o.smartSeats > 0 ? o.smartSeats : setup.identities.length;
    const runners = setup.identities.map((id, seatIdx) => {
      const isSmart = seatIdx < smartLimit;
      const character = isSmart ? (personas.get(id.name) ?? null) : null;
      const persona = character?.markdown ?? null;
      const relationships = isSmart && !skipRivalries ? ([character?.relationships, character?.experience].filter(Boolean).join('\n\n') || null) : null;
      const personalContext = !isSmart || o.mechanicsOnly || skipRivalries ? '' : [character?.personalMemory ? 'Your previous game notes (subjective advice, not rules):\n' + character.personalMemory : '',
        'Your all-time record and rivals: find your name/character ID below. Higher ranks are above you; lower ranks are below. Unlisted characters have 0 games, 0 points and are unranked. This is a pre-game snapshot.\n' + rankingContext].filter(Boolean).join('\n\n');
      const ledger = new DealLedger({ me: id.name, idPrefix: prefixes.get(id.name) });
      ledgers.set(id.name, ledger);
      let commander: Commander | null = null;
      if (o.llm && o.commander && isSmart) {
        commander = new Commander({
          llm: o.llm,
          seatName: id.name,
          playerId: id.playerId,
          profile: o.mechanicsOnly ? null : withRelationships([profileExcerpt(persona), personalContext].filter(Boolean).join('\n\n'), relationships),
          learnings: condenseLearnings(learnings, roundOptions),
          gameId,
          scoutingDir,
          timeoutMs: o.planTimeoutMs,
          log,
          ledger,
        });
        commanders.set(id.name, commander);
      }
      const diplomat =
        o.llm && o.chat && isSmart
          ? new Diplomat({
              llm: o.llm,
              seatName: id.name,
              playerId: id.playerId,
              characterMarkdown: persona,
              relationships,
              personalMemory: personalContext,
              maxPerTurn: o.maxChatPerTurn,
              ledger,
              getPlan: () => commander?.planText() ?? null,
              random,
            })
          : null;
      const quiet = (line: string) => {
        if (o.verbose || !/chat skipped/.test(line)) log(line);
      };
      return new SeatRunner({
        api,
        freeChat: o.freeChat,
        gameId: id.gameId,
        playerId: id.playerId,
        token: id.token,
        name: id.name,
        diplomat,
        commander,
        paceMs: o.paceMs,
        log: quiet,
        random,
        onView: (v) => tracker.observe(v),
      });
    });
    const abandon = () => leaveSeats(api, setup.identities);
    control.attach(runners, abandon);

    // Per-game time cap: past it the seats stop, leave the game and the loop moves on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capped = false;
    const capHit = new Promise<null>((resolve) => {
      if (maxGameMs > 0) {
        timer = setTimeout(() => {
          capped = true;
          resolve(null);
        }, maxGameMs);
      }
    });
    const playing = Promise.all(runners.map((r) => r.run()));
    let views: (GameView | null)[] | null;
    try {
      views = await Promise.race([playing, capHit]);
    } catch (e) {
      for (const r of runners) r.stop();
      await abandon();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (capped || !views) {
      log(`Game ${gameId} hit the ${Math.round(maxGameMs / 60_000)} minute time cap: leaving the seats and moving on`);
      for (const r of runners) r.stop();
      await abandon();
      await Promise.race([playing.catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
      continue;
    }
    const final = views.find((v): v is GameView => v?.phase === 'finished') ?? null;
    if (!final) {
      log(`Game ${gameId} did not finish${control.hard ? ' (stopped)' : ''}`);
      await abandon();
      if (control.hard) break;
      continue;
    }
    for (const l of ledgers.values()) l.finish();
    for (const c of commanders.values()) await c.settled();
    const winner = final.players.find((p) => p.id === final.winner);
    log(`Game over: ${gameId}. Winner: ${winner ? winner.name : 'none'}`);

    if (o.learn) {
      const reports: SeatReport[] = setup.identities.map((id, i) => ({
        name: id.name,
        playerId: id.playerId,
        characterId: order.find((s) => s.name === id.name)?.characterId,
        privateLog: [...(commanders.get(id.name)?.privateLog() ?? []), runners[i].memoryText()],
        strategy: commanders.get(id.name)?.planText(final) ?? null,
        chat: runners[i].chatLines(),
        deals: ledgers.get(id.name)?.stats(),
        dealLog: ledgers.get(id.name)?.history ?? [],
        observedDeals: ledgers.get(id.name)?.all() ?? [],
      }));
      const interval = Math.max(1, o.curationInterval ?? 1);
      const isLast = (o.games > 0 && g + 1 >= o.games) || control.soft || control.hard;
      const skipCurate = interval > 1 && (session.length + 1) % interval !== 0 && !isLast;
      const isGen4 = o.smartSeats === 1;
      const isGen5 = (o.smartSeats === undefined || o.smartSeats > 1) && !o.mechanicsOnly;
      const genName = o.generation ?? (isGen4 ? 'gen4' : isGen5 ? 'gen5' : o.mechanicsOnly ? 'mechanics' : undefined);
      try {
        const out = await runPostGame({ api, llm: o.llm, learningsDir: o.learningsDir, final, gameId, seats: reports, tracker, charactersKey: o.charactersKey, mechanicsOnly: o.mechanicsOnly, skipCurate, skipRivalries, smartSeats: o.smartSeats, generation: genName, log });
        session.push(out.result);
        log(out.leaderboardText);
      } catch (e) {
        log(`Post-game write-up failed: ${(e as Error).message}`);
      }
    } else {
      const isGen4 = o.smartSeats === 1;
      const isGen5 = (o.smartSeats === undefined || o.smartSeats > 1) && !o.mechanicsOnly;
      const genName = isGen4 ? 'gen4' : isGen5 ? 'gen5' : o.mechanicsOnly ? 'mechanics' : undefined;
      const result = buildResult(
        final,
        setup.identities.map((id) => ({ name: id.name, playerId: id.playerId, characterId: order.find((s) => s.name === id.name)?.characterId, deals: ledgers.get(id.name)?.stats() })),
        tracker,
        { gameId, smartSeats: o.smartSeats, generation: genName },
      );
      session.push(result);
      log(formatLeaderboard(computeLeaderboard(session)));
    }
  }
  return session;
}
