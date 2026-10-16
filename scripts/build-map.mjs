#!/usr/bin/env node
/**
 * Generates packages/engine/src/generated/<map>.json from real-world geography.
 *
 * Territories are unions of Natural Earth (110m) countries, optionally clipped to lon/lat boxes,
 * projected with Natural Earth I and emitted as SVG path data plus a label anchor. The script
 * also derives which adjacencies are sea links (shapes that do not touch) and warns about
 * shapes that touch without being adjacent, which catches mistakes in the edge lists.
 *
 *   node scripts/build-map.mjs            # all maps
 *   node scripts/build-map.mjs world      # one map
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { geoPath, geoArea, geoNaturalEarth1 } from 'd3-geo';
import pc from 'polygon-clipping';
import polylabel from 'polylabel';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const topo = require('world-atlas/countries-110m.json');
const countries = feature(topo, topo.objects.countries).features;
const byKey = new Map();
for (const f of countries) byKey.set(f.id ?? f.properties.name, f);

const WIDTH = 1000;
const MIN_AREA_DEG2 = 0.6; // drop islets smaller than this unless they are all a territory has

function polygonsOf(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  throw new Error(`Unsupported geometry ${geom.type}`);
}

function boxPoly([lonMin, lonMax, latMin, latMax]) {
  return [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]];
}

function partGeometry(part) {
  const spec = typeof part === 'string' ? { c: part } : part;
  const f = byKey.get(spec.c);
  if (!f) throw new Error(`Unknown country ${spec.c}`);
  let multi = polygonsOf(f.geometry);
  // Natural Earth splits Russia/Alaska at the antimeridian; drop the far side so nothing wraps.
  if (spec.c === '643') multi = multi.filter((poly) => poly[0][0][0] > 0);
  // `mainland` keeps only the country's largest polygon; `islands` keeps everything else.
  if (spec.mainland || spec.islands) {
    const ranked = multi.map((poly) => ({ poly, area: ringArea(poly[0]) })).sort((a, b) => b.area - a.area);
    multi = spec.mainland ? [ranked[0].poly] : ranked.slice(1).map((r) => r.poly);
  }
  const boxes = spec.boxes ?? (spec.box ? [spec.box] : null);
  if (boxes) multi = pc.intersection(multi, boxes.map(boxPoly));
  return multi;
}

/**
 * polygon-clipping emits GeoJSON winding (exterior counter-clockwise); d3-geo treats polygons as
 * spherical and needs the opposite (exterior clockwise), otherwise each shape becomes "the whole
 * globe minus the shape". Reverse every ring of a polygon-clipping result.
 */
function rewind(multi) {
  return multi.map((poly) => poly.map((ring) => ring.slice().reverse()));
}

function ringArea(ring) {
  // Planar shoelace in degrees², scaled by cos(mean lat) so islands near the poles aren't inflated.
  let a = 0;
  let latSum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    latSum += ring[i][1];
  }
  const meanLat = (latSum / (ring.length - 1)) * (Math.PI / 180);
  return Math.abs(a / 2) * Math.cos(meanLat);
}

function territoryGeometry(t) {
  const parts = t.parts.map(partGeometry).filter((m) => m.length);
  if (!parts.length) throw new Error(`${t.id}: no geometry`);
  let multi = pc.union(...parts);
  const big = multi.filter((poly) => ringArea(poly[0]) >= MIN_AREA_DEG2);
  if (big.length) multi = big;
  return { type: 'MultiPolygon', coordinates: rewind(multi) };
}

function key(pt) {
  return `${pt[0].toFixed(4)},${pt[1].toFixed(4)}`;
}

function segmentsOf(geom) {
  const segs = [];
  for (const poly of geom.coordinates)
    for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) segs.push([ring[i], ring[i + 1]]);
  return segs;
}

function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of geom.coordinates)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return [x0, y0, x1, y1];
}

/** Length of the collinear overlap between segments s and t (0 if not collinear). */
function collinearOverlap([a, b], [c, d]) {
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const len = Math.hypot(ux, uy);
  if (len < 1e-9) return 0;
  const cross = (p) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) / len;
  if (cross(c) > 1e-6 || cross(d) > 1e-6) return 0;
  const proj = (p) => ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / len;
  const lo = Math.max(0, Math.min(proj(c), proj(d)));
  const hi = Math.min(len, Math.max(proj(c), proj(d)));
  return Math.max(0, hi - lo);
}

