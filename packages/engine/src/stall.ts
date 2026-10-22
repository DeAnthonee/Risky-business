import { rankByStanding } from './standing.js';
import { createRng, nextFloat } from './rng.js';
import { RuleError, type ActionResult, type GameEvent, type GameOptions, type GameState, type PlayerId, type TerritoryId } from './types.js';

/**
 * Stall relievers: mechanics that move a stalled game on (everyone only reinforcing). All share one counter: full
 * rounds in a row with no territory captured by anyone.
 * - Step 1, the fog lift (`stallFogLift`, fog games): after that many stalled rounds the fog of war lifts for good.
 * - Step 2, the storm (`stallStorm`, any game): from that many stalled rounds, at every round start, each player's
 *   stack of more than STORM_MIN armies loses STORM_SHARE of them, until someone captures.
 * - The end (`stallEnd`): that many more stalled rounds after the last enabled reliever came on, the game ends,
 *   decided on standing (rankByStanding, the rule tournaments use), as a stalemate (endInStalemate).
 *
 * Kept out of the GPU-mirrored engine.ts and types.ts on purpose: engine.ts only calls noteCapture, checkStall and
 * validateStallOptions, and the storm's and the end's options, state and events are declared here. The end is not
 * reached from engine.ts at all: the game server applies endInStalemate when stalemateDue (as it applies
 * endByStanding for Zergs), through its commit like any move. With every reliever off (the default, as in self-play and
 * GPU training) nothing here touches the state, so `stall` and `fogLifted` stay absent and the state is bit-identical to
 * a game without relievers.
 */

declare module './types.js' {
  interface GameOptions {
    /** Stall reliever step 2 (any game): from this many stalled rounds, a storm wears down big stacks (0 or absent = off). */
    stallStorm?: number;
    /**
     * The stall relievers' end: this many more stalled rounds after the last enabled reliever came on, the game ends
     * decided on standing, as a stalemate (0 or absent = off).
     */
    stallEnd?: number;
  }
}

/** The storm hits each player's territory holding more than this many armies ... */
export const STORM_MIN = 10;
/** ... and each loses this share of them, rounded down: at least 2 there, and never the last (at least 8 stay). */
export const STORM_SHARE = 0.2;

/** `state.stall` as the relievers keep it (types.ts declares the step-1 fields; the rest live here). */
export interface StallState {
  lastCaptureRound: number;
  fogLiftedRound?: number;
  /** The round the storm first hit in the current stall (cleared by a capture). */
  stormRound?: number;
  /** Set when the game ended in a stalemate: the standing it was decided on, and the tie-break dice. */
  stalemate?: { round: number; standing: PlayerId[]; rolls: Record<PlayerId, number[]> };
}

/** The storm (stallStorm): `rounds` stalled rounds; each territory listed lost that many armies. */
export interface StormEvent {
  type: 'storm';
  rounds: number;
  losses: Record<TerritoryId, number>;
}
/** The relievers' end (stallEnd): the game ends on standing; a `game_over` with reason `stalemate` follows. */
export interface StalemateEvent {
  type: 'stalemate';
  rounds: number;
  standing: PlayerId[];
  rolls: Record<PlayerId, number[]>;
}
/** The events the stall relievers add past types.ts's GameEvent (which keeps fog_lifted). */
export type StallEvent = StormEvent | StalemateEvent | { type: 'game_over'; winner: PlayerId; reason: 'stalemate' };
/** Any event a game can emit, the relievers' included: switch on this to handle them. */
export type AnyGameEvent = GameEvent | StallEvent;

/** The relievers' state (`state.stall`), with this file's fields; undefined while every reliever is off. */
export function stallOf(state: GameState): StallState | undefined {
  return state.stall as StallState | undefined;
}

/** Whether any stall reliever is on for these options (the counter only runs then). */
export function stallRelieversOn(o: GameOptions): boolean {
  return (!!o.fogOfWar && (o.stallFogLift ?? 0) > 0) || (o.stallStorm ?? 0) > 0 || (o.stallEnd ?? 0) > 0;
}

/** Full rounds in a row with no capture, as of now: rounds completed after the round of the last capture. */
export function stalledRounds(state: GameState): number {
  return state.round - 1 - (state.stall?.lastCaptureRound ?? 0);
}

