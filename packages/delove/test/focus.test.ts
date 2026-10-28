import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { addPlayer, applyAction, createGame, getMap, legalMoves, NEUTRAL_ID, startGame, type GameState } from '@risk/engine';
import { candidates, encodeDecision, MAX_SLOTS, seatInput, makeTraits } from '@risk/selfplay';
import { focusSeats, focusView } from '../src/focus.js';
import { netAgent, seatOrder } from '../src/net-agent.js';

const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));

/** A started mega table: `n` seats on Mega Earth. */
function mega(n: number): GameState {
  let s = createGame('M', { map: 'mega_earth', maxPlayers: n, autoSetup: true });
  for (let i = 0; i < n; i++) s = addPlayer(s, `p${i}`, `P${i}`);
  return startGame(s).state;
}

describe('focusView: Delove at a table bigger than its seat slots', () => {
  it('keeps the decider and its 9 most relevant opponents; the rest reads as neutral; the encoder takes it', () => {
    const s = mega(100);
    const me = s.currentPlayer!;
    const view = focusView(s, me);
    expect(view.turnOrder).toHaveLength(MAX_SLOTS);
    expect(view.turnOrder).toContain(me);
    const kept = new Set(view.turnOrder);
    const map = getMap('mega_earth');
    // Every opponent bordering me with the most armies there is kept before anyone who does not border me.
    const borders = new Set(map.territoryIds.filter((t) => s.territories[t].owner === me).flatMap((t) => map.adjacency[t]).map((t) => s.territories[t].owner));
    borders.delete(me);
    if (borders.size <= MAX_SLOTS - 1) for (const b of borders) expect(kept.has(b!)).toBe(true);
    for (const t of map.territoryIds) {
      const o = s.territories[t].owner!;
      expect(view.territories[t].owner).toBe(kept.has(o) ? o : NEUTRAL_ID);
      expect(view.territories[t].armies).toBe(s.territories[t].armies);
    }
    const seats = focusSeats(view, seatOrder(s));
    expect(seats).toHaveLength(MAX_SLOTS);
    const f = encodeDecision(seatInput(view, seats, me, makeTraits(), candidates(s, me, legalMoves(s, me)), -1));
    expect(f.territories).toBe(map.territoryIds.length);
    // The real state, unfocused, does not fit the network.
    expect(() => encodeDecision(seatInput(s, seatOrder(s), me, makeTraits(), candidates(s, me, legalMoves(s, me)), -1))).toThrow();
  });

  it('a Delove network plays its moves at a 100-seat mega table', () => {
    const agent = netAgent('tiny@1', TINY);
    let s = mega(100);
    const me = s.currentPlayer!;
    const t0 = Date.now();
    let moves = 0;
    while (s.currentPlayer === me && moves < 12) {
      const legal = legalMoves(s, me);
      const cands = candidates(s, me, legal);
      const action = agent.choose({ state: s, me, seat: seatOrder(s).indexOf(me), legal, candidates: cands, traits: makeTraits(), random: () => 0.5 });
      if (!action) break;
      s = applyAction(s, me, action).state;
      moves++;
    }
    console.log(`mega Delove: ${moves} moves in ${Date.now() - t0} ms`);
    expect(moves).toBeGreaterThan(0);
  });

  it('leaves a table of 10 or fewer as it is', () => {
    const s = mega(10);
    expect(focusView(s, s.currentPlayer!)).toBe(s);
  });
});
