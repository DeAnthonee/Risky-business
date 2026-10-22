import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The tournament leaderboard (rankings-tournament.json): one result per entrant per finished tournament, apart from
 * the public and training boards. Scoring is the owner's (decisions 18 and 20), and lives here, never in the engine's
 * ranking.ts:
 * - placement: out in round r (before the final) = 3 × (r − 1); place p of F in the final = 3 × (L − 1) + 2 × (F − p),
 *   where L is the number of rounds; the champion gets +6 on top;
 * - +2 per table won, any round (+1 when the table was decided on standing rather than played out);
 * - +1 per player eliminated at your tables (surrenders credit nobody).
 *
 * It reads any bracket of rounds and tables, so knockouts score now and nested tournaments can feed the same shape.
 */

export const ROUND_POINTS = 3;
export const FINAL_PLACE_POINTS = 2;
export const CHAMPION_BONUS = 6;
export const TABLE_WIN_POINTS = 2;
export const DECIDED_WIN_POINTS = 1;
export const KILL_POINTS = 1;

/** What scoring needs from a bracket (a TournamentSnapshot fits). */
export interface ScoredBracket {
  id: string;
  name: string;
  /** 'knockout' today; nested tournaments later. */
  format?: string;
  /** `kind` "zerg" marks a Zerg entrant; any other bot is a built-in fill bot. */
  /** `isBot`: a server bot (a built-in fill bot, or `kind` "zerg" for a Zerg). Bots are scored but never ranked. */
  entrants: { id: string; name: string; isBot: boolean; kind?: string }[];
  rounds: {
    matches: {
      entrants: string[];
      winner: string | null;
      /** 'decided' (nested): the round clock ran out and the table was decided on standing: the win is worth less. */
      status: 'playing' | 'finished' | 'bye' | 'abandoned' | 'decided';
      /** Older flag for a table decided on standing (same as status 'decided'). */
      decided?: boolean;
      /** The table's entrants best first, from the game's final placings (missing for tables settled before scoring). */
      order?: string[];
      /** Players each entrant eliminated at this table. */
      kills?: Record<string, number>;
    }[];
  }[];
  champion: string | null;
}

export interface TournamentEntrantResult {
  key: string;
  name: string;
  /** A server bot (fill bot or Zerg): its result is kept (for bot stats) but it is never ranked on the board. */
  bot: boolean;
  /** For a bot: "zerg" or "bot". */
  kind?: 'zerg' | 'bot';
  /** The last round the entrant played (the final when it equals `rounds`). */
  round: number;
  /** Place in the final, of how many seats; null when out earlier. */
  final: { place: number; of: number } | null;
  champion: boolean;
  tablesWon: number;
  kills: number;
  placementPoints: number;
  tablePoints: number;
  points: number;
}

export interface TournamentResult {
  tournamentId: string;
  name: string;
  format: string;
  rounds: number;
  finishedAt: number;
  entrants: TournamentEntrantResult[];
}

export interface TournamentRow {
  key: string;
  name: string;
  rank: number;
  points: number;
  tournaments: number;
  championships: number;
  finals: number;
  tablesWon: number;
  kills: number;
  /** Best finish as words: "champion", "2nd in the final", "out in round 2". */
  bestFinish: string;
}

/** Placement points for an entrant out in `round` of `rounds` (the final when equal), with their final place if any. */
export function placementPoints(rounds: number, round: number, final: { place: number; of: number } | null, champion: boolean): number {
  if (!final || round < rounds) return ROUND_POINTS * (round - 1);
  return ROUND_POINTS * (rounds - 1) + FINAL_PLACE_POINTS * (final.of - final.place) + (champion ? CHAMPION_BONUS : 0);
}

/** The leaderboard key, as on the other boards: `bot:<name>` for bots and Zergs, `player:<name>` otherwise. */
export function entrantKey(e: { name: string; isBot: boolean }): string {
  return `${e.isBot ? 'bot' : 'player'}:${e.name.trim().toLowerCase()}`;
}

/** Score a finished bracket: one result per entrant. Null when it has no rounds. */
export function scoreTournament(t: ScoredBracket, finishedAt = Date.now()): TournamentResult | null {
  const L = t.rounds.length;
  if (!L) return null;
  // Everyone is scored; only people are ranked (rankTournaments), owner's decision: server bots, fill bots and Zergs
  // alike, keep their results for bot stats but never get a row.
  const entrants: TournamentEntrantResult[] = t.entrants.map((e) => {
    let round = 0;
    let final: TournamentEntrantResult['final'] = null;
    let tablesWon = 0;
    let tablePoints = 0;
    let kills = 0;
    t.rounds.forEach((r, i) => {
      const m = r.matches.find((x) => x.entrants.includes(e.id));
      if (!m) return;
      round = i + 1;
      kills += m.kills?.[e.id] ?? 0;
      if ((m.status === 'finished' || m.status === 'decided') && m.winner === e.id) {
        tablesWon++;
        tablePoints += m.status === 'decided' || m.decided ? DECIDED_WIN_POINTS : TABLE_WIN_POINTS;
      }
      if (i === L - 1) {
        const order = m.order ?? (m.winner ? [m.winner, ...m.entrants.filter((x) => x !== m.winner)] : m.entrants);
        const at = order.indexOf(e.id);
        final = { place: at < 0 ? m.entrants.length : at + 1, of: m.entrants.length };
      }
    });
    const champion = t.champion === e.id;
    const place = placementPoints(L, round, final, champion);
    return {
      key: entrantKey(e),
      name: e.name,
      bot: e.isBot,
      ...(e.isBot ? { kind: e.kind === 'zerg' ? ('zerg' as const) : ('bot' as const) } : {}),
      round,
      final,
      champion,
      tablesWon,
      kills,
      placementPoints: place,
      tablePoints,
      points: place + tablePoints + kills * KILL_POINTS,
    };
  });
  return { tournamentId: t.id, name: t.name, format: t.format ?? 'knockout', rounds: L, finishedAt, entrants };
}

