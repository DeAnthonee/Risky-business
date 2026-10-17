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
}

/**
 * Exact odds of a blitz from a stack of `fromArmies` into `toArmies` defenders that defend with up to
 * `defenseLimit` dice, stopping once the attacking stack is down to `stopAt` (1 = fight to the end).
 * Rolls follow the engine: the attacker rolls up to 3 dice but never more than it can lose without going
 * below `stopAt`; the defender rolls min(defenseLimit, defenders).
 */
export function blitzOdds(fromArmies: number, toArmies: number, defenseLimit: number, stopAt = 1): BlitzOdds {
  const floor = Math.max(1, Math.floor(stopAt));
  const A = Math.max(0, Math.floor(fromArmies));
  const D = Math.max(0, Math.floor(toArmies));
  const cols = D + 1;
  // win[a][d] and expected losses for each state; states only move to fewer armies, so fill in order.
  const win = new Float64Array((A + 1) * cols);
  const lossA = new Float64Array((A + 1) * cols);
  const lossD = new Float64Array((A + 1) * cols);
  for (let a = 0; a <= A; a++) {
    for (let d = 0; d <= D; d++) {
      const i = a * cols + d;
      if (d === 0) {
        win[i] = 1;
        continue;
      }
      const ad = blitzAttackDice(a, floor);
      if (ad < 1) continue; // stopped: no win, no further losses
      const dd = Math.min(defenseLimit, d);
      const table = rollTable(ad, dd);
      const pairs = table.length - 1;
      let w = 0;
      let la = 0;
      let ld = 0;
      for (let k = 0; k <= pairs; k++) {
        const p = table[k];
        if (p === 0) continue;
        const j = (a - k) * cols + (d - (pairs - k));
        w += p * win[j];
        la += p * (k + lossA[j]);
        ld += p * (pairs - k + lossD[j]);
      }
      win[i] = w;
      lossA[i] = la;
      lossD[i] = ld;
    }
  }
  const i = A * cols + D;
  const p = win[i];
  // The median of n runs is a conquest exactly when more than half of the runs conquer.
  const n = BALANCED_BLITZ_RUNS;
  let balancedWin = 0;
  for (let k = Math.floor(n / 2) + 1; k <= n; k++) balancedWin += binomial(n, k) * p ** k * (1 - p) ** (n - k);
  return { win: p, balancedWin, expectedAttackerLosses: lossA[i], expectedDefenderLosses: lossD[i] };
}

/**
 * The fewest armies to commit (stopAt = fromArmies - commit) for at least `target` chance to take the
 * territory, or null if even committing everything (stopAt 1) falls short. `balanced` uses the balanced-blitz
 * odds. Odds only rise with the commitment, so this is a binary search over blitzOdds.
 */
export function commitForOdds(fromArmies: number, toArmies: number, defenseLimit: number, target: number, balanced = false): number | null {
  const max = Math.floor(fromArmies) - 1;
  if (max < 1) return null;
  const chance = (commit: number) => {
    const o = blitzOdds(fromArmies, toArmies, defenseLimit, fromArmies - commit);
    return balanced ? o.balancedWin : o.win;
  };
  if (chance(max) < target) return null;
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
