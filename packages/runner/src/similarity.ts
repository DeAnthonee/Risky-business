/** Small text-similarity helpers shared by the chat repetition guard and the curator checks. */

/** Drop bracketed machine tags such as `[deal D7: truce Shen+Lux until round 9]`. */
export const stripTags = (s: string) => s.replace(/\[[^\]]*\]/g, ' ');

/** Lower-case word tokens: punctuation gone, bracketed tags gone, `drop` words (player names) gone. */
export function tokens(s: string, drop?: ReadonlySet<string>): string[] {
  const out = stripTags(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  return drop && drop.size > 0 ? out.filter((t) => !drop.has(t)) : out;
}

/** Token-set Jaccard similarity, 0..1 (0 when either side is empty). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const t of sa) if (sb.has(t)) both++;
  return both / (sa.size + sb.size - both);
}

/** True when the two token lists share `n` consecutive tokens. */
export function sharesSequence(a: readonly string[], b: readonly string[], n: number): boolean {
  if (a.length < n || b.length < n) return false;
  const grams = new Set<string>();
  for (let i = 0; i + n <= a.length; i++) grams.add(a.slice(i, i + n).join(' '));
  for (let i = 0; i + n <= b.length; i++) if (grams.has(b.slice(i, i + n).join(' '))) return true;
  return false;
}

/** Split a line into sentences (at . ! ? and newlines). */
export function sentences(s: string): string[] {
  return stripTags(s)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
