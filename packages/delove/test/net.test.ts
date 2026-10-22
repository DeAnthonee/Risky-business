import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getMap } from '@risk/engine';
import { decisionInput, encodeDecision, playGame, riskyBot, runBatch, stepAgent, type StepContext } from '@risk/selfplay';
import { adjacencyMatrix, branchFromEnv, discoverNetAgents, NetScorer, netAgent, searchAgent, seatOrder } from '../src/index.js';

// Random weights (hidden 8): it plays badly, but exercises encoder -> ONNX -> worker -> move exactly like a trained model.
const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));
// The same with fog inputs (two more columns; tiny-fog.json says fogInputs 1), as train.py --fog-dropout makes them.
const TINY_FOG = fileURLToPath(new URL('./fixtures/tiny-fog.onnx', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('Delove network player', () => {
  it('fog: a model with fog inputs reads them in every game; any model plays a fog game on its seat view', async () => {
    const fogModel = netAgent('fogtiny@1', TINY_FOG);
    const plain = netAgent('tiny@1', TINY);
    expect(fogModel.fogInputs).toBe(1);
    expect(plain.fogInputs).toBeUndefined();
    for (const options of [{ map: 'world', fogOfWar: true, autoSetup: true }, { map: 'world' }]) {
      const r = await runBatch({ games: 1, seed: 6, seats: () => [{ agent: fogModel }, { agent: plain }, { agent: riskyBot }], options, maxTurns: 25 });
      expect(r[0].turns).toBeGreaterThan(0);
    }
  });

  it('fog: the search seat (delove-branch) never searches under fog; it takes fog seats only with a fog-trained ranker', async () => {
    const fogSearch = branchFromEnv(FIXTURES, { DELOVE_BRANCH_RANKER: 'tiny-fog', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1' });
    const plainSearch = branchFromEnv(FIXTURES, { DELOVE_BRANCH_RANKER: 'tiny', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1' });
    expect(fogSearch.fogInputs).toBe(1);
    expect(plainSearch.fogInputs).toBeUndefined();
    // a fog game with three search seats: fast because no rollout runs (a search would take far longer than this)
    const t0 = Date.now();
    const r = await runBatch({ games: 1, seed: 2, seats: () => [{ agent: fogSearch }, { agent: plainSearch }, { agent: fogSearch }], options: { fogOfWar: true, autoSetup: true }, maxTurns: 20 });
    expect(r[0].turns).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('sees seats in the same order as the self-play harness', () => {
    const spy = stepAgent('spy@1', (ctx) => {
      expect(seatOrder(ctx.state)[ctx.seat]).toBe(ctx.me);
      return 0;
    });
    playGame({ seed: 1, seats: [{ agent: spy }, { agent: riskyBot }, { agent: spy }], maxTurns: 3 });
  });

  it('builds the adjacency matrix in territory order', () => {
    const map = getMap('classic');
    const m = adjacencyMatrix(map);
    const T = map.territoryIds.length;
    let edges = 0;
    for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) (edges += m[i * T + j]), expect(m[i * T + j]).toBe(m[j * T + i]);
    expect(edges).toBe(map.edges.length * 2);
  });

  it('scores every candidate and gives a win probability', () => {
    const scorer = new NetScorer(TINY);
    let checked = 0;
    const probe = stepAgent('probe@1', (ctx: StepContext) => {
      const { logits, value } = scorer.score(ctx);
      expect(logits.length).toBe(ctx.candidates.length);
      expect(logits.every(Number.isFinite)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      checked++;
      return 0;
    });
    playGame({ seed: 2, seats: [{ agent: probe }, { agent: riskyBot }], maxTurns: 4 });
    expect(checked).toBeGreaterThan(10);
  });

  it('plays whole games legally on any map, deterministically', () => {
    const net = netAgent('delove@0', TINY);
    for (const options of [{}, { map: 'world' as const }]) {
      const a = playGame({ seed: 3, seats: [{ agent: net }, { agent: riskyBot }], options, record: true, onIllegal: 'throw' });
      const b = playGame({ seed: 3, seats: [{ agent: net }, { agent: riskyBot }], options, record: true, onIllegal: 'throw' });
      expect(a.offList.every((n) => n === 0)).toBe(true);
      expect(a.records!.map((r) => r.choice)).toEqual(b.records!.map((r) => r.choice));
    }
  });

  it('samples with ctx.random when exploring, still replaying from the seed', () => {
    const explore = netAgent('delove@0-explore', TINY, 1);
    const run = () => playGame({ seed: 4, seats: [{ agent: explore }, { agent: riskyBot }], record: true, maxTurns: 20 }).records!.map((r) => r.choice);
    expect(run()).toEqual(run());
  });

  it('discovers only delove@N models in the models folder', () => {
    expect(discoverNetAgents(FIXTURES)).toEqual([]);
    expect(discoverNetAgents('does-not-exist')).toEqual([]);
  });
});

describe('Delove lookahead player', () => {
  const VALUE = fileURLToPath(new URL('./fixtures/tiny.value.onnx', import.meta.url));

  it('rates a batch of positions with the value model', () => {
    const scorer = new NetScorer(TINY, VALUE);
    let checked = 0;
    const probe = stepAgent('probe@2', (ctx: StepContext) => {
      const f = encodeDecision(decisionInput(ctx.state, seatOrder(ctx.state), ctx.me, ctx.traits, ctx.candidates));
      const v = scorer.values([f, f, f], ctx.state.options.map);
      expect(v.length).toBe(3);
      // Same network, separately exported graphs: equal up to kernel rounding.
      expect(v[0]).toBeCloseTo(scorer.score(ctx).value, 2);
      expect(v[1]).toBe(v[0]);
      checked++;
      return 0;
    });
    playGame({ seed: 5, seats: [{ agent: probe }, { agent: riskyBot }], maxTurns: 2 });
    expect(checked).toBeGreaterThan(5);
  });

  it('plays whole games legally with the lookahead, deterministically', () => {
    const look = searchAgent('delove@0+look', TINY, VALUE, { confident: 1.01 });
    for (const options of [{}, { capitals: true }]) {
      const run = () => playGame({ seed: 6, seats: [{ agent: look }, { agent: riskyBot }], options, record: true, onIllegal: 'throw', maxTurns: 60 });
      const a = run();
      expect(a.offList.every((n) => n === 0)).toBe(true);
      expect(a.records!.map((r) => r.choice)).toEqual(run().records!.map((r) => r.choice));
    }
  });
});
