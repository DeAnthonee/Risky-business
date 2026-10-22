import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gameSeed, mixSeed, resolveAgent, runBatch } from '@risk/selfplay';

/**
 * The A/B harness (`npm run delove:abtest <candidate>`, packages/delove/README.md "A/B scorecard"): a candidate against
 * a base version (default delove@13) over a frozen gate pool (configs/abtest-pool.json) that no training run plays.
 *
 * Duplicate deals: deal k of a table is played twice with the same seed (same board, dice and turn order), once with the
 * candidate in seat r and once with the base in that seat, every other seat the table's fixed field. The unit is the
 * candidate's leaderboard points in seat r minus the base's in the same seat of the same deal, so the deal's luck and
 * the field cancel. The seat r rotates with the deal (r = k mod players), so every seat and turn position is played.
 *
 * The verdict is a sequential test (SPRT) over the deciding tables (the fog tables: the owner's rule is "promote only if
 * better with fog on"), pooled with equal weight per table, as scripts/sprt.mjs decides a cycle's gates. Every table
 * reports its paired 95% interval, and a Plackett-Luce fit over the placements of every game puts the candidate, the
 * base and the field on one rating scale.
 */

/** A table of the gate pool. */
export interface GateTable {
  name: string;
  players: number;
  /**
   * The other seats, in order (players - 1 agent ids). The candidate's (or base's) seat is inserted at r; the field
   * keeps its order around it. "$base" stands for the base version.
   */
  field: string[];
  /**
   * Game options. `map` may be "gen1:t<territories>": a generated board per deal (`gen1-s<deal seed>-p<players>-t<n>`),
   * so a table plays many boards.
   */
  options: Record<string, unknown>;
  /** Deals to play (each is two games). A deciding table plays at least this many and goes on until the test decides. */
  deals: number;
  /** In the pooled sequential test that decides the verdict. */
  decides?: boolean;
  maxTurns?: number;
}

export interface SprtConfig {
  /** Points per seat: H0 says the gain is at most h0, H1 at least h1. */
  h0: number;
  h1: number;
  alpha: number;
  beta: number;
  /** Deals per deciding table at most. */
  maxDeals: number;
}

export interface GatePool {
  v: 1;
  name: string;
  /** Seeds of this pool's deals come from this number, far from the small seeds training cycles use. */
  seed: number;
  base: string;
  sprt: SprtConfig;
  tables: GateTable[];
}

/** One deal: the same seed played with the candidate and with the base in the same seat. */
export interface DealResult {
  table: number;
  deal: number;
  seat: number;
  /** Candidate's points in the seat minus the base's. */
  diff: number;
  candPlace: number;
  basePlace: number;
  candWin: boolean;
  baseWin: boolean;
  /** Agent ids in finishing order (first place first), one list per game: [candidate game, base game]. */
  rankings: [string[], string[]];
  turnLimit: number;
  turns: number;
}

export function loadPool(path: string): { pool: GatePool; hash: string } {
  const text = readFileSync(path, 'utf8');
  const pool = JSON.parse(text) as GatePool;
  if (pool.v !== 1) throw new Error(`${path}: unsupported pool version ${pool.v}`);
  for (const t of pool.tables) {
    if (t.field.length !== t.players - 1) throw new Error(`${path}: table ${t.name} has ${t.field.length} field seats for ${t.players} players`);
  }
  return { pool, hash: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12) };
}

/** Seed of deal k at table t: the same for every candidate, so all candidates face the same deals. */
export function dealSeed(pool: GatePool, table: number, deal: number): number {
  return gameSeed(mixSeed(pool.seed, table), deal);
}

/** Seats of a deal: the field with `player` inserted at seat r ("$base" in the field resolved to `base`). */
export function dealSeats(t: GateTable, r: number, player: string, base: string): string[] {
  const field = t.field.map((id) => (id === '$base' ? base : id));
  return [...field.slice(0, r), player, ...field.slice(r)];
}

/** The deal's options: a "gen1:t<n>" map becomes that deal's own generated board. */
export function dealOptions(t: GateTable, seed: number): Record<string, unknown> {
  const map = t.options.map;
  if (typeof map === 'string' && map.startsWith('gen1:')) {
    const n = /^gen1:t(\d+)$/.exec(map);
    if (!n) throw new Error(`table ${t.name}: map ${map} should be gen1:t<territories>`);
    return { ...t.options, map: `gen1-s${seed}-p${t.players}-t${n[1]}` };
  }
  return t.options;
}

const ranking = (r: { placement: number[] }, seats: string[]) =>
  r.placement
    .map((place, s) => ({ place, id: seats[s] }))
    .sort((a, b) => a.place - b.place)
    .map((x) => x.id);

