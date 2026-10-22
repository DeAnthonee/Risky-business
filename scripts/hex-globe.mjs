/**
 * Geometry for hex-globe maps, used by scripts/build-map.mjs for definitions with `kind: 'hexglobe'`.
 * The board is the whole sphere tiled by a Goldberg polyhedron GP(n, 0): 10n²+2 cells, all hexagons
 * except 12 pentagons. Real Earth decides which cells are land, and the map definition groups land
 * cells into territories:
 *
 *   1. Subdivide an icosahedron at frequency n and project to the sphere (a geodesic grid). Its
 *      vertices are the cell centres; each cell's corners are the centres of the triangles around
 *      its vertex. The icosahedron has a vertex at each pole, so two pentagons sit under the polar
 *      ice; `spin` turns the grid about the axis to park the other ten in open ocean.
 *   2. A cell is land when at least half of its sample points (centre and points towards each
 *      corner) fall on Natural Earth land. `land` / `sea` / `ice` points in the definition override
 *      single cells (keep an isthmus, open a strait). Land beyond `iceLat` [south, north] and
 *      everything beyond `seaIceLat` is ice: drawn, never played.
 *   3. Each territory has a `site` [lon, lat]. A site on a sea cell moves to the land cell next to it,
 *      unless the territory is an `island`, whose site's cell becomes land. Every playable land cell
 *      goes to the nearest site by distance over land (a multi-source Dijkstra on the cell graph, so
 *      a territory never jumps a strait), and `cells` points in a territory force single cells to it.
 *
 * Territories are adjacent when any of their cells touch; sea lanes add the overseas connectors.
 * Everything is deterministic, so re-running the build reproduces the committed JSON.
 */

