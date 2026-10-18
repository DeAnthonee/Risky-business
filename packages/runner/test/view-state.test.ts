import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, chooseBotAction, createGame, createRng, nextFloat, startGame, viewFor, type Action, type GameState } from '@risk/engine';
import { chooseMove, stateFromView } from '../src/view-state.js';

const seeded = (seed: number) => {
  const rng = createRng(seed);
  return () => nextFloat(rng);
};

function play(seed: number, players: number, check: (state: GameState, me: string, n: number) => void, maxDecisions = 4000) {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  let state = createGame(`T${seed}`, { maxPlayers: players, map: 'classic', fogOfWar: false }, seed);
  ids.forEach((id) => (state = addPlayer(state, id, id, true)));
  state = startGame(state).state;
  const rnd = seeded(seed ^ 0xabc);
  let n = 0;
  while (state.phase !== 'finished' && n < maxDecisions) {
    const me = state.currentPlayer!;
    check(state, me, n);
    const action = chooseBotAction(state, me, rnd) as Action;
    state = applyAction(state, me, action).state;
    n++;
  }
  return n;
}

describe('stateFromView', () => {
  it('lets the engine bot choose exactly what it would with the full state', () => {
    let compared = 0;
    for (const seed of [1, 2, 3]) {
      play(seed, 3 + (seed % 3), (state, me, n) => {
        const view = viewFor(state, me);
        const a = chooseBotAction(stateFromView(view), me, seeded(n + seed * 7919));
        const b = chooseBotAction(state, me, seeded(n + seed * 7919));
        expect(a).toEqual(b);
        compared++;
      });
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('drops view-only fields and blanks hidden hands', () => {
    let state = createGame('X', { maxPlayers: 2 }, 5);
    state = addPlayer(addPlayer(state, 'a', 'A', true), 'b', 'B', true);
    state = startGame(state).state;
    const s = stateFromView(viewFor(state, 'a')) as unknown as Record<string, unknown>;
    for (const k of ['you', 'legal', 'continentOwners', 'deckSize', 'discardSize']) expect(s).not.toHaveProperty(k);
    expect(s.deck).toEqual([]);
    expect(s.seed).toBe(0);
    expect((s.players as { cards: unknown; cardCount?: unknown }[]).every((p) => Array.isArray(p.cards) && !('cardCount' in p))).toBe(true);
  });

  it('never sends end_turn during setup', () => {
    let state = createGame('Y', { maxPlayers: 2, randomDeal: false }, 9);
    state = addPlayer(addPlayer(state, 'a', 'A', true), 'b', 'B', true);
    state = startGame(state).state;
    const me = state.currentPlayer!;
    const action = chooseMove(viewFor(state, me), me, seeded(1));
    expect(action?.type).not.toBe('end_turn');
  });
});
