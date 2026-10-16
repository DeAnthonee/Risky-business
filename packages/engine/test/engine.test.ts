import { describe, expect, it } from 'vitest';
import {
  ADJACENCY,
  CONTINENTS,
  EDGE_LIST,
  NEUTRAL_ID,
  RuleError,
  TERRITORY_IDS,
  addPlayer,
  applyAction,
  createGame,
  findSets,
  isValidSet,
  legalMoves,
  setOptions,
  startGame,
  territoriesOf,
  tradeBonus,
  viewFor,
  type GameState,
  type GameEvent,
} from '../src/index.js';

describe('map', () => {
  it('has 42 territories in 6 continents', () => {
    expect(TERRITORY_IDS).toHaveLength(42);
    expect(CONTINENTS).toHaveLength(6);
    expect(CONTINENTS.reduce((n, c) => n + c.territories.length, 0)).toBe(42);
    expect(CONTINENTS.find((c) => c.id === 'asia')!.territories).toHaveLength(12);
    expect(CONTINENTS.find((c) => c.id === 'north_america')!.territories).toHaveLength(9);
  });
  it('adjacency is symmetric and every territory has neighbours', () => {
    for (const t of TERRITORY_IDS) {
      expect(ADJACENCY[t].length).toBeGreaterThan(0);
      for (const n of ADJACENCY[t]) expect(ADJACENCY[n]).toContain(t);
    }
    expect(EDGE_LIST).toHaveLength(83);
    expect(ADJACENCY.alaska).toContain('kamchatka');
  });
});

describe('cards', () => {
  it('validates sets', () => {
    const c = (id: number, kind: any) => ({ id, kind, territory: null });
    expect(isValidSet([c(1, 'infantry'), c(2, 'infantry'), c(3, 'infantry')])).toBe(true);
    expect(isValidSet([c(1, 'infantry'), c(2, 'cavalry'), c(3, 'artillery')])).toBe(true);
    expect(isValidSet([c(1, 'infantry'), c(2, 'cavalry'), c(3, 'wild')])).toBe(true);
    expect(isValidSet([c(1, 'infantry'), c(2, 'infantry'), c(3, 'cavalry')])).toBe(false);
    expect(findSets([c(1, 'infantry'), c(2, 'infantry'), c(3, 'cavalry'), c(4, 'wild')])).toHaveLength(3);
  });
  it('escalates trade bonus', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(tradeBonus)).toEqual([4, 6, 8, 10, 12, 15, 20, 25]);
  });
});

function setup(n: number, opts = {}, seed = 42) {
  let s = createGame('g', opts, seed);
  for (let i = 0; i < n; i++) s = addPlayer(s, `p${i}`, `Player ${i}`);
  return startGame(s);
}

function finishSetup(s: GameState): GameState {
  let guard = 0;
  while (s.phase === 'setup') {
    const me = s.currentPlayer!;
    const lm = legalMoves(s, me);
    const t = lm.canPlaceOn[0];
    s = applyAction(s, me, { type: 'place', placements: { [t]: lm.placeLimit } }).state;
    if (++guard > 1000) throw new Error('setup did not finish');
  }
  return s;
}

