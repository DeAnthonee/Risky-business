import type { GameOptions, MapId } from '@risk/engine';
import { gameSeed, isZergName, playGame, zergBot, type Agent, type Seat } from '@risk/selfplay';
import { interval, type Interval } from './stage-eval.js';

/**
 * The Zerg-horde table (docs/zergs.md, section 5): one candidate seat against a horde of 2-3 coordinated Zergs
 * (default zerg@1, the engine's hand-coded horde bot; any Zerg agent such as zerg-branch@1), the other seats filled by a filler player (default Jacob Sensei 2).
 * Does the candidate survive being ganged up on? Two candidates are compared on the same seeds and seat layouts.
 *
 * A table is `map:players:zergs`. With no fillers (players = zergs + 1) the Zergs hunt only the candidate. Once it is
 * out the strongest Zerg keeps the table and the others surrender as their turns come (docs/zergs.md), so the game
 * runs on a little; the candidate's survival time is the last round it made a decision in.
 */
export interface HordeTable {
  map: MapId;
  players: number;
  zergs: number;
}

export const DEFAULT_HORDE_TABLES = 'classic:3:2,classic:4:3,classic:4:2,classic:6:3,classic:6:2';

/** Rounds a candidate must last at a solo table for full `hold` credit without winning. */
export const HOLD_ROUNDS = 30;

export function parseHordeTables(s: string): HordeTable[] {
  return s.split(',').map((t) => {
    const [map, players, zergs] = t.trim().split(':');
    const table = { map: map as MapId, players: Number(players), zergs: Number(zergs) };
    if (!Number.isInteger(table.players) || !Number.isInteger(table.zergs) || table.zergs < 1 || table.zergs >= table.players)
      throw new Error(`bad horde table "${t}" (map:players:zergs, 1 <= zergs < players)`);
    return table;
  });
}

export const tableName = (t: HordeTable) => `${t.map}:${t.players}:${t.zergs}`;

export interface HordeGame {
  table: string;
  seed: number;
  /** The candidate won the game outright. */
  win: number;
  /** Alive at the end (won, or still standing at the turn limit). */
  survived: number;
  /** Rounds the candidate lasted: the last round it made a decision in (the game's rounds if it is still alive). */
  rounds: number;
  /** The whole game's rounds (longer than `rounds` when the Zergs fight on after the candidate is out). */
  gameRounds: number;
  /** Place among the non-Zerg seats, as a score: 1 = best of them, 0 = first out. Solo tables: the win. */
  place: number;
  /** Players the candidate eliminated (only Zergs at a solo table; Zergs or fillers otherwise). */
  kills: number;
  /**
   * Leaderboard points of the seat (placement + kills, engine `gamePoints`), counting every seat including the Zergs, as
   * self-play scores any game (Zergs are not excluded from placements until the open-mode PR).
   */
  points: number;
  /**
   * The deciding score, 0 to 1. Solo tables: 1 for a win, else rounds survived / HOLD_ROUNDS (capped below 1).
   * With fillers: the non-Zerg place score.
   */
  hold: number;
  /**
   * The horde's side (the Zerg tuner's fitness): 1 if the candidate was knocked out, plus up to 0.5 for doing it fast
   * (0.5 × (1 − rounds / RUSH_ROUNDS), floored at 0); -1 if it was still standing at the turn limit. Higher = a
   * stronger horde.
   */
  rush: number;
  turnLimit: number;
}

/** Rounds after which knocking the candidate out earns no speed credit in `rush`. */
export const RUSH_ROUNDS = 40;

/** The seats of one game: the candidate at `shift % players`, then the Zergs, then fillers, wrapping around. */
export function hordeSeats(candidate: Agent, filler: Agent, table: HordeTable, shift: number, zerg: Agent = zergBot): { seats: Seat[]; me: number; zergSeats: number[] } {
  const me = shift % table.players;
  const seats: Seat[] = new Array(table.players);
  const zergSeats: number[] = [];
  for (let k = 0; k < table.players; k++) {
    const i = (me + k) % table.players;
    if (k === 0) seats[i] = { agent: candidate };
    else if (k <= table.zergs) {
      seats[i] = { agent: zerg };
      zergSeats.push(i);
    } else seats[i] = { agent: filler };
  }
  return { seats, me, zergSeats };
}

