import { applyAction, territoriesOf } from './engine.js';
import { RuleError } from './types.js';
import { getMap } from './maps.js';
import { boardFor, redactEvents, viewFor, type GameView } from './view.js';
import { stallOf } from './stall.js';
import type { Action, Card, GameEvent, GameOptions, GameState, Phase, PlayerId, TerritoryId, TerritoryState } from './types.js';

/**
 * Game records: everything that happened in one game, saved so it can be analysed, used for training and
 * replayed move for move. A record holds the full state right after the start (deck order and dice seed
 * included), so applying its steps in order with applyAction rebuilds every moment exactly.
 *
 * Under fog of war each step also keeps what the acting player could see when they chose it, and each turn
 * keeps what every living player could see when it began, next to the true board.
 *
 * Bump RECORD_VERSION for any change that breaks a reader; adding optional fields does not need one.
 */
export const RECORD_FORMAT = 'risky-game-record';
export const RECORD_VERSION = 1;

/** One territory: [owner, armies]. owner is an index into GameRecord.players, or -1 for nobody (blizzards). */
export type Cell = [owner: number, armies: number];
/** The whole board, one cell per territory in GameRecord.territories order. */
export type Board = Cell[];
/** The board as one player saw it under fog of war: null where the territory was hidden from them. */
export type SeenBoard = (Cell | null)[];

export interface RecordPlayer {
  index: number;
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  isNeutral: boolean;
  /** AI character this seat played as (e.g. "marvel/iron-man"), if any. */
  characterId: string | null;
}

/** Everything known when the game starts: written once, before any step. */
export interface RecordHeader {
  format: typeof RECORD_FORMAT;
  version: typeof RECORD_VERSION;
  /** Unique per game (room codes are reused once a room is gone). */
  id: string;
  /** board "training": a model-vs-model yardstick game, ranked on the training leaderboard, not the public one. */
  /** agents: each seat's self-declared player type, added when the game is filed (never while it is played). */
  room: { id: string; name: string; tournamentId?: string; board?: 'training'; agents?: Record<PlayerId, string> };
  map: GameOptions['map'];
  fog: boolean;
  options: GameOptions;
  seed: number;
  startedAt: number;
  /** Territory ids in board order: Board[i] is territories[i]. */
  territories: TerritoryId[];
  players: RecordPlayer[];
  /** The full state right after the start, and the start's events. Replays begin here. */
  start: { state: GameState; events: GameEvent[] };
  /** Set when this game is a scenario: it began from this moment of another recorded game (see scenarioState). */
  scenarioOf?: ScenarioRef;
}

/** A moment of a recorded game: the state just before step `step` of record `recordId`. */
export interface ScenarioRef {
  recordId: string;
  step: number;
}

/** One action by one player. */
export interface RecordStep {
  /** Position in GameRecord.steps (set when the record is assembled). */
  i: number;
  at: number;
  turn: number;
  round: number;
  /** Phase the action was taken in. */
  phase: Phase;
  player: PlayerId;
  action: Action;
  /** The true board just before the action. */
  board: Board;
  /** Fog of war only: the board as the acting player saw it just before the action. */
  seen?: SeenBoard;
  /** The acting player's cards just before the action. */
  hand: Card[];
  /** What the action caused, unredacted (dice, losses, conquests, eliminations...). */
  events: GameEvent[];
  /** The turn timer ran out: the server made this move for the player (see timeout.ts). Absent otherwise. */
  timeout?: true;
  /**
   * The acting player's own decision note for this move (`act` with `note`): a string or JSON, at most 2 KB. Never
   * shown during the game; optional, so records without it are unchanged.
   */
  note?: unknown;
}

/** The start of one player's turn. */
export interface RecordTurn {
  turn: number;
  round: number;
  player: PlayerId;
  at: number;
  /** Steps of this turn: GameRecord.steps[firstStep..lastStep] (-1 when the turn had none). Set on assembly. */
  firstStep: number;
  lastStep: number;
  /** Armies the player receives this turn, before cards. */
  reinforcements: number;
  /** The true board as the turn begins. */
  board: Board;
  /** Fog of war only: the board as each living player saw it as the turn began. */
  seen?: Record<PlayerId, SeenBoard>;
}

export interface RecordElimination {
  player: PlayerId;
  by: PlayerId | null;
  turn: number;
  step: number;
}

/** How a game that was stopped before its end was decided on standing (a nested tournament table at its round's end). */
export interface RecordDecision {
  /** Players from first to last as decided (rankByStanding: territories, then armies, then dice; then those out). */
  standing: PlayerId[];
  /** The tie-break dice each tied player rolled, by player (absent or empty when nobody was tied). */
  rolls?: Record<PlayerId, number[]>;
}

