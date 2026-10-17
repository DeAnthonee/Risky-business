/**
 * Character traits that steer how a player plays. They are inputs to the strategy network (one network, many
 * styles) and are logged with every decision. Each is in [0, 1]; 0.5 is neutral.
 *
 * The order of TRAIT_KEYS is the order of the trait vector in decision logs. Only append new keys: a trainer reads
 * older logs by position.
 */
export const TRAIT_KEYS = ['aggression', 'riskTolerance', 'grudge', 'expansion', 'cardHoarding', 'caution'] as const;

export type TraitKey = (typeof TRAIT_KEYS)[number];
export type Traits = Record<TraitKey, number>;

export const NEUTRAL_TRAITS: Traits = Object.fromEntries(TRAIT_KEYS.map((k) => [k, 0.5])) as Traits;

/** Fill in missing traits with 0.5 and reject values outside [0, 1]. */
export function makeTraits(partial: Partial<Traits> = {}): Traits {
  const t = { ...NEUTRAL_TRAITS };
  for (const [k, v] of Object.entries(partial)) {
    if (!(TRAIT_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown trait "${k}" (known: ${TRAIT_KEYS.join(', ')})`);
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`Trait "${k}" must be a number in [0, 1]`);
    t[k as TraitKey] = v;
  }
  return t;
}

export function traitVector(t: Traits): number[] {
  return TRAIT_KEYS.map((k) => t[k]);
}
