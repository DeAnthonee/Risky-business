import { createRng, nextFloat } from '@risk/engine';
import type { RandomSource } from '@risk/engine';

/** Mix two 32-bit integers into a well-spread 32-bit seed (murmur3 finaliser). */
export function mixSeed(a: number, b: number): number {
  let h = (Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Seed of game number `index` in a run started from `base`. Independent of how games are split over workers. */
export function gameSeed(base: number, index: number): number {
  return mixSeed(base, index);
}

/** A seeded RandomSource (mulberry32 from the engine). */
export function seededRandom(seed: number): RandomSource {
  const rng = createRng(seed);
  return () => nextFloat(rng);
}
