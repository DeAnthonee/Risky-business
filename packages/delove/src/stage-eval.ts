import {
  addPlayer,
  applyAction,
  createGame,
  finalPlacements,
  gamePoints,
  legalMoves,
  placementPoints,
  RuleError,
  startGame,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
  type MapId,
} from '@risk/engine';
import { candidates, gameSeed, makeTraits, mixSeed, seededRandom, type Agent } from '@risk/selfplay';
import { alivePlayers, rangeOf, type Range } from './net-agent.js';

/**
 * The yardstick for the range specialists (docs/delove-status.md, "Range specialists: how they are compared"): fixed,
 * seeded start positions per stage, a specialist against the base model from those positions in mirrored pairs (both
 * seat orders, same position and seed), scored by that range's own goal, with 95% intervals over positions.
 *
 * Stages: `long` (turn 1 of a 6-10 player table: every seat alive), `mid` (the first turn with exactly 3 players
 * alive), `close` (the first turn with exactly 2 alive, plus fresh duels), and `full` (whole games from the deal, for
 * the routed trio against the single best model). Positions are reached by a fixed capture player (default Jacob
 * Sensei, which never stalls), so the set depends only on the seed, the tables and the settings, never on the models
 * being compared.
 */

export type Stage = Range | 'full';
export type Metric = 'points' | 'top3' | 'top2' | 'win';

export interface Table {
  map: MapId;
  players: number;
}

export interface StageSpec {
  /** Players alive (not counting the neutral) at the captured turn start; null = the deal itself (no capture). */
  alive: ((n: number) => boolean) | null;
  /**
   * Smallest share of the alive players' armies the weakest alive player must hold at the captured position, so the
   * set is not mostly decided games (a duel at 95/5 is won by whoever sits in the big seat). 0 = no filter.
   */
  balance: number;
  /** The range the specialist plays in; outside it the base model plays the candidate's seats. null = always. */
  range: Range | null;
  tables: Table[];
  /** The first metric decides; the others are reported. */
  metrics: Metric[];
  /** Default number of positions (two games each). */
  positions: number;
}

const tables = (s: string): Table[] =>
  s.split(',').map((t) => {
    const [map, players] = t.split(':');
    return { map: map as MapId, players: Number(players) };
  });

export const STAGES: Record<Stage, StageSpec> = {
  long: { alive: (n) => n >= 4, balance: 0, range: 'long', tables: tables('classic:6,world:6,asia:8,world:10'), metrics: ['points', 'top3'], positions: 200 },
  mid: { alive: (n) => n === 3, balance: 0.12, range: 'mid', tables: tables('classic:4,world:4,classic:5,world:6'), metrics: ['top2', 'points'], positions: 300 },
  // 400 positions = 800 mirrored games: the size of a 2-player promotion call (docs/delove-status.md, section 10).
  close: { alive: (n) => n === 2, balance: 0.2, range: 'close', tables: tables('classic:2,classic:4,world:4,world:5'), metrics: ['win', 'points'], positions: 400 },
  full: { alive: null, balance: 0, range: null, tables: tables('classic:2,classic:4,classic:6,world:6,world:10'), metrics: ['points', 'win'], positions: 200 },
};

export function parseTables(s: string): Table[] {
  return tables(s);
}

/** A game position: a started game's state and the players already out, in elimination order. Plain JSON. */
export interface Position {
  state: GameState;
  eliminationOrder: string[];
}

/** What a stage game reports (the subset of the self-play GameResult the yardstick scores). */
export interface StageGame {
  /** Winning seat, or null at the turn limit or when stopped. */
  winner: number | null;
  turns: number;
  placement: number[];
  kills: number[];
  points: number[];
  /** Set when `stopWhen` stopped the game: the position it stopped at. */
  final?: Position;
}

export interface StageGameConfig {
  seed: number;
  agents: Agent[];
  options?: Partial<GameOptions>;
  /** Continue from this position instead of a new deal (its players must be s0..s<n-1>). */
  start?: Position;
  /** Stop before any decision where this returns true. */
  stopWhen?: (state: GameState) => boolean;
  maxTurns?: number;
}

