#!/usr/bin/env node
/**
 * Generates packages/engine/src/generated/<map>.json from real-world geography, or, for definitions
 * with `kind: 'authored'` (fictional worlds), from hand-drawn landmasses (see authored-map.mjs).
 *
 * Territories are unions of features from a geodata source, optionally clipped to lon/lat boxes,
 * projected (Natural Earth I by default) and emitted as SVG path data plus a label anchor. The
 * script also derives which adjacencies are sea links (shapes that do not touch) and warns about
 * shapes that touch without being adjacent, which catches mistakes in the edge lists. It also warns
 * about army badges that would overlap and explicit anchors that fall outside their territory.
 *
 * Map definition fields (scripts/maps/<id>.mjs):
 *   source      'countries-110m' (default) | 'countries-50m' (Natural Earth, world-atlas) |
 *               'us-states' (US states, us-atlas). Parts name a feature by id or by name.
 *   projection  { type: 'naturalEarth1' | 'conicEqualArea', rotate, parallels } (default
 *               Natural Earth I rotated [-10, 0])
 *   minArea     drop islets smaller than this many deg² (default 0.6)
 *   simplify    simplify the source topology first: drop points whose triangle is under this many
 *               deg² (keeps the generated JSON small for detailed sources)
 *   densify     add box-cut vertices every this many degrees so long cuts follow parallels and
 *               neighbouring cuts line up (recommended on zoomed-in maps: 1)
 *   width       viewBox width (default 1000). Very big boards (hundreds of territories) use a wider
 *               canvas so army badges keep their size relative to the land; the client zooms further.
 *   edges       adjacency list. Optional: without it, land adjacency is derived from the shapes
 *               (territories that share a border) and `seaLanes` ([a, b] pairs) add the crossings
 *               over water, like the authored maps. `wrapEdges` marks sea lanes drawn around the edge.
 * Continent fields: bonus may be left out to use the suggested bonus (size plus entry points).
 * Part fields: c (feature id or name), box / boxes (clip to lon/lat boxes), pick (keep only the
 * polygons whose centre lies in a lon/lat box, without cutting any), mainland, islands, split.
 * `drop` (a lon/lat box) removes the polygons whose centre lies in it (the opposite of pick).
 * `split: true` divides the feature between every territory that splits it (with the same box): each
 * gets the Voronoi cell around its `site` ([lon, lat]) or the union of the cells around its `sites`
 * (several points, for long or bent provinces), so a big country becomes provinces from a list of
 * named points instead of hand-placed boxes.
 * Territory fields: inset { from: [lon, lat], to: [lon, lat], scale: k | [kx, ky] } moves a far-away
 * territory (Alaska, Hawaii) next to the rest of the map; its anchor is moved with it.
 *
 *   node scripts/build-map.mjs            # all maps
 *   node scripts/build-map.mjs world      # one map
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { presimplify, simplify } from 'topojson-simplify';
import { geoPath, geoArea, geoContains, geoNaturalEarth1, geoConicEqualArea } from 'd3-geo';
import pc from 'polygon-clipping';
import polylabel from 'polylabel';
import { Delaunay } from 'd3-delaunay';
import { buildAuthored } from './authored-map.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Geodata sources: devDependencies only, read at build time; the output JSON is committed. */
const SOURCES = {
  'countries-110m': { file: 'world-atlas/countries-110m.json', object: 'countries' },
  'countries-50m': { file: 'world-atlas/countries-50m.json', object: 'countries' },
  'us-states': { file: 'us-atlas/states-10m.json', object: 'states' },
};
const sourceCache = new Map();
/**
 * `minWeight` (deg², optional) simplifies the topology before use (Visvalingam, planar triangle
 * area). It runs on shared arcs, so neighbouring shapes keep identical borders.
 */
