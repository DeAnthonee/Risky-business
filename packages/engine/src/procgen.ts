/**
 * Procedural boards: a seeded, deterministic generator for small hex boards, used for nested ("Inception")
 * tournaments and anywhere a fresh board is wanted. A generated board has no JSON in the repo: its id carries
 * the generator version and every input (`gen1-s<seed>-p<seats>-t<territories>[-r<regions>][-c<passes>]`), and
 * getMap (maps.ts) builds it on first use. The same id gives the same board on every machine and in every browser,
 * so saved games and records keep loading (README hard rules 7, 9 and 10).
 *
 * gen1 is frozen: any change to its output is a new version (gen2, ...), and gen1 stays as it is. The golden
 * hashes in packages/engine/test/procgen.test.ts fail on any change to a gen1 board.
 *
 * Determinism: only createRng/nextInt from rng.ts, integer arithmetic and fixed iteration orders. No Math.random,
 * no clocks, and no Math.sin/cos/sqrt/exp (not guaranteed bit-identical across JS engines). Every coordinate is an
 * integer. This file is not mirrored by the GPU mirror (packages/delove-gpu), so it can change without a re-verify;
 * only gen1's output must not.
 */
import { createRng, nextInt, type Rng } from './rng.js';
import { RuleError } from './types.js';
import type { ContinentDef, MapDef, SeaLink, TerritoryDef } from './maps.js';

/** A generated board's id, e.g. 'gen1-s42-p4-t20'. */
export type GenMapId = `gen${number}-${string}`;

/** Every input of a gen1 board. */
export interface GenSpec {
  /** Generator version. */
  v: 1;
  /** Any 32-bit unsigned integer. */
  seed: number;
  /** Players the board is made for (its maxPlayers): 2-10. */
  seats: number;
  /** Territory count: max(8, 3 * seats) up to 120. */
  territories: number;
  /** Regions (bonus areas): 2 up to territories / 3. Default: defaultRegions(territories). */
  regions: number;
  /** Land passes between each pair of linked regions: 1 or 2. Default 1. */
  passes: number;
}

/** The board as maps.ts wraps it (the same shape as packages/engine/src/generated/*.json). */
export interface GeneratedMap {
  id: GenMapId;
  name: string;
  maxPlayers: number;
  viewBox: [number, number];
  territories: TerritoryDef[];
  continents: ContinentDef[];
  edges: [string, string][];
  seaLinks: SeaLink[];
}

/** Board size per seat (owner, 2026-10-27, up from 5): default 8 territories per player, 4 to 10 allowed. */
export const DEFAULT_TERRITORIES_PER_SEAT = 8;
export const TERRITORIES_PER_SEAT_RANGE = { min: 4, max: 10 } as const;
export const GEN_SEATS_RANGE = { min: 2, max: 10 } as const;
export const GEN_MAX_TERRITORIES = 120;

export function minTerritories(seats: number): number {
  return Math.max(8, 3 * seats);
}

/** About one region per 5 territories, at least 2. */
export function defaultRegions(territories: number): number {
  return Math.max(2, Math.floor((territories + 2) / 5));
}

export function maxRegions(territories: number): number {
  return Math.floor(territories / 3);
}

/**
 * The spec for a board with `seats` players, sized `territoriesPerSeat` territories per player (default 8).
 * The id stores the resulting territory count, so changing the default later never changes a saved board.
 */
export function genSpecFor(opts: { seed: number; seats: number; territoriesPerSeat?: number; regions?: number; passes?: number }): GenSpec {
  const tps = opts.territoriesPerSeat ?? DEFAULT_TERRITORIES_PER_SEAT;
  if (!Number.isInteger(tps) || tps < TERRITORIES_PER_SEAT_RANGE.min || tps > TERRITORIES_PER_SEAT_RANGE.max)
    throw new RuleError(`territoriesPerSeat must be ${TERRITORIES_PER_SEAT_RANGE.min}-${TERRITORIES_PER_SEAT_RANGE.max}`);
  const territories = Math.max(minTerritories(opts.seats), opts.seats * tps);
  const spec: GenSpec = { v: 1, seed: opts.seed, seats: opts.seats, territories, regions: opts.regions ?? defaultRegions(territories), passes: opts.passes ?? 1 };
  checkSpec(spec);
  return spec;
}

/** The id of a board: `genSpecFor` + `formatGenId`. */
export function genMapId(opts: Parameters<typeof genSpecFor>[0]): GenMapId {
  return formatGenId(genSpecFor(opts));
}

