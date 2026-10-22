import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDeck, getMap, legalMoves, reinforcementsFor, viewFor, type GameOptions, type GameState } from '@risk/engine';
import { candidates, makeTraits, playGame, publicIncomes, seededRandom, stateFromView, type Agent, type DecisionContext } from '@risk/selfplay';
import { branchAgent, branchStats, DEFAULT_BRANCH, type FogSearch } from '../src/branch.js';
import { DEFAULT_FOG_SAMPLER, FogTracker, sampleBoard } from '../src/fog-sampler.js';
import { FogGuesser, type FogGuess } from '../src/fog-guesser.js';
import { teacher, teacherPickWith, DEFAULT_TEACHER_PARAMS } from '../src/index.js';

/** The league's fog settings (packages/delove/configs/gen5-randomfog.json, without the blizzards). */
const FOG: Partial<GameOptions> = { map: 'world', fogOfWar: true, capitals: true, chooseCapitals: true, autoSetup: true, randomDeal: true, cardValues: 'progressive' };

/** The true board of a 4-player fog game in the attack phase of round 4, and its current player's view of it. */
function fogMoment(): { truth: GameState; view: GameState; me: string; earlier: GameState[] } {
  let truth: GameState | null = null;
  const earlier: GameState[] = [];
  let me: string | null = null;
  const spy: Agent = {
    id: 'spy',
    choose(ctx) {
      if (!truth && ctx.state.phase === 'attack') {
        if (ctx.state.round >= 4) (truth = ctx.state), (me = ctx.me);
        else if (earlier.length === 0 || earlier[earlier.length - 1].round < ctx.state.round) earlier.push(ctx.state);
      }
      return teacher.choose(ctx);
    },
  };
  playGame({ seed: 11, seats: [{ agent: spy }, { agent: teacher }, { agent: teacher }, { agent: teacher }], options: FOG });
  const view = stateFromView(viewFor(truth!, me!), seededRandom(3));
  return { truth: truth!, view, me: me!, earlier: earlier.map((s) => stateFromView(viewFor(s, me!), seededRandom(3))) };
}

describe('fog sampler', () => {
  const { truth, view, me, earlier } = fogMoment();
  const map = getMap(view.options.map);
  const hidden = map.territoryIds.filter((t) => view.territories[t].hidden);
  const tracker = new FogTracker();
  for (const s of earlier) tracker.observe(s, me);
  const memory = tracker.observe(view, me);

  it('has something to sample', () => {
    expect(hidden.length).toBeGreaterThan(5);
    expect(publicIncomes(view)).toBeDefined();
  });

  it('keeps everything the seat can see and fills every hidden territory', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const b = sampleBoard(view, me, seededRandom(seed), memory);
      const alive = new Set(view.players.filter((p) => p.alive && p.id !== me).map((p) => p.id));
      for (const t of map.territoryIds) {
        if (!view.territories[t].hidden) expect(b.territories[t]).toEqual({ owner: view.territories[t].owner, armies: view.territories[t].armies });
        else {
          expect(alive.has(b.territories[t].owner!)).toBe(true);
          expect(b.territories[t].armies).toBeGreaterThanOrEqual(1);
          expect(b.territories[t].hidden).toBeUndefined();
        }
      }
      for (const p of view.players.filter((p) => p.alive && !p.isNeutral)) expect(map.territoryIds.some((t) => b.territories[t].owner === p.id)).toBe(true);
      // every non-neutral player has a capital again
      for (const p of view.players.filter((p) => !p.isNeutral)) expect(b.capitals[p.id]).toBeDefined();
      expect(new Set(Object.values(b.capitals)).size).toBe(Object.keys(b.capitals).length);
    }
  });

  it('deals hidden cards consistent with the public counts and the seat hand', () => {
    const b = sampleBoard(view, me, seededRandom(7), memory);
    b.players.forEach((p, i) => expect(p.cards.length).toBe(truth.players[i].cards.length));
    expect(b.players.find((p) => p.id === me)!.cards).toEqual(truth.players.find((p) => p.id === me)!.cards);
    expect(b.deck.length).toBe(truth.deck.length);
    expect(b.discard.length).toBe(truth.discard.length);
    // every card exactly once, the same cards as the true game
    const ids = (s: GameState) => [...s.players.flatMap((p) => p.cards), ...s.deck, ...s.discard].map((c) => c.id).sort((x, y) => x - y);
    expect(ids(b)).toEqual(ids(truth));
    expect(new Set(ids(b)).size).toBe(ids(b).length);
    expect(ids(b).length).toBeLessThanOrEqual(buildDeck(map).length);
  });

  it('is deterministic from its random source and varies across seeds', () => {
    expect(sampleBoard(view, me, seededRandom(9), memory)).toEqual(sampleBoard(view, me, seededRandom(9), memory));
    const a = sampleBoard(view, me, seededRandom(9), memory);
    const b = sampleBoard(view, me, seededRandom(10), memory);
    expect(hidden.some((t) => a.territories[t].owner !== b.territories[t].owner || a.territories[t].armies !== b.territories[t].armies)).toBe(true);
    expect(view.territories[hidden[0]].hidden).toBe(true); // the view itself is untouched
  });

  it('keeps a territory seen this round with its last-seen owner', () => {
    const t = hidden[0];
    const opp = view.players.find((p) => p.alive && p.id !== me && !p.isNeutral)!.id;
    const fresh = { turn: view.turnNumber, seen: new Map([[t, { owner: opp, armies: 7, round: view.round }]]), capitals: new Map() };
    for (const seed of [1, 2, 3]) {
      const b = sampleBoard(view, me, seededRandom(seed), fresh, { ...DEFAULT_FOG_SAMPLER, repairPasses: 0, frontShare: 0 });
      expect(b.territories[t]).toEqual({ owner: opp, armies: 7 });
    }
  });

  it('brings opponents incomes toward the public ones', () => {
    const income = publicIncomes(view)!;
    const opps = view.players.filter((p) => p.alive && p.id !== me && !p.isNeutral).map((p) => p.id);
    const miss = (passes: number) => {
      let sum = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const b = sampleBoard(view, me, seededRandom(seed), memory, { ...DEFAULT_FOG_SAMPLER, repairPasses: passes });
        for (const p of opps) sum += Math.abs(reinforcementsFor(b, p).total - income[p]);
      }
      return sum;
    };
    expect(miss(3)).toBeLessThanOrEqual(miss(0));
  });

  it('a new game under the same id starts a fresh memory', () => {
    const tr = new FogTracker();
    tr.observe(view, me);
    const restart = tr.observe({ ...earlier[0], id: view.id }, me);
    expect(restart.turn).toBe(earlier[0].turnNumber);
    expect([...restart.seen.values()].every((s) => s.round === earlier[0].round)).toBe(true);
  });
});

