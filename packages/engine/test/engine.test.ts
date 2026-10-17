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
  capitalsHeldBy,
  createGame,
  findSets,
  isValidSet,
  legalMoves,
  redactEvents,
  renamePlayer,
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

  it('capital conquest: capitals pay a bonus and capturing one takes the player over', () => {
    let state = finishSetup(setup(3, { setupBatch: 40, capitals: true }).state);
    expect(Object.keys(state.capitals)).toHaveLength(3);
    const me = state.currentPlayer!;
    const meP = state.players.find((x) => x.id === me)!;
    expect(meP.armiesToPlace).toBe(Math.max(3, Math.floor(14 / 3)) + 2);
    // Hand the current player a strong army next to a rival's capital.
    const rival = state.turnOrder.find((id) => id !== me)!;
    const cap = state.capitals[rival];
    const from = ADJACENCY[cap][0];
    state.territories[from] = { owner: me, armies: 80 };
    state.territories[cap].armies = 1;
    state.players.find((x) => x.id === rival)!.cards = state.deck.splice(0, 2);
    const rivalTerritories = territoriesOf(state, rival).length;
    state = applyAction(state, me, { type: 'place', placements: { [territoriesOf(state, me)[0]]: meP.armiesToPlace } }).state;
    const res = applyAction(state, me, { type: 'attack', from, to: cap, blitz: true, occupy: 'min' });
    expect(res.events.some((e) => e.type === 'capital_captured')).toBe(true);
    expect(res.events.some((e) => e.type === 'eliminated' && e.player === rival)).toBe(true);
    expect(territoriesOf(res.state, rival)).toHaveLength(0);
    expect(territoriesOf(res.state, me).length).toBeGreaterThanOrEqual(rivalTerritories + 1);
    expect(res.state.players.find((x) => x.id === me)!.cards.length).toBe(2);
    expect(capitalsHeldBy(res.state, me)).toContain(cap);
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
    expect(() => createGame('x', { blizzards: 8 })).toThrow(RuleError);
    expect(() => createGame('x', { blizzards: -1 })).toThrow(RuleError);
    const world = createGame('x', { map: 'world', blizzards: 12 });
    expect(setOptions(world, { map: 'classic' }).options.blizzards).toBe(7);
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
    usa: { territories: 45, regions: 8, maxPlayers: 10 },
    asia: { territories: 49, regions: 7, maxPlayers: 8 },
  };

  it('every map is well formed', async () => {
    const { MAPS, MAP_IDS } = await import('../src/index.js');
    expect(MAP_IDS).toEqual(['classic', 'world', 'world_large', 'europe', 'usa', 'asia']);
    for (const id of MAP_IDS) {
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

  it('scales starting armies on the new maps like the World map', async () => {
    const { MAPS } = await import('../src/index.js');
    const table = (id: keyof typeof MAPS) => Array.from({ length: MAPS[id].maxPlayers - 1 }, (_, i) => MAPS[id].startingArmies(i + 2));
    expect(table('world_large')).toEqual([60, 60, 60, 60, 52, 45, 39, 35, 31]);
    expect(table('europe')).toEqual([60, 44, 33, 26, 22, 20, 20]);
    expect(table('usa')).toEqual([60, 45, 34, 27, 23, 20, 20, 20, 20]);
    expect(table('asia')).toEqual([60, 49, 37, 29, 25, 21, 20]);
  });

  for (const id of ['world_large', 'europe', 'usa', 'asia'] as const) {
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
