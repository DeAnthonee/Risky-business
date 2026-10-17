import { BALANCED_BLITZ_RUNS } from './engine.js';

/** Chance of each attacker-loss count for one roll with `a` attack dice against `d` defence dice (ties to the defender). */
const rollTables = new Map<string, number[]>();
function rollTable(a: number, d: number): number[] {
  const key = `${a}:${d}`;
  const cached = rollTables.get(key);
  if (cached) return cached;
  const pairs = Math.min(a, d);
  const counts = new Array(pairs + 1).fill(0);
  const total = 6 ** (a + d);
  for (let n = 0; n < total; n++) {
    let x = n;
    const ad: number[] = [];
    const dd: number[] = [];
    for (let i = 0; i < a; i++) (ad.push((x % 6) + 1), (x = Math.floor(x / 6)));
    for (let i = 0; i < d; i++) (dd.push((x % 6) + 1), (x = Math.floor(x / 6)));
    ad.sort((p, q) => q - p);
    dd.sort((p, q) => q - p);
    let attackerLosses = 0;
    for (let i = 0; i < pairs; i++) if (ad[i] <= dd[i]) attackerLosses++;
    counts[attackerLosses]++;
  }
  const table = counts.map((c) => c / total);
  rollTables.set(key, table);
  return table;
}

/** Attack dice a blitz rolls from `armies` when it must not drop the stack below `stopAt`. */
export function blitzAttackDice(armies: number, stopAt: number): number {
  return Math.max(0, Math.min(3, armies - 1, armies - stopAt));
}

export interface BlitzOdds {
  /** Chance the territory falls with ordinary random dice. */
  win: number;
  /** Chance it falls with balanced blitz on (the median of BALANCED_BLITZ_RUNS full blitzes is played out). */
  balancedWin: number;
  /** Average armies the attacker loses with ordinary dice. */
  expectedAttackerLosses: number;
  /** Average armies the defender loses with ordinary dice. */
  expectedDefenderLosses: number;
  /** False for huge stacks, where the odds come from a proportionally scaled-down battle (see MAX_ODDS_CELLS). */
  exact: boolean;
}

/**
 * Above this many (attacker x defender) states the odds are computed on a battle scaled down in proportion,
 * so a late-game stack of thousands never blocks the browser or the server (format.ts runs this for every
 * listed attack). About 500 v 500 stays exact.
 */
export const MAX_ODDS_CELLS = 250_000;

interface AllIn {
  /** win[a]: chance that an all-in blitz from `a` attackers takes `D` defenders, for a = 0..A. */
  win: Float64Array;
  /** Expected losses of the all-in blitz from A attackers into D defenders. */
  lossA: number;
  lossD: number;
}

/**
 * Exact all-in blitz table from up to A attackers into D defenders. Each roll costs at most 3 armies in
 * total, so only the last 4 attacker rows are kept: memory O(D), time O(A x D).
 */
function allIn(A: number, D: number, defenseLimit: number): AllIn {
  const cols = D + 1;
  const rows = Array.from({ length: 4 }, () => ({ win: new Float64Array(cols), la: new Float64Array(cols), ld: new Float64Array(cols) }));
  const winAtD = new Float64Array(A + 1);
  for (let a = 0; a <= A; a++) {
    const row = rows[a % 4];
    for (let d = 0; d <= D; d++) {
      if (d === 0) {
        row.win[0] = 1;
        row.la[0] = 0;
        row.ld[0] = 0;
        continue;
      }
      const ad = blitzAttackDice(a, 1);
      if (ad < 1) {
        row.win[d] = 0;
        row.la[d] = 0;
        row.ld[d] = 0;
        continue;
      }
      const table = rollTable(ad, Math.min(defenseLimit, d));
      const pairs = table.length - 1;
      let w = 0;
      let la = 0;
      let ld = 0;
      for (let k = 0; k <= pairs; k++) {
        const p = table[k];
        if (p === 0) continue;
        const from = rows[(a - k) % 4]; // k = 0 is this row, at a smaller d (already filled)
        const j = d - (pairs - k);
        w += p * from.win[j];
        la += p * (k + from.la[j]);
        ld += p * (pairs - k + from.ld[j]);
      }
      row.win[d] = w;
      row.la[d] = la;
      row.ld[d] = ld;
    }
    winAtD[a] = row.win[D];
  }
  const last = rows[A % 4];
  return { win: winAtD, lossA: last.la[D], lossD: last.ld[D] };
}