/** Hard stop against an agent that never ends its turn (as in self-play's playGame). */
const MAX_DECISIONS_PER_TURN = 2000;

/**
 * Play a game headless from a new deal or from a position, optionally stopping at a position. The same loop as
 * self-play's `playGame` (illegal moves surrender the seat, a turn-limit game scores last place for every seat, agents'
 * randomness seeded per seat from `seed`), kept here because `packages/selfplay/src/game.ts` is in the GPU mirror's
 * fingerprint (`packages/delove-gpu`), where any edit means an hour-long re-verify.
 */
export function playStageGame(cfg: StageGameConfig): StageGame {
  const n = cfg.agents.length;
  const ids = cfg.agents.map((_, i) => `s${i}`);
  const traits = cfg.agents.map(() => makeTraits());
  const randoms = cfg.agents.map((_, i) => seededRandom(mixSeed(cfg.seed, 0x5eed + i)));
  const maxTurns = cfg.maxTurns ?? 500;
  let state: GameState;
  if (cfg.start) {
    state = structuredClone(cfg.start.state);
    const players = state.players.filter((p) => !p.isNeutral).map((p) => p.id);
    if (players.length !== n || !players.every((p) => ids.includes(p))) throw new Error(`position has players ${players.join(',')}, not the ${n} seats s0..s${n - 1}`);
  } else {
    state = createGame(`g${cfg.seed.toString(16)}`, { maxPlayers: n, ...cfg.options }, cfg.seed);
    cfg.agents.forEach((a, i) => (state = addPlayer(state, ids[i], a.id, true)));
    state = startGame(state).state;
  }
  const eliminationOrder = [...(cfg.start?.eliminationOrder ?? [])];
  let lastTurn = state.turnNumber;
  let turnDecisions = 0;
  while (state.phase !== 'finished' && state.turnNumber < maxTurns) {
    if (cfg.stopWhen?.(state)) return { winner: null, turns: state.turnNumber, placement: [], kills: [], points: [], final: { state, eliminationOrder } };
    const me = state.currentPlayer!;
    const seat = ids.indexOf(me);
    const legal = legalMoves(state, me);
    const agent = cfg.agents[seat];
    const action: Action = agent.choose({ state, me, seat, legal, candidates: candidates(state, me, legal), traits: traits[seat], random: randoms[seat] }) ?? { type: 'surrender' };
    let events: GameEvent[];
    try {
      ({ state, events } = applyAction(state, me, action));
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      ({ state, events } = applyAction(state, me, { type: 'surrender' }));
    }
    for (const e of events) if (e.type === 'eliminated' && !eliminationOrder.includes(e.player)) eliminationOrder.push(e.player);
    if (state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      turnDecisions = 0;
    } else if (++turnDecisions > MAX_DECISIONS_PER_TURN) {
      throw new Error(`${agent.id} (seat ${seat}) made ${MAX_DECISIONS_PER_TURN} decisions without ending turn ${state.turnNumber}`);
    }
  }
  const winner = state.winner === null ? null : ids.indexOf(state.winner);
  const standings = new Map(finalPlacements(state, eliminationOrder).map((p) => [p.id, p]));
  const placement = ids.map((p) => standings.get(p)!.placement);
  const kills = ids.map((p) => standings.get(p)!.killed.length);
  const points = ids.map((p, seat) => (winner === null ? placementPoints(n, n) : gamePoints({ key: p, name: p, placement: placement[seat], killed: standings.get(p)!.killed }, n)));
  return { winner, turns: state.turnNumber, placement, kills, points };
}

/** A start position: the table it is on, the seed of its pair of games and, unless it is the deal, the state. */
export interface StagePosition {
  index: number;
  table: Table;
  seed: number;
  /** Absent for `full` (the games start from the deal). */
  start?: Position;
}

