import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAPS,
  RuleError,
  addPlayer,
  applyAction,
  chooseBotAction,
  createGame,
  createRng,
  defaultRegions,
  describeOptions,
  formatGenId,
  genMapId,
  genSpecFor,
  generateFromId,
  generateMap,
  getMap,
  isMapId,
  nextFloat,
  parseGenId,
  parseOptions,
  pickStartSpots,
  startGame,
  suggestBonus,
  type GeneratedMap,
  type MapDef,
} from '../src/index.js';

const hash = (m: GeneratedMap) => createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16);

/** Every territory is reachable from the first through `inside`. */
function reachable(map: MapDef, ids: string[]): boolean {
  const inside = new Set(ids);
  const seen = new Set([ids[0]]);
  const stack = [ids[0]];
  while (stack.length) for (const u of map.adjacency[stack.pop()!]) if (inside.has(u) && !seen.has(u)) seen.add(u), stack.push(u);
  return seen.size === ids.length;
}

describe('generated board ids', () => {
  it('formats and parses canonical ids', () => {
    expect(genMapId({ seed: 42, seats: 4 })).toBe('gen1-s42-p4-t20');
    expect(parseGenId('gen1-s42-p4-t20')).toEqual({ v: 1, seed: 42, seats: 4, territories: 20, regions: 4, passes: 1 });
    expect(formatGenId({ v: 1, seed: 7, seats: 6, territories: 30, regions: 5, passes: 2 })).toBe('gen1-s7-p6-t30-r5-c2');
    expect(parseGenId('gen1-s7-p6-t30-r5-c2')).toEqual({ v: 1, seed: 7, seats: 6, territories: 30, regions: 5, passes: 2 });
    expect(genMapId({ seed: 4294967295, seats: 10, territoriesPerSeat: 4 })).toBe('gen1-s4294967295-p10-t40');
  });

  it('sizes boards at 5 territories per seat by default, 4 to 6 allowed', () => {
    expect([3, 4, 6, 10].map((seats) => genSpecFor({ seed: 1, seats }).territories)).toEqual([15, 20, 30, 50]);
    expect(genSpecFor({ seed: 1, seats: 6, territoriesPerSeat: 4 }).territories).toBe(24);
    expect(genSpecFor({ seed: 1, seats: 6, territoriesPerSeat: 6 }).territories).toBe(36);
    expect(() => genSpecFor({ seed: 1, seats: 6, territoriesPerSeat: 7 })).toThrow(RuleError);
    expect(() => genSpecFor({ seed: 1, seats: 6, territoriesPerSeat: 3 })).toThrow(RuleError);
    expect(defaultRegions(15)).toBe(3);
    expect(defaultRegions(50)).toBe(10);
  });

  it('rejects malformed, out-of-range and non-canonical ids', () => {
    for (const bad of ['gen1-s42-p4', 'gen2-s1-p4-t20', 'gen1-s-1-p4-t20', 'gen1-s042-p4-t20', 'gen1-s1-p11-t50', 'gen1-s1-p1-t20', 'gen1-s1-p4-t200', 'gen1-s1-p4-t11', 'gen1-s1-p4-t20-r9', 'gen1-s1-p4-t20-c3', 'gen1-s4294967296-p4-t20'])
      expect(() => parseGenId(bad), bad).toThrow(RuleError);
    // Defaults are never written out: 'r4' is the default for 20 territories.
    expect(() => parseGenId('gen1-s1-p4-t20-r4')).toThrow(/not canonical.*gen1-s1-p4-t20"/);
    expect(isMapId('gen1-s1-p4-t20')).toBe(true);
    expect(isMapId('gen1-s1-p4-t20-r4')).toBe(false);
    expect(isMapId('gen9-s1-p4-t20')).toBe(false);
    expect(isMapId('classic')).toBe(true);
  });
});

describe('generated boards', () => {
  it('are the same board every time (determinism, gen1 frozen)', () => {
    const a = generateFromId('gen1-s5-p6-t30');
    const b = generateFromId('gen1-s5-p6-t30');
    expect(a).toEqual(b);
    expect(generateFromId('gen1-s6-p6-t30')).not.toEqual(a);
    expect(getMap('gen1-s5-p6-t30')).toBe(getMap('gen1-s5-p6-t30'));
    expect(getMap('gen1-s5-p6-t30').territories).toEqual(a.territories);
  });

  // gen1 must never change: a board saved in a game has to come back exactly. If one of these fails, the change
  // belongs in a new generator version (gen2), not in gen1.
  it('match the golden hashes of gen1', () => {
    const golden: Record<string, string> = {
      'gen1-s1-p3-t15': '20ca16dea0ab5c2b',
      'gen1-s2-p3-t12': '262078030457561b',
      'gen1-s3-p4-t20': '04b9f5ff6c3e5f9b',
      'gen1-s4-p4-t24': '8d335b9ce717bf0c',
      'gen1-s5-p5-t25': '26e1a622f3f3fabe',
      'gen1-s6-p6-t30': 'da8da9c3b35bbbc4',
      'gen1-s7-p6-t36-c2': '0529869a7ee9a923',
      'gen1-s8-p7-t35': 'da1bafb3c663e856',
      'gen1-s9-p8-t40': 'b67935b92f1aa15e',
      'gen1-s10-p9-t45': '9ef1ebe3e44a844d',
      'gen1-s11-p10-t50': 'c3d75a2b9591e25e',
      'gen1-s12-p10-t60-r10': '2c6df17eda7361b0',
    };
    const actual = Object.fromEntries(Object.keys(golden).map((id) => [id, hash(generateFromId(id))]));
    expect(actual).toEqual(golden);
  });

  it('use integer coordinates only (the same board in every JS engine)', () => {
    const m = generateFromId('gen1-s3-p10-t50');
    const nums = (s: string) => s.match(/-?[\d.]+/g)!.map(Number);
    for (const t of m.territories) {
      for (const v of [t.x, t.y, ...t.bbox, ...nums(t.path)]) expect(Number.isInteger(v)).toBe(true);
    }
    for (const c of m.continents) for (const v of [...nums(c.outline), c.labelX ?? 0, c.labelY ?? 0]) expect(Number.isInteger(v)).toBe(true);
    expect(m.viewBox.every(Number.isInteger)).toBe(true);
  });

  it('use no Math.random, clocks or transcendental functions', () => {
    const src = readFileSync(new URL('../src/procgen.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.(random|sin|cos|tan|atan|sqrt|exp|log|pow|hypot|cbrt)\b|Date\.|performance\./);
  });

  it('build fast enough for a big tournament', () => {
    const t0 = Date.now();
    for (let seed = 100; seed < 130; seed++) generateMap(genSpecFor({ seed, seats: 4 }));
    expect((Date.now() - t0) / 30).toBeLessThan(200);
  });

  describe.each([3, 4, 5, 6, 7, 8, 9, 10])('%i seats', (seats) => {
    it.each([4, 5, 6])('pass the quality checks at %i territories per seat, over many seeds', (tps) => {
      for (let seed = 1; seed <= 12; seed++) {
        const id = genMapId({ seed: seed * 7919 + seats, seats, territoriesPerSeat: tps });
        const map = getMap(id);
        const T = seats * tps;
        expect(map.id).toBe(id);
        expect(map.maxPlayers).toBe(seats);
        expect(map.territoryIds).toHaveLength(T);
        expect(new Set(map.territories.map((t) => t.name)).size).toBe(T);
        expect(map.continents).toHaveLength(defaultRegions(T));
        expect(map.startingArmies(seats)).toBeGreaterThanOrEqual(Math.ceil((T / seats) * 1.5));
        // Edges: no duplicates, no self-links, both ends exist.
        expect(new Set(map.edges.map(([a, b]) => `${a}|${b}`)).size).toBe(map.edges.length);
        for (const [a, b] of map.edges) expect(a < b && map.isTerritory(a) && map.isTerritory(b)).toBe(true);
        // Connected, and every region connected inside itself.
        expect(reachable(map, map.territoryIds)).toBe(true);
        for (const c of map.continents) {
          expect(c.territories.length).toBeGreaterThanOrEqual(2);
          expect(reachable(map, c.territories), `${id} ${c.id}`).toBe(true);
          // Chokepoints: 1-3 entry territories for a region of up to 5, up to 5 for a bigger one.
          const entries = c.territories.filter((t) => map.adjacency[t].some((u) => map.territoryById[u].continent !== c.id)).length;
          expect(entries, `${id} ${c.id}`).toBeGreaterThanOrEqual(1);
          expect(entries, `${id} ${c.id}`).toBeLessThanOrEqual(c.territories.length <= 5 ? 3 : 5);
          expect(Math.abs(c.bonus - suggestBonus(c.territories.length, entries)), `${id} ${c.id}`).toBeLessThanOrEqual(1);
        }
        // Few dead ends, and badges far enough apart for the client's rings (radius 19).
        expect(map.territoryIds.filter((t) => map.adjacency[t].length < 2).length).toBeLessThanOrEqual(Math.floor(T / 15));
        for (const a of map.territories)
          for (const b of map.territories) if (a.id < b.id) expect((a.x - b.x) ** 2 + (a.y - b.y) ** 2).toBeGreaterThanOrEqual(24 * 24);
      }
    });
  });

  it('can be the table of a game, with fog of war too', () => {
    for (const [seed, seats, fogOfWar] of [[1, 3, false], [2, 4, true], [3, 6, false], [4, 10, true]] as const) {
      const map = genMapId({ seed, seats });
      let s = createGame('g', { map, maxPlayers: seats, autoSetup: true, fogOfWar }, seed);
      for (let i = 0; i < seats; i++) s = addPlayer(s, `p${i}`, `P${i}`, true);
      s = startGame(s).state;
      const rng = createRng(seed);
      const random = () => nextFloat(rng);
      let steps = 0;
      while (s.phase !== 'finished' && steps < 60_000) {
        s = applyAction(s, s.currentPlayer!, chooseBotAction(s, s.currentPlayer!, random)!).state;
        steps++;
      }
      expect(s.phase, `${map} after ${steps} actions`).toBe('finished');
      expect(s.winner).toBeTruthy();
    }
  });

  it('are accepted as a game setting', () => {
    expect(parseOptions({ map: 'gen1-s42-p4-t20' })).toEqual({ map: 'gen1-s42-p4-t20' });
    expect(() => parseOptions({ map: 'gen1-s42-p4-t20-r4' })).toThrow(/not canonical/);
    expect(() => parseOptions({ map: 'gen1-s42-p40-t20' })).toThrow(RuleError);
    const s = createGame('g', { map: 'gen1-s42-p4-t20', maxPlayers: 4 }, 1);
    expect(Object.keys(s.territories)).toHaveLength(20);
    expect(() => createGame('g', { map: 'gen1-s42-p4-t20', maxPlayers: 5 }, 1)).toThrow(/maxPlayers/);
    expect(describeOptions(s.options)[0]).toMatch(/^Map: Generated board 42 \(20\): 20 territories, 4 regions, 2-4 players \(generated from its id\)$/);
  });
});

describe('start spots', () => {
  it('pick one territory per region, spread out, on generated and existing boards', () => {
    for (const [map, n] of [[getMap(genMapId({ seed: 3, seats: 6 })), 6], [getMap(genMapId({ seed: 4, seats: 10 })), 10], [MAPS.world, 10], [MAPS.classic, 6]] as const) {
      const spots = pickStartSpots(map, n, 1);
      expect(spots).toHaveLength(n);
      expect(new Set(spots.map((t) => map.territoryById[t].continent)).size).toBe(n);
      expect(pickStartSpots(map, n, 1)).toEqual(spots);
      // Nobody starts next to another spot.
      for (const a of spots) for (const b of spots) if (a !== b) expect(map.isAdjacent(a, b), `${map.id} ${a} ${b}`).toBe(false);
    }
    expect(() => pickStartSpots(MAPS.classic, 7)).toThrow(RuleError);
  });
});