/** Play deals [from, from + n) of table `ti`: two games each (candidate, then base, in seat k mod players). */
export async function playDeals(pool: GatePool, ti: number, from: number, n: number, candidate: string, base: string): Promise<DealResult[]> {
  const t = pool.tables[ti];
  const out: DealResult[] = [];
  for (let k = from; k < from + n; k++) {
    const seed = dealSeed(pool, ti, k);
    const r = k % t.players;
    const ids = [dealSeats(t, r, candidate, base), dealSeats(t, r, base, base)];
    const games = await runBatch({
      games: 2,
      seed,
      seedOf: () => seed,
      seats: (i) => ids[i].map((id) => ({ agent: resolveAgent(id) })),
      options: dealOptions(t, seed),
      maxTurns: t.maxTurns,
      onIllegal: 'surrender',
    });
    const [a, b] = games;
    out.push({
      table: ti,
      deal: k,
      seat: r,
      diff: a.points[r] - b.points[r],
      candPlace: a.placement[r],
      basePlace: b.placement[r],
      candWin: a.winner === r,
      baseWin: b.winner === r,
      rankings: [ranking(a, ids[0]), ranking(b, ids[1])],
      turnLimit: (a.winner === null ? 1 : 0) + (b.winner === null ? 1 : 0),
      turns: a.turns + b.turns,
    });
  }
  return out;
}

export interface TableStats {
  name: string;
  players: number;
  decides: boolean;
  deals: number;
  /** Mean points per seat, candidate minus base in the same seat of the same deal, with its 95% interval. */
  diff: number;
  low: number;
  high: number;
  se: number;
  candPlace: number;
  basePlace: number;
  candWins: number;
  baseWins: number;
  turnLimit: number;
}

export function tableStats(t: GateTable, deals: DealResult[]): TableStats {
  const n = deals.length;
  const mean = n ? deals.reduce((a, d) => a + d.diff, 0) / n : 0;
  const v = n > 1 ? deals.reduce((a, d) => a + (d.diff - mean) ** 2, 0) / (n - 1) : NaN;
  const se = n > 1 ? Math.sqrt(v / n) : NaN;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    name: t.name,
    players: t.players,
    decides: !!t.decides,
    deals: n,
    diff: r(mean),
    low: r(mean - 1.96 * se),
    high: r(mean + 1.96 * se),
    se: r(se),
    candPlace: r(n ? deals.reduce((a, d) => a + d.candPlace, 0) / n : 0),
    basePlace: r(n ? deals.reduce((a, d) => a + d.basePlace, 0) / n : 0),
    candWins: deals.filter((d) => d.candWin).length,
    baseWins: deals.filter((d) => d.baseWin).length,
    turnLimit: deals.reduce((a, d) => a + d.turnLimit, 0),
  };
}

export interface SprtResult {
  status: 'H1' | 'H0' | 'continue';
  /** Equal-weight mean of the deciding tables' means, its standard error and the log-likelihood ratio. */
  mean: number;
  se: number;
  llr: number;
  lower: number;
  upper: number;
}

/**
 * The pooled sequential test of scripts/sprt.mjs: pooled mean = the mean of the per-table means, its variance the mean
 * of the per-table variances over T^2; LLR = (h1 - h0) / var * (mean - (h0 + h1) / 2) under a normal model.
 */
export function pooledSprt(tables: TableStats[], cfg: SprtConfig): SprtResult {
  const ts = tables.filter((t) => t.decides && t.deals > 1 && Number.isFinite(t.se));
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const lower = r(Math.log(cfg.beta / (1 - cfg.alpha)));
  const upper = r(Math.log((1 - cfg.beta) / cfg.alpha));
  if (!ts.length) return { status: 'continue', mean: 0, se: NaN, llr: 0, lower, upper };
  const mean = ts.reduce((a, t) => a + t.diff, 0) / ts.length;
  // A zero spread from a handful of deals would end the test at once: floor each table's standard error.
  const variance = ts.reduce((a, t) => a + Math.max(t.se, 0.05) ** 2, 0) / ts.length ** 2;
  const llr = ((cfg.h1 - cfg.h0) / variance) * (mean - (cfg.h0 + cfg.h1) / 2);
  const status = llr >= upper ? 'H1' : llr <= lower ? 'H0' : 'continue';
  return { status, mean: r(mean), se: r(Math.sqrt(variance)), llr: r(llr), lower, upper };
}

/**
 * Plackett-Luce strengths from finishing orders (Hunter's MM algorithm). Each list is one game, first place first; an
 * id seated several times in a game counts once per seat. Returns ratings on an Elo-like scale (400 log10 of the
 * strength ratio) with `anchor` at 0.
 */
export function plackettLuce(games: string[][], anchor: string, iterations = 200): Record<string, number> {
  const ids = [...new Set(games.flat())];
  // A weak prior: one virtual win and one virtual loss of every player against the anchor, so a player that never
  // loses (or never wins) keeps a finite rating.
  const rankings = [...games, ...ids.filter((id) => id !== anchor).flatMap((id) => [[id, anchor], [anchor, id]])];
  const gamma = new Map(ids.map((id) => [id, 1]));
  const wins = new Map(ids.map((id) => [id, 0]));
  // Each stage of a game: the first of the remaining players is chosen; the last stage (one left) carries nothing.
  for (const g of rankings) for (let s = 0; s < g.length - 1; s++) wins.set(g[s], wins.get(g[s])! + 1);
  for (let it = 0; it < iterations; it++) {
    const denom = new Map(ids.map((id) => [id, 0]));
    for (const g of rankings) {
      let total = g.reduce((a, id) => a + gamma.get(id)!, 0);
      for (let s = 0; s < g.length - 1; s++) {
        for (let j = s; j < g.length; j++) denom.set(g[j], denom.get(g[j])! + 1 / total);
        total -= gamma.get(g[s])!;
      }
    }
    for (const id of ids) {
      gamma.set(id, wins.get(id)! / denom.get(id)!);
    }
    const a = gamma.get(anchor) ?? 1;
    for (const id of ids) gamma.set(id, gamma.get(id)! / a);
  }
  return Object.fromEntries(ids.map((id) => [id, Math.round(400 * Math.log10(gamma.get(id)!))]));
}

