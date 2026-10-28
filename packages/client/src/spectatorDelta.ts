import type { GameView } from '@risk/engine';

/**
 * A compact spectator frame's patch (server spectator-delta.ts): top-level keys to set or drop, the territories that
 * changed and the players that changed (by index). Kept free of DOM code: the server test applies it too.
 */
export interface ViewPatch {
  set?: Record<string, unknown>;
  drop?: string[];
  territories?: Record<string, unknown>;
  players?: Record<string, unknown>;
}

/** The view after `patch`, as a new object: what did not change is shared with `view` (never mutated). */
export function applyViewPatch(view: GameView, patch: ViewPatch): GameView {
  const next: Record<string, unknown> = { ...view, ...patch.set };
  for (const k of patch.drop ?? []) delete next[k];
  if (patch.territories) next.territories = { ...(next.territories as object), ...patch.territories };
  if (patch.players) {
    const changed = patch.players;
    next.players = (next.players as unknown[]).map((p, i) => (String(i) in changed ? changed[String(i)] : p));
  }
  return next as unknown as GameView;
}
