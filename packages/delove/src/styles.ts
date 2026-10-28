/**
 * Opponent styles for branch and score's rollouts (T2, the bootstrapped teacher; BranchOptions.styles).
 *
 * With styles on, the decider's seat in every rollout copy plays the rollout network's top move, and each other seat
 * plays one style for the whole copy, drawn from the copy's seed (never from the seat's stream, so the game stays in
 * step with the GPU mirror): `net` (the rollout network), or the rollout teacher with some of its numbers scaled
 * (STYLE_SCALES): `aggr` attacks more and defends less, `turtle` the reverse, `zerg` (a stand-in for the Zerg horde,
 * which the GPU mirror does not play) rushes. Pluribus-style continuation strategies: the move is scored against a
 * mix of opponents instead of one.
 *
 * packages/delove-gpu reads STYLE_SCALES, STYLE_SALT and parseStyles' format from this file: keep them literal.
 */
import { createRng, nextFloat } from '@risk/engine';
import type { TeacherParams } from './teacher.js';

/** Multipliers of the rollout teacher's numbers per style (keys shared by Sensei and Jacob; both halves of a staged Jacob). */
export const STYLE_SCALES: Record<string, Partial<Record<keyof TeacherParams, number>>> = {
  aggr: { minWin: 0.75, minEv: 0.5, ownLoss: 0.6, captureBase: 1.4, defenseBase: 0.7, placeDefenseMult: 0.7 },
  turtle: { minWin: 1.3, minEv: 2, ownLoss: 1.5, captureBase: 0.7, defenseBase: 1.6, placeDefenseMult: 1.5 },
  zerg: { minWin: 0.6, minEv: 0.2, ownLoss: 0.4, captureBase: 1.6, elimBase: 1.5, defenseBase: 0.4, placeDefenseMult: 0.5 },
};

/** XORed into a copy's seed for its style draws. */
export const STYLE_SALT = 0x51e7c0de;

export const STYLE_NAMES = ['net', ...Object.keys(STYLE_SCALES)] as const;

export interface StyleMix {
  /** Style names in the order given, with their weights (cumulative sums are taken in this order). */
  names: string[];
  weights: number[];
}

/** 'net:0.4,aggr:0.2,turtle:0.2,zerg:0.2' -> the mix ('' or undefined: null, styles off). */
export function parseStyles(spec: string | undefined): StyleMix | null {
  if (!spec) return null;
  const names: string[] = [];
  const weights: number[] = [];
  for (const part of spec.split(',')) {
    const [name, w] = part.split(':');
    if (!(STYLE_NAMES as readonly string[]).includes(name) || names.includes(name)) throw new Error(`branch styles: unknown or repeated style ${name}`);
    const x = Number(w);
    if (!(x > 0)) throw new Error(`branch styles: weight of ${name} must be > 0`);
    names.push(name);
    weights.push(x);
  }
  return { names, weights };
}

/** A teacher's numbers with a style's multipliers applied. */
export function styleParams<P extends TeacherParams>(params: P, style: string): P {
  const out = { ...params };
  for (const [k, m] of Object.entries(STYLE_SCALES[style])) (out as unknown as Record<string, number>)[k] = (params as unknown as Record<string, number>)[k] * m;
  return out;
}

/**
 * The style of every seat of a copy (index in seat order, the Neutral left out: seatOrder): one draw per seat from
 * mulberry32 seeded with seed ^ STYLE_SALT, seat by seat (the decider draws too, so seat q's draw is the (q + 1)-th);
 * the decider plays 'net'; another player takes the first style whose cumulative weight exceeds u * total.
 */
export function copyStyles(seed: number, seats: number, me: number, mix: StyleMix): string[] {
  const rng = createRng((seed ^ STYLE_SALT) >>> 0);
  let total = 0;
  for (const w of mix.weights) total += w;
  const out: string[] = [];
  for (let q = 0; q < seats; q++) {
    const u = nextFloat(rng) * total;
    if (q === me) {
      out.push('net');
      continue;
    }
    let cum = 0;
    let pick = mix.names[mix.names.length - 1];
    for (let i = 0; i < mix.names.length; i++) {
      cum += mix.weights[i];
      if (u < cum) {
        pick = mix.names[i];
        break;
      }
    }
    out.push(pick);
  }
  return out;
}