function checkSpec(s: GenSpec): void {
  const problems: string[] = [];
  if (s.v !== 1) problems.push(`unknown generator version ${s.v}`);
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff) problems.push('seed must be an integer 0-4294967295');
  if (!Number.isInteger(s.seats) || s.seats < GEN_SEATS_RANGE.min || s.seats > GEN_SEATS_RANGE.max) problems.push(`seats must be ${GEN_SEATS_RANGE.min}-${GEN_SEATS_RANGE.max}`);
  else if (!Number.isInteger(s.territories) || s.territories < minTerritories(s.seats) || s.territories > GEN_MAX_TERRITORIES)
    problems.push(`territories must be ${minTerritories(s.seats)}-${GEN_MAX_TERRITORIES} for ${s.seats} seats`);
  else if (!Number.isInteger(s.regions) || s.regions < 2 || s.regions > maxRegions(s.territories))
    problems.push(`regions must be 2-${maxRegions(s.territories)} for ${s.territories} territories`);
  if (s.passes !== 1 && s.passes !== 2) problems.push('passes must be 1 or 2');
  if (problems.length) throw new RuleError(`Invalid generated board: ${problems.slice(-3).join('; ')}`);
}

/** Canonical id: regions and passes are written only when they differ from their defaults. */
export function formatGenId(s: GenSpec): GenMapId {
  checkSpec(s);
  let id = `gen${s.v}-s${s.seed}-p${s.seats}-t${s.territories}`;
  if (s.regions !== defaultRegions(s.territories)) id += `-r${s.regions}`;
  if (s.passes !== 1) id += `-c${s.passes}`;
  return id as GenMapId;
}

const GEN_ID = /^gen(\d+)-s(0|[1-9]\d{0,9})-p([1-9]\d?)-t([1-9]\d{0,2})(?:-r([1-9]\d?))?(?:-c([1-9]))?$/;

/** True when `id` looks like a generated board's id (cheap: no generation, no range checks). */
export function looksLikeGenId(id: unknown): id is GenMapId {
  return typeof id === 'string' && id.startsWith('gen') && GEN_ID.test(id);
}

/** Parse a generated board's id. Throws RuleError when it is malformed, out of range or not canonical. */
export function parseGenId(id: string): GenSpec {
  const m = GEN_ID.exec(id);
  if (!m) throw new RuleError(`Unknown map "${id}"`);
  const territories = Number(m[4]);
  const spec: GenSpec = {
    v: Number(m[1]) as 1,
    seed: Number(m[2]),
    seats: Number(m[3]),
    territories,
    regions: m[5] ? Number(m[5]) : defaultRegions(territories),
    passes: m[6] ? Number(m[6]) : 1,
  };
  checkSpec(spec);
  const canonical = formatGenId(spec);
  if (canonical !== id) throw new RuleError(`Map id "${id}" is not canonical; use "${canonical}"`);
  return spec;
}

// ---- hex grid --------------------------------------------------------------------------------------------------
// Pointy-top hexes in "odd-r" offset coordinates: odd rows are shifted half a cell right. A cell is 36 wide and
// 40 tall, rows are 30 apart; every vertex is on an integer point. Edge d of a cell runs from vertex d to d+1
// (clockwise from the top), and its neighbour across edge d is NB_*[d].
const CELL_W = 36;
const HALF_W = 18;
const ROW_H = 30;
const MARGIN = 24;
const VERT: ReadonlyArray<readonly [number, number]> = [[0, -20], [18, -10], [18, 10], [0, 20], [-18, 10], [-18, -10]];
const NB_EVEN: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const NB_ODD: ReadonlyArray<readonly [number, number]> = [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [0, -1]];
/** Land cells per territory, before the channels between regions are cut. */
const CELLS_PER_TERRITORY = 10;
const MAX_ATTEMPTS = 60;

interface Grid {
  cols: number;
  rows: number;
  /** Neighbour cell index across each edge, or -1 off the grid. */
  nb: Int32Array;
  cx: Int32Array;
  cy: Int32Array;
}

function makeGrid(cols: number, rows: number): Grid {
  const n = cols * rows;
  const nb = new Int32Array(n * 6).fill(-1);
  const cx = new Int32Array(n);
  const cy = new Int32Array(n);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      cx[i] = MARGIN + HALF_W + CELL_W * c + (r & 1) * HALF_W;
      cy[i] = MARGIN + 20 + ROW_H * r;
      const table = r & 1 ? NB_ODD : NB_EVEN;
      for (let d = 0; d < 6; d++) {
        const nc = c + table[d][0];
        const nr = r + table[d][1];
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) nb[i * 6 + d] = nr * cols + nc;
      }
    }
  return { cols, rows, nb, cx, cy };
}

function isqrt(n: number): number {
  let x = 0;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** 32-bit integer mix of a seed with a salt (for retries and sub-streams). */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Cells reachable from `start` through cells where `inside(i)` holds, in BFS order, with distances. */
function bfs(g: Grid, starts: number[], inside: (i: number) => boolean): Int32Array {
  const dist = new Int32Array(g.cols * g.rows).fill(-1);
  const queue: number[] = [];
  for (const s of starts) {
    dist[s] = 0;
    queue.push(s);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j >= 0 && dist[j] < 0 && inside(j)) {
        dist[j] = dist[i] + 1;
        queue.push(j);
      }
    }
  }
  return dist;
}