/** Candidate seat play: the specialist inside its range, the base model outside it (so only the stage is judged). */
export function stagedAgent(id: string, specialist: Agent, base: Agent, range: Range): Agent {
  return { id, choose: (ctx) => (rangeOf(ctx.state) === range ? specialist : base).choose(ctx) };
}

/** The routed trio as one player: Long Range at 4+ alive, Mid Range at 3, Close Range at 2 (any player versions). */
export function routedAgent(id: string, routes: Record<Range, Agent>): Agent {
  return { id, choose: (ctx) => routes[rangeOf(ctx.state)].choose(ctx) };
}

const MAX_ATTEMPTS = 200;

/**
 * Position `index` of a stage: table index % tables, then capture games seeded from (seed, index, attempt) played by
 * `capture` in every seat until the first turn start (first reinforce decision) whose alive count fits the stage.
 * Attempts that skip the stage (two players out in one turn), hit the turn limit or fail the stage's balance test
 * move on to the next attempt.
 */
export function capturePosition(stage: StageSpec, index: number, seed: number, capture: Agent, options: Partial<GameOptions>, maxTurns = 500): StagePosition {
  const table = stage.tables[index % stage.tables.length];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const s = gameSeed(seed, index * MAX_ATTEMPTS + attempt);
    if (!stage.alive) return { index, table, seed: s };
    const fits = stage.alive;
    let lastTurn = -1;
    const r = playStageGame({
      seed: s,
      agents: Array.from({ length: table.players }, () => capture),
      options: { ...options, map: table.map },
      maxTurns,
      stopWhen: (st: GameState) => {
        const turnStart = st.phase === 'reinforce' && st.turnNumber !== lastTurn;
        if (st.phase === 'reinforce') lastTurn = st.turnNumber;
        return turnStart && fits(alivePlayers(st));
      },
    });
    // Clock times are the only thing that differs between two captures; zero them so a position set is reproducible.
    if (r.final && weakestShare(r.final.state) >= stage.balance) return { index, table, seed: s, start: { ...r.final, state: { ...r.final.state, createdAt: 0, startedAt: 0 } } };
  }
  throw new Error(`no ${table.map}:${table.players} position for index ${index} in ${MAX_ATTEMPTS} attempts`);
}

/** The weakest alive player's share of the alive players' armies. */
export function weakestShare(state: GameState): number {
  const armies = new Map(state.players.filter((p) => p.alive && !p.isNeutral).map((p) => [p.id, 0]));
  for (const t of Object.values(state.territories)) if (t.owner && armies.has(t.owner)) armies.set(t.owner, armies.get(t.owner)! + t.armies);
  const total = [...armies.values()].reduce((a, b) => a + b, 0);
  return total ? Math.min(...armies.values()) / total : 0;
}

/** Seats alive at the position, in seat order (all seats for the deal). */
export function aliveSeats(p: StagePosition): number[] {
  if (!p.start) return Array.from({ length: p.table.players }, (_, i) => i);
  return p.start.state.players.filter((x) => x.alive && !x.isNeutral).map((x) => Number(x.id.slice(1)));
}

/** Candidate's seats in game `g` (0 or 1) of a position's pair: alternate alive seats, swapped in the second game. */
export function candidateSeats(p: StagePosition, g: number): Set<number> {
  return new Set(aliveSeats(p).filter((_, j) => (j + g) % 2 === 0));
}

export function metricOf(m: Metric, r: StageGame, seat: number): number {
  const finished = r.winner !== null;
  switch (m) {
    case 'points':
      return r.points[seat];
    case 'top3':
      return finished && r.placement[seat] <= 3 ? 1 : 0;
    case 'top2':
      return finished && r.placement[seat] <= 2 ? 1 : 0;
    case 'win':
      return r.winner === null ? 0.5 : r.winner === seat ? 1 : 0;
  }
}

/** One position's pair, reduced: per metric, the mean over the candidate's seat-games and over the base's. */
export interface PairResult {
  index: number;
  table: string;
  cand: Record<Metric, number>;
  base: Record<Metric, number>;
  turnLimit: number;
  turns: number;
  /** Both games ended with the same placements: the seats decided it, not who played them. */
  decided: boolean;
}