export interface RecordOutcome {
  /** The game reached its end in the engine. False for a game decided on standing (see `decided`). */
  finished: boolean;
  /** Set when the game was closed before anyone won (abandoned, swept, closed by its host), or decided on standing. */
  endedBecause?: string;
  winner: PlayerId | null;
  /**
   * 'standing': decided on standing (`decided`), not won on the board. 'stalemate': the engine ended a stalled game
   * (stallEnd) and decided it on standing itself; the winner is from its `stalemate` event. 'aborted': its tournament was
   * aborted (or deleted) while it was played: nobody won, `aborted` holds the standing so far.
   */
  reason: 'domination' | 'capitals' | 'standing' | 'stalemate' | 'aborted' | null;
  /** Set when the game was stopped and decided on standing: the order used. `winner` is its first, `placings` the order. */
  decided?: RecordDecision;
  /** Set when the game was stopped by its tournament's abort: the standing so far (`placings` follows it; no winner). */
  aborted?: RecordDecision;
  eliminations: RecordElimination[];
  /** Players from first to last (Neutral left out): the winner, the survivors by territories held, then the eliminated, last out first. */
  placings: PlayerId[];
  /** The true board at the end. */
  board: Board;
}

/** A note a seat's human coach sent during a quick-play game (live coach channel): private, kept for after the game. */
export interface RecordCoachNote {
  player: PlayerId;
  at: number;
  /** The game's state version when it was sent (the moves before it are the steps up to that version). */
  version: number;
  text: string;
}

export interface GameRecord extends RecordHeader {
  endedAt: number;
  steps: RecordStep[];
  turns: RecordTurn[];
  outcome: RecordOutcome;
  /** Live coach notes, by seat, in the order sent (quick play only). Optional: most games have none. */
  coach?: RecordCoachNote[];
}

/** A record's live journal entries, in the order they happened. */
export type RecordEntry = { kind: 'step'; step: Omit<RecordStep, 'i'> } | { kind: 'turn'; turn: Omit<RecordTurn, 'firstStep' | 'lastStep'> };

function cellsOf(territories: Record<TerritoryId, TerritoryState>, header: Pick<RecordHeader, 'territories' | 'players'>): SeenBoard {
  const index = new Map(header.players.map((p) => [p.id, p.index]));
  return header.territories.map((t) => {
    const ts = territories[t];
    if (!ts || ts.hidden) return null;
    return [ts.owner === null ? -1 : (index.get(ts.owner) ?? -1), ts.armies];
  });
}

/** The true board of a state. */
export function boardOf(state: GameState, header: Pick<RecordHeader, 'territories' | 'players'>): Board {
  return cellsOf(state.territories, header) as Board;
}

/** The board as one player sees it (the whole board when fog does not apply to them). */
export function seenBoardOf(state: GameState, viewer: PlayerId, header: Pick<RecordHeader, 'territories' | 'players'>): SeenBoard {
  return cellsOf(boardFor(state, viewer), header);
}

/** The header of a game that has just started. */
export function recordHeader(
  id: string,
  room: RecordHeader['room'],
  state: GameState,
  events: GameEvent[],
  characterIds: Record<PlayerId, string> = {},
  scenarioOf?: ScenarioRef,
): RecordHeader {
  if (state.phase === 'lobby' || state.startedAt === null) throw new Error('recordHeader: the game has not started');
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    id,
    room,
    map: state.options.map,
    fog: !!state.options.fogOfWar,
    options: state.options,
    seed: state.seed,
    startedAt: state.startedAt,
    territories: [...getMap(state.options.map).territoryIds],
    players: state.players.map((p, index) => ({
      index,
      id: p.id,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
      isNeutral: p.isNeutral,
      characterId: characterIds[p.id] ?? null,
    })),
    start: { state, events },
    ...(scenarioOf ? { scenarioOf } : {}),
  };
}