/** `k` seed cells among `cells` by farthest-point sampling over BFS distance inside `inside`. */
function spreadSeeds(g: Grid, rng: Rng, cells: number[], k: number, inside: (i: number) => boolean): number[] {
  const seeds = [cells[nextInt(rng, cells.length)]];
  while (seeds.length < k) {
    const dist = bfs(g, seeds, inside);
    let best = -1;
    for (const i of cells) if (dist[i] >= 0 && (best < 0 || dist[i] > dist[best])) best = i;
    if (best < 0 || dist[best] === 0) break;
    seeds.push(best);
  }
  return seeds;
}

/**
 * Grow one label per seed over the cells where `inside` holds, always growing the label furthest below its
 * target (sizes compared by cross-multiplication), by a random frontier cell. Returns the label per cell (-1 = none).
 */
function grow(g: Grid, rng: Rng, seeds: number[], targets: number[], inside: (i: number) => boolean): Int32Array {
  const label = new Int32Array(g.cols * g.rows).fill(-1);
  const size = seeds.map(() => 1);
  const frontier: number[][] = seeds.map(() => []);
  const push = (k: number, i: number) => {
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j >= 0 && label[j] < 0 && inside(j)) frontier[k].push(j);
    }
  };
  seeds.forEach((s, k) => (label[s] = k));
  seeds.forEach((s, k) => push(k, s));
  for (;;) {
    let pick = -1;
    for (let k = 0; k < seeds.length; k++) {
      const f = frontier[k];
      while (f.length && label[f[f.length - 1]] >= 0) f.pop();
      if (!f.length) continue;
      if (pick < 0 || size[k] * targets[pick] < size[pick] * targets[k]) pick = k;
    }
    if (pick < 0) return label;
    const f = frontier[pick];
    // A random live frontier cell: swap it to the end and take it.
    let at = nextInt(rng, f.length);
    while (label[f[at]] >= 0) {
      f[at] = f[f.length - 1];
      f.pop();
      if (!f.length) break;
      at = nextInt(rng, f.length);
    }
    if (!f.length) continue;
    const cell = f[at];
    f[at] = f[f.length - 1];
    f.pop();
    label[cell] = pick;
    size[pick]++;
    push(pick, cell);
  }
}

// ---- names ------------------------------------------------------------------------------------------------------
// Original names from short syllable lists (real-sounding place names are fine; no franchise names).
const PREFIXES = ['Ash', 'Bram', 'Cal', 'Dun', 'Ell', 'Fen', 'Gar', 'Hal', 'Ist', 'Kel', 'Lun', 'Mar', 'Nor', 'Oss', 'Pell', 'Quen', 'Ros', 'Sel', 'Tor', 'Vel', 'Wen', 'Yar', 'Brack', 'Cor'];
const SUFFIXES = ['brook', 'by', 'dale', 'den', 'fell', 'ford', 'gate', 'holm', 'hurst', 'mere', 'moor', 'ness', 'ridge', 'stead', 'thorpe', 'wick', 'wold', 'worth', 'combe', 'haven'];
const REGION_ROOTS = ['Amber', 'Briar', 'Cinder', 'Dusk', 'Ember', 'Frost', 'Gold', 'Iron', 'Mist', 'Raven', 'Salt', 'Stone', 'Thorn', 'Willow', 'Wolf', 'Copper', 'Heron', 'Bracken', 'Hollow', 'Lantern', 'Pine', 'Rook', 'Sorrel', 'Tallow', 'Umber', 'Vesper', 'Wren', 'Yew', 'Alder', 'Bell', 'Cobalt', 'Drift', 'Elder', 'Flint', 'Gorse', 'Hazel', 'Juniper', 'Larch', 'Moss', 'Nettle'];
const REGION_KINDS = ['March', 'Reach', 'Vale', 'Fells', 'Wold', 'Coast', 'Downs', 'Heath', 'Shire', 'Weald'];