function loadSource(name, minWeight = 0) {
  const cacheKey = `${name}@${minWeight}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);
  const src = SOURCES[name];
  if (!src) throw new Error(`Unknown source ${name}`);
  let topo = JSON.parse(readFileSync(require.resolve(src.file), 'utf8'));
  if (minWeight > 0) topo = simplify(presimplify(topo), minWeight);
  const byKey = new Map();
  for (const f of feature(topo, topo.objects[src.object]).features) {
    // Features are addressed by id (ISO numeric / FIPS) or, when they have none, by name; names
    // always work as aliases so definitions stay readable.
    // Two 1:50m features share an id (036: Australia and the Ashmore and Cartier Islands); the
    // first, the country, keeps it and the islets stay reachable by name.
    if (!byKey.has(f.id ?? f.properties.name)) byKey.set(f.id ?? f.properties.name, f);
    if (f.properties?.name && !byKey.has(f.properties.name)) byKey.set(f.properties.name, f);
  }
  sourceCache.set(cacheKey, byKey);
  return byKey;
}
let byKey = loadSource('countries-110m');
let sourceName = 'countries-110m';

let MIN_AREA_DEG2 = 0.6; // drop islets smaller than this unless they are all a territory has

function polygonsOf(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  throw new Error(`Unsupported geometry ${geom.type}`);
}

function boxPoly([lonMin, lonMax, latMin, latMax]) {
  return [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]];
}

let DENSIFY = 0;
/**
 * Projections draw edges as great-circle arcs, so a long box cut along a parallel bulges and
 * neighbours cut by boxes with different corners leave slivers. Re-insert vertices on a
 * whole-degree grid along axis-aligned segments (polygon-clipping drops collinear points) so cuts
 * follow parallels and neighbouring cuts line up.
 */
function densify(multi) {
  if (!DENSIFY) return multi;
  const grid = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out = [];
    for (let v = Math.floor(lo / DENSIFY + 1) * DENSIFY; v < hi - 1e-9; v += DENSIFY) out.push(v);
    return a <= b ? out : out.reverse();
  };
  return multi.map((poly) =>
    poly.map((ring) => {
      const out = [];
      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
        out.push(ring[i]);
        if (Math.abs(y0 - y1) < 1e-9 && Math.abs(x1 - x0) > DENSIFY) for (const x of grid(x0, x1)) out.push([x, y0]);
        else if (Math.abs(x0 - x1) < 1e-9 && Math.abs(y1 - y0) > DENSIFY) for (const y of grid(y0, y1)) out.push([x0, y]);
      }
      out.push(ring[ring.length - 1]);
      return out;
    }),
  );
}

/** Rings that cross the antimeridian (Natural Earth 1:50m Russia) jump from +180 to -180; move the far side past +180 so planar clipping sees one piece. */
function unwrap(multi) {
  return multi.map((poly) =>
    poly.map((ring) => {
      let jumps = false;
      for (let i = 0; i < ring.length - 1 && !jumps; i++) if (Math.abs(ring[i + 1][0] - ring[i][0]) > 180) jumps = true;
      return jumps ? ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : ring;
    }),
  );
}

/**
 * Voronoi cells for `split` parts: for every feature split between territories, a cell (lon/lat ring)
 * per territory around its site. Longitudes are scaled by cos(mean latitude) first so cells are not
 * stretched east-west far from the equator.
 */
let splitCells = new Map();
const splitKey = (spec) => `${spec.c}|${JSON.stringify(spec.boxes ?? spec.box ?? null)}`;
function computeSplitCells(def) {
  const groups = new Map();
  for (const t of def.territories)
    for (const part of t.parts) {
      if (typeof part === 'string' || !part.split) continue;
      const sites = t.sites ?? (t.site ? [t.site] : null);
      if (!sites) throw new Error(`${t.id}: a split part needs a site`);
      const key = splitKey(part);
      if (!groups.has(key)) groups.set(key, []);
      for (const site of sites) groups.get(key).push({ id: t.id, site });
    }
  splitCells = new Map();
  for (const [key, points] of groups) {
    const cells = new Map();
    splitCells.set(key, cells);
    if (new Set(points.map((p) => p.id)).size === 1) continue; // the whole feature
    const k = Math.cos((points.reduce((s, p) => s + p.site[1], 0) / points.length) * (Math.PI / 180));
    const delaunay = Delaunay.from(points.map((p) => [p.site[0] * k, p.site[1]]));
    const voronoi = delaunay.voronoi([-400 * k, -90, 400 * k, 90]);
    points.forEach((p, i) => {
      if (!cells.has(p.id)) cells.set(p.id, []);
      cells.get(p.id).push([voronoi.cellPolygon(i).map(([x, y]) => [x / k, y])]);
    });
  }
}

function partGeometry(part, t) {
  const spec = typeof part === 'string' ? { c: part } : part;
  const f = byKey.get(spec.c);
  if (!f) throw new Error(`Unknown feature ${spec.c} in ${sourceName}`);
  let multi = unwrap(polygonsOf(f.geometry));
  // Natural Earth splits Russia/Alaska at the antimeridian; drop the far side so nothing wraps.
  if (spec.c === '643' && sourceName.startsWith('countries')) multi = multi.filter((poly) => poly[0][0][0] > 0);
  // `pick` keeps whole polygons (islands) whose centre lies in a box, without cutting any.
  if (spec.pick) {
    const [lonMin, lonMax, latMin, latMax] = spec.pick;
    multi = multi.filter((poly) => {
      const ring = poly[0];
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      return cx >= lonMin && cx <= lonMax && cy >= latMin && cy <= latMax;
    });
  }
  if (spec.drop) {
    const [lonMin, lonMax, latMin, latMax] = spec.drop;
    multi = multi.filter((poly) => {
      const ring = poly[0];
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      return !(cx >= lonMin && cx <= lonMax && cy >= latMin && cy <= latMax);
    });
  }
  // `mainland` keeps only the country's largest polygon; `islands` keeps everything else.
  if (spec.mainland || spec.islands) {
    const ranked = multi.map((poly) => ({ poly, area: ringArea(poly[0]) })).sort((a, b) => b.area - a.area);
    multi = spec.mainland ? [ranked[0].poly] : ranked.slice(1).map((r) => r.poly);
  }
  const boxes = spec.boxes ?? (spec.box ? [spec.box] : null);
  if (boxes) multi = pc.intersection(multi, boxes.map(boxPoly));
  const cells = spec.split && splitCells.get(splitKey(spec))?.get(t.id);
  if (cells) multi = pc.intersection(multi, cells);
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
  const parts = t.parts.map((p) => partGeometry(p, t)).filter((m) => m.length);
  if (!parts.length) throw new Error(`${t.id}: no geometry`);
  let multi = densify(pc.union(...parts));
  if (t.inset) multi = multi.map((poly) => poly.map((ring) => ring.map((pt) => insetPoint(t.inset, pt))));
  const big = multi.filter((poly) => ringArea(poly[0]) >= MIN_AREA_DEG2);
  if (big.length) multi = big;
  return { type: 'MultiPolygon', coordinates: rewind(multi) };
}

/** Moves a point of an inset territory: scale around `from`, then place `from` at `to`. */
function insetPoint({ from, to, scale }, [lon, lat]) {
  const [kx, ky] = Array.isArray(scale) ? scale : [scale ?? 1, scale ?? 1];
  return [to[0] + (lon - from[0]) * kx, to[1] + (lat - from[1]) * ky];
}

function makeProjection(spec = {}) {
  const type = spec.type ?? 'naturalEarth1';
  if (type === 'naturalEarth1') return geoNaturalEarth1().rotate(spec.rotate ?? [-10, 0]);
  if (type === 'conicEqualArea') return geoConicEqualArea().rotate(spec.rotate ?? [0, 0]).parallels(spec.parallels ?? [30, 60]);
  throw new Error(`Unknown projection ${type}`);
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
  sourceName = def.source ?? 'countries-110m';
  byKey = loadSource(sourceName, def.simplify ?? 0);
  MIN_AREA_DEG2 = def.minArea ?? 0.6;
  DENSIFY = def.densify ?? 0;
  const WIDTH = def.width ?? 1000;
  computeSplitCells(def);
  const geoms = new Map();
  for (const t of def.territories) geoms.set(t.id, territoryGeometry(t));

  const fc = { type: 'FeatureCollection', features: def.territories.map((t) => ({ type: 'Feature', id: t.id, geometry: geoms.get(t.id) })) };
  const PAD = 14;
  const projection = makeProjection(def.projection).fitWidth(WIDTH - 2 * PAD, fc);
  const [[, y0], [, y1]] = geoPath(projection).bounds(fc);
  const height = Math.ceil(y1 - y0 + 2 * PAD);
  const [tx, ty] = projection.translate();
  projection.translate([tx + PAD, ty - y0 + PAD]);
  // Wide boards draw at whole units (a unit there is already finer than a tenth on a 1000-wide board).
  const path = geoPath(projection).digits(WIDTH >= 2000 ? 0 : 1);

  // Which territories share a border? Natural Earth topology shares exact vertices along real
  // borders, but straight borders and our box cuts only share collinear segments, so test both.
  const touches = memoTouch(geoms);

  const anchorWarnings = [];
  const territories = def.territories.map((t) => {
    const g = geoms.get(t.id);
    // Label anchor: pole of inaccessibility of the largest polygon, in projected space.
    const largest = g.coordinates.map((poly) => ({ poly, area: geoArea({ type: 'Polygon', coordinates: poly }) })).sort((p, q) => q.area - p.area)[0].poly;
    const projected = largest.map((ring) => ring.map((pt) => projection(pt)).filter(Boolean));
    // Explicit anchor (lon/lat) wins; otherwise the pole of inaccessibility.
    const lonlat = t.anchor && t.inset ? insetPoint(t.inset, t.anchor) : t.anchor;
    if (lonlat && !geoContains(g, lonlat)) anchorWarnings.push(`${t.id}: anchor [${t.anchor}] is outside its shape`);
    const [x, y] = lonlat ? projection(lonlat) : polylabel(projected, 0.5);
    const [[bx0, by0], [bx1, by1]] = path.bounds(g);
    const r = (v) => Math.round(v * 10) / 10;
    return {
      id: t.id,
      name: t.name,
      continent: t.continent,
      x: r(x),
      y: r(y),
      path: path(g),
      bbox: [r(bx0), r(by0), r(bx1 - bx0), r(by1 - by0)],
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
  // Arena outlines (union of member regions) for tournament boards.
  const arenas = (def.arenas ?? []).map((a) => {
    const members = def.territories.filter((t) => a.regions.includes(t.continent)).map((t) => t.id);
    const union = rewind(pc.union(...members.map((id) => geoms.get(id).coordinates)));
    return { id: a.id, name: a.name, continents: a.regions, territories: members, outline: path({ type: 'MultiPolygon', coordinates: union }) };
  });

  if (!def.edges) {
    // Derived adjacency: every pair of shapes that share a border, plus the declared sea lanes.
    const land = touches.pairs().map((k) => k.split('|'));
    const landKeys = new Set(touches.pairs());
    const lanes = (def.seaLanes ?? []).filter(([a, b]) => {
      if (!landKeys.has([a, b].sort().join('|'))) return true;
      anchorWarnings.push(`sea lane ${a}~${b} is redundant: they already share a border`);
      return false;
    });
    def = { ...def, edges: [...land, ...lanes] };
  }
  const out = finish(def, { viewBox: [WIDTH, height], territories, continents, arenas, touches, anchorWarnings });
  if (def.continents.some((c) => c.bonus === undefined)) printBonuses(def, out);
  return out;
}

/** Suggested bonus per region (classic logic: grows with size and with the number of border entry points). */
function suggestedBonuses(def, edges) {
  const adj = new Map(def.territories.map((t) => [t.id, new Set()]));
  for (const [a, b] of edges) adj.get(a).add(b), adj.get(b).add(a);
  const cont = new Map(def.territories.map((t) => [t.id, t.continent]));
  return def.continents.map((c) => {
    const members = def.territories.filter((t) => t.continent === c.id);
    const entries = members.filter((t) => [...adj.get(t.id)].some((n) => cont.get(n) !== c.id)).length;
    return { c, members: members.length, entries, suggested: Math.max(1, Math.round(members.length / 3 + entries * 0.6)) };
  });
}

function printBonuses(def, out) {
  for (const { c, members, entries, suggested } of suggestedBonuses(def, out.edges)) {
    const note = c.bonus !== undefined && Math.abs(suggested - c.bonus) > 1 ? '  <- check' : '';
    console.log(`  ${c.id}: ${members} territories, ${entries} entry points, bonus ${c.bonus ?? `${suggested} (suggested)`}${c.bonus !== undefined ? ` (suggested ${suggested})` : ''}${note}`);
  }
}

/** Hand-authored map: planar geometry, land adjacency from shared borders plus explicit sea lanes. */
function buildAuthoredMap(def) {
  const g = buildAuthored(def);
  const landKeys = new Set(g.landEdges.map((e) => e.join('|')));
  for (const [a, b] of def.seaLanes ?? []) {
    if (landKeys.has([a, b].sort().join('|'))) g.warnings.push(`sea lane ${a}~${b} is redundant: they already share a border`);
  }
  const edges = [...g.landEdges, ...(def.seaLanes ?? []).filter(([a, b]) => !landKeys.has([a, b].sort().join('|')))];
  const out = finish({ ...def, edges }, g);
  for (const w of g.warnings) console.log(`  WARNING ${w}`);
  printBonuses(def, out);
  return out;
}

/** Shared tail: validate edges, derive sea links, warn about suspicious borders and badges, write the JSON. */
function finish(def, { viewBox, territories, continents, arenas = [], touches, anchorWarnings = [] }) {
  const [WIDTH, height] = viewBox;
  const edgeKeys = new Set(def.edges.map((e) => [...e].sort().join('|')));
  const ids = new Set(def.territories.map((t) => t.id));
  for (const [a, b] of def.edges) {
    if (!ids.has(a) || !ids.has(b)) throw new Error(`${def.id}: edge references unknown territory ${a}-${b}`);
  }
  const wrap = new Set((def.wrapEdges ?? []).map((e) => [...e].sort().join('|')));
  const seaLinks = def.edges.filter(([a, b]) => !touches(a, b)).map(([a, b]) => ({ a, b, wrap: wrap.has([a, b].sort().join('|')) }));
  const suspicious = touches.pairs().filter((k) => !edgeKeys.has(k));

  // Every territory must be reachable from every other.
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const [a, b] of def.edges) adj.get(a).push(b), adj.get(b).push(a);
  const seen = new Set([def.territories[0].id]);
  const queue = [def.territories[0].id];
  while (queue.length) for (const n of adj.get(queue.shift())) if (!seen.has(n)) seen.add(n), queue.push(n);
  if (seen.size !== ids.size) throw new Error(`${def.id}: map is not connected; unreachable: ${[...ids].filter((id) => !seen.has(id)).join(', ')}`);

  // Arenas (tournament tables): every region in exactly one, each playable on its own (connected).
  if (def.arenas) {
    const regionArena = new Map();
    for (const a of def.arenas)
      for (const r of a.regions) {
        if (!def.continents.some((c) => c.id === r)) throw new Error(`${def.id}: arena ${a.id} names unknown region ${r}`);
        if (regionArena.has(r)) throw new Error(`${def.id}: region ${r} is in arenas ${regionArena.get(r)} and ${a.id}`);
        regionArena.set(r, a.id);
      }
    const orphans = def.continents.filter((c) => !regionArena.has(c.id)).map((c) => c.id);
    if (orphans.length) throw new Error(`${def.id}: regions in no arena: ${orphans.join(', ')}`);
    const arenaOf = new Map(def.territories.map((t) => [t.id, regionArena.get(t.continent)]));
    for (const a of arenas) {
      const inside = new Set(a.territories);
      const seenA = new Set([a.territories[0]]);
      const q = [a.territories[0]];
      while (q.length) for (const n of adj.get(q.shift())) if (inside.has(n) && !seenA.has(n)) seenA.add(n), q.push(n);
      if (seenA.size !== inside.size) throw new Error(`${def.id}: arena ${a.id} is not connected; cut off: ${a.territories.filter((x) => !seenA.has(x)).join(', ')}`);
      const neighbours = new Set();
      for (const tid of a.territories) for (const n of adj.get(tid)) if (arenaOf.get(n) !== a.id) neighbours.add(arenaOf.get(n));
      console.log(`  arena ${a.id}: ${a.territories.length} territories, ${a.continents.length} regions, borders ${[...neighbours].join(', ')}`);
    }
  }
  const bonusOf = new Map(suggestedBonuses(def, def.edges).map((b) => [b.c.id, b.c.bonus ?? b.suggested]));
  const out = {
    id: def.id,
    name: def.name,
    maxPlayers: def.maxPlayers,
    viewBox: [WIDTH, height],
    territories,
    continents: continents.map((c) => ({ ...c, bonus: bonusOf.get(c.id) })),
    ...(def.arenas ? { arenas } : {}),
    edges: def.edges,
    seaLinks,
  };
  const file = join(root, 'packages/engine/src/generated', `${def.id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  console.log(`${def.id}: ${territories.length} territories, ${def.edges.length} edges, ${seaLinks.length} sea links, ${WIDTH}x${height}, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB -> ${file}`);
  console.log(`  sea links: ${seaLinks.map((s) => `${s.a}~${s.b}${s.wrap ? '(wrap)' : ''}`).join(', ')}`);
  if (suspicious.length) console.log(`  WARNING touching but not adjacent:\n    ${suspicious.join('\n    ')}`);
  // Army badges: the client draws a ring of radius 15 (maps with more than 50 territories) or 19
  // around each anchor; anchors much closer than a ring diameter make badges overlap.
  const minGap = territories.length > 50 ? 24 : 32;
  for (let i = 0; i < territories.length; i++)
    for (let j = i + 1; j < territories.length; j++) {
      const a = territories[i], b = territories[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < minGap) anchorWarnings.push(`badges ${a.id} and ${b.id} are ${d.toFixed(1)} apart (want >= ${minGap})`);
    }
  // On maps with 50 or fewer territories the name is always drawn under the badge (9.5px, about
  // 5.3 units per character, baseline 26 below the anchor); warn when it runs into another badge.
  if (territories.length <= 50) {
    const labelBox = (t) => {
      const w = t.name.length * 5.3;
      return [t.x - w / 2, t.y + 18, t.x + w / 2, t.y + 28];
    };
    for (const a of territories) {
      const [x0, y0, x1, y1] = labelBox(a);
      for (const b of territories) {
        if (a === b) continue;
        const cx = Math.max(x0, Math.min(b.x, x1));
        const cy = Math.max(y0, Math.min(b.y, y1));
        if (Math.hypot(cx - b.x, cy - b.y) < 15) anchorWarnings.push(`label of ${a.id} runs into the badge of ${b.id}`);
      }
    }
  }
  if (anchorWarnings.length) console.log(`  WARNING anchors:\n    ${anchorWarnings.join('\n    ')}`);
  return out;
}

const MAP_NAMES = ['classic', 'world', 'world_large', 'europe', 'europe_advanced', 'usa', 'asia', 'fantasy', 'earth'];
const wanted = process.argv.slice(2);
for (const name of MAP_NAMES) {
  if (wanted.length && !wanted.includes(name)) continue;
  const def = (await import(`./maps/${name}.mjs`)).default;
  if (def.kind === 'authored') buildAuthoredMap(def);
  else build(def);
}