const METRICS: Metric[] = ['points', 'top3', 'top2', 'win'];

/** Play both games of a position's pair: candidate (specialist or router) against base, seats swapped. */
export function playPair(p: StagePosition, candidate: Agent, base: Agent, options: Partial<GameOptions>, maxTurns = 500): PairResult {
  const sums = { cand: zero(), base: zero(), nc: 0, nb: 0 };
  let turnLimit = 0;
  let turns = 0;
  const alive = aliveSeats(p);
  const places: string[] = [];
  for (const g of [0, 1]) {
    const mine = candidateSeats(p, g);
    const agents = Array.from({ length: p.table.players }, (_, s) => (mine.has(s) ? candidate : base));
    const r = playStageGame({ seed: p.seed, agents, options: { ...options, map: p.table.map }, maxTurns, start: p.start });
    if (r.winner === null) turnLimit++;
    places.push(r.placement.join(','));
    turns += r.turns - (p.start?.state.turnNumber ?? 0);
    for (const s of alive) {
      const side = mine.has(s) ? sums.cand : sums.base;
      for (const m of METRICS) side[m] += metricOf(m, r, s);
      if (mine.has(s)) sums.nc++;
      else sums.nb++;
    }
  }
  const div = (x: Record<Metric, number>, n: number) => Object.fromEntries(METRICS.map((m) => [m, x[m] / n])) as Record<Metric, number>;
  return { index: p.index, table: `${p.table.map}:${p.table.players}`, cand: div(sums.cand, sums.nc), base: div(sums.base, sums.nb), turnLimit, turns, decided: places[0] === places[1] };
}

function zero(): Record<Metric, number> {
  return { points: 0, top3: 0, top2: 0, win: 0 };
}

/** Mean and 95% interval (normal, over units). */
export interface Interval {
  mean: number;
  low: number;
  high: number;
}

export function interval(xs: number[], floorVar = 0): Interval {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const v = n > 1 ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : floorVar;
  const se = Math.sqrt(Math.max(v, floorVar) / Math.max(n, 1));
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { mean: r(mean), low: r(mean - 1.96 * se), high: r(mean + 1.96 * se) };
}

export interface MetricSummary {
  candidate: Interval;
  base: Interval;
  /** Candidate minus base, paired by position: the number that decides. */
  diff: Interval;
}

export interface StageSummary {
  positions: number;
  games: number;
  turnLimit: number;
  meanTurns: number;
  /**
   * Positions whose two games placed every seat the same: the position and dice decided them, not who played. They
   * count as no difference; a stage where most positions are decided needs more of them for the same interval.
   */
  decided: number;
  metrics: Partial<Record<Metric, MetricSummary>>;
  /** The deciding metric's verdict: better / worse when the diff interval clears 0, else even. */
  verdict: 'better' | 'worse' | 'even';
}

export function summarize(pairs: PairResult[], metrics: Metric[]): StageSummary {
  const out: Partial<Record<Metric, MetricSummary>> = {};
  for (const m of metrics) {
    // Floor the variance of win-like metrics so a handful of identical pairs never reads as certainty.
    const floor = m === 'points' ? 0 : 0.045;
    out[m] = {
      candidate: interval(pairs.map((p) => p.cand[m]), floor),
      base: interval(pairs.map((p) => p.base[m]), floor),
      diff: interval(pairs.map((p) => p.cand[m] - p.base[m]), floor),
    };
  }
  const d = out[metrics[0]]!.diff;
  return {
    positions: pairs.length,
    games: pairs.length * 2,
    turnLimit: pairs.reduce((a, p) => a + p.turnLimit, 0),
    decided: pairs.filter((p) => p.decided).length,
    meanTurns: Math.round((pairs.reduce((a, p) => a + p.turns, 0) / Math.max(1, pairs.length * 2)) * 10) / 10,
    metrics: out,
    verdict: d.low > 0 ? 'better' : d.high < 0 ? 'worse' : 'even',
  };
}