function pickDistinct(rng: Rng, n: number, count: number): number[] {
  const pool = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const j = i + nextInt(rng, n - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out;
}

// ---- geometry -----------------------------------------------------------------------------------------------------

/** SVG path of the union of the cells where `inside` holds: one closed ring per boundary, clockwise. */
function tracePath(g: Grid, cells: number[], inside: (i: number) => boolean): { path: string; minX: number; minY: number; maxX: number; maxY: number } {
  // Every boundary edge, keyed by its start vertex. A hex vertex touches three cells, so for any union of cells
  // each boundary vertex has exactly one outgoing boundary edge: the rings never branch.
  const next = new Map<number, number>();
  const key = (x: number, y: number) => x * 65536 + y;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of cells)
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j >= 0 && inside(j)) continue;
      const [ax, ay] = VERT[d];
      const [bx, by] = VERT[(d + 1) % 6];
      const x1 = g.cx[i] + ax, y1 = g.cy[i] + ay;
      next.set(key(x1, y1), key(g.cx[i] + bx, g.cy[i] + by));
      if (x1 < minX) minX = x1;
      if (x1 > maxX) maxX = x1;
      if (y1 < minY) minY = y1;
      if (y1 > maxY) maxY = y1;
    }
  const starts = [...next.keys()].sort((a, b) => a - b);
  const seen = new Set<number>();
  let path = '';
  for (const s of starts) {
    if (seen.has(s)) continue;
    let v = s;
    let ring = '';
    do {
      seen.add(v);
      ring += `${ring ? 'L' : 'M'}${Math.floor(v / 65536)},${v % 65536}`;
      v = next.get(v)!;
    } while (v !== s);
    path += ring + 'Z';
  }
  return { path, minX, minY, maxX, maxY };
}

/** Suggested region bonus, as build-map.mjs prints it: max(1, round(size / 3 + entries * 0.6)), in integers. */
export function suggestBonus(size: number, entries: number): number {
  return Math.max(1, Math.floor((10 * size + 18 * entries + 15) / 30));
}

// ---- the generator ------------------------------------------------------------------------------------------------

/** Build a gen1 board. Throws RuleError for a bad spec, or if no attempt passes the quality checks. */
export function generateMap(spec: GenSpec): GeneratedMap {
  checkSpec(spec);
  const problems: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const out = attemptBoard(spec, createRng(mix(spec.seed, attempt)));
    if (typeof out !== 'string') return out;
    problems.push(out);
  }
  throw new RuleError(`Could not generate ${formatGenId(spec)}: ${problems.slice(-3).join('; ')}`);
}

/** Generate the board for a gen id (parse + generate). */
export function generateFromId(id: string): GeneratedMap {
  return generateMap(parseGenId(id));
}