describe('setup', () => {
  it('deals territories and starting armies for 3 players', () => {
    const { state } = setup(3);
    expect(state.phase).toBe('setup');
    expect(state.players).toHaveLength(3);
    for (const p of state.players) {
      expect(territoriesOf(state, p.id)).toHaveLength(14);
      expect(p.armiesToPlace).toBe(35 - 14);
    }
  });
  it('adds a neutral player for 2 players and distributes its armies', () => {
    const { state } = setup(2);
    const neutral = state.players.find((p) => p.isNeutral)!;
    expect(neutral.id).toBe(NEUTRAL_ID);
    expect(neutral.armiesToPlace).toBe(0);
    expect(territoriesOf(state, neutral.id)).toHaveLength(14);
    const neutralArmies = territoriesOf(state, neutral.id).reduce((n, t) => n + state.territories[t].armies, 0);
    expect(neutralArmies).toBe(40);
    expect(state.turnOrder).not.toContain(NEUTRAL_ID);
  });
  it('enforces setup batch and advances to first turn', () => {
    let { state } = setup(3, { setupBatch: 5 });
    const me = state.currentPlayer!;
    const t = territoriesOf(state, me)[0];
    expect(() => applyAction(state, me, { type: 'place', placements: { [t]: 6 } })).toThrow(RuleError);
    state = applyAction(state, me, { type: 'place', placements: { [t]: 5 } }).state;
    expect(state.currentPlayer).not.toBe(me);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    expect(state.currentPlayer).toBe(state.turnOrder[0]);
    expect(state.turnNumber).toBe(1);
    const total = TERRITORY_IDS.reduce((n, t) => n + state.territories[t].armies, 0);
    expect(total).toBe(35 * 3); // every starting army is on the board
  });
  it('claim mode lets players pick territories', () => {
    let { state } = setup(3, { randomDeal: false, setupBatch: 10 });
    expect(TERRITORY_IDS.every((t) => state.territories[t].owner === null)).toBe(true);
    const me = state.currentPlayer!;
    expect(() => applyAction(state, me, { type: 'place', placements: { alaska: 2 } })).toThrow(RuleError);
    state = applyAction(state, me, { type: 'place', placements: { alaska: 1 } }).state;
    expect(state.territories.alaska).toEqual({ owner: me, armies: 1 });
    expect(() => applyAction(state, state.currentPlayer!, { type: 'place', placements: { alaska: 1 } })).toThrow(/claimed/);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    expect(TERRITORY_IDS.every((t) => state.territories[t].owner !== null)).toBe(true);
  });
});

