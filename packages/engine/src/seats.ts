import { RuleError, type GameState, type PlayerId } from './types.js';

/**
 * Rename a seat in a game in progress: a stand-in that takes over a dropped seat plays as "<name>-bot" or
 * "<name>-Delove" (the server's disconnect takeover). Not a rule of play: the board and turn order are unchanged.
 * Pure: returns a new state with the version bumped. Kept out of the GPU-mirrored engine.ts.
 */
export function renameStandIn(state: GameState, id: PlayerId, name: string): GameState {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new RuleError('Unknown player');
  if (p.isNeutral) throw new RuleError("The neutral army is nobody's seat");
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!clean) throw new RuleError('A name is required');
  if (p.name === clean) return state;
  const next = structuredClone(state);
  next.players.find((x) => x.id === id)!.name = clean;
  next.version++;
  return next;
}
