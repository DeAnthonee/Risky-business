import { getMap, NEUTRAL_ID, type GameState, type PlayerId } from '@risk/engine';
import { MAX_SLOTS } from '@risk/selfplay';

/**
 * The mega-table adapter (owner, 2026-10-28: Deloves play the 100-player mega tournament now, a retrain may come
 * later). Delove's network has MAX_SLOTS (10) seat slots, so at a bigger table each decision sees a focused view: the
 * decider and its MAX_SLOTS - 1 most relevant opponents, and everyone else's land as neutral (armies kept), with the
 * turn order holding only the seats kept. Relevant = most armies on territories bordering the decider's, then most
 * territories, then seat order. A view only: the engine still plays the real game; the candidates are territory moves
 * and do not change. At MAX_SLOTS players or fewer the state comes back as it is.
 */
export function focusView(state: GameState, me: PlayerId): GameState {
  const others = state.players.filter((p) => !p.isNeutral && p.alive && p.id !== me);
  if (others.length + 1 <= MAX_SLOTS) return state;
  const map = getMap(state.options.map);
  const threat = new Map<PlayerId, number>();
  const size = new Map<PlayerId, number>();
  for (const t of map.territoryIds) {
    const { owner, armies } = state.territories[t];
    if (!owner || owner === me || owner === NEUTRAL_ID) continue;
    size.set(owner, (size.get(owner) ?? 0) + 1);
    if (map.adjacency[t].some((n) => state.territories[n].owner === me)) threat.set(owner, (threat.get(owner) ?? 0) + armies);
  }
  const seat = new Map(state.players.map((p, i) => [p.id, i]));
  const kept = new Set<PlayerId>([
    me,
    ...others
      .slice()
      .sort((a, b) => (threat.get(b.id) ?? 0) - (threat.get(a.id) ?? 0) || (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) || seat.get(a.id)! - seat.get(b.id)!)
      .slice(0, MAX_SLOTS - 1)
      .map((p) => p.id),
  ]);
  const territories = { ...state.territories };
  for (const t of map.territoryIds) {
    const o = territories[t].owner;
    if (o && o !== NEUTRAL_ID && !kept.has(o)) territories[t] = { ...territories[t], owner: NEUTRAL_ID };
  }
  return { ...state, territories, turnOrder: state.turnOrder.filter((id) => kept.has(id)) };
}

/** The seats a focused view keeps, in seating order (the network's seat list). */
export function focusSeats(view: GameState, seats: readonly string[]): string[] {
  const kept = new Set(view.turnOrder);
  return seats.filter((id) => kept.has(id));
}