/** Scale (A, D) down in proportion when the table would exceed MAX_ODDS_CELLS; returns the factor used. */
function fit(A: number, D: number): { A: number; D: number; scale: number } {
  const cells = (A + 1) * (D + 1);
  if (cells <= MAX_ODDS_CELLS) return { A, D, scale: 1 };
  const scale = Math.sqrt(MAX_ODDS_CELLS / cells);
  return { A: Math.max(2, Math.round(A * scale)), D: Math.max(1, Math.round(D * scale)), scale };
}

function balanced(p: number): number {
  // The median of n runs is a conquest exactly when more than half of the runs conquer.
  const n = BALANCED_BLITZ_RUNS;
  let b = 0;
  for (let k = Math.floor(n / 2) + 1; k <= n; k++) b += binomial(n, k) * p ** k * (1 - p) ** (n - k);
  return b;
}

/**
 * Odds of a blitz from a stack of `fromArmies` into `toArmies` defenders that defend with up to
 * `defenseLimit` dice, stopping once the attacking stack is down to `stopAt` (1 = fight to the end).
 * Rolls follow the engine: the attacker rolls up to 3 dice but never more than it can lose without going
 * below `stopAt`; the defender rolls min(defenseLimit, defenders). So committing N armies (stopAt =
 * fromArmies - N) fights exactly like an all-in blitz from N + 1, which is what is computed. Exact up to
 * MAX_ODDS_CELLS states, a proportional approximation above.
 */
export function blitzOdds(fromArmies: number, toArmies: number, defenseLimit: number, stopAt = 1): BlitzOdds {
  const floor = Math.max(1, Math.floor(stopAt));
  const D = Math.max(0, Math.floor(toArmies));
  const A = Math.max(0, Math.floor(fromArmies) - floor + 1);
  if (D === 0) return { win: 1, balancedWin: 1, expectedAttackerLosses: 0, expectedDefenderLosses: 0, exact: true };
  const f = fit(A, D);
  const t = allIn(f.A, f.D, defenseLimit);
  const p = t.win[f.A];
  return { win: p, balancedWin: balanced(p), expectedAttackerLosses: t.lossA / f.scale, expectedDefenderLosses: t.lossD / f.scale, exact: f.scale === 1 };
}

/**
 * The fewest armies to commit (stopAt = fromArmies - commit) for at least `target` chance to take the
 * territory, or null if even committing everything (stopAt 1) falls short. `balanced` uses the balanced-blitz
 * odds. Committing c fights like an all-in blitz from c + 1, so one all-in table answers every commitment.
 */
export function commitForOdds(fromArmies: number, toArmies: number, defenseLimit: number, target: number, balancedOn = false): number | null {
  const max = Math.floor(fromArmies) - 1;
  if (max < 1) return null;
  const D = Math.max(0, Math.floor(toArmies));
  if (D === 0) return 1;
  const f = fit(max + 1, D);
  const t = allIn(f.A, f.D, defenseLimit);
  const chance = (commit: number) => {
    const a = f.scale === 1 ? commit + 1 : Math.min(f.A, Math.max(0, Math.round((commit + 1) * f.scale)));
    return balancedOn ? balanced(t.win[a]) : t.win[a];
  };
  if (chance(max) < target) return null;
  // Odds only rise with the commitment: binary search over the precomputed table.
  let lo = 1;
  let hi = max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chance(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