const DEG = Math.PI / 180;
const norm = ([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Unit vector -> [lon, lat] in degrees (z is north, lon 0 on +x). */
export function toLonLat([x, y, z]) {
  return [Math.atan2(y, x) / DEG, Math.asin(Math.max(-1, Math.min(1, z))) / DEG];
}
export function fromLonLat([lon, lat]) {
  const c = Math.cos(lat * DEG);
  return [c * Math.cos(lon * DEG), c * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** Icosahedron with vertices at both poles, turned `spin` degrees about the polar axis. */
function icosahedron(spin) {
  const lat = Math.atan(0.5) / DEG;
  const v = [[0, 90]];
  for (let i = 0; i < 5; i++) v.push([spin + i * 72, lat]);
  for (let i = 0; i < 5; i++) v.push([spin + 36 + i * 72, -lat]);
  v.push([0, -90]);
  const verts = v.map(fromLonLat);
  const faces = [];
  for (let i = 0; i < 5; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % 5), c = 6 + i, d = 6 + ((i + 1) % 5);
    faces.push([0, a, b], [a, c, b], [b, c, d], [c, 11, d]);
  }
  return { verts, faces };
}

/**
 * Goldberg GP(n, 0) cells: `center` (unit vector), `corners` (unit vectors, clockwise seen
 * from outside) and `neighbors` (cell indices, same order as the corner edges).
 */
export function goldberg(n, spin = 0) {
  const ico = icosahedron(spin);
  const points = [];
  const index = new Map();
  const vid = (p) => {
    const k = p.map((c) => c.toFixed(9)).join(',');
    if (!index.has(k)) index.set(k, points.push(p) - 1);
    return index.get(k);
  };
  const tris = [];
  for (const [ia, ib, ic] of ico.faces) {
    const [A, B, C] = [ia, ib, ic].map((i) => ico.verts[i]);
    // Barycentric grid on the flat face, then projected: a geodesic grid of frequency n.
    const at = (i, j) => vid(norm(add(add(scale(A, (n - i - j) / n), scale(B, i / n)), scale(C, j / n))));
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        tris.push([at(i, j), at(i + 1, j), at(i, j + 1)]);
        if (i + j < n - 1) tris.push([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
      }
  }
  // Orient every triangle counter-clockwise from outside.
  for (const t of tris) {
    const [a, b, c] = t.map((i) => points[i]);
    if (dot(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]), a) < 0) [t[1], t[2]] = [t[2], t[1]];
  }
  const around = points.map(() => []);
  tris.forEach((t, ti) => t.forEach((v) => around[v].push(ti)));
  const centroid = tris.map((t) => norm(t.reduce((s, i) => add(s, points[i]), [0, 0, 0])));
  return points.map((center, i) => {
    // Walk the fan of triangles around the vertex: each step shares the edge (i, next).
    const fan = around[i];
    const next = (ti) => {
      const t = tris[ti];
      const k = t.indexOf(i);
      return t[(k + 1) % 3];
    };
    const prev = (ti) => {
      const t = tris[ti];
      const k = t.indexOf(i);
      return t[(k + 2) % 3];
    };
    const order = [fan[0]];
    while (order.length < fan.length) {
      const want = next(order[order.length - 1]);
      order.push(fan.find((ti) => prev(ti) === want));
    }
    // Corner k is the centroid of triangle k; the edge from corner k to corner k+1 faces the
    // neighbour shared by both triangles, which is next(order[k]).
    return { center, corners: order.map((ti) => centroid[ti]), neighbors: order.map(next) };
  });
}

/** Sample points of a cell for land tests: the centre and points half way to each corner. */
function samples(cell) {
  return [cell.center, ...cell.corners.map((c) => norm(add(cell.center, c)))].map(toLonLat);
}

const nearestCell = (cells, lonlat) => {
  const p = fromLonLat(lonlat);
  let best = 0, bestD = Infinity;
  cells.forEach((c, i) => {
    const d = angle(c.center, p);
    if (d < bestD) (best = i), (bestD = d);
  });
  return best;
};

/**
 * Point-in-land test in lon/lat. Natural Earth rings are already cut at the antimeridian, so a
 * planar even-odd test with per-ring bounding boxes is exact enough and far faster than geoContains.
 */
export function landTester(land) {
  const rings = [];
  const geoms = land.type === 'FeatureCollection' ? land.features.map((f) => f.geometry) : [land.geometry ?? land];
  for (const g of geoms) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys)
      for (let ring of poly) {
        // A ring that crosses the antimeridian (1:50m Eurasia) jumps between +180 and -180: unwrap
        // it into one continuous planar ring (points are then also tested at lon + 360). A ring
        // that goes all the way round (Antarctica) is skipped: everything that far south is ice.
        let shift = 0;
        ring = ring.map(([x, y], i) => {
          if (i) {
            const prev = ring[i - 1][0];
            if (x - prev > 180) shift -= 360;
            else if (prev - x > 180) shift += 360;
          }
          return [x + shift, y];
        });
        if (Math.abs(ring[ring.length - 1][0] - ring[0][0]) > 180) continue;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of ring) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
        rings.push({ ring, box: [x0, x1, y0, y1] });
      }
  }
  const test = (x, y) => {
    let inside = false;
    for (const { ring, box } of rings) {
      if (x < box[0] || x > box[1] || y < box[2] || y > box[3]) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  return ([x, y]) => test(x, y) || test(x + 360, y) || test(x - 360, y);
}

/** Land fraction of every cell, from a landTester. */
export function landFractions(cells, isLand) {
  return cells.map((c) => {
    const s = samples(c);
    return s.filter(isLand).length / s.length;
  });
}

/**
 * Builds the cell grid, the land mask and the territory partition of a hex-globe definition.
 * Returns the cells (with `kind`: 'sea' | 'ice' | 'land', and `territory` for land) and warnings.
 */
export function buildHexGlobe(def, land) {
  const warnings = [];
  const cells = goldberg(def.frequency, def.spin ?? 0);
  const frac = landFractions(cells, landTester(land));
  const threshold = def.landThreshold ?? 0.5;
  const kinds = frac.map((f) => (f >= threshold ? 'land' : 'sea'));
  for (const p of def.land ?? []) kinds[nearestCell(cells, p)] = 'land';
  for (const p of def.sea ?? []) kinds[nearestCell(cells, p)] = 'sea';
  const iceLat = def.iceLat ?? [-60, 82];
  cells.forEach((c, i) => {
    const lat = toLonLat(c.center)[1];
    if (lat < iceLat[0] || (lat > iceLat[1] && kinds[i] === 'land')) kinds[i] = 'ice';
    if (lat > (def.seaIceLat ?? 84)) kinds[i] = 'ice';
  });
  for (const p of def.ice ?? []) kinds[nearestCell(cells, p)] = 'ice';

  // Territory partition: multi-source Dijkstra over land cells from each territory's site.
  const owner = cells.map(() => null);
  const dist = cells.map(() => Infinity);
  const queue = [];
  const spacing = angle(cells[0].center, cells[cells[0].neighbors[0]].center);
  for (const t of def.territories) {
    let i = nearestCell(cells, t.site);
    // An island territory makes its site's cell land. Any other site on a sea cell moves to the
    // nearest land cell next to it; one farther out is reported.
    if (kinds[i] !== 'land' && !t.island) {
      const p = fromLonLat(t.site);
      const near = cells[i].neighbors.filter((j) => kinds[j] === 'land').sort((a, b) => angle(cells[a].center, p) - angle(cells[b].center, p));
      if (near.length && angle(cells[near[0]].center, p) < 1.5 * spacing) i = near[0];
      else warnings.push(`${t.id}: site [${t.site}] is on a ${kinds[i]} cell (move it, or mark the territory island: true)`);
    }
    if (owner[i] && owner[i] !== t.id) warnings.push(`${t.id}: site shares a cell with ${owner[i]}`);
    kinds[i] = 'land';
    owner[i] = t.id;
    dist[i] = 0;
    queue.push(i);
  }
  while (queue.length) {
    queue.sort((a, b) => dist[b] - dist[a]);
    const i = queue.pop();
    for (const j of cells[i].neighbors) {
      if (kinds[j] !== 'land') continue;
      const d = dist[i] + angle(cells[i].center, cells[j].center);
      if (d < dist[j] - 1e-12) {
        dist[j] = d;
        owner[j] = owner[i];
        if (!queue.includes(j)) queue.push(j);
      }
    }
  }
  for (const t of def.territories) for (const p of t.cells ?? []) {
    const i = nearestCell(cells, p);
    kinds[i] = 'land';
    owner[i] = t.id;
  }
  // Land with no site reachable over land: report it (add a site, or mark it sea or ice).
  const orphans = cells.map((c, i) => (kinds[i] === 'land' && !owner[i] ? i : -1)).filter((i) => i >= 0);
  for (const i of orphans) {
    const [lon, lat] = toLonLat(cells[i].center);
    warnings.push(`land cell at [${lon.toFixed(1)}, ${lat.toFixed(1)}] belongs to no territory (sea or ice it, or give it a site)`);
    kinds[i] = 'sea';
  }
  // Every territory must be one connected piece.
  for (const t of def.territories) {
    const mine = cells.map((_, i) => i).filter((i) => owner[i] === t.id);
    if (!mine.length) {
      warnings.push(`${t.id} has no cells (its site's cell went to another territory)`);
      continue;
    }
    const seen = new Set([mine[0]]);
    const stack = [mine[0]];
    while (stack.length) for (const j of cells[stack.pop()].neighbors) if (owner[j] === t.id && !seen.has(j)) seen.add(j), stack.push(j);
    if (seen.size !== mine.length) warnings.push(`${t.id} is split into pieces (${mine.length} cells)`);
  }
  return {
    cells: cells.map((c, i) => ({ ...c, kind: kinds[i], territory: kinds[i] === 'land' ? owner[i] : null })),
    warnings,
  };
}

/** Pentagons are the cells with five corners. */
export const isPentagon = (cell) => cell.corners.length === 5;