function attemptBoard(spec: GenSpec, rng: Rng): GeneratedMap | string {
  const T = spec.territories;
  const K = spec.regions;
  // ---- 1. grid and land: a blob grown from the middle, about half the grid ----
  const landTarget = Math.floor((T * CELLS_PER_TERRITORY * 13) / 10);
  const area = landTarget * 2;
  const cols = Math.max(8, isqrt(Math.floor((area * 115) / 100)) + 2);
  const rows = Math.max(8, Math.ceil(area / (cols - 2)) + 2);
  const g = makeGrid(cols, rows);
  const n = cols * rows;
  const inner = (i: number) => {
    const c = i % cols, r = Math.floor(i / cols);
    return c > 1 && r > 1 && c < cols - 2 && r < rows - 2;
  };
  const land = new Uint8Array(n);
  const midX = (g.cx[0] + g.cx[n - 1]) >> 1;
  const midY = (g.cy[0] + g.cy[n - 1]) >> 1;
  const spanX = Math.max(1, g.cx[n - 1] - g.cx[0]);
  const spanY = Math.max(1, g.cy[n - 1] - g.cy[0]);
  const ellipse = (i: number) => {
    const dx = g.cx[i] - midX, dy = g.cy[i] - midY;
    return dx * dx * spanY * spanY + dy * dy * spanX * spanX;
  };
  {
    const start = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    land[start] = 1;
    const frontier: number[] = [];
    const inFrontier = new Uint8Array(n);
    const addFrontier = (i: number) => {
      for (let d = 0; d < 6; d++) {
        const j = g.nb[i * 6 + d];
        if (j >= 0 && !land[j] && !inFrontier[j] && inner(j)) {
          inFrontier[j] = 1;
          frontier.push(j);
        }
      }
    };
    addFrontier(start);
    let count = 1;
    while (count < landTarget && frontier.length) {
      // The roundest of three random frontier cells: a blob with a bumpy coast.
      let at = nextInt(rng, frontier.length);
      for (let t = 0; t < 2; t++) {
        const other = nextInt(rng, frontier.length);
        if (ellipse(frontier[other]) < ellipse(frontier[at])) at = other;
      }
      const cell = frontier[at];
      frontier[at] = frontier[frontier.length - 1];
      frontier.pop();
      land[cell] = 1;
      count++;
      addFrontier(cell);
    }
    // Smooth: fill inlets and one-cell lakes, drop spits.
    for (let pass = 0; pass < 2; pass++) {
      const snap = land.slice();
      for (let i = 0; i < n; i++) {
        if (!inner(i)) continue;
        let k = 0;
        for (let d = 0; d < 6; d++) {
          const j = g.nb[i * 6 + d];
          if (j >= 0 && snap[j]) k++;
        }
        if (!snap[i] && k >= 4) land[i] = 1;
        else if (snap[i] && k <= 1) land[i] = 0;
      }
    }
  }
  keepLargest(g, land, (i) => land[i] === 1);
  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (land[i]) landCells.push(i);

  // ---- 2. regions ----
  const isLand = (i: number) => land[i] === 1;
  const regionSeeds = spreadSeeds(g, rng, landCells, K, isLand);
  if (regionSeeds.length < K) return 'too few region seeds';
  const base = Math.floor(landCells.length / K);
  const regionTargets = regionSeeds.map(() => Math.max(4, Math.floor((base * (80 + nextInt(rng, 41))) / 100)));
  const region = grow(g, rng, regionSeeds, regionTargets, isLand);
  const regionCells: number[][] = Array.from({ length: K }, () => []);
  for (const i of landCells) regionCells[region[i]].push(i);

  // Region contacts on the uncut land: pairs [a, b] (a < b) with their border cell pairs.
  const contacts = new Map<number, Array<[number, number]>>();
  for (const i of landCells)
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j < 0 || !land[j] || region[j] <= region[i]) continue;
      const k = region[i] * K + region[j];
      if (!contacts.has(k)) contacts.set(k, []);
      contacts.get(k)!.push([i, j]);
    }
  const pairs = [...contacts.keys()].filter((k) => contacts.get(k)!.length >= 3).sort((a, b) => a - b);

  // ---- 3. which neighbouring regions stay linked: a random spanning tree, then extra links up to 3 per region ----
  const order = pairs.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const parent = Array.from({ length: K }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const degree = new Array(K).fill(0);
  const linked: number[] = [];
  const rest: number[] = [];
  for (const k of order) {
    const a = Math.floor(k / K), b = k % K;
    if (find(a) !== find(b)) {
      parent[find(a)] = find(b);
      linked.push(k);
      degree[a]++;
      degree[b]++;
    } else rest.push(k);
  }
  if (new Set(Array.from({ length: K }, (_, i) => find(i))).size > 1) return 'regions not connected';
  // Regions left with one link get a second where they can; then any pair where both have room.
  for (const wantLeaf of [true, false])
    for (const k of rest.slice()) {
      const a = Math.floor(k / K), b = k % K;
      if (wantLeaf && degree[a] !== 1 && degree[b] !== 1) continue;
      if (degree[a] >= 3 || degree[b] >= 3) continue;
      if (!wantLeaf && nextInt(rng, 2) === 0) continue;
      linked.push(k);
      rest.splice(rest.indexOf(k), 1);
      degree[a]++;
      degree[b]++;
    }
  linked.sort((a, b) => a - b);

  // ---- 4. cut a one-cell channel along every region border, keeping land bridges ("passes") for linked pairs ----
  // A region with a single neighbour gets two passes to it, so it still has two entries.
  const regionSize = regionCells.map((c) => c.length);
  // The side of each pair that turns to water: the bigger region (ties: the higher index), unless only the other
  // side has a cell that can be a pass.
  const cutOf = new Map<number, number>();
  const cutSide = (a: number, b: number) => cutOf.get(a * K + b) ?? (regionSize[a] > regionSize[b] ? a : b);
  const keep = new Uint8Array(n);
  const linkedSet = new Set(linked);
  // Pass cells on `side` toward `other`: touching only these two regions, with a neighbour of its own region that
  // does not touch the other one (so the pass stays joined to its region after the cut).
  const passCells = (k: number, side: number, other: number) => {
    const cand: number[] = [];
    for (const [i, j] of contacts.get(k)!) {
      const c = region[i] === side ? i : j;
      if (cand.includes(c)) continue;
      let ok = true, anchored = false;
      for (let d = 0; d < 6 && ok; d++) {
        const x = g.nb[c * 6 + d];
        if (x < 0 || !land[x]) continue;
        if (region[x] !== side && region[x] !== other) ok = false;
        else if (region[x] === side) {
          let touches = false;
          for (let e = 0; e < 6; e++) {
            const y = g.nb[x * 6 + e];
            if (y >= 0 && land[y] && region[y] !== side) touches = true;
          }
          if (!touches) anchored = true;
        }
      }
      if (ok && anchored) cand.push(c);
    }
    return cand;
  };
  for (const k of linked) {
    const a = Math.floor(k / K), b = k % K;
    let side = cutSide(a, b);
    let cand = passCells(k, side, side === a ? b : a);
    if (!cand.length) {
      side = side === a ? b : a;
      cand = passCells(k, side, side === a ? b : a);
      cutOf.set(k, side);
    }
    if (!cand.length) return 'no pass cell';
    const want = Math.max(spec.passes, degree[a] === 1 || degree[b] === 1 ? 2 : 1);
    // Spread the passes along the border: sort the candidates across the line between the regions' seeds.
    const sa = regionSeeds[a], sb = regionSeeds[b];
    const px = -(g.cy[sb] - g.cy[sa]), py = g.cx[sb] - g.cx[sa];
    cand.sort((x, y) => g.cx[x] * px + g.cy[x] * py - (g.cx[y] * px + g.cy[y] * py) || x - y);
    for (let p = 0; p < want; p++) keep[cand[Math.floor(((2 * p + 1) * cand.length) / (2 * want))]] = 1;
  }
  const cut = new Uint8Array(n);
  for (const i of landCells) {
    if (keep[i]) continue;
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j < 0 || !land[j] || region[j] === region[i]) continue;
      // Every border is cut on its pair's cut side (linked or not); only the pass cells stay.
      if (cutSide(Math.min(region[i], region[j]), Math.max(region[i], region[j])) === region[i]) {
        cut[i] = 1;
        break;
      }
    }
  }
  for (const i of landCells) if (cut[i]) land[i] = 0;
  // Trim the one-cell spurs the cut leaves (cells with at most one land neighbour), then each region keeps its
  // largest piece; slivers become water.
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of landCells) {
      if (!land[i] || keep[i]) continue;
      let k = 0;
      for (let d = 0; d < 6; d++) {
        const j = g.nb[i * 6 + d];
        if (j >= 0 && land[j]) k++;
      }
      if (k <= 1) {
        land[i] = 0;
        changed = true;
      }
    }
  }
  for (let r = 0; r < K; r++) keepLargest(g, land, (i) => land[i] === 1 && region[i] === r);
  const cells: number[] = [];
  for (let i = 0; i < n; i++) if (land[i]) cells.push(i);
  // No contact may remain between unlinked regions.
  for (const i of cells)
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j >= 0 && land[j] && region[j] !== region[i] && !linkedSet.has(Math.min(region[i], region[j]) * K + Math.max(region[i], region[j])))
        return 'unlinked regions touch';
    }

  // ---- 5. territories: shared out by region size, grown inside each region ----
  const rc: number[][] = Array.from({ length: K }, () => []);
  for (const i of cells) rc[region[i]].push(i);
  const total = cells.length;
  const counts = rc.map((c) => Math.floor((T * c.length) / total));
  const remainders = rc.map((c, r) => ({ r, rem: (T * c.length) % total }));
  remainders.sort((x, y) => y.rem - x.rem || x.r - y.r);
  for (let i = 0; counts.reduce((s, x) => s + x, 0) < T; i++) counts[remainders[i % K].r]++;
  if (counts.some((x) => x < 2)) return 'a region with fewer than 2 territories';
  const terr = new Int32Array(n).fill(-1);
  let nextT = 0;
  for (let r = 0; r < K; r++) {
    const inRegion = (i: number) => land[i] === 1 && region[i] === r;
    const seeds = spreadSeeds(g, rng, rc[r], counts[r], inRegion);
    if (seeds.length < counts[r]) return 'too few territory seeds';
    const lab = grow(g, rng, seeds, seeds.map(() => 1), inRegion);
    for (const i of rc[r]) {
      if (lab[i] < 0) return 'territory growth missed a cell';
      terr[i] = nextT + lab[i];
    }
    nextT += counts[r];
  }
  const tCells: number[][] = Array.from({ length: T }, () => []);
  for (const i of cells) tCells[terr[i]].push(i);
  if (tCells.some((c) => c.length < 4)) return 'a territory under 4 cells';

  // ---- 6. adjacency ----
  const adj = Array.from({ length: T }, () => new Set<number>());
  for (const i of cells)
    for (let d = 0; d < 6; d++) {
      const j = g.nb[i * 6 + d];
      if (j >= 0 && land[j] && terr[j] !== terr[i]) adj[terr[i]].add(terr[j]);
    }
  // A few dead ends are fine (one per 15 territories); a board full of them is not.
  if (adj.some((s) => s.size < 1) || adj.filter((s) => s.size < 2).length > Math.floor(T / 15)) return 'too many dead-end territories';
  const tRegion = tCells.map((c) => region[c[0]]);
  // Entry territories per region: 1-3 for a region of up to 5 territories, up to 5 for a bigger one.
  const entries = new Array(K).fill(0);
  for (let t = 0; t < T; t++) if ([...adj[t]].some((u) => tRegion[u] !== tRegion[t])) entries[tRegion[t]]++;
  for (let r = 0; r < K; r++) {
    const max = counts[r] <= 5 ? 3 : 5;
    if (entries[r] < 1 || entries[r] > max || entries[r] >= counts[r]) return `region with ${entries[r]} entries`;
  }
  if (!connected(T, adj)) return 'board not connected';

  // ---- 7. ids, names, geometry ----
  // Regions in reading order of their first cell; territories by region, then reading order of their first cell.
  const regionOrder = Array.from({ length: K }, (_, r) => r).sort((a, b) => rc[a][0] - rc[b][0]);
  const regionRank = new Array(K);
  regionOrder.forEach((r, i) => (regionRank[r] = i));
  const tOrder = Array.from({ length: T }, (_, t) => t).sort((a, b) => regionRank[tRegion[a]] - regionRank[tRegion[b]] || tCells[a][0] - tCells[b][0]);
  const tRank = new Array(T);
  tOrder.forEach((t, i) => (tRank[t] = i));
  const pad = (i: number) => String(i + 1).padStart(T >= 100 ? 3 : 2, '0');
  const tId = (t: number) => `t${pad(tRank[t])}`;
  const rId = (r: number) => `r${regionRank[r] + 1}`;

  const nameIdx = pickDistinct(rng, PREFIXES.length * SUFFIXES.length, T);
  const rootIdx = pickDistinct(rng, REGION_ROOTS.length, K);
  const kindIdx = Array.from({ length: K }, () => nextInt(rng, REGION_KINDS.length));
  const tName = (t: number) => {
    const k = nameIdx[tRank[t]];
    return PREFIXES[Math.floor(k / SUFFIXES.length)] + SUFFIXES[k % SUFFIXES.length];
  };

  const territories: TerritoryDef[] = tOrder.map((t) => {
    const own = tCells[t];
    const inside = (i: number) => land[i] === 1 && terr[i] === t;
    const shape = tracePath(g, own, inside);
    // Badge anchor: the most enclosed cell, then the one nearest the cells' centroid.
    let sx = 0, sy = 0;
    for (const i of own) {
      sx += g.cx[i];
      sy += g.cy[i];
    }
    let best = own[0], bestIn = -1, bestD = Infinity;
    for (const i of own) {
      let k = 0;
      for (let d = 0; d < 6; d++) {
        const j = g.nb[i * 6 + d];
        if (j >= 0 && inside(j)) k++;
      }
      const dx = g.cx[i] * own.length - sx, dy = g.cy[i] * own.length - sy;
      const dd = dx * dx + dy * dy;
      if (k > bestIn || (k === bestIn && dd < bestD)) {
        best = i;
        bestIn = k;
        bestD = dd;
      }
    }
    return {
      id: tId(t),
      name: tName(t),
      continent: rId(tRegion[t]),
      x: g.cx[best],
      y: g.cy[best],
      path: shape.path,
      bbox: [shape.minX, shape.minY, shape.maxX - shape.minX, shape.maxY - shape.minY],
    };
  });
  const anchors = territories.map((t) => [t.x, t.y] as const);
  const viewBox: [number, number] = [2 * MARGIN + CELL_W * cols + HALF_W, 2 * MARGIN + ROW_H * (rows - 1) + 40];
  const placed: Array<[number, number, number]> = [];

  const continents: ContinentDef[] = regionOrder.map((r) => {
    const members = tOrder.filter((t) => tRegion[t] === r);
    const inside = (i: number) => land[i] === 1 && region[i] === r;
    const outline = tracePath(g, rc[r], inside).path;
    const leaf = degree[r] <= 1 ? 1 : 0;
    const bonus = Math.max(1, suggestBonus(members.length, entries[r]) - leaf);
    const name = `${REGION_ROOTS[rootIdx[regionRank[r]]]} ${REGION_KINDS[kindIdx[regionRank[r]]]}`;
    const label = placeLabel(g, land, rc[r], `${name} +${bonus}`, anchors, viewBox[0], placed);
    return { id: rId(r), name, bonus, territories: members.map(tId), outline, ...(label ? { labelX: label[0], labelY: label[1] } : {}) };
  });

  const edges: [string, string][] = [];
  for (let t = 0; t < T; t++)
    for (const u of adj[t]) {
      const a = tId(t), b = tId(u);
      if (a < b) edges.push([a, b]);
    }
  edges.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));

  return {
    id: formatGenId(spec),
    name: `Generated board ${spec.seed} (${T})`,
    maxPlayers: spec.seats,
    viewBox,
    territories,
    continents,
    edges,
    seaLinks: [],
  };
}

