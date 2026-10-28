import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, getMap, startGame, viewFor, type Action, type GameView } from '@risk/engine';
import { choosePlannedAction, cleanPlan, isLegalAction, winChance, type Plan } from '../src/planned-bot.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';
import { playHeadless, seeded } from './headless.js';

/** A plan that is sometimes sensible, sometimes full of bad ids, wrong types and extreme numbers. */
function randomPlan(view: GameView, random: () => number): Plan | null {
  const r = random();
  if (r < 0.2) return null;
  const map = getMap(view.options.map);
  const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const others = view.players.filter((p) => p.id !== view.you).map((p) => p.id);
  const junk = [undefined, null, 'nope', 42, NaN, '', {}, [], 'classic'] as unknown[];
  const plan: Record<string, unknown> = {
    focus: random() < 0.3 ? pick(junk) : random() < 0.5 ? pick(map.territoryIds) : pick(map.continents).id,
    target: random() < 0.3 ? pick(junk) : pick(others),
    avoid: random() < 0.3 ? pick(junk) : others.filter(() => random() < 0.3).concat(random() < 0.3 ? ['ghost'] : []),
    aggression: random() < 0.3 ? pick([NaN, -4, 9, 'high', Infinity, null]) : random(),
    capitalGarrison: random() < 0.3 ? pick([NaN, -1, 1e9, 'x', 0, 2.5]) : Math.floor(random() * 20),
    capital: random() < 0.4 ? pick(junk) : random() < 0.5 ? pick(map.territoryIds) : null,
    riskTolerance: random() < 0.3 ? pick(junk) : random(),
    moveCapitalStack: random() < 0.5,
    purposeMin: random() < 0.3 ? pick(junk) : random() * 4,
    borderGuard: random() < 0.3 ? pick(junk) : random() * 3,
    fortify: random() < 0.8,
    stallPressure: random() < 0.8,
    skipCard: random() < 0.3,
    skipCardReason: random() < 0.5 ? 'because' : '',
    winPath: pick(['diplomacy', 'bonuses', 'cards', 'capitals', 'kills', 'hopeless', 'junk', null]),
  };
  return plan as Plan;
}

