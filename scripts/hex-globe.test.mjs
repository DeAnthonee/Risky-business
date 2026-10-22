// Tests for scripts/hex-globe.mjs and the hex-globe maps it builds: run with `npm run maps:test` (part of `npm test`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildHexGlobe, goldberg, isPentagon, landTester, toLonLat, fromLonLat } from './hex-globe.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('a Goldberg sphere has 10n²+2 cells, 12 of them pentagons, with symmetric neighbours', () => {
  for (const n of [1, 3, 12]) {
    const cells = goldberg(n, 50);
    assert.equal(cells.length, 10 * n * n + 2);
    assert.equal(cells.filter(isPentagon).length, 12);
    cells.forEach((c, i) => {
      assert.equal(c.neighbors.length, c.corners.length);
      for (const j of c.neighbors) assert.ok(cells[j].neighbors.includes(i), `cell ${j} lists ${i} back`);
    });
  }
});

test('corners wind the same way round every cell, and each edge faces the neighbour that shares it', () => {
  const cells = goldberg(4, 0);
  const key = (v) => v.map((x) => x.toFixed(6)).join(',');
  for (const c of cells) {
    const k = c.corners.length;
    for (let e = 0; e < k; e++) {
      const [a, b] = [c.corners[e], c.corners[(e + 1) % k]];
      assert.ok(dot(cross(sub(a, c.center), sub(b, c.center)), c.center) < 0, 'clockwise seen from outside');
      const nb = cells[c.neighbors[e]].corners.map(key);
      assert.ok(nb.includes(key(a)) && nb.includes(key(b)), 'edge shared with its neighbour');
    }
  }
});

test('two pentagons sit on the poles', () => {
  const poles = goldberg(12, 50).filter(isPentagon).map((c) => toLonLat(c.center)[1]).filter((lat) => Math.abs(lat) > 89.9);
  assert.equal(poles.length, 2);
});

test('lon/lat round-trips through unit vectors', () => {
  for (const p of [[0, 0], [-170, 65], [120, -33.5]]) toLonLat(fromLonLat(p)).forEach((v, k) => assert.ok(Math.abs(v - p[k]) < 1e-9));
});

test('the land test unwraps rings that cross the antimeridian', () => {
  // One ring from 170°E across the antimeridian to 170°W, written the way Natural Earth stores it.
  const land = { type: 'Polygon', coordinates: [[[170, 60], [180, 60], [-180, 60], [-170, 60], [-170, 70], [-180, 70], [180, 70], [170, 70], [170, 60]]] };
  const isLand = landTester(land);
  assert.ok(isLand([175, 65]) && isLand([-175, 65]));
  assert.ok(!isLand([0, 65]) && !isLand([175, 75]));
});

test('territories grow from their sites over land and never jump the sea', () => {
  // Two square continents separated by ocean; each has two territories.
  const land = {
    type: 'MultiPolygon',
    coordinates: [
      [[[-60, -30], [-60, 30], [-20, 30], [-20, -30], [-60, -30]]],
      [[[20, -30], [20, 30], [60, 30], [60, -30], [20, -30]]],
    ],
  };
  const def = {
    frequency: 8,
    territories: [
      { id: 'w1', site: [-40, 15] },
      { id: 'w2', site: [-40, -15] },
      { id: 'e1', site: [40, 15] },
      { id: 'e2', site: [40, -15] },
    ],
  };
  const { cells, warnings } = buildHexGlobe(def, land);
  assert.deepEqual(warnings, []);
  for (const c of cells.filter((c) => c.territory)) {
    const lon = toLonLat(c.center)[0];
    assert.equal(c.territory[0], lon < 0 ? 'w' : 'e', 'each continent keeps its own territories');
  }
  for (const t of def.territories) assert.ok(cells.filter((c) => c.territory === t.id).length >= 3);
});

test('hexworld: the globe file matches the engine map', () => {
  const map = read('../packages/engine/src/generated/hexworld.json');
  const globe = read('../packages/client/src/generated/hexworld.globe.json');
  assert.deepEqual(globe.territories, map.territories.map((t) => t.id));
  assert.equal(globe.cells.length, 10 * globe.frequency ** 2 + 2);
  const owned = new Map(globe.territories.map((_, i) => [i, 0]));
  for (const c of globe.cells) if (c.t >= 0) owned.set(c.t, owned.get(c.t) + 1);
  for (const [i, n] of owned) assert.ok(n > 0, `${globe.territories[i]} has cells`);
  globe.badges.forEach((cell, i) => assert.equal(globe.cells[cell].t, i, `${globe.territories[i]}'s badge is on its own cell`));
  // Every land border in the engine map is two touching cells on the globe, and vice versa.
  const byCorner = new Map();
  globe.cells.forEach((c, i) => c.v.forEach((v) => byCorner.set(v, [...(byCorner.get(v) ?? []), i])));
  const touching = new Set();
  for (const list of byCorner.values())
    for (const a of list)
      for (const b of list) {
        const [ta, tb] = [globe.cells[a].t, globe.cells[b].t];
        if (ta >= 0 && tb >= 0 && ta !== tb) touching.add([globe.territories[ta], globe.territories[tb]].sort().join('|'));
      }
  const sea = new Set(map.seaLinks.map((l) => [l.a, l.b].sort().join('|')));
  const land = new Set(map.edges.map((e) => [...e].sort().join('|')).filter((k) => !sea.has(k)));
  assert.deepEqual([...touching].sort(), [...land].sort());
});
