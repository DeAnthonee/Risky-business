import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRITORIES_PER_SEAT, MAPS, RuleError, getMap, nestSeed, planNest, planToNest, resolveNest, type NestPlan } from '../src/index.js';

/** Compact form of a plan: tables per round, "4x1+3x23" style, then the final. */
function shape(p: NestPlan): string {
  return p.rounds
    .map((r) => {
      const sizes = new Map<number, number>();
      for (const t of r) sizes.set(t.seats, (sizes.get(t.seats) ?? 0) + 1);
      return [...sizes].sort((a, b) => b[0] - a[0]).map(([s, n]) => `${n}x${s}`).join('+');
    })
    .join(' > ');
}

describe('planNest (tables of 3-6, a final of 6-10, Zergs only when needed)', () => {
  it('plans the worked examples', () => {
    const cases: Array<[number, string, number]> = [
      [6, '1x6', 0],
      [10, '1x10', 0],
      [11, '6x3 > 1x6', 7],
      [17, '6x3 > 1x6', 1],
      [18, '6x3 > 1x6', 0],
      [25, '1x4+7x3 > 1x8', 0],
      [40, '10x4 > 1x10', 0],
      [54, '4x6+6x5 > 1x10', 0],
      [61, '4x4+15x3 > 1x4+5x3 > 1x6', 0],
      [73, '1x4+23x3 > 8x3 > 1x8', 0],
      [89, '5x4+23x3 > 1x4+8x3 > 1x9', 0],
      [100, '4x4+28x3 > 2x4+8x3 > 1x10', 0],
      [250, '50x5 > 10x5 > 1x10', 0],
    ];
    for (const [n, want, zergs] of cases) {
      const p = planNest(n);
      expect(`${n}: ${shape(p)} +${p.zergs}`).toBe(`${n}: ${want} +${zergs}`);
    }
    // Fewer than 6 players: Zergs fill the final up to 6.
    expect(planNest(4)).toMatchObject({ zergs: 2, finalSeats: 6 });
    expect(() => planNest(1)).toThrow(RuleError);
  });

  it('gives a valid plan for every field from 2 to 400 players, and samples up to 1500', () => {
    const fields = [...Array.from({ length: 399 }, (_, i) => i + 2), ...Array.from({ length: 30 }, (_, i) => 401 + i * 37)];
    for (const n of fields) {
      const p = planNest(n);
      const R = p.rounds.length;
      // Zergs only below 6 and for 11-17 (too many for a lone final, too few for 6 tables of 3).
      expect(p.zergs > 0, `${n}`).toBe(n < 6 || (n >= 11 && n <= 17));
      expect(p.rounds[0].reduce((s, t) => s + t.seats, 0)).toBe(n + p.zergs);
      expect(p.rounds[0].reduce((s, t) => s + t.zergs, 0)).toBe(p.zergs);
      expect(p.rounds[R - 1]).toHaveLength(1);
      expect(p.finalSeats).toBe(p.rounds[R - 1][0].seats);
      expect(p.finalSeats).toBeGreaterThanOrEqual(6);
      expect(p.finalSeats).toBeLessThanOrEqual(10);
      for (let r = 0; r < R; r++) {
        const sizes = p.rounds[r].map((t) => t.seats);
        if (r < R - 1) {
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(3);
          expect(Math.max(...sizes)).toBeLessThanOrEqual(6);
          // Uneven by at most one in a round, and every winner has a seat in the next round.
          expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
          expect(p.rounds[r]).toHaveLength(p.rounds[r + 1].reduce((s, t) => s + t.seats, 0));
          for (const parent of p.rounds[r + 1]) {
            const kids = p.rounds[r].filter((t) => t.parent === parent.index);
            expect(kids.map((k) => k.portal).sort((a, b) => a! - b!)).toEqual(Array.from({ length: parent.seats }, (_, i) => i));
          }
        }
      }
      const z = p.rounds[0].map((t) => t.zergs);
      expect(Math.max(...z) - Math.min(...z)).toBeLessThanOrEqual(1);
      // A table is never all Zergs while there are humans to seat.
      for (const t of p.rounds[0]) if (n >= p.rounds[0].length) expect(t.zergs).toBeLessThan(t.seats);
    }
  });

  it('uses no Math.random or clocks', () => {
    const src = readFileSync(new URL('../src/nest.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.random|Date\.|performance\./);
  });
});

describe('nested boards', () => {
  it('derive each board seed from the root seed and the path', () => {
    expect(nestSeed(1, '')).toBe(nestSeed(1, ''));
    expect(nestSeed(1, 'a')).not.toBe(nestSeed(1, 'b'));
    expect(nestSeed(1, 'a')).not.toBe(nestSeed(2, 'a'));
  });

  it('put generated boards inside an existing board (World outer, 10 portals in 10 regions)', () => {
    const nodes = resolveNest({ v: 1, seed: 9, board: { map: 'world', seats: 10 }, inside: { gen: { seats: 4 } } });
    expect(nodes).toHaveLength(11);
    const [outer, ...kids] = nodes;
    expect(outer).toMatchObject({ map: 'world', seats: 10, parent: null, portal: null, depth: 0 });
    expect(new Set(outer.portals.map((t) => MAPS.world.territoryById[t].continent)).size).toBe(10);
    expect(kids.map((k) => k.portal)).toEqual(outer.portals);
    for (const k of kids) {
      expect(k).toMatchObject({ seats: 4, parent: 0, depth: 1, portals: [] });
      expect(getMap(k.map).territoryIds).toHaveLength(4 * DEFAULT_TERRITORIES_PER_SEAT);
    }
    expect(new Set(kids.map((k) => k.map)).size).toBe(10);
    // The same spec is the same tree.
    expect(resolveNest({ v: 1, seed: 9, board: { map: 'world', seats: 10 }, inside: { gen: { seats: 4 } } })).toEqual(nodes);
  });

  it('nest three levels and mix existing boards inside generated ones', () => {
    const nodes = resolveNest({
      v: 1,
      seed: 3,
      board: { gen: { seats: 6 } },
      inside: { board: { gen: { seats: 3 } }, inside: [{ map: 'skirmish', seats: 4 }, { gen: { seats: 3 } }, { gen: { seats: 5, territoriesPerSeat: 4 } }] },
    });
    expect(nodes).toHaveLength(1 + 6 + 18);
    expect(getMap(nodes[0].map).continents.length).toBeGreaterThanOrEqual(6);
    expect(nodes.filter((n) => n.depth === 2).map((n) => n.seats).slice(0, 3)).toEqual([4, 3, 5]);
    expect(nodes.filter((n) => n.map === 'skirmish')).toHaveLength(6);
    for (const n of nodes.filter((n) => n.depth === 2)) expect(nodes[n.parent!].portals).toContain(n.portal);
  });

  it('take listed portals and reject bad trees', () => {
    const ok = resolveNest({ v: 1, seed: 1, board: { map: 'classic' }, portals: ['alaska', 'brazil', 'egypt'], inside: { gen: { seats: 3 } } });
    expect(ok[0].portals).toEqual(['alaska', 'brazil', 'egypt']);
    expect(ok[0].seats).toBe(3);
    expect(() => resolveNest({ v: 1, seed: 1, board: { map: 'classic' }, portals: ['alaska', 'atlantis'], inside: { gen: { seats: 3 } } })).toThrow(/not a territory/);
    expect(() => resolveNest({ v: 1, seed: 1, board: { map: 'classic' }, portals: ['alaska', 'alaska'], inside: { gen: { seats: 3 } } })).toThrow(/repeat/);
    expect(() => resolveNest({ v: 1, seed: 1, board: { map: 'classic' }, portals: ['alaska', 'brazil'], inside: [{ gen: { seats: 3 } }] })).toThrow(/portals for/);
    expect(() => resolveNest({ v: 1, seed: 1, board: { map: 'nowhere' } })).toThrow(/Unknown map/);
    expect(() => resolveNest({ v: 1, seed: 1, board: { map: 'classic', seats: 7 }, inside: { gen: { seats: 3 } } })).toThrow(RuleError);
  });
});

describe('planToNest', () => {
  it('gives every table of a 100-player plan a board for its seats, nested in its parent', () => {
    const plan = planNest(100);
    const { spec, boards } = planToNest(plan, { seed: 2026 });
    expect(spec.seed).toBe(2026);
    for (const [r, round] of plan.rounds.entries())
      for (const t of round) {
        const node = boards[r][t.index];
        expect(node.seats).toBe(t.seats);
        expect(getMap(node.map).maxPlayers).toBe(t.seats);
        if (t.parent !== null) expect(node.portal).toBe(boards[r + 1][t.parent].portals[t.portal!]);
      }
    expect(new Set(boards.flat().map((n) => n.map)).size).toBe(plan.rounds.flat().length);
  });

  it('can play the final on an existing board', () => {
    const plan = planNest(40);
    const { boards } = planToNest(plan, { seed: 5, final: { map: 'world' } });
    expect(boards[1][0]).toMatchObject({ map: 'world', seats: 10 });
    expect(boards[0].every((n) => getMap(n.map).maxPlayers === 4)).toBe(true);
  });

  it('can play the final on Hex Earth: one portal per region at every final size', () => {
    const finals = new Set<number>();
    for (const players of [12, 21, 24, 27, 30, 64, 100, 128]) {
      const plan = planNest(players);
      const R = plan.rounds.length;
      const { boards, nodes } = planToNest(plan, { seed: players, final: { map: 'hexworld' } });
      const final = boards[R - 1][0];
      expect(final).toMatchObject({ map: 'hexworld', seats: plan.rounds[R - 1][0].seats, depth: 0 });
      const regions = final.portals.map((t) => MAPS.hexworld.territoryById[t].continent);
      expect(new Set(regions).size).toBe(final.portals.length);
      finals.add(final.seats);
      // Every other table plays on a generated board inside a portal.
      for (const n of nodes.slice(1)) expect(n.map.startsWith('gen1-')).toBe(true);
    }
    expect([...finals].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10]);
  });

  it('nests boards in Hex Earth at 2 to 10 seats, and Hex Earth inside other boards', () => {
    for (let seats = 2; seats <= 10; seats++) {
      const [outer, ...kids] = resolveNest({ v: 1, seed: seats, board: { map: 'hexworld', seats }, inside: { gen: { seats: 4 } } });
      expect(outer.portals).toHaveLength(seats);
      expect(new Set(outer.portals.map((t) => MAPS.hexworld.territoryById[t].continent)).size).toBe(seats);
      expect(kids.map((k) => k.portal)).toEqual(outer.portals);
    }
    const inner = resolveNest({ v: 1, seed: 3, board: { gen: { seats: 4 } }, inside: { map: 'hexworld', seats: 6 } });
    expect(inner.slice(1).map((n) => [n.map, n.seats])).toEqual(Array(4).fill(['hexworld', 6]));
  });
});
