/**
 * Geometry for hand-authored (fictional) maps, used by scripts/build-map.mjs for definitions with
 * `kind: 'authored'`. A fantasy world has no Natural Earth data, so instead of country unions it is
 * drawn in its own planar coordinate space (the viewBox):
 *
 *   1. Each landmass is a coarse hand-drawn outline. Its coastline is roughened by seeded midpoint
 *      displacement so it reads as a natural shore, and optional lakes are cut out of it.
 *   2. A landmass owned by one territory (an island) goes to it whole. Otherwise the territory
 *      `site` points on it partition it: a Voronoi diagram of those sites (d3-delaunay), whose
 *      straight cell edges are replaced by "noisy" borders. Each border is subdivided inside the
 *      quadrilateral formed by its two endpoints and the two sites it separates, so it wiggles
 *      without ever crossing another border, and both neighbours use the very same polyline.
 *   3. Cells are clipped to the land. A fragment cut off from its territory (a cell reaching across
 *      a bay) is handed to the neighbour it shares the longest border with.
 *
 * Everything is deterministic: the random streams are seeded from the map seed plus the landmass
 * id or the border's endpoints, so re-running the build reproduces the committed JSON byte for byte.
 */
import { Delaunay } from 'd3-delaunay';
import pc from 'polygon-clipping';
import polylabel from 'polylabel';

// ---- seeded randomness ----
function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h;
}
function rngFor(...keys) {
  let a = hash(keys.join('|'));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- planar helpers ----
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const mid = (a, b) => lerp(a, b, 0.5);
const pkey = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
const polyArea = (poly) => Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
const closed = (ring) => (pkey(ring[0]) === pkey(ring[ring.length - 1]) ? ring : [...ring, ring[0]]);

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPoly = (pt, poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h));

/** Chaikin corner cutting: turns the coarse sketch into smooth curves before the shore is roughened. */
function smooth(outline, iterations) {
  let pts = outline;
  for (let k = 0; k < iterations; k++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      next.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
    pts = next;
  }
  return pts;
}

/** Midpoint displacement of a closed outline: a fractal shoreline that still follows the sketch. */
function roughen(outline, rng, { roughness, fine = roughness, detail }) {
  const out = [];
  const split = (a, b, depth) => {
    const len = dist(a, b);
    if (len < detail || depth > 12) return;
    const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    // Bolder displacement on the first subdivisions (headlands, coves), gentler below (texture).
    const off = (rng() * 2 - 1) * (depth < 2 ? roughness : fine) * len;
    const m = [(a[0] + b[0]) / 2 + n[0] * off, (a[1] + b[1]) / 2 + n[1] * off];
    split(a, m, depth + 1);
    out.push(m);
    split(m, b, depth + 1);
  };
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    out.push(a);
    split(a, b, 0);
  }
  return out;
}

/**
 * Control point for one side of the Voronoi edge a-c: on the edge's perpendicular through its midpoint,
 * pulled in so it stays inside the triangle (a, c, site). That triangle lies inside the site's convex
 * cell, and the fan of such triangles around a site never overlaps, so the kite a-b-c-d formed by the
 * two control points is convex and no two borders can cross.
 */
function controlPoint(a, c, site) {
  const m = mid(a, c);
  const len = dist(a, c);
  let n = [-(c[1] - a[1]) / len, (c[0] - a[0]) / len];
  if ((site[0] - m[0]) * n[0] + (site[1] - m[1]) * n[1] < 0) n = [-n[0], -n[1]];
  let tMax = Infinity;
  for (const [p, q] of [[a, site], [c, site]]) {
    // Solve m + n t = p + (q - p) s.
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const den = n[0] * ey - n[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - m[0]) * ey - (p[1] - m[1]) * ex) / den;
    const s = ((p[0] - m[0]) * n[1] - (p[1] - m[1]) * n[0]) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) tMax = Math.min(tMax, t);
  }
  if (!Number.isFinite(tMax)) tMax = 0;
  return [m[0] + n[0] * tMax, m[1] + n[1] * tMax];
}

