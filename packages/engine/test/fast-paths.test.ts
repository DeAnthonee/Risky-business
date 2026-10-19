import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  chooseBotAction,
  connectedTerritories,
  createGame,
  createRng,
  getMap,
  legalMoves,
  nextFloat,
  startGame,
  territoriesOf,
  type GameOptions,
  type GameState,
} from '../src/index.js';

// The engine's speed paths (the state copy in applyAction, the connected-territory search behind legalMoves) must
// behave exactly like the plain versions they replaced: structuredClone, and one connectedTerritories per source.

function objects(x: unknown, out = new Set<object>()): Set<object> {
  if (typeof x === 'object' && x !== null) {
    out.add(x);
    for (const v of Object.values(x)) objects(v, out);
  }
  return out;
}

function referenceFortifies(state: GameState, me: string) {
  if (state.fortifiedThisTurn) return [];
  const map = getMap(state.options.map);
  const out: { from: string; to: string; maxArmies: number }[] = [];
  for (const t of territoriesOf(state, me)) {
    const armies = state.territories[t].armies;
    if (armies < 2) continue;
    const targets =
      state.options.fortifyMode === 'adjacent' ? map.adjacency[t].filter((n) => state.territories[n].owner === me) : [...connectedTerritories(state, me, t)];
    for (const n of targets) out.push({ from: t, to: n, maxArmies: armies - 1 });
  }
  return out;
}

function playChecked(players: number, options: Partial<GameOptions>, seed: number) {
  let s = createGame('g', { maxPlayers: players, ...options }, seed);
  for (let i = 0; i < players; i++) s = addPlayer(s, `p${i}`, `P${i}`, true);
  s = startGame(s).state;
  const rng = createRng(seed);
  const random = () => nextFloat(rng);
  let steps = 0;
  while (s.phase !== 'finished' && steps < 400) {
    const me = s.currentPlayer!;
    const lm = legalMoves(s, me);
    if (lm.canEndTurn) expect(lm.fortifies).toEqual(referenceFortifies(s, me));
    const action = chooseBotAction(s, me, random) ?? { type: 'end_turn' };
    const before = structuredClone(s);
    const next = applyAction(s, me, action).state;
    // The input is untouched, the result shares no object with it, and it copies like structuredClone.
    expect(s).toEqual(before);
    const old = objects(s);
    expect([...objects(next)].filter((o) => old.has(o))).toEqual([]);
    expect(structuredClone(next)).toEqual(next);
    s = next;
    steps++;
  }
  return steps;
}

describe('engine speed paths', () => {
  it('match the plain implementations over 400 moves of bot games', { timeout: 60_000 }, () => {
    expect(playChecked(2, {}, 3)).toBeGreaterThan(50);
    expect(playChecked(4, { capitals: true, blizzards: 5 }, 4)).toBeGreaterThan(50);
    expect(playChecked(3, { map: 'skirmish', fortifyMode: 'adjacent', cardValues: 'fixed' }, 5)).toBeGreaterThan(50);
    expect(playChecked(5, { map: 'world', neutrals: 6 }, 6)).toBeGreaterThan(50);
  });
});
