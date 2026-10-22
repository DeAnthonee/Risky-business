// Layout for the live globe of a nested ("Inception") tournament: the boards of the round being played tile the
// sphere, each drawn as a patch (a cap) around its own spot. Spots run along a spiral from pole to pole in the tree's
// breadth-first order, so tables that feed the same next-round board sit next to each other. Pure, no three.js.
import type { MapDef, NestNode } from '@risk/engine';

export type Vec3 = [number, number, number];

/** Where a board sits on the sphere: its centre, a tangent frame (board +u is east, +v is south) and its scale. */
export interface Patch {
  centre: Vec3;
  east: Vec3;
  north: Vec3;
  /** Radians of arc per board unit. */
  k: number;
  /** The board's centre in its own coordinates. */
  cu: number;
  cv: number;
}

/** A snapshot status per node, enough to tell which round is being played. */
type Status = 'waiting' | 'playing' | 'finished' | 'decided';

/**
 * The depth of the round in play: the deepest level with a table waiting or playing; failing that, the shallowest level
 * that has any table (everything settled: the last round shown); with no tables at all, the first round (deepest).
 */
export function liveDepth(nodes: readonly NestNode[], status: (i: number) => Status | undefined): number {
  let deepest = -1;
  let shallowestSeen = Infinity;
  nodes.forEach((n, i) => {
    const s = status(i);
    if (s === 'waiting' || s === 'playing') deepest = Math.max(deepest, n.depth);
    if (s) shallowestSeen = Math.min(shallowestSeen, n.depth);
  });
  if (deepest >= 0) return deepest;
  if (shallowestSeen !== Infinity) return shallowestSeen;
  return nodes.reduce((d, n) => Math.max(d, n.depth), 0);
}

/**
 * `n` points spread evenly over the sphere along a spiral from the north pole to the south pole (Saff and Kuijlaars),
 * so consecutive points are neighbours. Y is up.
 */
export function spiralPoints(n: number): Vec3[] {
  if (n === 1) return [[0, 0, 1]];
  const out: Vec3[] = [];
  let phi = 0;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i) / (n - 1);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    if (i > 0 && i < n - 1) phi += 3.6 / Math.sqrt(n * (1 - y * y));
    out.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
  }
  return out;
}

/** Angular radius of the cap each of `n` evenly spread boards gets (no overlap), at most a wide hemisphere. */
export function capRadius(n: number): number {
  // n caps of equal area cover the sphere at acos(1 - 2/n); packing circles leaves gaps, so take 85% of that.
  return n <= 1 ? 1.25 : 0.85 * Math.acos(1 - 2 / n);
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A tangent frame at `c`: east along the parallel, north towards +Y (any frame at the poles). */
export function frameAt(c: Vec3): { east: Vec3; north: Vec3 } {
  const up: Vec3 = Math.abs(c[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const east = unit(cross(up, c));
  return { east, north: unit(cross(c, east)) };
}

/**
 * The patches of the boards at `depth`, in node order: each on its spiral spot, as large as its cap allows (the board's
 * half-diagonal reaches the cap's edge).
 */
export function livePatches(nodes: readonly NestNode[], depth: number, mapOf: (id: string) => MapDef): Map<number, Patch> {
  const live = nodes.map((n, i) => (n.depth === depth ? i : -1)).filter((i) => i >= 0);
  const spots = spiralPoints(live.length);
  const radius = capRadius(live.length);
  const out = new Map<number, Patch>();
  live.forEach((i, j) => {
    const [x0, y0, x1, y1] = landBox(mapOf(nodes[i].map));
    const centre = spots[j];
    out.set(i, { centre, ...frameAt(centre), k: radius / (Math.hypot(x1 - x0, y1 - y0) / 2), cu: (x0 + x1) / 2, cv: (y0 + y1) / 2 });
  });
  return out;
}

/** The box around a board's land (its territories), in board units: [x0, y0, x1, y1]. Boards carry sea margins. */
export function landBox(map: MapDef): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of map.territories) {
    const [bx, by, bw, bh] = t.bbox;
    x0 = Math.min(x0, bx);
    y0 = Math.min(y0, by);
    x1 = Math.max(x1, bx + bw);
    y1 = Math.max(y1, by + bh);
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, map.viewBox[0], map.viewBox[1]];
}

/** A board point (u, v) on its patch: walk the arc from the centre (azimuthal equidistant), at radius `r`. */
export function onPatch(p: Patch, u: number, v: number, r = 1): Vec3 {
  const x = (u - p.cu) * p.k;
  const y = -(v - p.cv) * p.k; // board v grows downwards, north is up
  const a = Math.hypot(x, y);
  if (a < 1e-9) return [p.centre[0] * r, p.centre[1] * r, p.centre[2] * r];
  const [dx, dy] = [x / a, y / a];
  const dir: Vec3 = [p.east[0] * dx + p.north[0] * dy, p.east[1] * dx + p.north[1] * dy, p.east[2] * dx + p.north[2] * dy];
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [(p.centre[0] * c + dir[0] * s) * r, (p.centre[1] * c + dir[1] * s) * r, (p.centre[2] * c + dir[2] * s) * r];
}

/** The polygons of an SVG path made of M/L/H/V/Z commands (generated boards draw only those), as [u, v] rings. */
export function pathRings(d: string): [number, number][][] {
  const rings: [number, number][][] = [];
  let ring: [number, number][] = [];
  let x = 0;
  let y = 0;
  const tokens = d.match(/[MLHVZmlhvz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let cmd = 'M';
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (ring.length > 2) rings.push(ring);
        ring = [];
      }
      continue;
    }
    const num = (k: number) => Number(tokens[i + k]);
    const rel = cmd === cmd.toLowerCase();
    if (cmd === 'M' || cmd === 'm') {
      if (ring.length > 2) rings.push(ring);
      ring = [];
      x = rel ? x + num(0) : num(0);
      y = rel ? y + num(1) : num(1);
      ring.push([x, y]);
      i += 2;
      cmd = rel ? 'l' : 'L';
    } else if (cmd === 'L' || cmd === 'l') {
      x = rel ? x + num(0) : num(0);
      y = rel ? y + num(1) : num(1);
      ring.push([x, y]);
      i += 2;
    } else if (cmd === 'H' || cmd === 'h') {
      x = rel ? x + num(0) : num(0);
      ring.push([x, y]);
      i += 1;
    } else if (cmd === 'V' || cmd === 'v') {
      y = rel ? y + num(0) : num(0);
      ring.push([x, y]);
      i += 1;
    } else i++; // unsupported command (curves): skip its numbers one by one
  }
  if (ring.length > 2) rings.push(ring);
  return rings;
}