/** A territory was captured: the stall count starts again (only while a reliever is on), and the storm stops. */
export function noteCapture(state: GameState): void {
  if (!stallRelieversOn(state.options)) return;
  const { stormRound: _, ...rest } = stallOf(state) ?? { lastCaptureRound: 0 };
  state.stall = { ...rest, lastCaptureRound: state.round };
}

/** A round just ended (state.round was advanced): any reliever whose count is reached kicks in, and is recorded. */
export function checkStall(state: GameState, events: GameEvent[]): void {
  if (!stallRelieversOn(state.options)) return;
  state.stall ??= { lastCaptureRound: 0 };
  const stall = stallOf(state)!;
  const stalled = stalledRounds(state);
  const n = state.options.stallFogLift ?? 0;
  if (state.options.fogOfWar && !state.fogLifted && n > 0 && stalled >= n) {
    state.fogLifted = true;
    stall.fogLiftedRound = state.round;
    events.push({ type: 'fog_lifted', rounds: stalled });
  }
  const storm = state.options.stallStorm ?? 0;
  if (storm > 0 && stalled >= storm) {
    stall.stormRound ??= state.round;
    (events as AnyGameEvent[]).push({ type: 'storm', rounds: stalled, losses: stormLosses(state) });
  }
}

/** The storm: every player's territory over STORM_MIN armies loses STORM_SHARE of them (rounded down). */
function stormLosses(state: GameState): Record<TerritoryId, number> {
  const neutral = new Set(state.players.filter((p) => p.isNeutral).map((p) => p.id));
  const losses: Record<TerritoryId, number> = {};
  for (const [id, t] of Object.entries(state.territories)) {
    if (t.owner === null || neutral.has(t.owner) || t.armies <= STORM_MIN) continue;
    const lost = Math.floor(t.armies * STORM_SHARE);
    t.armies -= lost;
    losses[id] = lost;
  }
  return losses;
}

/**
 * The stalled-round count the game ends at: stallEnd after the last enabled reliever comes on (the fog lift counts
 * only in a fog game; with no other reliever, stallEnd from the stall's start). null when stallEnd is off.
 */
export function stalemateRound(o: GameOptions): number | null {
  const end = o.stallEnd ?? 0;
  if (end <= 0) return null;
  const fog = o.fogOfWar ? (o.stallFogLift ?? 0) : 0;
  return Math.max(fog, o.stallStorm ?? 0) + end;
}

/** The game is still on and has stalled long enough to end (stallEnd), between moves (no conquest being occupied). */
export function stalemateDue(state: GameState): boolean {
  const at = stalemateRound(state.options);
  if (at === null || state.phase === 'lobby' || state.phase === 'setup' || state.phase === 'finished' || state.pendingConquest) return false;
  return stalledRounds(state) >= at;
}

/**
 * End a stalled game on standing (rankByStanding: territories, then armies, then dice), the dice drawn from the game's
 * own seeded rng so the same game always ends the same way. Pure: returns the finished state (a winner, no current
 * player, `stall.stalemate` with the standing) and the `stalemate` and `game_over` (reason `stalemate`) events.
 * `eliminated`: the order players went out in, earliest first (the server keeps it), for the players already out.
 */
export function endInStalemate(state: GameState, eliminated: readonly PlayerId[] = [], at = Date.now()): ActionResult {
  if (!stalemateDue(state)) throw new RuleError('This game has not stalled long enough to end');
  const rng = createRng(state.rngState);
  const standing = rankByStanding(state, () => nextFloat(rng), eliminated);
  const rounds = stalledRounds(state);
  const stall: StallState = { ...(stallOf(state) ?? { lastCaptureRound: 0 }), stalemate: { round: state.round, standing: standing.order, rolls: standing.rolls } };
  const events: AnyGameEvent[] = [
    { type: 'stalemate', rounds, standing: standing.order, rolls: standing.rolls },
    { type: 'game_over', winner: standing.order[0], reason: 'stalemate' },
  ];
  return {
    state: { ...state, phase: 'finished', winner: standing.order[0], currentPlayer: null, finishedAt: at, rngState: rng.state, stall, version: state.version + 1 },
    events: events as GameEvent[],
  };
}

/** Range checks for the stall options (validateOptions). */
export function validateStallOptions(o: GameOptions): void {
  for (const key of ['stallFogLift', 'stallStorm', 'stallEnd'] as const) {
    const n = o[key] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new RuleError(`${key} must be an integer between 0 and 20`);
  }
}
