import { RuleError, type GameEvent, type GameOptions, type GameState } from './types.js';

/**
 * Stall relievers: mechanics that move a stalled game on (everyone only reinforcing). Step 1 is the fog lift
 * (`stallFogLift`): after that many full rounds in a row with no territory captured by anyone, the fog of war lifts for
 * the rest of the game. Later steps (storms, then ending a game that still stalls) reuse the same counter.
 *
 * Kept out of the GPU-mirrored engine.ts on purpose: engine.ts only calls these. With every reliever off (the
 * default, as in self-play and GPU training) nothing here touches the state, so `stall` and `fogLifted` stay absent
 * and the state is bit-identical to a game without relievers.
 */

/** Whether any stall reliever is on for these options (the counter only runs then). */
export function stallRelieversOn(o: GameOptions): boolean {
  return !!o.fogOfWar && (o.stallFogLift ?? 0) > 0;
}

/** Full rounds in a row with no capture, as of now: rounds completed after the round of the last capture. */
export function stalledRounds(state: GameState): number {
  return state.round - 1 - (state.stall?.lastCaptureRound ?? 0);
}

/** A territory was captured: the stall count starts again (only while a reliever is on). */
export function noteCapture(state: GameState): void {
  if (!stallRelieversOn(state.options)) return;
  state.stall = { ...(state.stall ?? {}), lastCaptureRound: state.round };
}

/** A round just ended (state.round was advanced): any reliever whose count is reached kicks in, and is recorded. */
export function checkStall(state: GameState, events: GameEvent[]): void {
  if (!stallRelieversOn(state.options)) return;
  state.stall ??= { lastCaptureRound: 0 };
  const stalled = stalledRounds(state);
  const n = state.options.stallFogLift ?? 0;
  if (!state.fogLifted && n > 0 && stalled >= n) {
    state.fogLifted = true;
    state.stall.fogLiftedRound = state.round;
    events.push({ type: 'fog_lifted', rounds: stalled });
  }
}

/** Range checks for the stall options (validateOptions). */
export function validateStallOptions(o: GameOptions): void {
  const n = o.stallFogLift ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new RuleError('stallFogLift must be an integer between 0 and 20');
}