/** Plackett-Luce ratings with a bootstrap 95% interval over deals (both games of a deal resampled together). */
export function ratings(deals: DealResult[], anchor: string, resamples: number, seed: number): Record<string, { elo: number; low: number; high: number }> {
  const all = deals.flatMap((d) => d.rankings);
  const point = plackettLuce(all, anchor);
  const draws: Record<string, number[]> = Object.fromEntries(Object.keys(point).map((id) => [id, []]));
  let s = seed >>> 0;
  const rand = () => ((s = mixSeed(s, 0x5bd1e995)) / 2 ** 32);
  for (let b = 0; b < resamples && deals.length > 1; b++) {
    const sample = Array.from({ length: deals.length }, () => deals[Math.floor(rand() * deals.length)]);
    const r = plackettLuce(sample.flatMap((d) => d.rankings), anchor);
    for (const id of Object.keys(point)) if (r[id] !== undefined) draws[id].push(r[id]);
  }
  const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
  return Object.fromEntries(Object.entries(point).map(([id, elo]) => [id, { elo, low: q(draws[id], 0.025), high: q(draws[id], 0.975) }]));
}

export interface Scorecard {
  candidate: string;
  base: string;
  pool: string;
  poolHash: string;
  /** 'better': the deciding tables accepted H1; 'not better': H0; 'undecided': stopped at maxDeals. */
  verdict: 'better' | 'not better' | 'undecided';
  sprt: SprtResult;
  /** Tables of 2 players: not significantly worse (the owner's rule at 2 players). */
  duelsOk: boolean;
  tables: TableStats[];
  ratings: Record<string, { elo: number; low: number; high: number }>;
  games: number;
  seconds: number;
}

export function scorecard(pool: GatePool, hash: string, candidate: string, base: string, deals: DealResult[][], seconds: number, resamples = 200): Scorecard {
  const tables = pool.tables.map((t, i) => tableStats(t, deals[i])).filter((t) => t.deals > 0);
  const sprt = pooledSprt(tables, pool.sprt);
  return {
    candidate,
    base,
    pool: pool.name,
    poolHash: hash,
    verdict: sprt.status === 'H1' ? 'better' : sprt.status === 'H0' ? 'not better' : 'undecided',
    sprt,
    duelsOk: tables.filter((t) => t.players === 2 && t.deals > 1).every((t) => t.high >= 0),
    tables,
    ratings: ratings(deals.flat(), base, resamples, pool.seed),
    games: 2 * deals.reduce((a, d) => a + d.length, 0),
    seconds,
  };
}

/** The scorecard as a short Markdown report. */
export function scorecardMarkdown(c: Scorecard): string {
  const sign = (x: number) => (x >= 0 ? `+${x}` : `${x}`);
  const lines = [
    `# A/B scorecard: ${c.candidate} vs ${c.base}`,
    '',
    `Pool ${c.pool} (${c.poolHash}), ${c.games} games, ${Math.round(c.seconds / 60)} min.`,
    '',
    (c.tables.some((t) => t.decides)
      ? `**Verdict: ${c.verdict}** (deciding tables pooled: ${sign(c.sprt.mean)} points per seat, se ${c.sprt.se}, LLR ${c.sprt.llr} in [${c.sprt.lower}, ${c.sprt.upper}]).`
      : '**No verdict:** no deciding (fog) table was played.') +
      ` 2-player tables ${c.duelsOk ? 'not worse' : 'significantly worse'}.`,
    '',
    '| table | players | decides | deals | points/seat (cand - base) | 95% | place cand / base | wins cand / base | turn limit |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...c.tables.filter((t) => t.deals > 0).map(
      (t) => `| ${t.name} | ${t.players} | ${t.decides ? 'yes' : ''} | ${t.deals} | ${sign(t.diff)} | ${t.low} to ${t.high} | ${t.candPlace} / ${t.basePlace} | ${t.candWins} / ${t.baseWins} | ${t.turnLimit} |`,
    ),
    '',
    `Plackett-Luce ratings over every game (${c.base} = 0, Elo-like scale, bootstrap 95%):`,
    '',
    '| player | rating | 95% |',
    '| --- | --- | --- |',
    ...Object.entries(c.ratings)
      .sort((a, b) => b[1].elo - a[1].elo)
      .map(([id, r]) => `| ${id} | ${sign(r.elo)} | ${r.low} to ${r.high} |`),
  ];
  return lines.join('\n') + '\n';
}
