import type { RankedGame, RankingRow } from './ranking.js';

/**
 * Gives every leaderboard row its own display name: no two rows may both read "Darius". The identity that reached the
 * board first (by `results` order, i.e. completion order) keeps the name; later ones become "Darius2", "Darius3", ...
 * (case-insensitive, skipping any number already taken). Display only: keys and points are unchanged. Kept apart from
 * `ranking.ts`, which the GPU mirror fingerprints.
 */
export function uniqueBoardNames(rows: readonly RankingRow[], results: readonly RankedGame[]): RankingRow[] {
  const first = new Map<string, number>();
  for (const result of results) for (const seat of result.seats) if (!first.has(seat.key)) first.set(seat.key, first.size);
  const order = [...rows].sort((a, b) => (first.get(a.key) ?? Infinity) - (first.get(b.key) ?? Infinity) || a.key.localeCompare(b.key));
  const fold = (s: string) => s.trim().toLowerCase();
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const row of order) {
    const base = row.name.trim() || row.key;
    let name = base;
    for (let n = 2; taken.has(fold(name)); n++) name = `${base}${n}`;
    taken.add(fold(name));
    names.set(row.key, name);
  }
  return rows.map((row) => ({ ...row, name: names.get(row.key)! }));
}