describe('turn flow', () => {
  it('reinforce -> attack -> fortify -> next player', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const p = state.players.find((x) => x.id === me)!;
    expect(p.armiesToPlace).toBe(Math.max(3, Math.floor(14 / 3)) + 0);
    expect(() => applyAction(state, me, { type: 'end_turn' })).toThrow(RuleError);
    expect(() => applyAction(state, 'p_other', { type: 'end_turn' })).toThrow(RuleError);
    const t = territoriesOf(state, me)[0];
    state = applyAction(state, me, { type: 'place', placements: { [t]: p.armiesToPlace } }).state;
    expect(state.phase).toBe('attack');
    state = applyAction(state, me, { type: 'end_attack' }).state;
    expect(state.phase).toBe('fortify');
    state = applyAction(state, me, { type: 'end_turn' }).state;
    expect(state.phase).toBe('reinforce');
    expect(state.currentPlayer).toBe(state.turnOrder[1]);
  });

  it('attacks resolve with dice, conquest requires occupy, card drawn at end of turn', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    // find an owned territory with an enemy neighbour
    const lmBefore = legalMoves(state, me);
    const from = lmBefore.canPlaceOn[0];
    state = applyAction(state, me, { type: 'place', placements: { [from]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    // make a strong attacker deterministically
    state.territories[from].armies = 50;
    const to = ADJACENCY[from].find((n) => state.territories[n].owner !== me)!;
    const res = applyAction(state, me, { type: 'attack', from, to, blitz: true });
    state = res.state;
    const battles = res.events.filter((e) => e.type === 'battle');
    expect(battles.length).toBeGreaterThan(0);
    expect(res.events.some((e) => e.type === 'conquered')).toBe(true);
    expect(state.pendingConquest).not.toBeNull();
    expect(state.territories[to].owner).toBe(me);
    expect(() => applyAction(state, me, { type: 'end_attack' })).toThrow(/occupy/);
    const pc = state.pendingConquest!;
    expect(() => applyAction(state, me, { type: 'occupy', armies: pc.maxArmies + 1 })).toThrow(RuleError);
    state = applyAction(state, me, { type: 'occupy', armies: pc.minArmies }).state;
    expect(state.territories[to].armies).toBe(pc.minArmies);
    expect(state.pendingConquest).toBeNull();
    const cardsBefore = state.players.find((x) => x.id === me)!.cards.length;
    const end = applyAction(state, me, { type: 'end_turn' });
    expect(end.events.some((e) => e.type === 'card_drawn')).toBe(true);
    expect(end.state.players.find((x) => x.id === me)!.cards.length).toBe(cardsBefore + 1);
  });

  it('auto occupy via attack.occupy and dice validation', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const from = legalMoves(state, me).canPlaceOn[0];
    state = applyAction(state, me, { type: 'place', placements: { [from]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    state.territories[from].armies = 2;
    const to = ADJACENCY[from].find((n) => state.territories[n].owner !== me)!;
    expect(() => applyAction(state, me, { type: 'attack', from, to, dice: 3 })).toThrow(/at most 1 dice/);
    state.territories[from].armies = 30;
    state.territories[to].armies = 1;
    const res = applyAction(state, me, { type: 'attack', from, to, blitz: true, occupy: 'max' });
    expect(res.state.pendingConquest).toBeNull();
    expect(res.state.territories[from].armies).toBe(1);
    expect(res.state.territories[to].owner).toBe(me);
  });

  it('fortify respects mode and ends the turn', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, fortifyMode: 'adjacent' }).state);
    const me = state.currentPlayer!;
    const owned = territoriesOf(state, me);
    state = applyAction(state, me, { type: 'place', placements: { [owned[0]]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    state = applyAction(state, me, { type: 'end_attack' }).state;
    const lm = legalMoves(state, me);
    for (const f of lm.fortifies) expect(ADJACENCY[f.from]).toContain(f.to);
    if (lm.fortifies.length) {
      const f = lm.fortifies[0];
      const next = applyAction(state, me, { type: 'fortify', from: f.from, to: f.to, armies: f.maxArmies }).state;
      expect(next.territories[f.from].armies).toBe(1);
      expect(next.currentPlayer).not.toBe(me);
    }
  });

  it('forces a trade with 5+ cards in reinforce and awards escalating bonuses', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const p = state.players.find((x) => x.id === me)!;
    p.cards = state.deck.splice(0, 5);
    const lm = legalMoves(state, me);
    expect(lm.mustTrade).toBe(true);
    expect(lm.canPlaceOn).toHaveLength(0);
    expect(() => applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: 1 } })).toThrow(/trade/);
    const set = lm.tradeableSets[0];
    expect(set).toBeDefined();
    const before = p.armiesToPlace;
    const res = applyAction(state, me, { type: 'trade', cardIds: set });
    const traded = res.events.find((e) => e.type === 'traded') as Extract<GameEvent, { type: 'traded' }>;
    expect(traded.armies).toBe(4);
    expect(res.state.players.find((x) => x.id === me)!.armiesToPlace).toBe(before + 4);
    expect(res.state.tradeCount).toBe(1);
    expect(res.state.players.find((x) => x.id === me)!.cards).toHaveLength(2);
  });

  it('eliminating a player transfers cards and ends the game when one remains', () => {
    let state = finishSetup(setup(2, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const enemy = state.turnOrder.find((id) => id !== me)!;
    // Hand the enemy a single territory; give neutral the rest of theirs.
    const enemyTerrs = territoriesOf(state, enemy);
    for (const t of enemyTerrs.slice(1)) state.territories[t].owner = NEUTRAL_ID;
    const last = enemyTerrs[0];
    state.territories[last].armies = 1;
    state.players.find((x) => x.id === enemy)!.cards = state.deck.splice(0, 2);
    // Make a neighbour mine with lots of armies
    const from = ADJACENCY[last][0];
    state.territories[from] = { owner: me, armies: 40 };
    // Place reinforcements first
    state = applyAction(state, me, { type: 'place', placements: { [from]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    const res = applyAction(state, me, { type: 'attack', from, to: last, blitz: true, occupy: 'min' });
    expect(res.events.some((e) => e.type === 'eliminated')).toBe(true);
    expect(res.events.some((e) => e.type === 'cards_taken')).toBe(true);
    expect(res.state.phase).toBe('finished');
    expect(res.state.winner).toBe(me);
  });

  it('view hides other players cards and exposes legal moves', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    state.players[0].cards = state.deck.splice(0, 2);
    state.players[1].cards = state.deck.splice(0, 2);
    const v = viewFor(state, state.players[0].id);
    expect(v.players[0].cards).toHaveLength(2);
    expect(v.players[1].cards).toBeNull();
    expect(v.players[1].cardCount).toBe(2);
    expect((v as any).deck).toBeUndefined();
    expect(v.legal!.yourTurn).toBe(state.players[0].id === me);
  });

  it('surrender during setup skips the dead player for the first turn', () => {
    let state = setup(3, { setupBatch: 40 }).state;
    const first = state.turnOrder[0];
    state = applyAction(state, first, { type: 'surrender' }).state;
    expect(state.players.find((p) => p.id === first)!.alive).toBe(false);
    expect(state.currentPlayer).not.toBe(first);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    expect(state.currentPlayer).not.toBe(first);
    expect(state.players.find((p) => p.id === state.currentPlayer)!.alive).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const a = finishSetup(setup(4, {}, 7).state);
    const b = finishSetup(setup(4, {}, 7).state);
    expect(a.territories).toEqual(b.territories);
    expect(a.turnOrder).toEqual(b.turnOrder);
  });
});

describe('maps', () => {
  it('classic and world maps are well formed', async () => {
    const { MAPS, MAP_IDS } = await import('../src/index.js');
    expect(MAP_IDS).toEqual(['classic', 'world']);
    for (const id of MAP_IDS) {
      const m = MAPS[id];
      expect(m.territories.length).toBe(id === 'classic' ? 42 : 74);
      // every territory has a shape and an anchor inside the viewBox
      for (const t of m.territories) {
        expect(t.path.length).toBeGreaterThan(10);
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThanOrEqual(m.viewBox[0]);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(m.viewBox[1]);
        expect(m.continentById[t.continent]).toBeDefined();
      }
      // continents partition the territories
      const all = m.continents.flatMap((c) => c.territories).sort();
      expect(all).toEqual([...m.territoryIds].sort());
      // adjacency symmetric, no self loops, graph connected
      for (const t of m.territoryIds) {
        expect(m.adjacency[t].length).toBeGreaterThan(0);
        for (const n of m.adjacency[t]) {
          expect(n).not.toBe(t);
          expect(m.adjacency[n]).toContain(t);
        }
      }
      const seen = new Set<string>([m.territoryIds[0]]);
      const stack = [m.territoryIds[0]];
      while (stack.length) for (const n of m.adjacency[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
      expect(seen.size).toBe(m.territoryIds.length);
      for (const l of m.seaLinks) expect(m.isAdjacent(l.a, l.b)).toBe(true);
      expect(m.seaLinks.some((l) => l.wrap)).toBe(true);
    }
    expect(MAPS.world.maxPlayers).toBe(10);
    expect(MAPS.world.startingArmies(10)).toBe(22);
    expect(MAPS.world.startingArmies(2)).toBe(60);
    expect(() => MAPS.classic.startingArmies(7)).toThrow(RuleError);
  });

  it('plays a 10 player game on the world map', () => {
    let s = createGame('w', { map: 'world', maxPlayers: 10, setupBatch: 40 }, 3);
    for (let i = 0; i < 10; i++) s = addPlayer(s, `p${i}`, `P${i}`);
    expect(() => addPlayer(s, 'extra', 'X')).toThrow(/full/);
    let state = startGame(s).state;
    expect(state.players).toHaveLength(10);
    expect(Object.keys(state.territories)).toHaveLength(74);
    const counts = state.players.map((p) => territoriesOf(state, p.id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(state.deck.length).toBe(76);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    const me = state.currentPlayer!;
    const lm = legalMoves(state, me);
    expect(lm.canPlaceOn.length).toBeGreaterThan(0);
    for (const t of lm.canPlaceOn) expect(t in state.territories).toBe(true);
  });

  it('rejects more players than the map allows and unknown maps', () => {
    expect(() => createGame('x', { maxPlayers: 10 })).toThrow(/maxPlayers/);
    expect(() => createGame('x', { map: 'moon' as any })).toThrow(/Unknown map/);
    let s = createGame('x', { maxPlayers: 6 });
    s = setOptions(s, { map: 'world' });
    expect(s.options.map).toBe('world');
    expect(Object.keys(s.territories)).toHaveLength(74);
    s = setOptions(s, { maxPlayers: 10 });
    s = setOptions(s, { map: 'classic' });
    expect(s.options.maxPlayers).toBe(6);
  });
});
