import {
  addPlayer,
  applyAction,
  createGame,
  getMap,
  legalMoves,
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
import { mixSeed, seededRandom } from './seed.js';
import { makeTraits, type Traits } from './traits.js';

export interface Seat {
  agent: Agent;
  traits?: Partial<Traits>;
}

export interface GameConfig {
  seed: number;
  seats: Seat[];
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

  let state: GameState = createGame(id, { maxPlayers: n, ...cfg.options }, cfg.seed);
  cfg.seats.forEach((s, i) => (state = addPlayer(state, ids[i], s.agent.id, true)));
  state = startGame(state).state;
  const map = getMap(state.options.map);

  const records: DecisionRecord[] = [];
  const illegal = new Array<number>(n).fill(0);
  const offList = new Array<number>(n).fill(0);
  let decisions = 0;
  let stepCount = 0;
  let turnDecisions = 0;
  let lastTurn = state.turnNumber;
  let reason: Outcome['reason'] = 'turn_limit';

  while (state.phase !== 'finished' && state.turnNumber < maxTurns) {
    const me = state.currentPlayer!;
    const seat = ids.indexOf(me);
    const legal = legalMoves(state, me);
    const cands = candidates(state, me, legal);
    const agent = cfg.seats[seat].agent;
    const action: Action = agent.choose({ state, me, seat, legal, candidates: cands, traits: traits[seat], random: randoms[seat] }) ?? { type: 'surrender' };
    const steps = actionSteps(state, me, legal, action, cands);
    stepCount += steps.length;
    if (steps[steps.length - 1].choice < 0) offList[seat]++;
    if (cfg.record) {
      for (const step of steps) {
        records.push({
          v: LOG_VERSION,
          game: id,
          seed: cfg.seed,
          i: records.length,
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
    const over = events.find((e) => e.type === 'game_over');
    if (over && over.type === 'game_over') reason = over.reason ?? 'domination';

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
  for (const r of records) r.outcome = { winner, z: z(r.seat), turns: state.turnNumber, reason };

  return {
    id,
    seed: cfg.seed,
    map: map.id,
    agents: cfg.seats.map((s) => s.agent.id),
    winner,
    reason: winner === null ? 'turn_limit' : reason,
    turns: state.turnNumber,
    rounds: state.round,
    decisions,
    steps: stepCount,
    turnOrder: state.turnOrder.map((p) => ids.indexOf(p)),
    territories: ids.map((p) => map.territoryIds.filter((t) => state.territories[t].owner === p).length),
    illegal,
    offList,
    ...(cfg.record ? { records } : {}),
  };
}