export function playHordeGame(candidate: Agent, filler: Agent, table: HordeTable, seed: number, shift: number, options: Partial<GameOptions> = {}, maxTurns = 500, zerg: Agent = zergBot): HordeGame {
  if (isZergName(candidate.id) || isZergName(filler.id)) throw new Error('the candidate and filler must not be Zergs');
  if (!isZergName(zerg.id)) throw new Error(`the Zerg seat must be a Zerg agent (got ${zerg.id})`);
  // Track the candidate's last round from its own decisions (game.ts, mirrored, does not report when a seat fell).
  let lastRound = 0;
  const watched: Agent = { ...candidate, choose: (ctx) => ((lastRound = Math.max(lastRound, ctx.state.round)), candidate.choose(ctx)) };
  const { seats, me, zergSeats } = hordeSeats(watched, filler, table, shift, zerg);
  const r = playGame({ seed, seats, options: { map: table.map, ...options, maxPlayers: table.players }, maxTurns, onIllegal: 'surrender' });
  const win = Number(r.winner === me);
  const survived = Number(win === 1 || (r.winner === null && r.territories[me] > 0));
  const nonZerg = seats.map((_, i) => i).filter((i) => !zergSeats.includes(i));
  const solo = nonZerg.length === 1;
  // Non-Zerg places in finishing order (placement counts Zergs too; only the order among non-Zergs matters here).
  const better = nonZerg.filter((i) => i !== me && r.placement[i] < r.placement[me]).length;
  const place = solo ? win : 1 - better / (nonZerg.length - 1);
  const turnLimit = Number(r.winner === null);
  const knocked = r.territories[me] === 0 ? 1 : 0;
  const rounds = knocked ? lastRound : r.rounds;
  const hold = solo ? (win ? 1 : Math.min(0.99, rounds / HOLD_ROUNDS)) : place;
  // The turn-limit penalty only when the candidate was still standing (a Zerg-vs-Zerg stall after it fell is no stall on it).
  const rush = knocked ? 1 + 0.5 * Math.max(0, 1 - rounds / RUSH_ROUNDS) : turnLimit ? -1 : 0;
  return { table: tableName(table), seed, win, survived, rounds, gameRounds: r.rounds, place, kills: r.kills[me], points: r.points[me], hold, rush, turnLimit };
}

export type HordeMetric = 'hold' | 'win' | 'place' | 'rounds' | 'kills' | 'points' | 'rush';
export const HORDE_METRICS: HordeMetric[] = ['hold', 'win', 'place', 'rounds', 'kills', 'points', 'rush'];
/** Metrics on an open scale: no variance floor (the floor keeps a few identical 0/1 results from reading as certain). */
const unbounded = (m: HordeMetric) => m === 'rounds' || m === 'kills' || m === 'points' || m === 'rush';

export interface HordeSummary {
  games: number;
  turnLimit: number;
  /** Mean length of the whole games (the Zergs fight on after the candidate is out). */
  gameRounds: number;
  metrics: Record<HordeMetric, Interval>;
}

export function summarizeHorde(games: HordeGame[]): HordeSummary {
  const metrics = Object.fromEntries(HORDE_METRICS.map((m) => [m, interval(games.map((g) => g[m]), unbounded(m) ? 0 : 0.045)])) as Record<HordeMetric, Interval>;
  const gameRounds = Math.round((games.reduce((a, g) => a + g.gameRounds, 0) / Math.max(1, games.length)) * 10) / 10;
  return { games: games.length, turnLimit: games.reduce((a, g) => a + g.turnLimit, 0), gameRounds, metrics };
}

/** Candidate minus base on the same games (same seed, table and seat layout): the number that decides a gate. */
export function compareHorde(
  cand: HordeGame[],
  base: HordeGame[],
  metric: HordeMetric = 'hold',
): { diff: Interval; verdict: 'better' | 'worse' | 'even'; diffs: Record<HordeMetric, Interval> } {
  if (cand.length !== base.length) throw new Error('compareHorde needs the same games for both');
  const diffs = Object.fromEntries(HORDE_METRICS.map((m) => [m, interval(cand.map((g, i) => g[m] - base[i][m]), unbounded(m) ? 0 : 0.045)])) as Record<HordeMetric, Interval>;
  const diff = diffs[metric];
  return { diff, verdict: diff.low > 0 ? 'better' : diff.high < 0 ? 'worse' : 'even', diffs };
}

/** The games of a run: `games` per table, seeds from `seed` (gameSeed), the candidate's seat rotating. */
export function hordeSchedule(tables: HordeTable[], games: number, seed: number): { table: HordeTable; seed: number; shift: number }[] {
  const out: { table: HordeTable; seed: number; shift: number }[] = [];
  tables.forEach((table, t) => {
    for (let g = 0; g < games; g++) out.push({ table, seed: gameSeed(seed + 1000 * t, g), shift: g });
  });
  return out;
}