describe('planned bot, headless six-player games with the default preset', () => {
  for (const map of ['classic', 'europe'] as const) {
    it(`plays legal moves to a finish on ${map} with random and null plans`, () => {
      let finished = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const r = playHeadless({
          seed,
          map,
          seats: Array(6).fill('planned'),
          plan: seed % 4 === 0 ? () => null : (_s, view, rnd) => randomPlan(view, rnd),
          maxTurns: 1500,
        });
        // playHeadless throws on any rule error; also nothing the view's legal list forbids.
        expect(r.illegal).toEqual([]);
        if (r.state.phase === 'finished') finished++;
      }
      expect(finished).toBe(8);
    }, 120_000);
  }

  it('plays alongside the engine bot too', () => {
    for (const seed of [11, 12, 13]) {
      const r = playHeadless({ seed, map: 'classic', seats: ['planned', 'engine', 'planned', 'engine', 'planned', 'engine'] });
      expect(r.illegal).toEqual([]);
      expect(r.state.phase).toBe('finished');
    }
  }, 60_000);

  it('picks a capital from the legal choices, honouring a valid plan capital', () => {
    let state = createGame('C1', { ...DEFAULT_OPTIONS, maxPlayers: 6, map: 'classic' }, 5);
    for (let i = 0; i < 6; i++) state = addPlayer(state, `s${i}`, `P${i}`, true);
    state = startGame(state).state;
    expect(state.phase).toBe('capitals');
    const me = state.currentPlayer!;
    const view = viewFor(state, me);
    const choices = view.legal!.capitalChoices;
    const a = choosePlannedAction(view, me, null, seeded(1));
    expect(a?.type).toBe('choose_capital');
    expect(choices).toContain((a as Extract<Action, { type: 'choose_capital' }>).territory);
    const wanted = choices[choices.length - 1];
    expect(choosePlannedAction(view, me, { capital: wanted }, seeded(1))).toEqual({ type: 'choose_capital', territory: wanted });
    // A capital that is not on offer is ignored.
    const other = choosePlannedAction(view, me, { capital: 'nowhere' }, seeded(1)) as Extract<Action, { type: 'choose_capital' }>;
    expect(choices).toContain(other.territory);
  });

  it('never attacks an avoided player when it does not win the game', () => {
    let state = createGame('A1', { ...DEFAULT_OPTIONS, maxPlayers: 6, map: 'classic', fogOfWar: false }, 7);
    for (let i = 0; i < 6; i++) state = addPlayer(state, `s${i}`, `P${i}`, true);
    state = startGame(state).state;
    const rnd = seeded(3);
    let checked = 0;
    for (let n = 0; n < 4000 && state.phase !== 'finished' && checked < 30; n++) {
      const me = state.currentPlayer!;
      const view = viewFor(state, me);
      const avoid = view.players.filter((p) => p.id !== me).map((p) => p.id);
      if (state.phase === 'attack' && view.legal!.attacks.length > 0 && !view.legal!.pendingConquest) {
        const a = choosePlannedAction(view, me, { avoid }, rnd);
        // Everyone is avoided: only a game-winning attack is allowed (not possible this early).
        expect(a?.type).not.toBe('attack');
        checked++;
      }
      const action = choosePlannedAction(view, me, null, rnd)!;
      state = applyAction(state, me, action).state;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('funds high-value elimination placements ahead of plan placeOn directives', () => {
    let state = createGame('K1', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', fogOfWar: false, cardValues: 'progressive' }, 1);
    for (const [id, n] of [['s0', 'Attacker'], ['s1', 'Victim'], ['s2', 'Other']]) state = addPlayer(state, id, n, true);
    state = startGame(state).state;
    for (const t of getMap('classic').territoryIds) state.territories[t] = { owner: 's2', armies: 10 };
    state.territories.brazil = { owner: 's0', armies: 3 };
    state.territories.western_europe = { owner: 's0', armies: 1 };
    state.territories.argentina = { owner: 's1', armies: 1 };
    state.territories.north_africa = { owner: 's1', armies: 1 };
    state.players.find(p => p.id === 's1')!.cards = [0, 1, 2, 3].map(id => ({ id: 2000 + id, kind: 'cavalry', territory: null }));
    state.players.find(p => p.id === 's0')!.armiesToPlace = 10;
    state.phase = 'reinforce';
    state.currentPlayer = 's0';
    const view = viewFor(state, 's0');
    const plan: Plan = {
      placeOn: ['western_europe'],
      route: [],
      focusTerritory: null,
      focusContinent: null,
      target: null,
      avoid: new Set(),
      noAttack: new Set(),
      aggression: 0.5,
      capitalGarrison: null,
      capital: null,
      riskTolerance: 0.5,
      moveCapitalStack: false,
      purposeMin: 0.2,
      borderGuard: 1,
      fortify: true,
      stallPressure: false,
      skipCard: false,
      skipCardReason: '',
      winPath: 'kills',
      commitArmies: 0,
      stopAfterBonus: false,
      stopAfterRoute: false,
    };
    const action = choosePlannedAction(view, 's0', plan, seeded(1));
    expect(action?.type).toBe('place');
    if (action?.type === 'place') {
      expect(action.placements.brazil).toBeGreaterThan(0);
    }
  });
});

describe('cleanPlan', () => {
  it('drops unknown ids and clamps numbers', () => {
    let state = createGame('P1', { maxPlayers: 3 }, 2);
    for (const [id, n] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) state = addPlayer(state, id, n, true);
    state = startGame(state).state;
    const view = viewFor(state, 'a');
    const t = getMap('classic').territoryIds[0];
    const c = cleanPlan({ focus: t, target: 'b', avoid: ['c', 'a', 'zzz'], aggression: 7, capitalGarrison: -3, capital: 'x' }, view, 'a');
    expect(c).toMatchObject({ focusTerritory: t, focusContinent: null, target: 'b', aggression: 1, capitalGarrison: 1, capital: null });
    expect([...c.avoid]).toEqual(['c']);
    const bad = cleanPlan({ focus: 'asia-ish', target: 'ghost', aggression: NaN } as unknown as Plan, view, 'a');
    expect(bad.focusTerritory).toBeNull();
    expect(bad.target).toBeNull();
    expect(bad.aggression).toBe(0.5);
    expect(cleanPlan(null, view, 'a').avoid.size).toBe(0);
  });
});

describe('isLegalAction', () => {
  it('rejects what the legal list does not offer', () => {
    let state = createGame('L1', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false }, 4);
    for (const [id, n] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) state = addPlayer(state, id, n, true);
    state = startGame(state).state;
    const me = state.currentPlayer!;
    const view = viewFor(state, me);
    const lm = view.legal!;
    expect(lm.phase).toBe('reinforce');
    const mine = lm.canPlaceOn[0];
    expect(isLegalAction(view, { type: 'place', placements: { [mine]: lm.placeLimit } })).toBe(true);
    expect(isLegalAction(view, { type: 'place', placements: { [mine]: lm.placeLimit + 1 } })).toBe(false);
    expect(isLegalAction(view, { type: 'place', placements: { nowhere: 1 } })).toBe(false);
    expect(isLegalAction(view, { type: 'end_turn' })).toBe(false);
    expect(isLegalAction(view, { type: 'fortify', from: mine, to: mine, armies: 1 })).toBe(false);
  });
});

describe('winChance', () => {
  it('rises with the attacking stack and falls against a capital', () => {
    expect(winChance(10, 3, 2, false)).toBeGreaterThan(0.9);
    expect(winChance(10, 3, 3, false)).toBeLessThan(winChance(10, 3, 2, false));
    expect(winChance(2, 10, 2, false)).toBeLessThan(0.05);
    expect(winChance(1000, 900, 2, false)).toBeGreaterThan(0.5); // scaled, does not blow up
  });
});
