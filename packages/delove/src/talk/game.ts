import {
  addPlayer,
  applyAction,
  createGame,
  endByStanding,
  onlySideLeft,
  RuleError,
  startGame,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
  type PlayerId,
  type RandomSource,
} from '@risk/engine';
import { mixSeed, seededRandom } from '@risk/selfplay';
import { visibleTo, type MessageKind, type TalkMessage } from './vocab.js';

/**
 * Talking tables for the learned Zerg (docs/zergs.md §7): a self-play loop with table chat. It is separate from
 * packages/selfplay/src/game.ts, which is mirrored on the GPU and stays untouched.
 *
 * Each seat has a role the seat itself knows and nobody else is told: `zerg`, `impostor` (a non-Zerg rewarded for
 * being taken for a Zerg) or `plain`. At the first decision of each of its turns a seat may say one message
 * (vocab.ts). Every seat sees the public messages and the whispers it sent or received, plus the public board and
 * every battle (who attacked whom, losses). Nothing else: no role labels, no ally list.
 *
 * Endgame, rule-based (owner): when only true Zergs are left the game ends by standing (engine `endByStanding`; the
 * strongest Zerg wins). Deterministic from the seed: everything random comes from seeded sources and the end time is 0.
 */
export type Role = 'zerg' | 'impostor' | 'plain';

/** One battle as every seat saw it (the board is public, fog of war is not used at talking tables yet). */
export interface BattleRecord {
  attacker: PlayerId;
  defender: PlayerId;
  attackerLosses: number;
  defenderLosses: number;
  turn: number;
  round: number;
}

export interface TalkView {
  state: GameState;
  me: PlayerId;
  seat: number;
  random: RandomSource;
  /** Messages this seat can see. */
  chat: TalkMessage[];
  battles: readonly BattleRecord[];
}

export interface Speech {
  kind: MessageKind;
  about?: PlayerId;
  to?: PlayerId;
}

/** A seat's player. One instance per seat per game, so it may keep state (beliefs). */
export interface TalkAgent {
  id: string;
  speak?(view: TalkView): Speech | null;
  act(view: TalkView): Action | null;
}

export interface TalkSeat {
  role: Role;
  /** Build the seat's agent for one game. */
  make(me: PlayerId): TalkAgent;
}

export interface TalkGameConfig {
  seed: number;
  seats: TalkSeat[];
  options?: Partial<GameOptions>;
  maxTurns?: number;
}

export interface TalkGameResult {
  seed: number;
  ids: PlayerId[];
  roles: Role[];
  agents: string[];
  /** Winning seat, or null at the turn limit. */
  winner: number | null;
  turns: number;
  rounds: number;
  turnLimit: boolean;
  /** Seats in the order they went out (earliest first), with the round they went out in. */
  eliminated: { seat: number; round: number }[];
  chat: TalkMessage[];
  battles: (BattleRecord & { preyAlive: boolean })[];
}

const MAX_DECISIONS = 60_000;

export function playTalkGame(cfg: TalkGameConfig): TalkGameResult {
  const ids = cfg.seats.map((_, i) => `s${i}`);
  const roles = cfg.seats.map((s) => s.role);
  const zergs = new Set(ids.filter((_, i) => roles[i] === 'zerg'));
  const maxTurns = cfg.maxTurns ?? 300;
  let state = createGame(`t${cfg.seed.toString(16)}`, { maxPlayers: ids.length, ...cfg.options }, cfg.seed);
  for (const id of ids) state = addPlayer(state, id, id, true);
  state = startGame(state).state;
  const agents = cfg.seats.map((s, i) => s.make(ids[i]));
  const randoms = ids.map((_, i) => seededRandom(mixSeed(cfg.seed, 0x7a1c + i)));
  const chat: TalkMessage[] = [];
  const battles: TalkGameResult['battles'] = [];
  const eliminated: TalkGameResult['eliminated'] = [];
  let spokenTurn = -1;

  for (let d = 0; d < MAX_DECISIONS && state.phase !== 'finished' && state.turnNumber < maxTurns; d++) {
    const me = state.currentPlayer!;
    const seat = ids.indexOf(me);
    const agent = agents[seat];
    const view = (): TalkView => ({ state, me, seat, random: randoms[seat], chat: visibleTo(chat, me), battles });

    // One message at the first decision of each of the seat's turns (not during setup).
    if (state.turnNumber !== spokenTurn && state.phase !== 'setup' && state.phase !== 'capitals') {
      spokenTurn = state.turnNumber;
      const said = agent.speak?.(view()) ?? null;
      if (said && said.about !== me && (said.to === undefined || (said.to !== me && ids.includes(said.to)))) {
        chat.push({ from: me, ...said, turn: state.turnNumber, round: state.round });
      }
    }

    let events: GameEvent[];
    // Read before the move: a battle that knocks out the last prey still happened while prey was alive.
    const preyAlive = state.players.some((p) => p.alive && !p.isNeutral && !zergs.has(p.id));
    const action = agent.act(view()) ?? { type: 'surrender' as const };
    try {
      ({ state, events } = applyAction(state, me, action));
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      ({ state, events } = applyAction(state, me, { type: 'surrender' }));
    }
    for (const e of events) {
      if (e.type === 'battle') {
        battles.push({ attacker: e.attacker, defender: e.defender, attackerLosses: e.attackerLosses, defenderLosses: e.defenderLosses, turn: state.turnNumber, round: state.round, preyAlive });
      }
      if (e.type === 'eliminated') eliminated.push({ seat: ids.indexOf(e.player), round: state.round });
    }
    // Only true Zergs left: the game ends by standing, as on live tables (owner's rule).
    if (zergs.size > 0 && onlySideLeft(state, zergs)) state = endByStanding(state, zergs, 0).state;
  }

  return {
    seed: cfg.seed,
    ids,
    roles,
    agents: agents.map((a) => a.id),
    winner: state.winner === null ? null : ids.indexOf(state.winner),
    turns: state.turnNumber,
    rounds: state.round,
    turnLimit: state.phase !== 'finished',
    eliminated,
    chat,
    battles,
  };
}