/** Keep only the largest connected piece of the cells where `inside` holds; the rest of them become water. */
function keepLargest(g: Grid, land: Uint8Array, inside: (i: number) => boolean): void {
  const n = g.cols * g.rows;
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || !inside(i)) continue;
    const dist = bfs(g, [i], inside);
    let size = 0;
    for (let j = 0; j < n; j++)
      if (dist[j] >= 0) {
        comp[j] = id;
        size++;
      }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
    id++;
  }
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== best) land[i] = 0;
}

function connected(T: number, adj: Set<number>[]): boolean {
  const seen = new Uint8Array(T);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const t = stack.pop()!;
    for (const u of adj[t])
      if (!seen[u]) {
        seen[u] = 1;
        count++;
        stack.push(u);
      }
  }
  return count === T;
}

/**
 * A region label position over open water near the region: the client draws it upper-case, centred, about 9.5
 * units per character and 12 tall. The box must clear every land cell and badge, stay inside the board and not
 * overlap the labels already `placed` (each [x, y, half width], appended to). Returns null when nothing fits (the
 * client then places it above the region's badges).
 */
function placeLabel(
  g: Grid,
  land: Uint8Array,
  own: number[],
  text: string,
  anchors: ReadonlyArray<readonly [number, number]>,
  width: number,
  placed: Array<[number, number, number]>,
): [number, number] | null {
  const halfW = Math.ceil((text.length * 95) / 20) + 4;
  const halfH = 10;
  let sx = 0, sy = 0;
  for (const i of own) {
    sx += g.cx[i];
    sy += g.cy[i];
  }
  const mx = Math.floor(sx / own.length), my = Math.floor(sy / own.length);
  const n = g.cols * g.rows;
  let best: [number, number] | null = null, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    const x = g.cx[i], y = g.cy[i];
    const dx = x - mx, dy = y - my;
    const dd = dx * dx + dy * dy;
    if (dd >= bestD || x - halfW < 4 || x + halfW > width - 4) continue;
    let clear = true;
    for (const [px, py, pw] of placed) if (Math.abs(px - x) < halfW + pw + 8 && Math.abs(py - y) < 2 * halfH + 6) clear = false;
    for (let j = 0; j < n && clear; j++) {
      if (!land[j]) continue;
      // A land hex (radius 20) overlaps the box when its centre is within the box grown by the hex's size.
      // Plus a few units of open water around the text.
      if (Math.abs(g.cx[j] - x) < halfW + 24 && Math.abs(g.cy[j] - y) < halfH + 26) clear = false;
    }
    for (const [ax, ay] of anchors) if (Math.abs(ax - x) < halfW + 24 && Math.abs(ay - y) < halfH + 24) clear = false;
    if (clear) {
      best = [x, y];
      bestD = dd;
    }
  }
  if (best) placed.push([best[0], best[1], halfW]);
  return best;
}