/** Interior points of a wiggly border from a to c, kept inside the quadrilateral a-b-c-d. */
function noisyBorder(a, c, b, d, rng, { roughness, detail }, out) {
  if (dist(a, c) < detail) return;
  const m = mid(a, c);
  const u = (rng() * 2 - 1) * roughness;
  const h = u >= 0 ? lerp(m, b, u) : lerp(m, d, -u);
  noisyBorder(a, h, mid(a, b), mid(a, d), rng, { roughness, detail }, out);
  out.push(h);
  noisyBorder(h, c, mid(c, b), mid(c, d), rng, { roughness, detail }, out);
}

/** Map of canonical segment key -> length for every edge of a multipolygon. */
function segmentMap(multi) {
  const m = new Map();
  for (const poly of multi)
    for (const ring of poly)
      for (let i = 0; i < ring.length - 1; i++) {
        const ka = pkey(ring[i]), kb = pkey(ring[i + 1]);
        if (ka === kb) continue;
        m.set(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, dist(ring[i], ring[i + 1]));
      }
  return m;
}
function sharedLength(sa, sb) {
  let len = 0;
  const [small, big] = sa.size < sb.size ? [sa, sb] : [sb, sa];
  for (const [k, l] of small) if (big.has(k)) len += l;
  return len;
}

function pathOf(multi) {
  const r = (v) => Math.round(v * 10) / 10;
  let d = '';
  for (const poly of multi)
    for (const ring of poly) {
      const pts = [];
      for (const p of ring.slice(0, -1)) {
        const q = [r(p[0]), r(p[1])];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      if (pts.length < 3) continue;
      d += `M${pts.map((p) => `${p[0]},${p[1]}`).join('L')}Z`;
    }
  return d;
}

function bboxOf(multi) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of multi)
    for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  return [x0, y0, x1, y1];
}

/**
 * Builds territory and continent shapes for an authored map definition.
 * Returns everything build-map.mjs needs: output records, a border-length based `touches`
 * function, the land adjacency it implies, and warnings.
 */