function finishText(r: TournamentEntrantResult): string {
  if (r.champion) return 'champion';
  if (r.final) return `${ordinal(r.final.place)} in the final`;
  return `out in round ${r.round}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

/** Higher is better: champion, then a final place (better places higher), then the later round. */
function finishRank(r: TournamentEntrantResult): number {
  if (r.champion) return 1_000_000;
  if (r.final) return 10_000 - r.final.place;
  return r.round;
}

/** A server bot's result. Results saved before the flag existed are bots when their key is a bot key. */
export function isBotResult(e: Pick<TournamentEntrantResult, 'key'> & { bot?: boolean }): boolean {
  return e.bot ?? e.key.startsWith('bot:');
}

/**
 * The board from results in completion order: people only (owner's decision). No server bot, neither a built-in fill
 * bot nor a Zerg, gets a row; their results stay in the file for bot stats. A person named "Bot 1" is still a person.
 */
export function rankTournaments(results: readonly TournamentResult[]): TournamentRow[] {
  const rows = new Map<string, TournamentRow & { best: number }>();
  for (const t of results) {
    for (const e of t.entrants) {
      if (isBotResult(e)) continue;
      const row = rows.get(e.key) ?? { key: e.key, name: e.name, rank: 0, points: 0, tournaments: 0, championships: 0, finals: 0, tablesWon: 0, kills: 0, bestFinish: '', best: -1 };
      row.name = e.name;
      row.points += e.points;
      row.tournaments++;
      row.championships += Number(e.champion);
      row.finals += Number(!!e.final);
      row.tablesWon += e.tablesWon;
      row.kills += e.kills;
      if (finishRank(e) > row.best) {
        row.best = finishRank(e);
        row.bestFinish = finishText(e);
      }
      rows.set(e.key, row);
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.points - a.points || b.championships - a.championships || b.finals - a.finals || b.kills - a.kills || a.key.localeCompare(b.key))
    .map(({ best: _best, ...row }, i) => ({ ...row, rank: i + 1 }));
}

/** Server-owned, append-only tournament results (rankings-tournament.json); no seasons yet. */
export class TournamentRankings {
  private results: TournamentResult[] = [];
  private ids = new Set<string>();

  constructor(private file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!Array.isArray(data)) throw new Error('not a list of tournaments');
      for (const r of data) {
        if (r && typeof r.tournamentId === 'string' && Array.isArray(r.entrants) && !this.ids.has(r.tournamentId)) {
          this.results.push(r);
          this.ids.add(r.tournamentId);
        }
      }
    } catch (e) {
      // A bad file must not keep the server from starting: set it aside and start empty.
      console.error(`tournament rankings: could not read ${file} (${(e as Error).message}); moved to ${file}.corrupt`);
      try { renameSync(file, `${file}.corrupt`); } catch { /* keep going */ }
    }
  }

  /** Record a finished tournament once. False when it was already recorded or has nothing to score. */
  record(bracket: ScoredBracket, finishedAt = Date.now()): boolean {
    if (this.ids.has(bracket.id)) return false;
    const result = scoreTournament(bracket, finishedAt);
    if (!result || result.entrants.length < 2) return false;
    this.results.push(result);
    this.ids.add(result.tournamentId);
    this.save();
    return true;
  }

  has(tournamentId: string): boolean { return this.ids.has(tournamentId); }
  result(tournamentId: string): TournamentResult | null { return this.results.find((r) => r.tournamentId === tournamentId) ?? null; }
  rows(): TournamentRow[] { return rankTournaments(this.results); }

  profile(key: string, name: string): TournamentRow & { results: { tournamentId: string; name: string; finish: string; points: number }[] } {
    const row = this.rows().find((r) => r.key === key) ?? { key, name, rank: 0, points: 0, tournaments: 0, championships: 0, finals: 0, tablesWon: 0, kills: 0, bestFinish: '' };
    const results = this.results.flatMap((t) => t.entrants.filter((e) => e.key === key && !isBotResult(e)).map((e) => ({ tournamentId: t.tournamentId, name: t.name, finish: finishText(e), points: e.points })));
    return { ...row, results };
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.results), 'utf8');
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error(`tournament rankings: could not save ${this.file}: ${(e as Error).message}`);
    }
  }
}
