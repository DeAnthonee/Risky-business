import { describe, expect, it } from 'vitest';
import {
  ADJACENCY,
  CONTINENTS,
  EDGE_LIST,
  LEGACY_MAP_IDS,
  MAPS,
  MAP_IDS,
  NEUTRAL_ID,
  RuleError,
  TERRITORY_IDS,
  addPlayer,
  applyAction,
  bestSet,
  describeOptions,
  capitalsHeldBy,
  createGame,
  findSets,
  isValidSet,
  legalMoves,
  parseOptions,
  redactEvents,
  renamePlayer,
  setOptions,
  startGame,
  startingArmies,
  territoriesOf,
  tradeBonus,
  viewFor,
  visibleTerritories,
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
  it('values fixed sets like RISK: Global Domination', async () => {
    const { fixedSetValue } = await import('../src/index.js');
    const c = (id: number, kind: any) => ({ id, kind, territory: null });
    expect(fixedSetValue([c(1, 'infantry'), c(2, 'infantry'), c(3, 'infantry')])).toBe(4);
    expect(fixedSetValue([c(1, 'cavalry'), c(2, 'cavalry'), c(3, 'cavalry')])).toBe(6);
    expect(fixedSetValue([c(1, 'artillery'), c(2, 'artillery'), c(3, 'artillery')])).toBe(8);
    expect(fixedSetValue([c(1, 'infantry'), c(2, 'cavalry'), c(3, 'artillery')])).toBe(10);
    expect(fixedSetValue([c(1, 'infantry'), c(2, 'infantry'), c(3, 'wild')])).toBe(4);
    expect(fixedSetValue([c(1, 'infantry'), c(2, 'cavalry'), c(3, 'wild')])).toBe(10);
    expect(fixedSetValue([c(1, 'infantry'), c(2, 'wild'), c(3, 'wild')])).toBe(10);
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
  it('neutral territories for 3+ players: set aside with a fixed garrison, players keep full armies', () => {
    const { state } = setup(4, { neutrals: 10, neutralArmies: 3 });
    const neutral = state.players.find((p) => p.isNeutral)!;
    expect(neutral.id).toBe(NEUTRAL_ID);
    expect(state.turnOrder).not.toContain(NEUTRAL_ID);
    const held = territoriesOf(state, NEUTRAL_ID);
    expect(held).toHaveLength(10);
    for (const t of held) expect(state.territories[t].armies).toBe(3);
    expect(neutral.armiesToPlace).toBe(0);
    // The other 32 territories are dealt 8 each and players keep the classic 30 starting armies.
    for (const p of state.players.filter((x) => !x.isNeutral)) {
      expect(territoriesOf(state, p.id)).toHaveLength(8);
      expect(p.armiesToPlace).toBe(30 - 8);
    }
    expect(TERRITORY_IDS.every((t) => state.territories[t].owner !== null)).toBe(true);
    // Setup finishes and Neutral never gets a turn.
    let s = finishSetup(state);
    for (let i = 0; i < 8; i++) {
      expect(s.currentPlayer).not.toBe(NEUTRAL_ID);
      const me = s.currentPlayer!;
      const lm = legalMoves(s, me);
      if (lm.armiesToPlace) s = applyAction(s, me, { type: 'place', placements: { [lm.canPlaceOn[0]]: lm.armiesToPlace } }).state;
      s = applyAction(s, me, { type: 'end_turn' }).state;
    }
  });
  it('neutral territories: off by default, ignored for 2 players, validated, work in claim mode', () => {
    expect(setup(3).state.players.some((p) => p.isNeutral)).toBe(false);
    const two = setup(2, { neutrals: 10 }).state;
    expect(territoriesOf(two, NEUTRAL_ID)).toHaveLength(14); // classic 2-player Neutral, unchanged
    expect(() => createGame('x', { neutrals: 15 })).toThrow(RuleError);
    expect(() => createGame('x', { neutralArmies: 0 })).toThrow(RuleError);
    expect(setOptions(createGame('x', { map: 'world', neutrals: 24 }), { map: 'classic' }).options.neutrals).toBe(14);
    const claim = setup(3, { neutrals: 6, randomDeal: false }).state;
    expect(territoriesOf(claim, NEUTRAL_ID)).toHaveLength(6);
    expect(legalMoves(claim, claim.currentPlayer!).canPlaceOn).toHaveLength(36);
  });
  it('neutral territories never land on a blizzard', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { state } = setup(4, { neutrals: 14, blizzards: 7 }, seed);
      const held = territoriesOf(state, NEUTRAL_ID);
      expect(held).toHaveLength(14);
      for (const t of held) expect(state.blizzards).not.toContain(t);
      for (const t of state.blizzards) expect(state.territories[t]).toEqual({ owner: null, armies: 0 });
    }
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
  it('autoSetup skips placement and starts turn 1 with all armies on the board', () => {
    const { state, events } = setup(4, { autoSetup: true }, 11);
    expect(state.phase).toBe('reinforce');
    expect(state.currentPlayer).toBe(state.turnOrder[0]);
    expect(events.some((e) => e.type === 'turn_started')).toBe(true);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'setup')).toBe(false);
    const onBoard = TERRITORY_IDS.reduce((n, t) => n + state.territories[t].armies, 0);
    const current = state.players.find((p) => p.id === state.currentPlayer)!;
    expect(onBoard).toBe(30 * 4);
    expect(current.armiesToPlace).toBeGreaterThan(0); // turn-1 reinforcements, not setup armies
    for (const p of state.players) if (p.id !== current.id) expect(p.armiesToPlace).toBe(0);
    // 2 players: the neutral army is placed too
    const two = setup(2, { autoSetup: true, randomDeal: false }, 5).state; // implies random deal
    expect(two.phase).toBe('reinforce');
    expect(TERRITORY_IDS.reduce((n, t) => n + two.territories[t].armies, 0)).toBe(40 * 3);
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

  it('trades a set in automatically when a turn starts with 5+ cards', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const next = state.turnOrder[(state.turnOrder.indexOf(me) + 1) % state.turnOrder.length];
    const nextP = state.players.find((x) => x.id === next)!;
    nextP.cards = state.deck.splice(0, 5);
    expect(legalMoves(state, next).mustTrade).toBe(false); // not their turn yet
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    const res = applyAction(state, me, { type: 'end_turn' });
    expect(res.state.currentPlayer).toBe(next);
    const traded = res.events.filter((e) => e.type === 'traded') as Extract<GameEvent, { type: 'traded' }>[];
    expect(traded).toHaveLength(1);
    expect(traded[0].auto).toBe(true);
    expect(traded[0].player).toBe(next);
    expect(traded[0].armies).toBe(4);
    const after = res.state.players.find((x) => x.id === next)!;
    expect(after.cards).toHaveLength(2);
    const started = res.events.find((e) => e.type === 'turn_started') as Extract<GameEvent, { type: 'turn_started' }>;
    expect(after.armiesToPlace).toBe(started.reinforcements.total + 4);
    expect(res.state.tradeCount).toBe(1);
    expect(legalMoves(res.state, next).mustTrade).toBe(false);
    expect(legalMoves(res.state, next).canPlaceOn.length).toBeGreaterThan(0);
  });

  it('lets you trade a set by choice in reinforce and awards escalating bonuses', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const p = state.players.find((x) => x.id === me)!;
    const pick = (kind: string) => state.deck.splice(state.deck.findIndex((c) => c.kind === kind), 1)[0];
    p.cards = [pick('infantry'), pick('infantry'), pick('infantry'), pick('cavalry')];
    const lm = legalMoves(state, me);
    expect(lm.mustTrade).toBe(false);
    const set = lm.tradeableSets[0];
    expect(set).toBeDefined();
    const before = p.armiesToPlace;
    const res = applyAction(state, me, { type: 'trade', cardIds: set });
    const traded = res.events.find((e) => e.type === 'traded') as Extract<GameEvent, { type: 'traded' }>;
    expect(traded.armies).toBe(4);
    expect(traded.auto).toBeUndefined();
    expect(res.state.players.find((x) => x.id === me)!.armiesToPlace).toBe(before + 4);
    expect(res.state.tradeCount).toBe(1);
    expect(res.state.players.find((x) => x.id === me)!.cards).toHaveLength(1);
  });

  it('the automatic trade picks the most armies and keeps wilds', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, cardValues: 'fixed' }).state);
    const me = state.currentPlayer!;
    const p = state.players.find((x) => x.id === me)!;
    const pick = (kind: string) => state.deck.splice(state.deck.findIndex((c) => c.kind === kind), 1)[0];
    // Sets on offer: 3 infantry (4), infantry+cavalry+artillery (10), and several with the wild.
    p.cards = [pick('infantry'), pick('infantry'), pick('infantry'), pick('cavalry'), pick('artillery'), pick('wild')];
    const set = bestSet(state, me)!;
    expect(set.map((c) => c.kind).sort()).toEqual(['artillery', 'cavalry', 'infantry']);
  });

  it('balanced blitz plays out the median of several real blitzes: fewer upsets, single rolls untouched', () => {
    // 12 attackers against 6 defenders, over many seeds, with and without balanced blitz.
    const trial = (balanced: boolean, seed: number, blitz = true, attackers = 12, defenders = 6) => {
      let state = finishSetup(setup(3, { setupBatch: 40, balancedBlitz: balanced }, seed).state);
      const me = state.currentPlayer!;
      const from = legalMoves(state, me).canPlaceOn.find((t) => ADJACENCY[t].some((n) => state.territories[n].owner !== me))!;
      state = applyAction(state, me, { type: 'place', placements: { [from]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
      const to = ADJACENCY[from].find((n) => state.territories[n].owner !== me)!;
      state.territories[from].armies = attackers;
      state.territories[to].armies = defenders;
      return applyAction(state, me, { type: 'attack', from, to, blitz });
    };
    let randomWins = 0;
    let balancedWins = 0;
    const runs = 300;
    for (let seed = 1; seed <= runs; seed++) {
      const r = trial(false, seed);
      if (r.events.some((e) => e.type === 'conquered')) randomWins++;
      expect(r.events.some((e) => e.type === 'battle' && e.balanced)).toBe(false);
      const b = trial(true, seed);
      if (b.events.some((e) => e.type === 'conquered')) balancedWins++;
      const battles = b.events.filter((e) => e.type === 'battle') as Extract<GameEvent, { type: 'battle' }>[];
      expect(battles.every((e) => e.balanced)).toBe(true);
      // The played-out run is a real, consistent sequence of rolls.
      let a = 12;
      let d = 6;
      for (const e of battles) {
        const n = Math.min(e.attackerDice.length, e.defenderDice.length);
        let al = 0;
        for (let i = 0; i < n; i++) if (e.attackerDice[i] <= e.defenderDice[i]) al++;
        expect(e.attackerLosses).toBe(al);
        expect(e.defenderLosses).toBe(n - al);
        a -= e.attackerLosses;
        d -= e.defenderLosses;
        expect(e.fromArmies).toBe(a);
        expect(e.toArmies).toBe(d);
      }
      expect(d === 0 || a === 1).toBe(true);
    }
    // 12 v 6 wins about 90% of the time on pure luck; the median of 5 almost always does.
    expect(randomWins / runs).toBeGreaterThan(0.8);
    expect(randomWins / runs).toBeLessThan(0.97);
    expect(balancedWins / runs).toBeGreaterThan(randomWins / runs + 0.04);
    // And a long shot (5 v 6, about 25% on luck) comes off less often.
    let longShotRandom = 0;
    let longShotBalanced = 0;
    for (let seed = 1; seed <= runs; seed++) {
      if (trial(false, seed, true, 5, 6).events.some((e) => e.type === 'conquered')) longShotRandom++;
      if (trial(true, seed, true, 5, 6).events.some((e) => e.type === 'conquered')) longShotBalanced++;
    }
    expect(longShotBalanced).toBeLessThan(longShotRandom);
    // A single roll is never balanced, even with the setting on.
    expect(trial(true, 7, false).events.some((e) => e.type === 'battle' && e.balanced)).toBe(false);
    // Same seed, same outcome.
    expect(trial(true, 9).events).toEqual(trial(true, 9).events);
  });

  it('dice ties go to the defender', () => {
    // Force a 3v2 battle and check every comparison: equal dice cost the attacker.
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const from = legalMoves(state, me).canPlaceOn[0];
    state = applyAction(state, me, { type: 'place', placements: { [from]: state.players.find((x) => x.id === me)!.armiesToPlace } }).state;
    state.territories[from].armies = 200;
    const to = ADJACENCY[from].find((n) => state.territories[n].owner !== me)!;
    state.territories[to].armies = 200;
    let ties = 0;
    for (let i = 0; i < 60; i++) {
      const res = applyAction(state, me, { type: 'attack', from, to, dice: 3 });
      const b = res.events.find((e) => e.type === 'battle') as Extract<GameEvent, { type: 'battle' }>;
      let aLoss = 0;
      let dLoss = 0;
      for (let k = 0; k < Math.min(b.attackerDice.length, b.defenderDice.length); k++) {
        if (b.attackerDice[k] === b.defenderDice[k]) ties++;
        if (b.attackerDice[k] > b.defenderDice[k]) dLoss++;
        else aLoss++;
      }
      expect(b.attackerLosses).toBe(aLoss);
      expect(b.defenderLosses).toBe(dLoss);
      state = res.state;
    }
    expect(ties).toBeGreaterThan(0);
  });

  it('fixed card values are paid out when the option is on', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, cardValues: 'fixed' }).state);
    const me = state.currentPlayer!;
    const p = state.players.find((x) => x.id === me)!;
    const inf = state.deck.filter((c) => c.kind === 'infantry').slice(0, 3);
    state.deck = state.deck.filter((c) => !inf.includes(c));
    p.cards = inf;
    const before = p.armiesToPlace;
    const res = applyAction(state, me, { type: 'trade', cardIds: inf.map((c) => c.id) });
    const bonusT = inf.find((c) => c.territory && state.territories[c.territory].owner === me);
    expect(res.state.players.find((x) => x.id === me)!.armiesToPlace).toBe(before + 4);
    if (bonusT) expect(res.state.territories[bonusT.territory!].armies).toBe(state.territories[bonusT.territory!].armies + 2);
  });

  it('fog of war hides unseen territories and events for players but not spectators', () => {
    const state = finishSetup(setup(4, { setupBatch: 40, fogOfWar: true }).state);
    const me = state.turnOrder[0];
    const v = viewFor(state, me);
    const hidden = Object.entries(v.territories).filter(([, t]) => t.hidden).map(([id]) => id);
    expect(hidden.length).toBeGreaterThan(0);
    for (const [id, t] of Object.entries(v.territories)) {
      const mine = state.territories[id].owner === me;
      const adjacentToMine = ADJACENCY[id].some((n) => state.territories[n].owner === me);
      expect(!!t.hidden).toBe(!(mine || adjacentToMine));
      if (t.hidden) expect(t.owner).toBeNull();
    }
    const spectator = viewFor(state, null);
    expect(Object.values(spectator.territories).some((t) => t.hidden)).toBe(false);
    const far = hidden[0];
    const other = state.territories[far].owner!;
    const events: GameEvent[] = [
      { type: 'placed', player: other, territory: far, armies: 3 },
      { type: 'turn_started', player: other, turnNumber: 2, round: 1, reinforcements: { territories: 1, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0, total: 3 } },
    ];
    const red = redactEvents(state, me, events);
    expect(red[0]).toEqual({ type: 'fogged', kind: 'placed' });
    expect(red[1].type).toBe('turn_started');
    expect(redactEvents(state, null, events)).toEqual(events);
  });

  it('capital conquest: losing your capital does not knock you out', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, capitals: true }).state);
    expect(Object.keys(state.capitals)).toHaveLength(3);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    expect(meP.armiesToPlace).toBe(Math.max(3, Math.floor(14 / 3)) + 2);
    const rival = state.turnOrder.find((id) => id !== me)!;
    const cap = state.capitals[rival];
    const from = ADJACENCY[cap].find((t) => !Object.values(state.capitals).includes(t))!;
    state.territories[from] = { owner: me, armies: 80 };
    state.territories[cap].armies = 1;
    const rivalTerritories = territoriesOf(state, rival).length;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const res = applyAction(state, me, { type: 'attack', from, to: cap, blitz: true, occupy: 'min' });
    expect(res.events.some((e) => e.type === 'capital_captured')).toBe(true);
    // The rival keeps everything else and stays in the game.
    expect(res.events.some((e) => e.type === 'eliminated')).toBe(false);
    expect(territoriesOf(res.state, rival)).toHaveLength(rivalTerritories - 1);
    expect(res.state.players.find((x) => x.id === rival)!.alive).toBe(true);
    expect(capitalsHeldBy(res.state, me)).toContain(cap);
    expect(res.state.phase).not.toBe('finished');
  });

  it('capital conquest: holding every capital wins, including eliminated players\' capitals', () => {
    let state = finishSetup(setup(4, { setupBatch: 40, capitals: true }).state);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const others = state.turnOrder.filter((id) => id !== me);
    // Give me every capital but one; that last one belongs to a rival and sits next to my stack.
    const [last, ...rest] = others;
    for (const id of rest) state.territories[state.capitals[id]] = { owner: me, armies: 3 };
    const target = state.capitals[last];
    const from = ADJACENCY[target].find((t) => !Object.values(state.capitals).includes(t))!;
    state.territories[from] = { owner: me, armies: 60 };
    state.territories[target].armies = 1;
    // Mark one rival eliminated: its capital (already mine) still counts.
    const gone = rest[0];
    for (const t of territoriesOf(state, gone)) state.territories[t] = { owner: me, armies: 1 };
    state.players.find((p) => p.id === gone)!.alive = false;
    expect(state.phase).toBe('attack');
    const res = applyAction(state, me, { type: 'attack', from, to: target, blitz: true, occupy: 'min' });
    expect(res.state.phase).toBe('finished');
    expect(res.state.winner).toBe(me);
    expect(res.events.find((e) => e.type === 'game_over')).toMatchObject({ winner: me, reason: 'capitals' });
    // The other players are still alive: this is a capitals win, not a domination win.
    expect(res.state.players.filter((p) => p.alive && p.id !== me).length).toBeGreaterThan(0);
  });

  it('capital conquest off: holding several capitals means nothing', () => {
    const state = finishSetup(setup(3, { setupBatch: 40 }).state);
    expect(state.capitals).toEqual({});
  });

  it('blizzards: frozen territories are unowned, impassable and keep the map connected', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { state: s0, events } = setup(3, { blizzards: 7 }, seed);
      expect(s0.blizzards).toHaveLength(7);
      expect(events.some((e) => e.type === 'blizzards')).toBe(true);
      for (const t of s0.blizzards) expect(s0.territories[t]).toEqual({ owner: null, armies: 0 });
      // Open territories form one network, and every continent keeps at least two open territories.
      const open = TERRITORY_IDS.filter((t) => !s0.blizzards.includes(t));
      const seen = new Set([open[0]]);
      const queue = [open[0]];
      while (queue.length) for (const n of ADJACENCY[queue.pop()!]) if (!s0.blizzards.includes(n) && !seen.has(n)) (seen.add(n), queue.push(n));
      expect(seen.size).toBe(open.length);
      for (const c of CONTINENTS) expect(c.territories.filter((t) => !s0.blizzards.includes(t)).length).toBeGreaterThanOrEqual(2);
      // Every open territory was dealt.
      for (const t of open) expect(s0.territories[t].owner).not.toBeNull();
    }

    let state = finishSetup(setup(3, { blizzards: 5, setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const frozen = state.blizzards[0];
    const from = ADJACENCY[frozen].find((t) => !state.blizzards.includes(t))!;
    state.territories[from] = { owner: me, armies: 20 };
    expect(legalMoves(state, me).attacks.some((a) => a.to === frozen)).toBe(false);
    expect(() => applyAction(state, me, { type: 'attack', from, to: frozen })).toThrow(RuleError);
  });

  it('blizzards: a continent is controlled by owning all its open territories', () => {
    let state = finishSetup(setup(3, { blizzards: 7, setupBatch: 40 }, 3).state);
    const me = state.currentPlayer!;
    const cont = CONTINENTS.find((c) => c.territories.some((t) => state.blizzards.includes(t)))!;
    for (const t of cont.territories) if (!state.blizzards.includes(t)) state.territories[t] = { owner: me, armies: 1 };
    expect(viewFor(state, me).continentOwners[cont.id]).toBe(me);
  });

  it('blizzards: option is validated per map and clamped when switching maps', () => {
    expect(() => createGame('x', { blizzards: 9 })).toThrow(RuleError);
    expect(createGame('x', { blizzards: 8 }).options.blizzards).toBe(8);
    expect(() => createGame('x', { blizzards: -1 })).toThrow(RuleError);
    const world = createGame('x', { map: 'world', blizzards: 12 });
    expect(setOptions(world, { map: 'classic' }).options.blizzards).toBe(8);
  });

  it('capital conquest: a capital defends with up to 3 dice, other territories with 2', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, capitals: true }).state);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const rival = state.turnOrder.find((id) => id !== me)!;
    const cap = state.capitals[rival];
    const from = ADJACENCY[cap][0];
    state.territories[from] = { owner: me, armies: 10 };
    state.territories[cap] = { owner: rival, armies: 5 };
    const capBattle = applyAction(state, me, { type: 'attack', from, to: cap }).events.find((e) => e.type === 'battle')!;
    expect(capBattle.type === 'battle' && capBattle.defenderDice).toHaveLength(3);
    expect(capBattle.type === 'battle' && capBattle.attackerLosses + capBattle.defenderLosses).toBe(3);

    // A non-capital rival territory still defends with 2.
    const plain = ADJACENCY[from].find((t) => t !== cap && !Object.values(state.capitals).includes(t))!;
    state.territories[plain] = { owner: rival, armies: 5 };
    const plainBattle = applyAction(state, me, { type: 'attack', from, to: plain }).events.find((e) => e.type === 'battle')!;
    expect(plainBattle.type === 'battle' && plainBattle.defenderDice).toHaveLength(2);

    // Without the capitals option there is no bonus at all.
    const off = { ...state, options: { ...state.options, capitals: false } };
    const offBattle = applyAction(off, me, { type: 'attack', from, to: cap }).events.find((e) => e.type === 'battle')!;
    expect(offBattle.type === 'battle' && offBattle.defenderDice).toHaveLength(2);
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

  it('a kill that leaves you with 5 cards trades a set in automatically, then you keep attacking', () => {
    let state = finishSetup(setup(3, { setupBatch: 40 }).state);
    const me = state.currentPlayer!;
    const victim = state.turnOrder.find((id) => id !== me)!;
    const third = state.turnOrder.find((id) => id !== me && id !== victim)!;
    // The victim is down to one territory with 2 cards; I already hold 3 (no set among them).
    const victimTerrs = territoriesOf(state, victim);
    for (const t of victimTerrs.slice(1)) state.territories[t].owner = third;
    const last = victimTerrs[0];
    state.territories[last].armies = 1;
    const kinds = ['infantry', 'infantry', 'cavalry', 'cavalry', 'artillery'] as const;
    const pick = (kind: (typeof kinds)[number]) => state.deck.splice(state.deck.findIndex((c) => c.kind === kind), 1)[0];
    const meP = state.players.find((x) => x.id === me)!;
    meP.cards = [pick('infantry'), pick('infantry'), pick('cavalry')];
    state.players.find((x) => x.id === victim)!.cards = [pick('cavalry'), pick('artillery')];
    const from = ADJACENCY[last][0];
    state.territories[from] = { owner: me, armies: 40 };
    state = applyAction(state, me, { type: 'place', placements: { [from]: meP.armiesToPlace } }).state;
    expect(legalMoves(state, me).mustTrade).toBe(false); // 3 cards: no forced trade yet

    const res = applyAction(state, me, { type: 'attack', from, to: last, blitz: true, occupy: 'min' });
    state = res.state;
    const traded = res.events.find((e) => e.type === 'traded') as Extract<GameEvent, { type: 'traded' }>;
    expect(traded?.auto).toBe(true);
    // The trade comes after the cards are taken.
    expect(res.events.findIndex((e) => e.type === 'traded')).toBeGreaterThan(res.events.findIndex((e) => e.type === 'cards_taken'));
    const after = state.players.find((x) => x.id === me)!;
    expect(after.cards).toHaveLength(2);
    expect(after.armiesToPlace).toBeGreaterThan(0);
    expect(state.phase).toBe('attack');
    expect(legalMoves(state, me).mustTrade).toBe(false);

    // Place the armies, and the attack phase carries on.
    state = applyAction(state, me, { type: 'place', placements: { [from]: after.armiesToPlace } }).state;
    expect(legalMoves(state, me).canEndTurn).toBe(true);
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
    // spectators see every hand
    const sv = viewFor(state, null);
    expect(sv.players[0].cards).toHaveLength(2);
    expect(sv.players[1].cards).toHaveLength(2);
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
  const EXPECTED: Record<string, { territories: number; regions: number; maxPlayers: number }> = {
    classic: { territories: 42, regions: 6, maxPlayers: 6 },
    world: { territories: 74, regions: 14, maxPlayers: 10 },
    world_large: { territories: 104, regions: 20, maxPlayers: 10 },
    europe: { territories: 44, regions: 8, maxPlayers: 8 },
    europe_advanced: { territories: 99, regions: 14, maxPlayers: 6 }, // legacy, saved games only
    greater_europe: { territories: 116, regions: 15, maxPlayers: 10 },
    europe_classic: { territories: 84, regions: 14, maxPlayers: 6 },
    usa: { territories: 45, regions: 8, maxPlayers: 10 },
    asia: { territories: 49, regions: 7, maxPlayers: 8 },
    fantasy: { territories: 87, regions: 16, maxPlayers: 10 },
  };

  it('every map is well formed', async () => {
    const { MAPS, MAP_IDS } = await import('../src/index.js');
    expect(MAP_IDS).toEqual(['classic', 'world', 'world_large', 'europe', 'greater_europe', 'europe_classic', 'usa', 'asia', 'fantasy']);
    // every registered board is either offered or legacy, never both
    expect([...MAP_IDS, ...LEGACY_MAP_IDS].sort()).toEqual(Object.keys(MAPS).sort());
    for (const id of [...MAP_IDS, ...LEGACY_MAP_IDS]) {
      const m = MAPS[id];
      expect(m.territories.length).toBe(EXPECTED[id].territories);
      expect(m.continents.length).toBe(EXPECTED[id].regions);
      expect(m.maxPlayers).toBe(EXPECTED[id].maxPlayers);
      expect(new Set(m.territoryIds).size).toBe(m.territoryIds.length);
      // every territory sits in exactly one region, and every region has a positive bonus
      for (const t of m.territoryIds) expect(m.continents.filter((c) => c.territories.includes(t))).toHaveLength(1);
      for (const c of m.continents) {
        expect(c.territories.length).toBeGreaterThan(0);
        expect(c.bonus).toBeGreaterThanOrEqual(1);
      }
      // no duplicate edges
      expect(new Set(m.edges.map(([a, b]) => [a, b].sort().join('|'))).size).toBe(m.edges.length);
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
      if (id === 'classic' || id === 'world' || id === 'world_large') expect(m.seaLinks.some((l) => l.wrap)).toBe(true);
      // starting armies: defined for every legal player count, enough to give each owned territory
      // an army (two-player games deal a third of the map to the Neutral), never more for more players
      let previous = Infinity;
      for (let n = 2; n <= m.maxPlayers; n++) {
        const armies = m.startingArmies(n);
        expect(Number.isInteger(armies)).toBe(true);
        expect(armies).toBeGreaterThanOrEqual(Math.ceil(m.territoryIds.length / n));
        expect(armies).toBeLessThanOrEqual(previous);
        previous = armies;
      }
      expect(() => m.startingArmies(1)).toThrow(RuleError);
      expect(() => m.startingArmies(m.maxPlayers + 1)).toThrow(RuleError);
    }
    expect(MAPS.world.maxPlayers).toBe(10);
    expect(MAPS.world.startingArmies(10)).toBe(21);
    expect(MAPS.world.startingArmies(2)).toBe(70);
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

  it('scales the classic starting armies by map size (equal share of the 6-player total above 6)', async () => {
    const { MAPS } = await import('../src/index.js');
    const table = (id: keyof typeof MAPS) => Array.from({ length: MAPS[id].maxPlayers - 1 }, (_, i) => MAPS[id].startingArmies(i + 2));
    expect(table('classic')).toEqual([40, 35, 30, 25, 20]);
    expect(table('world')).toEqual([70, 62, 53, 44, 35, 30, 26, 23, 21]);
    expect(table('world_large')).toEqual([99, 87, 74, 62, 50, 42, 37, 33, 30]);
    expect(table('europe')).toEqual([42, 37, 31, 26, 21, 18, 16]);
    expect(table('greater_europe')).toEqual([110, 97, 83, 69, 55, 47, 41, 37, 33]);
    expect(table('europe_advanced')).toEqual([94, 83, 71, 59, 47]);
    expect(table('europe_classic')).toEqual([80, 70, 60, 50, 40]);
    expect(table('usa')).toEqual([43, 38, 32, 27, 21, 18, 16, 14, 13]);
    expect(table('asia')).toEqual([47, 41, 35, 29, 23, 20, 18]);
    expect(table('fantasy')).toEqual([83, 73, 62, 52, 41, 36, 31, 28, 25]);
  });

  for (const id of ['world_large', 'europe', 'europe_advanced', 'greater_europe', 'europe_classic', 'usa', 'asia'] as const) {
    it(`deals and plays the first turn of a full ${id} game`, async () => {
      const { MAPS } = await import('../src/index.js');
      const m = MAPS[id];
      let s = createGame(id, { map: id, maxPlayers: m.maxPlayers, setupBatch: 40 }, 11);
      for (let i = 0; i < m.maxPlayers; i++) s = addPlayer(s, `p${i}`, `P${i}`);
      expect(() => addPlayer(s, 'extra', 'X')).toThrow(/full/);
      let state = startGame(s).state;
      expect(Object.keys(state.territories)).toHaveLength(m.territoryIds.length);
      expect(state.deck.length).toBe(m.territoryIds.length + 2);
      const counts = state.players.map((p) => territoriesOf(state, p.id).length);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      for (const p of state.players) expect(p.armiesToPlace).toBe(m.startingArmies(m.maxPlayers) - territoriesOf(state, p.id).length);
      state = finishSetup(state);
      expect(state.phase).toBe('reinforce');
      for (const t of m.territoryIds) expect(state.territories[t].owner).not.toBeNull();
      const lm = legalMoves(state, state.currentPlayer!);
      expect(lm.canPlaceOn.length).toBeGreaterThan(0);
      // two-player game with the classic Neutral
      let two = createGame(`${id}2`, { map: id, maxPlayers: 2 }, 5);
      two = addPlayer(addPlayer(two, 'a', 'A'), 'b', 'B');
      const started = startGame(two).state;
      expect(started.players.find((p) => p.id === NEUTRAL_ID)).toBeDefined();
      for (const p of started.players) expect(p.armiesToPlace).toBeGreaterThanOrEqual(0);
    });
  }

  it('runs blizzards and neutrals at their limits on a new map', async () => {
    const { MAPS, maxBlizzards, optionLimits } = await import('../src/index.js');
    const m = MAPS.world_large;
    const limits = optionLimits('world_large');
    expect(limits.blizzards.max).toBe(maxBlizzards(m));
    expect(limits.neutrals.max).toBe(Math.floor(104 / 3));
    let s = createGame('wl', { map: 'world_large', maxPlayers: 10, autoSetup: true, blizzards: limits.blizzards.max, neutrals: 10, neutralArmies: 2 }, 9);
    for (let i = 0; i < 10; i++) s = addPlayer(s, `p${i}`, `P${i}`);
    const state = startGame(s).state;
    expect(state.phase).toBe('reinforce');
    expect(state.blizzards).toHaveLength(limits.blizzards.max);
    for (const t of state.blizzards) expect(state.territories[t].owner).toBeNull();
    expect(m.territoryIds.filter((t) => state.territories[t].owner === NEUTRAL_ID)).toHaveLength(10);
  });

  it('renames players in the lobby only', () => {
    let s = createGame('r');
    s = addPlayer(s, 'a', 'Player');
    s = renamePlayer(s, 'a', '  Dean  ');
    expect(s.players[0].name).toBe('Dean');
    expect(() => renamePlayer(s, 'a', '   ')).toThrow(RuleError);
    s = addPlayer(s, 'b', 'B');
    const started = startGame(s).state;
    expect(() => renamePlayer(started, 'a', 'X')).toThrow(/lobby/);
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

describe('Europe Advanced map (europe_classic)', () => {
  const m = MAPS.europe_classic;
  // name: [territories, bonus], as on the reference board
  const REGIONS: Record<string, [string, number, number]> = {
    iceland: ['Iceland', 3, 2],
    british_empire: ['British Empire', 4, 3],
    scandinavia: ['Scandinavia', 5, 3],
    western_europe: ['Western Europe', 5, 4],
    central_europe: ['Central Europe', 6, 5],
    dinaric_alps: ['Dinaric Alps', 3, 4],
    southern_europe: ['Southern Europe', 5, 4],
    south_western_europe: ['South Western Europe', 6, 4],
    south_eastern_europe: ['South Eastern Europe', 4, 4],
    eastern_europe: ['Eastern Europe', 8, 8],
    russian_empire: ['Russian Empire', 9, 7],
    orient: ['Orient', 11, 6],
    west_africa: ['West Africa', 10, 6],
    north_africa: ['North Africa', 5, 3],
  };

  it('is registered as "Europe Advanced" with 84 territories in 14 regions for 2-6 players', async () => {
    const { classicScaledArmies } = await import('../src/index.js');
    expect(MAP_IDS).toContain('europe_classic');
    expect(m.name).toMatch(/^Europe Advanced/);
    expect(m.territories).toHaveLength(84);
    expect(m.maxPlayers).toBe(6);
    for (let n = 2; n <= 6; n++) expect(m.startingArmies(n)).toBe(classicScaledArmies(84, n));
    expect([2, 3, 4, 5, 6].map((n) => m.startingArmies(n))).toEqual([80, 70, 60, 50, 40]);
    expect(() => m.startingArmies(7)).toThrow(RuleError);
  });

  it('has exactly the reference regions, territory counts and bonuses', () => {
    expect(m.continents.map((c) => c.id).sort()).toEqual(Object.keys(REGIONS).sort());
    for (const c of m.continents) {
      const [name, count, bonus] = REGIONS[c.id];
      expect(c.name).toBe(name);
      expect(c.territories, c.id).toHaveLength(count);
      expect(c.bonus, c.id).toBe(bonus);
    }
    const counts = new Map<string, number>();
    for (const c of m.continents) for (const t of c.territories) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of m.territoryIds) expect(counts.get(t)).toBe(1);
  });

  it('has symmetric, connected adjacency and the reference sea crossings', () => {
    for (const t of m.territoryIds) {
      expect(m.adjacency[t].length).toBeGreaterThan(0);
      expect(new Set(m.adjacency[t]).size).toBe(m.adjacency[t].length);
      for (const n of m.adjacency[t]) {
        expect(n).not.toBe(t);
        expect(m.adjacency[n]).toContain(t);
      }
    }
    const seen = new Set([m.territoryIds[0]]);
    const stack = [m.territoryIds[0]];
    while (stack.length) for (const n of m.adjacency[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
    expect(seen.size).toBe(84);
    for (const [a, b] of [
      ['northern_iceland', 'scotland'],
      ['southern_iceland', 'ireland'],
      ['scotland', 'southern_norway'],
      ['southern_england', 'normandy'],
      ['southern_sweden', 'finland'],
      ['corsica_sardinia', 'constantine'],
      ['corsica_sardinia', 'naples'],
      ['naples', 'greece'],
      ['greece', 'cyrenaica'],
      ['andalusia', 'morocco'],
    ])
      expect(m.isAdjacent(a, b), `${a}~${b}`).toBe(true);
    expect(m.seaLinks.some((l) => l.wrap)).toBe(false);
  });

  it('deals and completes setup for six players, also with blizzards and neutrals at their limits', async () => {
    const { optionLimits, maxBlizzards } = await import('../src/index.js');
    let s = createGame('ec', { map: 'europe_classic', maxPlayers: 6, setupBatch: 40 }, 8);
    for (let i = 0; i < 6; i++) s = addPlayer(s, `p${i}`, `P${i}`);
    expect(() => addPlayer(s, 'extra', 'X')).toThrow(/full/);
    let state = startGame(s).state;
    const counts = state.players.map((p) => territoriesOf(state, p.id).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(84);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    for (const p of state.players) expect(p.armiesToPlace).toBe(40 - territoriesOf(state, p.id).length);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    for (const t of m.territoryIds) expect(state.territories[t].owner).not.toBeNull();

    const limits = optionLimits('europe_classic');
    expect(limits.blizzards.max).toBe(maxBlizzards(m));
    let b = createGame('ecb', { map: 'europe_classic', maxPlayers: 6, autoSetup: true, blizzards: limits.blizzards.max, neutrals: 6 }, 3);
    for (let i = 0; i < 6; i++) b = addPlayer(b, `p${i}`, `P${i}`);
    const frozen = startGame(b).state;
    expect(frozen.phase).toBe('reinforce');
    expect(frozen.blizzards).toHaveLength(limits.blizzards.max);
    const open = m.territoryIds.filter((t) => !frozen.blizzards.includes(t));
    const reach = new Set([open[0]]);
    const queue = [open[0]];
    while (queue.length) for (const n of m.adjacency[queue.pop()!]) if (!frozen.blizzards.includes(n) && !reach.has(n)) (reach.add(n), queue.push(n));
    expect(reach.size).toBe(open.length);
  });
});

describe('Greater Europe map (greater_europe)', () => {
  const m = MAPS.greater_europe;

  it('is registered with 116 territories in 15 regions for 2-10 players', async () => {
    const { classicScaledArmies } = await import('../src/index.js');
    expect(MAP_IDS).toContain('greater_europe');
    expect(m.name).toMatch(/Greater Europe/);
    expect(m.territories).toHaveLength(116);
    expect(m.continents).toHaveLength(15);
    expect(m.maxPlayers).toBe(10);
    for (let n = 2; n <= 10; n++) {
      expect(m.startingArmies(n)).toBe(classicScaledArmies(116, n));
      // at least 1.5 armies per territory a player is dealt (a third goes to the Neutral with 2 players)
      expect(m.startingArmies(n)).toBeGreaterThanOrEqual(1.5 * Math.ceil(116 / (n === 2 ? 3 : n)));
    }
    expect(() => m.startingArmies(11)).toThrow(RuleError);
  });

  it('puts every territory in exactly one region and sizes bonuses like the other boards', () => {
    const counts = new Map<string, number>();
    for (const c of m.continents) for (const t of c.territories) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of m.territoryIds) expect(counts.get(t)).toBe(1);
    for (const c of m.continents) {
      expect(c.territories.length).toBeGreaterThanOrEqual(4);
      expect(c.territories.length).toBeLessThanOrEqual(12);
      expect(c.bonus).toBeGreaterThanOrEqual(2);
      expect(c.bonus).toBeLessThanOrEqual(7);
    }
    const total = m.continents.reduce((n, c) => n + c.bonus, 0);
    expect(total / m.territories.length).toBeGreaterThan(0.6);
    expect(total / m.territories.length).toBeLessThan(0.8);
  });

  it('has symmetric, connected adjacency and the expected sea crossings', () => {
    for (const t of m.territoryIds) {
      expect(m.adjacency[t].length).toBeGreaterThan(0);
      expect(new Set(m.adjacency[t]).size).toBe(m.adjacency[t].length);
      for (const n of m.adjacency[t]) {
        expect(n).not.toBe(t);
        expect(m.adjacency[n]).toContain(t);
      }
    }
    const seen = new Set([m.territoryIds[0]]);
    const stack = [m.territoryIds[0]];
    while (stack.length) for (const n of m.adjacency[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
    expect(seen.size).toBe(116);
    const sea = (a: string, b: string) => m.seaLinks.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    for (const [a, b] of [
      ['southern_england', 'ile_de_france'], // the Channel
      ['ireland', 'wales'], // Irish Sea
      ['iceland', 'scotland'],
      ['denmark', 'gotaland'], // the Sound
      ['finland', 'estonia'],
      ['andalusia', 'fez'], // Gibraltar
      ['sicily', 'tunisia'],
      ['corsica', 'sardinia'],
      ['thrace', 'bithynia'], // the Bosporus
      ['crimea', 'kuban'], // Kerch Strait
    ])
      expect(sea(a, b), `${a}~${b}`).toBe(true);
    expect(m.seaLinks.some((l) => l.wrap)).toBe(false);
  });

  it('deals and completes setup for ten players, also with blizzards and neutrals at their limits', async () => {
    const { optionLimits, maxBlizzards } = await import('../src/index.js');
    let s = createGame('ea', { map: 'greater_europe', maxPlayers: 10, setupBatch: 40 }, 21);
    for (let i = 0; i < 10; i++) s = addPlayer(s, `p${i}`, `P${i}`);
    expect(() => addPlayer(s, 'extra', 'X')).toThrow(/full/);
    let state = startGame(s).state;
    const counts = state.players.map((p) => territoriesOf(state, p.id).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(116);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    for (const p of state.players) expect(p.armiesToPlace).toBe(33 - territoriesOf(state, p.id).length);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    for (const t of m.territoryIds) expect(state.territories[t].owner).not.toBeNull();

    const limits = optionLimits('greater_europe');
    expect(limits.blizzards.max).toBe(maxBlizzards(m));
    let b = createGame('eab', { map: 'greater_europe', maxPlayers: 10, autoSetup: true, blizzards: limits.blizzards.max, neutrals: 10 }, 4);
    for (let i = 0; i < 10; i++) b = addPlayer(b, `p${i}`, `P${i}`);
    const frozen = startGame(b).state;
    expect(frozen.phase).toBe('reinforce');
    expect(frozen.blizzards).toHaveLength(limits.blizzards.max);
    const open = m.territoryIds.filter((t) => !frozen.blizzards.includes(t));
    const reach = new Set([open[0]]);
    const queue = [open[0]];
    while (queue.length) for (const n of m.adjacency[queue.pop()!]) if (!frozen.blizzards.includes(n) && !reach.has(n)) (reach.add(n), queue.push(n));
    expect(reach.size).toBe(open.length);
  });
});

describe('legacy board europe_advanced (99 territories)', () => {
  const m = MAPS.europe_advanced;

  it('keeps its id, territories and adjacency so saved games still load', () => {
    expect(LEGACY_MAP_IDS).toContain('europe_advanced');
    expect(MAP_IDS).not.toContain('europe_advanced');
    expect(m.name).toBe('Europe (legacy, 99)');
    expect(m.territories).toHaveLength(99);
    expect(m.continents).toHaveLength(14);
    expect(m.maxPlayers).toBe(6);
    expect(m.isTerritory('morocco')).toBe(true);
    expect(m.isTerritory('cappadocia')).toBe(true);
    expect(m.adjacency.morocco).toContain('andalusia');
  });

  it('is not offered for new games but a lobby saved on it can still change other settings', () => {
    expect(() => parseOptions({ map: 'europe_advanced' })).toThrow(/map must be one of/);
    let s = createGame('legacy', { map: 'europe_advanced', maxPlayers: 6 }, 3);
    s = setOptions(s, parseOptions({ maxPlayers: 4, fogOfWar: true }));
    expect(s.options.map).toBe('europe_advanced');
    expect(s.options.maxPlayers).toBe(4);
    expect(() => setOptions(s, parseOptions({ maxPlayers: 7 }))).toThrow(/maxPlayers must be between 2 and 6/);
    expect(describeOptions(s.options)[0]).toMatch(/^Map: Europe \(legacy, 99\): 99 territories, 2-6 players \(legacy board/);
    // and can move to a current board
    s = setOptions(s, parseOptions({ map: 'greater_europe' }));
    expect(Object.keys(s.territories)).toHaveLength(116);
    for (const id of ['a', 'b', 'c']) s = addPlayer(s, id, id.toUpperCase());
    expect(startGame(s).state.phase).toBe('setup');
  });
});

describe('fantasy map (Realms of Halvaren)', () => {
  const m = MAPS.fantasy;

  it('is registered with 87 territories in 16 regions for up to 10 players', () => {
    expect(MAP_IDS).toContain('fantasy');
    expect(m.territories).toHaveLength(87);
    expect(m.continents).toHaveLength(16);
    expect(m.maxPlayers).toBe(10);
    expect(m.name).toMatch(/Halvaren/);
  });

  it('puts every territory in exactly one region, with a shape and an anchor on the board', () => {
    const counts = new Map<string, number>();
    for (const c of m.continents) for (const t of c.territories) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of m.territories) {
      expect(counts.get(t.id)).toBe(1);
      expect(m.continentById[t.continent].territories).toContain(t.id);
      expect(t.path.length).toBeGreaterThan(10);
      expect(t.x).toBeGreaterThan(0);
      expect(t.x).toBeLessThan(m.viewBox[0]);
      expect(t.y).toBeGreaterThan(0);
      expect(t.y).toBeLessThan(m.viewBox[1]);
    }
    expect(new Set(m.territoryIds).size).toBe(87);
    for (const c of m.continents) {
      expect(c.bonus).toBeGreaterThanOrEqual(2);
      expect(c.bonus).toBeLessThanOrEqual(7);
      expect(c.outline.length).toBeGreaterThan(10);
    }
    // The lawless wasteland is the biggest prize.
    expect(Math.max(...m.continents.map((c) => c.bonus))).toBe(m.continentById.grimward.bonus);
  });

  it('has symmetric, connected adjacency with sea lanes that do not wrap', () => {
    for (const t of m.territoryIds) {
      expect(m.adjacency[t].length).toBeGreaterThan(0);
      expect(new Set(m.adjacency[t]).size).toBe(m.adjacency[t].length);
      for (const n of m.adjacency[t]) {
        expect(n).not.toBe(t);
        expect(m.adjacency[n]).toContain(t);
      }
    }
    const seen = new Set<string>([m.territoryIds[0]]);
    const stack = [m.territoryIds[0]];
    while (stack.length) for (const n of m.adjacency[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
    expect(seen.size).toBe(87);
    expect(m.seaLinks.length).toBeGreaterThan(10);
    for (const l of m.seaLinks) {
      expect(m.isAdjacent(l.a, l.b)).toBe(true);
      expect(l.wrap).toBe(false);
    }
    // every region is reachable from outside (no sealed-off region)
    for (const c of m.continents) expect(c.territories.some((t) => m.adjacency[t].some((n) => m.territoryById[n].continent !== c.id))).toBe(true);
  });

  it('scales starting armies with the player count (classic numbers scaled by map size)', () => {
    const expected: Record<number, number> = { 2: 83, 3: 73, 4: 62, 5: 52, 6: 41, 7: 36, 8: 31, 9: 28, 10: 25 };
    for (let n = 2; n <= 10; n++) {
      const armies = m.startingArmies(n);
      expect(armies).toBe(expected[n]);
      expect(armies).toBe(startingArmies(n, 'fantasy'));
      // enough to cover every territory a player is dealt (2 players share with the Neutral)
      expect(armies).toBeGreaterThanOrEqual(Math.ceil(87 / Math.max(3, n)));
      if (n > 2) expect(armies).toBeLessThanOrEqual(m.startingArmies(n - 1));
    }
    expect(() => m.startingArmies(1)).toThrow(RuleError);
    expect(() => m.startingArmies(11)).toThrow(RuleError);
  });

  it('sets up and starts a 10-player game', () => {
    let s = createGame('f', { map: 'fantasy', maxPlayers: 10, setupBatch: 40 }, 11);
    for (let i = 0; i < 10; i++) s = addPlayer(s, `p${i}`, `P${i}`);
    expect(() => addPlayer(s, 'extra', 'X')).toThrow(/full/);
    let state = startGame(s).state;
    expect(Object.keys(state.territories)).toHaveLength(87);
    const counts = state.players.map((p) => territoriesOf(state, p.id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(state.deck.length).toBe(89);
    state = finishSetup(state);
    expect(state.phase).toBe('reinforce');
    for (const p of state.players) {
      const total = territoriesOf(state, p.id).reduce((sum, t) => sum + state.territories[t].armies, 0);
      expect(total).toBe(25);
    }
    const lm = legalMoves(state, state.currentPlayer!);
    expect(lm.canPlaceOn.length).toBeGreaterThan(0);
  });

  it('clamps seats when switching from fantasy back to classic', () => {
    let s = setOptions(createGame('x'), { map: 'fantasy' });
    expect(Object.keys(s.territories)).toHaveLength(87);
    s = setOptions(s, { maxPlayers: 10 });
    s = setOptions(s, { map: 'classic' });
    expect(s.options.maxPlayers).toBe(6);
  });
});

describe('game settings catalogue', () => {
  it('has a spec for every option and parses untrusted input strictly', async () => {
    const { OPTION_KEYS, OPTION_SPECS, DEFAULT_OPTIONS, parseOptions, describeOptions, optionCatalogue, optionLimits } = await import('../src/index.js');
    expect([...OPTION_KEYS].sort()).toEqual(Object.keys(DEFAULT_OPTIONS).sort());
    for (const k of OPTION_KEYS) expect(OPTION_SPECS[k].description.length).toBeGreaterThan(20);
    // coercion of form/query style values
    expect(parseOptions({ fogOfWar: 'true', capitals: 1, blizzards: '3', map: 'world' })).toEqual({ fogOfWar: true, capitals: true, blizzards: 3, map: 'world' });
    expect(parseOptions(undefined)).toEqual({});
    // typos and wrong types are errors, never silently dropped
    expect(() => parseOptions({ fog_of_war: true })).toThrow(/unknown setting "fog_of_war"/);
    expect(() => parseOptions({ fogOfWar: 'yes' })).toThrow(/fogOfWar must be true or false/);
    expect(() => parseOptions({ map: 'mars' })).toThrow(/map must be one of/);
    expect(() => parseOptions({ blizzards: 1.5 })).toThrow(/whole number/);
    expect(() => parseOptions({ neutrals: -1 })).toThrow(/at least 0/);
    // per-map limits and a human summary that mentions every setting
    expect(optionLimits('world').maxPlayers.max).toBe(10);
    expect(optionLimits('classic').maxPlayers.max).toBe(6);
    const lines = describeOptions({ ...DEFAULT_OPTIONS, fogOfWar: true, capitals: true, neutrals: 4, blizzards: 2, autoSetup: true });
    expect(lines.join('\n')).toMatch(/Fog of war: on/);
    expect(lines.join('\n')).toMatch(/Neutral territories: 4 with 2 armies/);
    expect(lines.join('\n')).toMatch(/Blizzards: 2 frozen/);
    expect(lines.join('\n')).toMatch(/Setup: skipped/);
    expect(optionCatalogue().options.map((o) => o.key).sort()).toEqual([...OPTION_KEYS].sort());
  });
});

describe('player income in views', () => {
  it('reports each player\'s next-turn reinforcements with a breakdown; none for the Neutral', () => {
    const state = finishSetup(setup(2, { setupBatch: 40 }).state);
    const v = viewFor(state, null);
    for (const p of v.players) {
      if (p.isNeutral) {
        expect(p.income).toBeNull();
        continue;
      }
      expect(p.income).toEqual(reinforcementsForTest(state, p.id));
      expect(p.income!.total).toBeGreaterThanOrEqual(3);
    }
  });
});

function reinforcementsForTest(state: GameState, id: string) {
  const owned = territoriesOf(state, id).length;
  const continents = CONTINENTS.filter((c) => c.territories.every((t) => state.territories[t].owner === id)).map((c) => ({ id: c.id, bonus: c.bonus }));
  const fromTerritories = Math.max(3, Math.floor(owned / 3));
  return { territories: owned, fromTerritories, continents, capitals: 0, fromCapitals: 0, total: fromTerritories + continents.reduce((n, c) => n + c.bonus, 0) };
}

describe('blizzards never trap territories or split the map', () => {
  it('on every map, at the maximum count, every open territory can reach every other', async () => {
    const { MAPS, MAP_IDS, pickBlizzards, maxBlizzards, createRng } = await import('../src/index.js');
    for (const id of MAP_IDS) {
      const map = MAPS[id];
      for (let seed = 1; seed <= 400; seed++) {
        const blocked = new Set(pickBlizzards(map, maxBlizzards(map), createRng(seed)));
        const open = map.territoryIds.filter((t) => !blocked.has(t));
        // No open territory is walled in by blizzards...
        for (const t of open) expect(map.adjacency[t].some((n) => !blocked.has(n)), `${id} seed ${seed}: ${t} is walled in`).toBe(true);
        // ...and the open territories form one network (no side of the map cut off from the other).
        const seen = new Set([open[0]]);
        const queue = [open[0]];
        while (queue.length) for (const n of map.adjacency[queue.pop()!]) if (!blocked.has(n) && !seen.has(n)) (seen.add(n), queue.push(n));
        expect(seen.size, `${id} seed ${seed}: map split by blizzards`).toBe(open.length);
      }
    }
  });
});

describe('round-1 late-turn bonus', () => {
  it('the Nth player in turn order gets at least N armies in round 1 only', () => {
    let state = setup(6, { autoSetup: true }).state;
    const order = state.turnOrder;
    const got: number[] = [];
    for (let i = 0; i < order.length; i++) {
      const pid = state.currentPlayer!;
      expect(pid).toBe(order[i]);
      const p = state.players.find((x) => x.id === pid)!;
      got.push(p.armiesToPlace);
      expect(p.armiesToPlace).toBeGreaterThanOrEqual(Math.max(3, i + 1));
      state = applyAction(state, pid, { type: 'place', placements: { [territoriesOf(state, pid)[0]]: p.armiesToPlace } }).state;
      state = applyAction(state, pid, { type: 'end_turn' }).state;
    }
    // 7 territories each, no continents at random: 3, 3, 3, 4, 5, 6.
    expect(got.slice(3)).toEqual([4, 5, 6].map((n, k) => Math.max(n, got[3 + k])));
    // Round 2: back to normal reinforcements.
    const p = state.players.find((x) => x.id === state.currentPlayer)!;
    expect(state.round).toBe(2);
    expect(p.armiesToPlace).toBe(viewFor(state, null).players.find((x) => x.id === p.id)!.income!.total);
  });

  it('can be turned off', () => {
    let state = setup(6, { autoSetup: true, firstRoundBonus: false }).state;
    for (let i = 0; i < 5; i++) {
      const pid = state.currentPlayer!;
      const p = state.players.find((x) => x.id === pid)!;
      state = applyAction(state, pid, { type: 'place', placements: { [territoriesOf(state, pid)[0]]: p.armiesToPlace } }).state;
      state = applyAction(state, pid, { type: 'end_turn' }).state;
    }
    const last = state.players.find((x) => x.id === state.currentPlayer)!;
    expect(last.armiesToPlace).toBe(viewFor(state, null).players.find((x) => x.id === last.id)!.income!.total);
  });
});

describe('chosen capitals', () => {
  it('players pick their capitals in turn order before turn 1, each getting +3 armies there', () => {
    let state = setup(3, { capitals: true, chooseCapitals: true, autoSetup: true }).state;
    expect(state.phase).toBe('capitals');
    expect(state.capitals).toEqual({});
    const order = state.turnOrder;
    for (const pid of order) {
      expect(state.currentPlayer).toBe(pid);
      const lm = legalMoves(state, pid);
      expect(lm.capitalChoices.length).toBe(territoriesOf(state, pid).length);
      expect(() => applyAction(state, pid, { type: 'end_turn' })).toThrow(RuleError);
      const enemy = TERRITORY_IDS.find((t) => state.territories[t].owner !== pid)!;
      expect(() => applyAction(state, pid, { type: 'choose_capital', territory: enemy })).toThrow(RuleError);
      // Pick the weakest territory to show the +2.
      const pick = [...lm.capitalChoices].sort((a, b) => state.territories[a].armies - state.territories[b].armies)[0];
      const before = state.territories[pick].armies;
      const res = applyAction(state, pid, { type: 'choose_capital', territory: pick });
      expect(res.state.territories[pick].armies).toBe(before + 3);
      expect(res.events).toContainEqual({ type: 'capital_chosen', player: pid, territory: pick, armies: 3 });
      expect(res.state.capitals[pid]).toBe(pick);
      state = res.state;
    }
    // Everyone picked: turn 1 starts with the first player reinforcing.
    expect(state.phase).toBe('reinforce');
    expect(state.currentPlayer).toBe(order[0]);
    expect(Object.keys(state.capitals)).toHaveLength(3);
  });

  it('under fog of war, a capital pick is only revealed to players who can see it', () => {
    const state = setup(3, { capitals: true, chooseCapitals: true, autoSetup: true, fogOfWar: true }).state;
    const pid = state.currentPlayer!;
    const others = state.turnOrder.filter((id) => id !== pid);
    // A territory at least one rival cannot see, so the fog actually has something to hide.
    const hiddenFrom = (t: string) => others.filter((o) => !visibleTerritories(state.territories, o, MAPS.classic).has(t));
    const pick = legalMoves(state, pid).capitalChoices.find((t) => hiddenFrom(t).length > 0)!;
    expect(pick).toBeDefined();
    const res = applyAction(state, pid, { type: 'choose_capital', territory: pick });
    const chosen = res.events.filter((e) => e.type === 'capital_chosen');
    expect(chosen).toHaveLength(1);
    expect(redactEvents(res.state, pid, chosen)).toEqual(chosen);
    expect(redactEvents(res.state, null, chosen)).toEqual(chosen);
    for (const other of others) {
      const sees = !hiddenFrom(pick).includes(other);
      expect(redactEvents(res.state, other, chosen)[0].type).toBe(sees ? 'capital_chosen' : 'fogged');
    }
  });

  it('without chooseCapitals, capitals are assigned automatically with no bonus armies', () => {
    const state = setup(3, { capitals: true, autoSetup: true }).state;
    expect(state.phase).toBe('reinforce');
    expect(Object.keys(state.capitals)).toHaveLength(3);
  });

  it('a capital rolls 3 dice only when defending, never more than 3 when attacking', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, capitals: true }).state);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const myCap = state.capitals[me];
    state.territories[myCap].armies = 20;
    const target = ADJACENCY[myCap].find((t) => !Object.values(state.capitals).includes(t))!;
    const rival = state.turnOrder.find((id) => id !== me)!;
    state.territories[target] = { owner: rival, armies: 10 };
    const battle = applyAction(state, me, { type: 'attack', from: myCap, to: target }).events.find((e) => e.type === 'battle')!;
    expect(battle.type === 'battle' && battle.attackerDice).toHaveLength(3);
    expect(battle.type === 'battle' && battle.defenderDice).toHaveLength(2);
    expect(legalMoves(state, me).attacks.filter((a) => a.from === myCap).every((a) => a.maxDice <= 3)).toBe(true);
  });
});

describe('capital placement bonus and 8 blizzards', () => {
  it('auto-assigned capitals also get 3 extra armies', () => {
    const before = setup(3, { capitals: true, setupBatch: 40 }).state;
    const after = finishSetup(before);
    for (const [pid, t] of Object.entries(after.capitals)) {
      const total = territoriesOf(after, pid).reduce((n, x) => n + after.territories[x].armies, 0);
      expect(total).toBe(35 + 3);
      expect(after.territories[t].armies).toBeGreaterThanOrEqual(4);
    }
  });

  it('the classic map can hold 8 blizzards without trapping anyone', async () => {
    const { MAPS, pickBlizzards, createRng } = await import('../src/index.js');
    for (let seed = 1; seed <= 300; seed++) {
      const b = new Set(pickBlizzards(MAPS.classic, 8, createRng(seed)));
      expect(b.size).toBe(8);
      const open = TERRITORY_IDS.filter((t) => !b.has(t));
      const seen = new Set([open[0]]);
      const q = [open[0]];
      while (q.length) for (const n of ADJACENCY[q.pop()!]) if (!b.has(n) && !seen.has(n)) (seen.add(n), q.push(n));
      expect(seen.size).toBe(open.length);
    }
  });
});

describe('rules text', () => {
  it('lists the same starting armies as the engine for every scaled map', async () => {
    const { RULES_TEXT } = await import('../src/rules.js');
    const labels: Record<string, string> = { world: 'World', world_large: 'Grand World', europe: 'Europe', greater_europe: 'Greater Europe', europe_classic: 'Europe Advanced', usa: 'USA', asia: 'Asia', fantasy: 'Realms of Halvaren' };
    // every offered board except classic (whose fixed table is listed separately) is covered
    expect(Object.keys(labels).sort()).toEqual(MAP_IDS.filter((id) => id !== 'classic').sort());
    const section = RULES_TEXT.slice(RULES_TEXT.indexOf('PLAYERS & STARTING ARMIES'), RULES_TEXT.indexOf('SETUP'));
    for (const [id, label] of Object.entries(labels)) {
      const m = MAPS[id as keyof typeof MAPS];
      const line = section.match(new RegExp(`(?:\\n  |\\. )${label}: (?:2 players )?([^A-Z\\n]*)`))?.[1] ?? '';
      const listed = Object.fromEntries([...line.matchAll(/(\d+): (\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]));
      const two = line.match(/^(\d+),/);
      if (two) listed[2] = Number(two[1]);
      for (let p = 2; p <= m.maxPlayers; p++) expect(listed[p], `${label} ${p} players`).toBe(m.startingArmies(p));
    }
  });
});

describe('fog of war hides everything a player cannot see', () => {
  it('hides other players\' counts, income and continents unless all their territories are visible', () => {
    const state = finishSetup(setup(4, { setupBatch: 40, fogOfWar: true }).state);
    const [me, ...others] = state.turnOrder;
    const v = viewFor(state, me);
    const mine = v.players.find((p) => p.id === me)!;
    expect(mine.armyCount).not.toBeNull();
    expect(mine.territoryCount).not.toBeNull();
    expect(mine.income).not.toBeNull();
    for (const o of others) {
      const pv = v.players.find((p) => p.id === o)!;
      const allVisible = territoriesOf(state, o).every((t) => !v.territories[t].hidden);
      if (allVisible) continue;
      expect(pv.armyCount).toBeNull();
      expect(pv.territoryCount).toBeNull();
      expect(pv.cardCount).toBe(state.players.find((p) => p.id === o)!.cards.length); // card counts stay public
      expect(pv.income).toBeNull();
      expect(pv.cards).toBeNull();
    }
    // Spectators see everything.
    const spec = viewFor(state, null);
    for (const p of spec.players.filter((x) => !x.isNeutral)) {
      expect(p.armyCount).not.toBeNull();
      expect(p.territoryCount).not.toBeNull();
    }
    // A continent only shows an owner if the viewer can see all of it.
    for (const [cid, owner] of Object.entries(v.continentOwners)) {
      if (!owner || owner === me) continue;
      const c = CONTINENTS.find((x) => x.id === cid)!;
      expect(c.territories.every((t) => !v.territories[t].hidden)).toBe(true);
    }
  });

  it('shows another player\'s numbers once every territory they hold is visible', () => {
    const state = finishSetup(setup(3, { setupBatch: 40, fogOfWar: true }).state);
    const [me, other] = state.turnOrder;
    // Shrink `other` to one territory next to mine.
    const mineT = territoriesOf(state, me)[0];
    const target = ADJACENCY[mineT][0];
    for (const t of territoriesOf(state, other)) state.territories[t].owner = me;
    state.territories[target] = { owner: other, armies: 4 };
    const pv = viewFor(state, me).players.find((p) => p.id === other)!;
    expect(pv.territoryCount).toBe(1);
    expect(pv.armyCount).toBe(4);
  });

  it('redacts other players\' income, card draws and trades from the event stream', () => {
    const state = finishSetup(setup(4, { setupBatch: 40, fogOfWar: true }).state);
    const [me, other] = state.turnOrder;
    const events: GameEvent[] = [
      { type: 'turn_started', player: other, turnNumber: 2, round: 1, reinforcements: { territories: 10, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0, total: 3 } },
      { type: 'card_drawn', player: other },
      { type: 'traded', player: other, cardIds: [1, 2, 3], cards: [], armies: 4, bonusTerritory: null },
      { type: 'card_drawn', player: me },
    ];
    const out = redactEvents(state, me, events);
    // With 4 players on 42 territories, `other` always holds something `me` cannot see.
    expect(territoriesOf(state, other).some((t) => viewFor(state, me).territories[t].hidden)).toBe(true);
    expect(out[0]).toMatchObject({ type: 'turn_started', player: other, reinforcements: { hidden: true, total: 0 } });
    expect(out[1]).toEqual(events[1]); // card draws are public, like card counts
    expect(out[2]).toEqual({ type: 'fogged', kind: 'traded' });
    expect(out[3]).toEqual(events[3]);
    // Spectators get everything as is.
    expect(redactEvents(state, null, events)).toEqual(events);
  });

  it('hides another player\'s armies to place and pending occupy behind the fog', () => {
    const state = finishSetup(setup(4, { setupBatch: 40, fogOfWar: true }).state);
    const [first, me] = state.turnOrder;
    expect(state.currentPlayer).toBe(first);
    const hiddenFromMe = (t: string) => viewFor(state, me).territories[t].hidden;
    expect(territoriesOf(state, first).some(hiddenFromMe)).toBe(true);
    // `first` is reinforcing: their armies to place equal their (hidden) income.
    expect(state.players.find((p) => p.id === first)!.armiesToPlace).toBeGreaterThan(0);
    expect(viewFor(state, me).players.find((p) => p.id === first)!.armiesToPlace).toBe(0);
    expect(viewFor(state, null).players.find((p) => p.id === first)!.armiesToPlace).toBeGreaterThan(0);
    // A pending occupy between two territories `me` cannot see.
    const to = territoriesOf(state, first).find(hiddenFromMe)!;
    const from = ADJACENCY[to].find(hiddenFromMe) ?? to;
    state.pendingConquest = { from, to, minArmies: 3, maxArmies: 29 };
    expect(viewFor(state, me).pendingConquest).toBeNull();
    expect(viewFor(state, first).pendingConquest).toEqual(state.pendingConquest);
    expect(viewFor(state, null).pendingConquest).toEqual(state.pendingConquest);
  });

  it('lifts the fog for eliminated players and once the game is over', () => {
    const state = finishSetup(setup(4, { setupBatch: 40, fogOfWar: true }).state);
    const [, me, other] = state.turnOrder;
    const hidden = (s: GameState) => Object.values(viewFor(s, me).territories).filter((t) => t.hidden).length;
    expect(hidden(state)).toBeGreaterThan(0);
    const events: GameEvent[] = [{ type: 'traded', player: other, cardIds: [1, 2, 3], cards: [], armies: 4, bonusTerritory: null }];
    expect(redactEvents(state, me, events)[0].type).toBe('fogged');
    const out = { ...state, players: state.players.map((p) => (p.id === me ? { ...p, alive: false } : p)) };
    expect(hidden(out)).toBe(0);
    expect(viewFor(out, me).players.find((p) => p.id === other)!.armyCount).not.toBeNull();
    expect(redactEvents(out, me, events)).toEqual(events);
    const over = { ...state, phase: 'finished' as const };
    expect(hidden(over)).toBe(0);
  });
});