export function buildAuthored(def) {
  const [W, H] = def.size;
  const coast = { roughness: 0.34, fine: 0.17, detail: 4, smoothing: 1, ...def.coast };
  const borders = { roughness: 0.6, detail: 4, ...def.borders };
  const minBorder = def.minBorder ?? 8;
  const warnings = [];
  const tById = new Map(def.territories.map((t) => [t.id, t]));
  const pieces = new Map(def.territories.map((t) => [t.id, []]));

  for (const L of def.landmasses) {
    const c = { ...coast, ...L.coast };
    const shore = closed(roughen(smooth(L.outline, c.smoothing), rngFor(def.seed, 'coast', L.id), c));
    let land = pc.union([shore]);
    for (const [i, lake] of (L.lakes ?? []).entries()) {
      land = pc.difference(land, [closed(roughen(smooth(lake, c.smoothing), rngFor(def.seed, 'lake', L.id, i), { ...c, roughness: c.roughness * 0.6, fine: c.fine * 0.6 }))]);
    }
    if (L.territory) {
      if (!tById.has(L.territory)) throw new Error(`${def.id}: landmass ${L.id} names unknown territory ${L.territory}`);
      pieces.get(L.territory).push(...land);
      continue;
    }
    const sites = def.territories.filter((t) => t.land === L.id);
    if (!sites.length) throw new Error(`${def.id}: landmass ${L.id} has no territory sites`);
    for (const t of sites) if (!land.some((poly) => pointInPoly(t.site, poly))) warnings.push(`site of ${t.id} is not on land ${L.id}`);
    if (sites.length === 1) {
      pieces.get(sites[0].id).push(...land);
      continue;
    }
    const [bx0, by0, bx1, by1] = bboxOf(land);
    const delaunay = Delaunay.from(sites.map((t) => t.site));
    const voronoi = delaunay.voronoi([bx0 - 50, by0 - 50, bx1 + 50, by1 + 50]);
    const borderCache = new Map();
    sites.forEach((t, i) => {
      const cell = voronoi.cellPolygon(i); // closed ring
      const neighbours = [...delaunay.neighbors(i)];
      const ring = [];
      for (let k = 0; k < cell.length - 1; k++) {
        const a = cell[k], c = cell[k + 1];
        ring.push(a);
        // Which neighbouring site does this edge separate us from? (equidistant from its midpoint)
        const m = mid(a, c);
        const di = dist(m, t.site);
        const j = neighbours.find((n) => Math.abs(dist(m, sites[n].site) - di) < 1e-6 * Math.max(1, di));
        if (j === undefined) continue; // edge of the clip box, far out at sea
        const ka = pkey(a), kc = pkey(c);
        const key = ka < kc ? `${ka}|${kc}` : `${kc}|${ka}`;
        if (!borderCache.has(key)) {
          const [p, q] = ka < kc ? [a, c] : [c, a];
          const [s1, s2] = i < j ? [t.site, sites[j].site] : [sites[j].site, t.site];
          const pts = [];
          noisyBorder(p, q, controlPoint(p, q, s1), controlPoint(p, q, s2), rngFor(def.seed, 'border', key), borders, pts);
          borderCache.set(key, pts);
        }
        const pts = borderCache.get(key);
        ring.push(...(ka < kc ? pts : pts.slice().reverse()));
      }
      const clipped = pc.intersection([closed(ring)], land);
      pieces.get(t.id).push(...clipped.filter((poly) => polyArea(poly) > 1));
    });
  }

  // Hand fragments that are cut off from their territory to the neighbour they border most.
  const geoms = new Map();
  for (const [id, polys] of pieces) {
    if (!polys.length) throw new Error(`${def.id}: territory ${id} has no land`);
    geoms.set(id, pc.union(...polys.map((p) => [p])));
  }
  const islandsOk = new Set(def.landmasses.filter((L) => L.territory).map((L) => L.territory));
  for (const [id, multi] of [...geoms]) {
    if (multi.length < 2 || islandsOk.has(id)) continue;
    const ranked = multi.slice().sort((p, q) => polyArea(q) - polyArea(p));
    const keep = [ranked[0]];
    for (const frag of ranked.slice(1)) {
      const fs = segmentMap([frag]);
      let best = null, bestLen = 0;
      for (const [other, om] of geoms) {
        if (other === id) continue;
        const len = sharedLength(fs, segmentMap(om));
        if (len > bestLen) (best = other), (bestLen = len);
      }
      if (best) geoms.set(best, pc.union(geoms.get(best), [frag]));
      else keep.push(frag), warnings.push(`${id} has a detached piece (area ${polyArea(frag).toFixed(0)}) touching nobody`);
    }
    geoms.set(id, keep);
  }

  // Shared border lengths decide land adjacency.
  const segs = new Map([...geoms].map(([id, m]) => [id, segmentMap(m)]));
  const borderLen = new Map();
  const ids = [...geoms.keys()];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const len = sharedLength(segs.get(ids[i]), segs.get(ids[j]));
      if (len > 0) borderLen.set([ids[i], ids[j]].sort().join('|'), len);
    }
  const touches = (a, b) => (borderLen.get([a, b].sort().join('|')) ?? 0) >= minBorder;
  touches.pairs = () => [...borderLen.entries()].filter(([, l]) => l > 0).map(([k]) => k);
  const landEdges = [...borderLen.entries()].filter(([, l]) => l >= minBorder).map(([k]) => k.split('|'));
  for (const [k, l] of borderLen) if (l < minBorder) warnings.push(`${k.replace('|', '/')} share only ${l.toFixed(1)} units of border (< ${minBorder}): not adjacent; move a site if they should be`);

  const r = (v) => Math.round(v * 10) / 10;
  const territories = def.territories.map((t) => {
    const multi = geoms.get(t.id);
    const largest = multi.slice().sort((p, q) => polyArea(q) - polyArea(p))[0];
    const [x, y] = t.anchor ?? polylabel(largest, 0.5);
    const [bx0, by0, bx1, by1] = bboxOf(multi);
    return { id: t.id, name: t.name, continent: t.continent, x: r(x), y: r(y), path: pathOf(multi), bbox: [r(bx0), r(by0), r(bx1 - bx0), r(by1 - by0)] };
  });

  const continents = def.continents.map((c) => {
    const members = def.territories.filter((t) => t.continent === c.id).map((t) => t.id);
    if (!members.length) throw new Error(`${def.id}: continent ${c.id} has no territories`);
    const union = pc.union(...members.map((id) => geoms.get(id)));
    const { label, ...rest } = c;
    return { ...rest, territories: members, outline: pathOf(union), ...(label ? { labelX: label[0], labelY: label[1] } : {}) };
  });

  return { viewBox: [W, H], territories, continents, landEdges, touches, warnings };
}