/** The journal entry for one action: `before` is the state it was taken in. */
export function recordStep(header: RecordHeader, before: GameState, player: PlayerId, action: Action, events: GameEvent[], at: number, extra: { note?: unknown; timeout?: boolean } = {}): RecordEntry {
  return {
    kind: 'step',
    step: {
      at,
      turn: before.turnNumber,
      round: before.round,
      phase: before.phase,
      player,
      action,
      board: boardOf(before, header),
      ...(header.fog ? { seen: seenBoardOf(before, player, header) } : {}),
      hand: before.players.find((p) => p.id === player)?.cards ?? [],
      events,
      ...(extra.timeout ? { timeout: true as const } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
    },
  };
}

/** The journal entry for a turn that these events started, if they started one. `state` is the state after them. */
export function recordTurnStart(header: RecordHeader, state: GameState, events: GameEvent[], at: number): RecordEntry | null {
  const started = [...events].reverse().find((e): e is Extract<GameEvent, { type: 'turn_started' }> => e.type === 'turn_started');
  if (!started) return null;
  const seen: Record<PlayerId, SeenBoard> = {};
  if (header.fog) for (const p of state.players) if (p.alive && !p.isNeutral) seen[p.id] = seenBoardOf(state, p.id, header);
  return {
    kind: 'turn',
    turn: {
      turn: started.turnNumber,
      round: started.round,
      player: started.player,
      at,
      reinforcements: started.reinforcements.total,
      board: boardOf(state, header),
      ...(header.fog ? { seen } : {}),
    },
  };
}

/** Put a record together from its header, its journal and the state it ended in. */
/** `decided`: the game was stopped and decided on standing (outcome reason 'standing', winner and placings from it). */
/** `aborted`: the game was stopped by its tournament's abort (outcome reason 'aborted', no winner, placings the standing so far). */
export function assembleRecord(header: RecordHeader, entries: RecordEntry[], final: GameState, endedAt: number, endedBecause?: string, decided?: RecordDecision, aborted?: RecordDecision): GameRecord {
  const steps: RecordStep[] = [];
  const turns: RecordTurn[] = [];
  for (const e of entries) {
    if (e.kind === 'step') steps.push({ i: steps.length, ...e.step });
    else turns.push({ ...e.turn, firstStep: -1, lastStep: -1 });
  }
  for (const t of turns) {
    const own = steps.filter((s) => s.turn === t.turn);
    t.firstStep = own[0]?.i ?? -1;
    t.lastStep = own.at(-1)?.i ?? -1;
  }
  const eliminations: RecordElimination[] = [];
  let over: Extract<GameEvent, { type: 'game_over' }> | undefined;
  for (const s of steps) {
    for (const e of s.events) {
      if (e.type === 'eliminated') eliminations.push({ player: e.player, by: e.by, turn: s.turn, step: s.i });
      if (e.type === 'game_over') over = e;
    }
  }
  const out = new Set(eliminations.map((e) => e.player));
  const survivors = final.players
    .filter((p) => !p.isNeutral && !out.has(p.id))
    .sort((a, b) => Number(b.id === final.winner) - Number(a.id === final.winner) || territoriesOf(final, b.id).length - territoriesOf(final, a.id).length)
    .map((p) => p.id);
  // Placings hold real seats only: a neutral can join mid-game (a surrender) and be eliminated too.
  const seats = new Set(final.players.filter((p) => !p.isNeutral).map((p) => p.id));
  const finished = final.phase === 'finished';
  const placings = [...survivors, ...eliminations.map((e) => e.player).reverse().filter((id) => seats.has(id))];
  // Decided on standing: the order used is the result (only for a game the engine did not finish itself).
  const standing = !finished && decided ? decided.standing.filter((id) => seats.has(id)) : null;
  // A stalemate (stall.ts, stallEnd): the engine finished the game on standing; its order is the result.
  const ended = finished ? stallOf(final)?.stalemate : undefined;
  const stalemate = ended ? { order: ended.standing.filter((id) => seats.has(id)), rolls: ended.rolls } : null;
  // Aborted with its tournament: the standing so far, and nobody won (only for a game the engine did not finish).
  const stopped = !finished && !standing && aborted ? aborted.standing.filter((id) => seats.has(id)) : null;
  if (stopped) {
    return {
      ...header,
      endedAt,
      steps,
      turns,
      outcome: {
        finished,
        endedBecause: endedBecause ?? 'its tournament was aborted',
        winner: null,
        reason: 'aborted',
        eliminations,
        placings: [...stopped, ...placings.filter((id) => !stopped.includes(id))],
        aborted: { standing: stopped, ...(aborted!.rolls && Object.keys(aborted!.rolls).length ? { rolls: aborted!.rolls } : {}) },
        board: boardOf(final, header),
      },
    };
  }
  return {
    ...header,
    endedAt,
    steps,
    turns,
    outcome: {
      finished,
      ...(finished ? {} : { endedBecause: endedBecause ?? (standing ? 'decided on standing' : 'closed before the end') }),
      winner: standing ? (standing[0] ?? null) : final.winner,
      reason: standing ? (standing.length ? 'standing' : null) : stalemate ? 'stalemate' : (over?.reason ?? (final.winner ? 'domination' : null)),
      eliminations,
      placings: standing ? [...standing, ...placings.filter((id) => !standing.includes(id))] : stalemate ? [...stalemate.order, ...placings.filter((id) => !stalemate.order.includes(id))] : placings,
      ...(standing ? { decided: { standing, ...(decided!.rolls && Object.keys(decided!.rolls).length ? { rolls: decided!.rolls } : {}) } } : {}),
      ...(stalemate ? { decided: { standing: stalemate.order, ...(Object.keys(stalemate.rolls).length ? { rolls: stalemate.rolls } : {}) } } : {}),
      board: boardOf(final, header),
    },
  };
}

/** The exact game state just before step `step` (record.steps.length = the state after the last step). */
export function stateAtStep(record: Pick<GameRecord, 'start' | 'steps'>, step: number): GameState {
  if (!Number.isInteger(step) || step < 0 || step > record.steps.length) throw new RangeError(`step must be 0..${record.steps.length}`);
  let state = structuredClone(record.start.state);
  for (const s of record.steps.slice(0, step)) state = applyAction(state, s.player, s.action).state;
  return state;
}

/**
 * Replay a record from the start and check every step reproduces the board it recorded. Returns the first
 * step that does not (or the end, when the final board differs), or null when the replay matches throughout.
 */
export function verifyRecord(record: GameRecord): { step: number; reason: string } | null {
  let state = structuredClone(record.start.state);
  for (const s of record.steps) {
    if (JSON.stringify(boardOf(state, record)) !== JSON.stringify(s.board)) return { step: s.i, reason: 'board before the step differs' };
    try {
      state = applyAction(state, s.player, s.action).state;
    } catch (err) {
      return { step: s.i, reason: `action rejected on replay: ${(err as Error).message}` };
    }
  }
  if (JSON.stringify(boardOf(state, record)) !== JSON.stringify(record.outcome.board)) return { step: record.steps.length, reason: 'final board differs' };
  return null;
}

/**
 * What one player (null = a spectator) saw just before step `step`: their view of the game (fog applied, their
 * legal moves included), plus that step's events as they were shown to them. A scenario is the same state with
 * every seat played out differently from here.
 */
export function observeStep(record: GameRecord, step: number, viewer: PlayerId | null): { view: GameView; events: GameEvent[] } {
  const before = stateAtStep(record, step);
  const s = record.steps[step];
  if (!s) return { view: viewFor(before, viewer), events: [] };
  const after = applyAction(before, s.player, s.action).state;
  return { view: viewFor(before, viewer), events: redactEvents(after, viewer, s.events) };
}

/** Who plays a seat in a scenario: a built-in bot, or a person or agent holding the seat's token. */
export type ScenarioSeat = 'bot' | 'open';

export interface ScenarioOptions {
  /** The new game's id (its room code). */
  id: string;
  /** When the new game starts. */
  at: number;
  /** A new dice seed, so the game plays out differently from the record. Omitted: the recorded dice are kept. */
  seed?: number;
  /** Per player id; every seat not listed is a bot. Eliminated players and the neutral army are left as they are. */
  seats?: Record<PlayerId, ScenarioSeat>;
}

/**
 * A new game that begins at one moment of a recorded game: the exact state just before step `step`, under a new
 * id and start time. Players keep their ids, names, colours, cards and armies; who plays each seat comes from
 * `seats` (bots by default). With a seed the dice differ from the record from here on; the deck's order is
 * part of the state and is kept either way.
 */
export function scenarioState(record: Pick<GameRecord, 'start' | 'steps'>, step: number, opts: ScenarioOptions): GameState {
  const state = stateAtStep(record, step);
  if (state.phase === 'finished' || state.phase === 'lobby') throw new RuleError('That moment is after the game was decided: pick an earlier step');
  const seats = opts.seats ?? {};
  for (const [id, seat] of Object.entries(seats)) {
    const p = state.players.find((x) => x.id === id);
    if (!p || p.isNeutral) throw new RuleError(`${id} is not a player in that game`);
    if (seat !== 'bot' && seat !== 'open') throw new RuleError(`A seat is "bot" or "open", not ${JSON.stringify(seat)}`);
  }
  return {
    ...state,
    id: opts.id,
    players: state.players.map((p) => (p.isNeutral ? p : { ...p, isBot: (seats[p.id] ?? 'bot') === 'bot' })),
    ...(opts.seed !== undefined ? { seed: opts.seed >>> 0, rngState: opts.seed >>> 0 } : {}),
    createdAt: opts.at,
    startedAt: opts.at,
    finishedAt: null,
  };
}
