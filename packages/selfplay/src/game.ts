import {
  addPlayer,
  applyAction,
  createGame,
  finalPlacements,
  gamePoints,
  getMap,
  legalMoves,
  placementPoints,
  RuleError,
  startGame,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
} from '@risk/engine';
import { actionSteps, candidates } from './actions.js';
import type { Agent } from './agents.js';
import { decisionInput } from './encode.js';
import { LOG_VERSION, seatOf, type DecisionRecord, type Outcome } from './log.js';
import { aliveCount, stageSeats } from './positions.js';
import { mixSeed, seededRandom } from './seed.js';
import { makeTraits, type Traits } from './traits.js';

export interface Seat {
  agent: Agent;
  traits?: Partial<Traits>;
}

/**
 * A stage-focused game (positions.ts): the seats' own agents play a lead-in until `alive` real players are left, then
 * `agents` take the survivors' seats (stageSeats: in turn order from the player to move, rotated by `rotate`) and
 * only from then on are decisions recorded.
 */
export interface StageConfig {
  alive: number;
  agents: Agent[];
  rotate: number;
}

export interface GameConfig {
  seed: number;
  seats: Seat[];
  /** Play a stage: lead-in by `seats`, recorded from the moment `stage.alive` players remain. */
  stage?: StageConfig;
  /**
   * Begin from this state (a StartPosition made ready by startState) instead of a new game. Its players must be
   * s0..s{seats-1} (and the Neutral); `eliminated` lists the players already out, in order.
   */
  start?: { state: GameState; eliminated: string[] };
  /** Engine options; maxPlayers defaults to the number of seats. Defaults otherwise as on the live server. */
  options?: Partial<GameOptions>;
  /** Stop after this many turns and call it a draw. Default 500. */
  maxTurns?: number;
  /** Collect a DecisionRecord for every decision (with the outcome filled in). Default false. */
  record?: boolean;
  /** What to do when an agent plays an illegal action: 'throw' (default) or 'surrender' that seat. */
  onIllegal?: 'throw' | 'surrender';
  id?: string;
}

export interface GameResult {
  id: string;
  seed: number;
  map: string;
  agents: string[];
  /** Winning seat, or null at the turn limit. */
  winner: number | null;
  reason: Outcome['reason'];
  turns: number;
  rounds: number;
  decisions: number;
  /** Decision steps (decisions plus one per fortify, which is two steps); one log record each. */
  steps: number;
  /** Seats in turn order. */
  turnOrder: number[];
  /** Territories held per seat at the end. */
  territories: number[];
  /** Per seat: final place (1 = first), players eliminated, leaderboard points (see Outcome.points). */
  placement: number[];
  kills: number[];
  points: number[];
  /** Stage games: when the stage began (null: never, the game ended before), and each seat's agent from then on. */
  stage?: { turn: number; step: number; alive: number; agents: string[] } | null;
  /** Illegal actions per seat (only non-zero with onIllegal: 'surrender'). */
  illegal: number[];
  /** Decisions outside the discrete action space, per seat. */
  offList: number[];
  records?: DecisionRecord[];
}

/** Hard stop against an agent that never ends its turn. */
const MAX_DECISIONS_PER_TURN = 2000;

/**
 * Play one game to the end, headless: engine only, no server, no timers. Everything random (deal, dice, agents)
 * derives from `seed`, so the same config always produces the same game.
 */