describe('determinized branch and score', () => {
  const { view, me, truth } = fogMoment();
  const legal = legalMoves(view, me);
  const ctx = (seed: number): DecisionContext => ({
    state: view,
    me,
    seat: view.turnOrder.indexOf(me),
    legal,
    candidates: candidates(view, me, legal),
    traits: makeTraits(),
    random: seededRandom(seed),
  });
  const pick = teacherPickWith(DEFAULT_TEACHER_PARAMS);

  it('samples one board per rollout seed and shares them across every option', () => {
    const calls: number[] = [];
    const fog: FogSearch = {
      anchor: pick,
      samples: 8,
      sample: (state, who, random) => {
        calls.push(random());
        return sampleBoard(state, who, random);
      },
    };
    const agent = branchAgent('fog-test', pick, null, { ...DEFAULT_BRANCH, options: 3, horizon: 1, skip: [] }, null, null, fog);
    const before = { branched: branchStats.branched, sims: branchStats.simulations };
    const action = agent.choose(ctx(5));
    expect(action).not.toBeNull();
    const branched = branchStats.branched - before.branched;
    expect(branched).toBe(1);
    expect(calls).toHaveLength(8); // not 8 per option
    const sims = branchStats.simulations - before.sims;
    expect(sims % 8).toBe(0);
    expect(sims / 8).toBeGreaterThanOrEqual(2); // every option played on the same 8 boards
    // the same decision random gives the same pick
    expect(agent.choose(ctx(5))).toEqual(action);
  });

  it('leaves normal games and fog off unchanged', () => {
    let sampled = 0;
    const fog: FogSearch = { anchor: pick, samples: 8, sample: (s, who, r) => (sampled++, sampleBoard(s, who, r)) };
    const opts = { ...DEFAULT_BRANCH, options: 3, horizon: 1, skip: [] };
    const state = { ...truth, options: { ...truth.options, fogOfWar: false } };
    const clear = { ...ctx(5), state, legal: legalMoves(state, me), candidates: candidates(state, me, legalMoves(state, me)) };
    const a = branchAgent('fog-test', pick, null, opts, null, null, fog).choose(clear);
    const b = branchAgent('fog-test', pick, null, opts).choose({ ...clear, random: seededRandom(5) });
    expect(a).toEqual(b);
    expect(sampled).toBe(0);
  });
});

describe('learned fog guess', () => {
  const { view, me } = fogMoment();
  const map = getMap(view.options.map);
  const hidden = map.territoryIds.filter((t) => view.territories[t].hidden);
  const opponents = view.players.filter((p) => p.alive && p.id !== me).map((p) => p.id);

  it('guesses every hidden territory, among the opponents still alive', () => {
    // an untrained tiny guesser (python/test_fog_guess.py --fixture): the shapes and the slot mapping, not the quality
    const guesser = new FogGuesser(fileURLToPath(new URL('./fixtures/tiny-guess.onnx', import.meta.url)));
    const g = guesser.guess(view, me);
    expect([...g.territories.keys()].sort()).toEqual([...hidden].sort());
    for (const tg of g.territories.values()) {
      expect(tg.owners.length).toBeGreaterThan(0);
      for (const o of tg.owners) expect(opponents).toContain(o);
      expect(tg.p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      expect(tg.bins).toHaveLength(g.armyBins.length);
      expect(tg.bins.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
    expect(guesser.guess(view, me)).toEqual(g); // deterministic
  });

  it('draws hidden owners and armies from the guess, without the hand-written front armies', () => {
    const opp = view.players.find((p) => p.alive && p.id !== me && !p.isNeutral)!.id;
    const armyBins: [number, number][] = [[1, 1], [2, 2], [3, 4], [5, 8], [9, 16], [17, 1e9]];
    const guess: FogGuess = { armyBins, territories: new Map(hidden.map((t) => [t, { owners: [opp], p: [1], bins: [0, 0, 0, 1, 0, 0] }])) };
    const opts = { ...DEFAULT_FOG_SAMPLER, keep: 0, keepNeutral: 0, repairPasses: 0 };
    const b = sampleBoard(view, me, seededRandom(4), undefined, opts, guess);
    for (const t of hidden) {
      expect(b.territories[t].owner).toBe(opp);
      expect(b.territories[t].armies).toBeGreaterThanOrEqual(5);
      expect(b.territories[t].armies).toBeLessThanOrEqual(8);
    }
    expect(sampleBoard(view, me, seededRandom(4), undefined, opts, guess)).toEqual(b);
  });
});
