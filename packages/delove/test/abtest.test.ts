import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dealOptions, dealSeats, loadPool, playDeals, plackettLuce, pooledSprt, scorecard, scorecardMarkdown, sprtConfig, type GatePool, type TableStats } from '../src/abtest.js';

// Built-in players only (no models in CI): risky@1, the server's bot, is far stronger than random@1.
const pool: GatePool = {
  v: 1,
  name: 'test-pool',
  seed: 777,
  base: 'random@1',
  sprt: { h0: 0, h1: 0.15, alpha: 0.05, beta: 0.05, maxDeals: 40 },
  tables: [
    { name: 'gen-3', players: 3, field: ['risky@1', '$base'], options: { autoSetup: true, map: 'gen1:t12' }, deals: 6, decides: true, maxTurns: 150 },
    { name: 'duel', players: 2, field: ['risky@1'], options: { autoSetup: true, map: 'gen1:t10' }, deals: 4, maxTurns: 150 },
  ],
};

describe('A/B harness (abtest.ts)', () => {
  it('seats the candidate at the rotating seat, the field around it, $base as the base', () => {
    expect(dealSeats(pool.tables[0], 0, 'cand', 'base')).toEqual(['cand', 'risky@1', 'base']);
    expect(dealSeats(pool.tables[0], 2, 'cand', 'base')).toEqual(['risky@1', 'base', 'cand']);
    expect(dealOptions(pool.tables[0], 42)).toEqual({ autoSetup: true, map: 'gen1-s42-p3-t12' });
  });

  it('duplicate deals: the base against itself differs by exactly 0 on every deal, and replays the same', async () => {
    const a = await playDeals(pool, 0, 0, 4, 'random@1', 'random@1');
    expect(a.map((d) => d.diff)).toEqual([0, 0, 0, 0]);
    expect(a.map((d) => d.seat)).toEqual([0, 1, 2, 0]);
    expect(a.every((d) => JSON.stringify(d.rankings[0]) === JSON.stringify(d.rankings[1]))).toBe(true);
    const b = await playDeals(pool, 0, 0, 4, 'random@1', 'random@1');
    expect(b).toEqual(a);
  });

  it('a much stronger candidate scores above the base, and the scorecard says so', async () => {
    const deals = [await playDeals(pool, 0, 0, 12, 'risky@1', 'random@1'), await playDeals(pool, 1, 0, 4, 'risky@1', 'random@1')];
    expect(deals[0].reduce((a, d) => a + d.diff, 0)).toBeGreaterThan(0);
    const card = scorecard(pool, 'hash', 'risky@1', 'random@1', deals, 1, 20);
    expect(card.test).toMatchObject({ kind: 'quick', h1: 0.15 });
    expect(card.tables.map((t) => t.name)).toEqual(['gen-3', 'duel']);
    expect(card.tables[0].diff).toBeGreaterThan(0);
    expect(card.ratings['random@1'].elo).toBe(0);
    expect(card.ratings['risky@1'].elo).toBeGreaterThan(0);
    expect(card.games).toBe(32);
    expect(scorecardMarkdown(card)).toContain('| gen-3 | 3 | yes | 12 |');
  });

  it('pooled SPRT: accepts H1 on a clear gain, H0 on a clear loss, goes on in between', () => {
    const t = (diff: number, se: number): TableStats => ({ name: 't', players: 4, decides: true, deals: 100, diff, low: 0, high: 0, se, candPlace: 0, basePlace: 0, candWins: 0, baseWins: 0, turnLimit: 0 });
    const cfg = pool.sprt;
    expect(pooledSprt([t(0.6, 0.1), t(0.5, 0.1)], cfg).status).toBe('H1');
    expect(pooledSprt([t(-0.4, 0.1), t(-0.3, 0.1)], cfg).status).toBe('H0');
    expect(pooledSprt([t(0.1, 0.4), t(0.05, 0.4)], cfg).status).toBe('continue');
    // Only deciding tables count.
    expect(pooledSprt([{ ...t(0.6, 0.1), decides: false }], cfg).status).toBe('continue');
  });

  it('Plackett-Luce puts a player that finishes first more often above, anchored at 0, finite when it never loses', () => {
    const games = [...Array(30)].map((_, i) => (i % 3 === 0 ? ['b', 'a', 'c'] : ['a', 'b', 'c']));
    const r = plackettLuce(games, 'b');
    expect(r.b).toBe(0);
    expect(r.a).toBeGreaterThan(0);
    expect(r.c).toBeLessThan(0);
    expect(Number.isFinite(r.c)).toBe(true);
  });

  it('the shipped frozen pools load: every table has its field, the fog tables decide; @2 has the quick and promotion tests', () => {
    for (const f of ['abtest-pool-1.json', 'abtest-pool-2.json']) {
      const { pool: p, hash } = loadPool(join(__dirname, '..', 'configs', f));
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
      expect(p.base).toBe('delove@13');
      expect(p.tables.filter((t) => t.decides).every((t) => t.options.fogOfWar === true)).toBe(true);
      expect(p.tables.some((t) => t.field.includes('zerg@2'))).toBe(true);
    }
    const { pool: p2 } = loadPool(join(__dirname, '..', 'configs', 'abtest-pool-2.json'));
    expect(p2.name).toBe('abtest-pool@2');
    expect(sprtConfig(p2, false)).toMatchObject({ h1: 0.25, maxDeals: 400 });
    expect(sprtConfig(p2, true)).toMatchObject({ h0: 0, h1: 0.15, alpha: 0.05, maxDeals: 1200 });
    expect(p2.tables.find((t) => t.name === 'zerg-horde-4')!.maxTurns).toBe(200);
    const { pool: p1 } = loadPool(join(__dirname, '..', 'configs', 'abtest-pool-1.json'));
    expect(p1.name).toBe('abtest-pool@1');
    expect(() => sprtConfig(p1, true)).toThrow(/no promotion settings/);
  });
});
