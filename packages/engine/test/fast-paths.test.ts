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
  boardStats,
  viewFor,
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

  it('a view from shared board stats is the view worked out alone, for every seat, fog or not', { timeout: 60_000 }, () => {
    // Mega Earth has layered bonus zones, which views list per player too.
    for (const [fogOfWar, map] of [[false, undefined], [true, undefined], [false, 'mega_earth'], [true, 'mega_earth']] as const) {
      let s = createGame('g', { maxPlayers: 4, capitals: true, blizzards: 4, fogOfWar, ...(map ? { map } : {}) }, 9);
      for (let i = 0; i < 4; i++) s = addPlayer(s, `p${i}`, `P${i}`, true);
      s = startGame(s).state;
      // Hand P0 a whole bonus zone, so the views have real zone lists to compare from the start.
      if (map) for (const t of getMap(map).zones[0].territories) s.territories[t] = { ...s.territories[t], owner: 'p0' };
      const rng = createRng(9);
      let zonesHeld = 0;
      for (let step = 0; step < (map ? 40 : 150) && s.phase !== 'finished'; step++) {
        const stats = boardStats(s);
        zonesHeld = Math.max(zonesHeld, ...viewFor(s, null, stats).players.map((p) => p.zones?.length ?? 0));
        for (const viewer of [null, ...s.players.map((p) => p.id)]) expect(viewFor(s, viewer, stats)).toEqual(viewFor(s, viewer));
        const me = s.currentPlayer!;
        s = applyAction(s, me, chooseBotAction(s, me, () => nextFloat(rng)) ?? { type: 'end_turn' }).state;
      }
      // On Mega Earth the views compared real zone lists, not only empty ones.
      if (map) expect(zonesHeld).toBeGreaterThan(0);
    }
  });
});