// ---- start spots ----------------------------------------------------------------------------------------------------

/**
 * `n` start territories on any board, one per region in n different regions, spread as far apart as possible
 * (max-min BFS distance over the adjacency, then the smallest spread of nearest-spot distances). Deterministic for
 * a given board and seed. Used for the portals of a nested board (a winner of each child table starts there).
 */
export function pickStartSpots(map: MapDef, n: number, seed = 0): string[] {
  const ids = map.territoryIds;
  if (n < 1 || n > map.continents.length) throw new RuleError(`${map.name} has ${map.continents.length} regions; cannot pick ${n} start spots in different regions`);
  const index = new Map(ids.map((t, i) => [t, i]));
  const dist = ids.map((t) => {
    const d: number[] = new Array(ids.length).fill(-1);
    const q = [index.get(t)!];
    d[q[0]] = 0;
    for (let k = 0; k < q.length; k++)
      for (const u of map.adjacency[ids[q[k]]]) {
        const j = index.get(u)!;
        if (d[j] < 0) {
          d[j] = d[q[k]] + 1;
          q.push(j);
        }
      }
    return d;
  });
  const regionOf = ids.map((t) => map.territoryById[t].continent);
  const rng = createRng(seed);
  const starts = ids.map((_, i) => i);
  for (let i = starts.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [starts[i], starts[j]] = [starts[j], starts[i]];
  }
  let best: number[] | null = null, bestMin = -1, bestSpread = Infinity;
  for (const s of starts) {
    const pick = [s];
    while (pick.length < n) {
      let cand = -1, candD = -1;
      for (let i = 0; i < ids.length; i++) {
        if (pick.some((p) => regionOf[p] === regionOf[i])) continue;
        const d = Math.min(...pick.map((p) => dist[p][i]));
        if (d > candD) {
          cand = i;
          candD = d;
        }
      }
      if (cand < 0) break;
      pick.push(cand);
    }
    if (pick.length < n) continue;
    const nearest = pick.map((p) => Math.min(...pick.filter((q) => q !== p).map((q) => dist[p][q]), Infinity));
    const min = Math.min(...nearest);
    const spread = Math.max(...nearest) - min;
    if (min > bestMin || (min === bestMin && spread < bestSpread)) {
      best = pick;
      bestMin = min;
      bestSpread = spread;
    }
  }
  if (!best) throw new RuleError(`Could not pick ${n} start spots on ${map.name}`);
  return best.map((i) => ids[i]).sort();
}
