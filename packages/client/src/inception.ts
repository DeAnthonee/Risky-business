// Layout for the nested ("Inception") tournament view: where each board of a resolved nest tree sits, drawn inside
// its parent's portal territory, in the outermost board's coordinates. Pure, so the zoom and hit areas are testable.
import type { MapDef, NestNode } from '@risk/engine';

/** A board placed in root coordinates: its own (0,0)-(W,H) viewBox maps to x + u * scale, y + v * scale. */
export interface Placement {
  x: number;
  y: number;
  scale: number;
  /** The board's size in its own coordinates. */
  w: number;
  h: number;
}

/** How much of a portal's bounding box a child board fills (the rest is margin around it). */
export const PORTAL_FILL = 0.84;

/**
 * Place every node: the outermost board at scale 1, and each child centred in its portal territory's bounding box
 * (in the parent's placement), as large as fits while keeping its aspect ratio.
 */
export function layoutNest(nodes: readonly NestNode[], mapOf: (id: string) => MapDef): Placement[] {
  const out: Placement[] = [];
  nodes.forEach((n, i) => {
    const [w, h] = mapOf(n.map).viewBox;
    if (n.parent === null || n.portal === null) {
      out[i] = { x: 0, y: 0, scale: 1, w, h };
      return;
    }
    const p = out[n.parent];
    const box = mapOf(nodes[n.parent].map).territoryById[n.portal]?.bbox ?? [0, 0, p.w, p.h];
    const [bx, by, bw, bh] = box;
    const fit = Math.min((bw * PORTAL_FILL) / w, (bh * PORTAL_FILL) / h);
    const scale = fit * p.scale;
    out[i] = { x: p.x + (bx + bw / 2) * p.scale - (w * scale) / 2, y: p.y + (by + bh / 2) * p.scale - (h * scale) / 2, scale, w, h };
  });
  return out;
}

/** The camera (an SVG viewBox in root coordinates) that frames one placed board, with a small margin. */
export function cameraFor(p: Placement, margin = 0.04): [number, number, number, number] {
  const w = p.w * p.scale;
  const h = p.h * p.scale;
  return [p.x - w * margin, p.y - h * margin, w * (1 + 2 * margin), h * (1 + 2 * margin)];
}

/** The chain of node indexes from the outermost board down to `index`. */
export function pathTo(nodes: readonly NestNode[], index: number): number[] {
  const chain: number[] = [];
  for (let i: number | null = index; i !== null; i = nodes[i].parent) chain.unshift(i);
  return chain;
}

/**
 * A step of the zoom between two cameras at time t in [0, 1]: eased, with the size changing geometrically so a deep
 * zoom feels even (a linear width would rush the first frames).
 */
export function lerpCamera(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const w = a[2] * (b[2] / a[2]) ** e;
  const h = a[3] * (b[3] / a[3]) ** e;
  // Keep the centre moving linearly in eased time.
  const cx = a[0] + a[2] / 2 + (b[0] + b[2] / 2 - (a[0] + a[2] / 2)) * e;
  const cy = a[1] + a[3] / 2 + (b[1] + b[3] / 2 - (a[1] + a[3] / 2)) * e;
  return [cx - w / 2, cy - h / 2, w, h];
}