function memoTouch(geoms) {
  const ids = [...geoms.keys()];
  const segs = new Map(ids.map((id) => [id, segmentsOf(geoms.get(id))]));
  const boxes = new Map(ids.map((id) => [id, bboxOf(geoms.get(id))]));
  const verts = new Map();
  for (const id of ids) {
    const set = new Set();
    for (const poly of geoms.get(id).coordinates) for (const ring of poly) for (const pt of ring) set.add(key(pt));
    verts.set(id, set);
  }
  const cache = new Map();
  const touching = (a, b) => {
    const k = [a, b].sort().join('|');
    if (cache.has(k)) return cache.get(k);
    let result = false;
    const [ax0, ay0, ax1, ay1] = boxes.get(a);
    const [bx0, by0, bx1, by1] = boxes.get(b);
    if (ax0 <= bx1 + 1e-6 && bx0 <= ax1 + 1e-6 && ay0 <= by1 + 1e-6 && by0 <= ay1 + 1e-6) {
      let shared = 0;
      for (const v of verts.get(a)) if (verts.get(b).has(v) && ++shared >= 3) break;
      if (shared >= 3) result = true;
      else {
        let overlap = 0;
        outer: for (const s of segs.get(a))
          for (const t of segs.get(b)) {
            overlap += collinearOverlap(s, t);
            if (overlap > 0.05) {
              result = true;
              break outer;
            }
          }
      }
    }
    cache.set(k, result);
    return result;
  };
  touching.pairs = () => {
    const out = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (touching(ids[i], ids[j])) out.push([ids[i], ids[j]].sort().join('|'));
    return out;
  };
  return touching;
}

function build(def) {
  const geoms = new Map();
  for (const t of def.territories) geoms.set(t.id, territoryGeometry(t));

  const fc = { type: 'FeatureCollection', features: def.territories.map((t) => ({ type: 'Feature', id: t.id, geometry: geoms.get(t.id) })) };
  const PAD = 14;
  const projection = geoNaturalEarth1().rotate([-10, 0]).fitWidth(WIDTH - 2 * PAD, fc);
  const [[, y0], [, y1]] = geoPath(projection).bounds(fc);
  const height = Math.ceil(y1 - y0 + 2 * PAD);
  const [tx, ty] = projection.translate();
  projection.translate([tx + PAD, ty - y0 + PAD]);
  const path = geoPath(projection).digits(1);

  // Which territories share a border? Natural Earth topology shares exact vertices along real
  // borders, but straight borders and our box cuts only share collinear segments, so test both.
  const touches = memoTouch(geoms);

  const edgeKeys = new Set(def.edges.map((e) => [...e].sort().join('|')));
  const ids = new Set(def.territories.map((t) => t.id));
  for (const [a, b] of def.edges) {
    if (!ids.has(a) || !ids.has(b)) throw new Error(`${def.id}: edge references unknown territory ${a}-${b}`);
  }
  const wrap = new Set((def.wrapEdges ?? []).map((e) => [...e].sort().join('|')));
  const seaLinks = def.edges.filter(([a, b]) => !touches(a, b)).map(([a, b]) => ({ a, b, wrap: wrap.has([a, b].sort().join('|')) }));
  const suspicious = touches.pairs().filter((k) => !edgeKeys.has(k));

  const territories = def.territories.map((t) => {
    const g = geoms.get(t.id);
    // Label anchor: pole of inaccessibility of the largest polygon, in projected space.
    const largest = g.coordinates.map((poly) => ({ poly, area: geoArea({ type: 'Polygon', coordinates: poly }) })).sort((p, q) => q.area - p.area)[0].poly;
    const projected = largest.map((ring) => ring.map((pt) => projection(pt)).filter(Boolean));
    // Explicit anchor (lon/lat) wins; otherwise the pole of inaccessibility.
    const [x, y] = t.anchor ? projection(t.anchor) : polylabel(projected, 0.5);
    return {
      id: t.id,
      name: t.name,
      continent: t.continent,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      path: path(g),
    };
  });

  // Continent outlines (union of member territories) for the board look.
  const continents = def.continents.map((c) => {
    const members = def.territories.filter((t) => t.continent === c.id).map((t) => t.id);
    if (!members.length) throw new Error(`${def.id}: continent ${c.id} has no territories`);
    // Members are already d3-wound; polygon-clipping is orientation-agnostic on input, so rewind its output again.
    const union = rewind(pc.union(...members.map((id) => geoms.get(id).coordinates)));
    const { label, ...rest } = c;
    const [lx, ly] = label ? projection(label) : [NaN, NaN];
    return {
      ...rest,
      territories: members,
      outline: path({ type: 'MultiPolygon', coordinates: union }),
      ...(label ? { labelX: Math.round(lx * 10) / 10, labelY: Math.round(ly * 10) / 10 } : {}),
    };
  });

  const out = {
    id: def.id,
    name: def.name,
    maxPlayers: def.maxPlayers,
    viewBox: [WIDTH, height],
    territories,
    continents,
    edges: def.edges,
    seaLinks,
  };
  const file = join(root, 'packages/engine/src/generated', `${def.id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  console.log(`${def.id}: ${territories.length} territories, ${def.edges.length} edges, ${seaLinks.length} sea links, ${WIDTH}x${height}, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB -> ${file}`);
  console.log(`  sea links: ${seaLinks.map((s) => `${s.a}~${s.b}${s.wrap ? '(wrap)' : ''}`).join(', ')}`);
  if (suspicious.length) console.log(`  WARNING touching but not adjacent:\n    ${suspicious.join('\n    ')}`);
  return out;
}

const wanted = process.argv.slice(2);
for (const name of ['classic', 'world']) {
  if (wanted.length && !wanted.includes(name)) continue;
  const def = (await import(`./maps/${name}.mjs`)).default;
  build(def);
}