export function playGame(cfg: GameConfig): GameResult {
  const n = cfg.seats.length;
  const ids = cfg.seats.map((_, i) => `s${i}`);
  const traits = cfg.seats.map((s) => makeTraits(s.traits));
  const randoms = cfg.seats.map((_, i) => seededRandom(mixSeed(cfg.seed, 0x5eed + i)));
  const maxTurns = cfg.maxTurns ?? 500;
  const id = cfg.id ?? `g${cfg.seed.toString(16)}`;

  let state: GameState;
  if (cfg.start) {
    state = cfg.start.state;
    const real = state.players.filter((p) => !p.isNeutral).map((p) => p.id);
    if (real.join() !== ids.join()) throw new Error(`game ${id}: the start position's seats are ${real.join()}, not ${ids.join()}`);
  } else {
    state = createGame(id, { maxPlayers: n, ...cfg.options }, cfg.seed);
    cfg.seats.forEach((s, i) => (state = addPlayer(state, ids[i], s.agent.id, true)));
    state = startGame(state).state;
  }
  const map = getMap(state.options.map);
  const seatAgents = cfg.seats.map((s) => s.agent);
  let staged = !cfg.stage;
  let stage: GameResult['stage'] = cfg.stage ? null : undefined;

  const records: DecisionRecord[] = [];
  const illegal = new Array<number>(n).fill(0);
  const offList = new Array<number>(n).fill(0);
  let decisions = 0;
  let stepCount = 0;
  let turnDecisions = 0;
  let lastTurn = state.turnNumber;
  let reason: Outcome['reason'] = 'turn_limit';
  /** Player ids in the order they were eliminated (for final placements). */
  const eliminationOrder: string[] = [...(cfg.start?.eliminated ?? [])];

  while (state.phase !== 'finished' && state.turnNumber < maxTurns) {
    if (!staged && aliveCount(state) <= cfg.stage!.alive) {
      for (const [s, a] of stageSeats(state, ids, cfg.stage!.agents.length, cfg.stage!.rotate)) seatAgents[s] = cfg.stage!.agents[a];
      staged = true;
      stage = { turn: state.turnNumber, step: stepCount, alive: aliveCount(state), agents: seatAgents.map((a) => a.id) };
    }
    const me = state.currentPlayer!;
    const seat = ids.indexOf(me);
    const legal = legalMoves(state, me);
    const cands = candidates(state, me, legal);
    const agent = seatAgents[seat];
    const action: Action = agent.choose({ state, me, seat, legal, candidates: cands, traits: traits[seat], random: randoms[seat] }) ?? { type: 'surrender' };
    const steps = actionSteps(state, me, legal, action, cands);
    const firstStep = stepCount;
    stepCount += steps.length;
    if (steps[steps.length - 1].choice < 0) offList[seat]++;
    if (cfg.record && staged) {
      for (const [k, step] of steps.entries()) {
        records.push({
          v: LOG_VERSION,
          game: id,
          seed: cfg.seed,
          i: firstStep + k,
          agent: agent.id,
          ...decisionInput(state, ids, me, traits[seat], step.cands, step.fortifyFrom ?? -1),
          choice: step.choice,
          ...(step.choice < 0 ? { action } : {}),
          outcome: null as unknown as Outcome,
        });
      }
    }

    let events: GameEvent[];
    try {
      ({ state, events } = applyAction(state, me, action));
    } catch (err) {
      if (!(err instanceof RuleError) || cfg.onIllegal !== 'surrender') {
        throw new Error(`${agent.id} (seat ${seat}) played an illegal action in game ${id} at decision ${decisions}: ${JSON.stringify(action)}: ${(err as Error).message}`);
      }
      illegal[seat]++;
      ({ state, events } = applyAction(state, me, { type: 'surrender' }));
    }
    decisions++;
    for (const e of events) if (e.type === 'eliminated' && !eliminationOrder.includes(e.player)) eliminationOrder.push(e.player);
    const over = events.find((e) => e.type === 'game_over');
    // A stalemate (stallEnd, off in self-play) is no win on the board: logged like the turn limit, so LOG_VERSION holds.
    if (over && over.type === 'game_over') reason = over.reason === 'stalemate' ? 'turn_limit' : (over.reason ?? 'domination');

    if (state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      turnDecisions = 0;
    } else if (++turnDecisions > MAX_DECISIONS_PER_TURN) {
      throw new Error(`${agent.id} (seat ${seat}) made ${MAX_DECISIONS_PER_TURN} decisions without ending turn ${state.turnNumber} in game ${id}`);
    }
  }

  const winner = state.winner === null ? null : seatOf(ids, state.winner);
  const alive = ids.map((p) => state.players.find((x) => x.id === p)!.alive);
  const survivors = alive.filter(Boolean).length;
  const z = (seat: number) => (winner !== null ? (seat === winner ? 1 : 0) : alive[seat] ? 1 / survivors : 0);
  const standings = new Map(finalPlacements(state, eliminationOrder).map((p) => [p.id, p]));
  const placement = ids.map((p) => standings.get(p)!.placement);
  const kills = ids.map((p) => standings.get(p)!.killed.length);
  const points = ids.map((p, seat) =>
    winner === null ? placementPoints(n, n) : gamePoints({ key: p, name: p, placement: placement[seat], killed: standings.get(p)!.killed }, n),
  );
  for (const r of records) {
    r.outcome = { winner, z: z(r.seat), turns: state.turnNumber, reason, placement: placement[r.seat], kills: kills[r.seat], points: points[r.seat] };
  }

  return {
    id,
    seed: cfg.seed,
    map: map.id,
    agents: cfg.seats.map((s) => s.agent.id),
    ...(stage !== undefined ? { stage } : {}),
    winner,
    reason: winner === null ? 'turn_limit' : reason,
    turns: state.turnNumber,
    rounds: state.round,
    decisions,
    steps: stepCount,
    turnOrder: state.turnOrder.map((p) => ids.indexOf(p)),
    territories: ids.map((p) => map.territoryIds.filter((t) => state.territories[t].owner === p).length),
    placement,
    kills,
    points,
    illegal,
    offList,
    ...(cfg.record ? { records } : {}),
  };
}
