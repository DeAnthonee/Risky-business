#!/usr/bin/env node
// Paired gate statistics and a sequential test (SPRT) for a cycle's ladder gates, as Stockfish's fishtest decides
// patches: games stream in until the call is made at preset error rates, so clear results stop early and only close
// calls run long. docs: packages/delove/README.md "Gates: paired statistics and SPRT".
//
//   node packages/delove/scripts/sprt.mjs <gates dir> [--h0 0] [--h1 0.15] [--alpha 0.05] [--beta 0.05]
//        [--next <chunks per table>] [--max-games N] [--base <opponent id>] [--json]
//
// <gates dir> is a cycle's OUT/gates: pool.txt ("i k opponent players games options" per chunk, written by cycle.sh)
// and g<i>-<k>.json (one ladder result per chunk). The unit is a mirrored pair (same seed, seats swapped): the pair's
// points difference per seat (pairPointsDiff, written by runMatch and delove_gpu.ladder). Chunks from before that
// field fall back to the chunk's own points difference, one unit per chunk.
//
// The decision follows the owner's promotion rule (docs/delove-status.md section 3): pooled mean leaderboard points
// per seat at 4-10 players against the gate's opponent table, each table weighted equally (the mean of the per-table
// means), compared with H0: diff <= h0 against H1: diff >= h1. The log-likelihood ratio of the pooled mean under a
// normal model is LLR = (h1 - h0) / var * (mean - (h0 + h1) / 2); H1 is accepted at LLR >= ln((1 - beta) / alpha),
// H0 at LLR <= ln(beta / (1 - alpha)), otherwise the test continues. 2-player tables are reported with their paired
// 95% interval (the rule: not significantly worse at 2 players). Only gates against one opponent (the first gate's)
// (or --base's) are pooled; reference-panel gates are reported, never pooled.
//
// --next K prints, for an undecided test, K more chunk lines per pooled table (and per 2-player table whose interval
// still crosses 0), "i k opponent players games options" continuing each table's chunk numbering, up to --max-games
// per table; cycle.sh (GATE_SPRT=1) plays them and asks again.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || !existsSync(join(dir, 'pool.txt'))) {
  console.error('usage: sprt.mjs <gates dir with pool.txt> [--h0 0] [--h1 0.15] [--alpha 0.05] [--beta 0.05] [--next K] [--max-games N] [--json]');
  process.exit(2);
}
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : Number(args[i + 1]);
};
const h0 = opt('h0', 0);
const h1 = opt('h1', 0.15);
const alpha = opt('alpha', 0.05);
const beta = opt('beta', 0.05);
const next = opt('next', 0);
const maxGames = opt('max-games', 800);

// Gate definitions from the pool: per gate index, opponent, players, options, chunk size and the chunks planned.
const gates = new Map();
for (const line of readFileSync(join(dir, 'pool.txt'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [i, k, opp, players, games, ...rest] = line.trim().split(' ');
  const g = gates.get(+i) ?? { i: +i, opp, players: +players, options: rest.join(' ') || '{}', chunk: +games, ks: [] };
  g.ks.push(+k);
  gates.set(+i, g);
}

// Units per gate: the pairs of every finished chunk.
const files = readdirSync(dir);
for (const g of gates.values()) {
  g.units = [];
  g.games = 0;
  g.maxK = Math.max(...g.ks);
  for (const f of files) {
    const m = new RegExp(`^g${g.i}-(\\d+)\\.json$`).exec(f);
    if (!m) continue;
    g.maxK = Math.max(g.maxK, +m[1]);
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    g.games += r.games;
    if (Array.isArray(r.pairPointsDiff) && r.pairPointsDiff.length) g.units.push(...r.pairPointsDiff);
    else if (typeof r.pointsDiff === 'number') (g.units.push(r.pointsDiff), (g.chunkLevel = true));
  }
  const n = g.units.length;
  g.mean = n ? g.units.reduce((a, b) => a + b, 0) / n : 0;
  const v = n > 1 ? g.units.reduce((a, x) => a + (x - g.mean) ** 2, 0) / (n - 1) : NaN;
  g.se = n > 1 ? Math.sqrt(v / n) : NaN;
}

const all = [...gates.values()].sort((a, b) => a.i - b.i);
const bi = args.indexOf('--base');
const base = bi >= 0 ? args[bi + 1] : all[0]?.opp;
const pooled = all.filter((g) => g.opp === base && g.players >= 4 && g.units.length > 1);
const duels = all.filter((g) => g.opp === base && g.players === 2 && g.units.length > 1);
const k = pooled.length;
const mean = k ? pooled.reduce((a, g) => a + g.mean, 0) / k : NaN;
const se = k ? Math.sqrt(pooled.reduce((a, g) => a + g.se ** 2, 0)) / k : NaN;
const llr = k ? ((h1 - h0) / se ** 2) * (mean - (h0 + h1) / 2) : 0;
const upper = Math.log((1 - beta) / alpha);
const lower = Math.log(beta / (1 - alpha));
let verdict = llr >= upper ? 'H1' : llr <= lower ? 'H0' : 'continue';
const duelWorse = duels.some((g) => g.mean + 1.96 * g.se < 0);
const duelOpen = duels.filter((g) => g.mean - 1.96 * g.se < 0 && g.mean + 1.96 * g.se > 0);
// Every pooled table has reached its cap and the test is still open: stop, undecided.
const capped = pooled.every((g) => g.games >= maxGames);
if (verdict === 'continue' && capped) verdict = 'undecided (cap)';

const f2 = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : 'n/a');
if (next > 0) {
  // More chunks: pooled tables while the test is open; 2-player tables while their interval crosses 0.
  const grow = verdict === 'continue' ? [...pooled, ...duelOpen] : [];
  for (const g of grow) {
    let kk = g.maxK;
    for (let j = 0; j < next && g.games + (j + 1) * g.chunk <= maxGames; j++) console.log(`${g.i} ${++kk} ${g.opp} ${g.players} ${g.chunk} ${g.options}`);
  }
  process.exit(0);
}
if (args.includes('--json')) {
  console.log(JSON.stringify({ verdict, llr, upper, lower, mean, se, h0, h1, tables: all.map(({ i, opp, players, options, games, mean: m, se: s, chunkLevel }) => ({ i, opp, players, options, games, mean: m, se: s, chunkLevel: !!chunkLevel })) }));
  process.exit(0);
}
console.log(`| opponent | players | options | games | pairs | points diff per seat (paired 95%) |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const g of all)
  console.log(`| ${g.opp} | ${g.players} | ${g.options} | ${g.games} | ${g.units.length}${g.chunkLevel ? ' (chunks)' : ''} | ${f2(g.mean)} (${f2(g.mean - 1.96 * g.se)} to ${f2(g.mean + 1.96 * g.se)}) |`);
console.log('');
console.log(`**SPRT vs ${base}** (pooled ${k} tables at 4-10p, each weighted equally; H0 <= ${h0}, H1 >= ${h1} points per seat, alpha ${alpha}, beta ${beta}): ` +
  `pooled ${f2(mean)} (95% ${f2(mean - 1.96 * se)} to ${f2(mean + 1.96 * se)}), LLR ${llr.toFixed(2)} (bounds ${lower.toFixed(2)} / ${upper.toFixed(2)}): ` +
  (verdict === 'H1' ? '**better (H1 accepted)**' : verdict === 'H0' ? '**not better (H0 accepted)**' : `**${verdict}**`) +
  (duels.length ? `; 2p: ${duels.map((g) => f2(g.mean)).join(', ')}${duelWorse ? ' **significantly worse**' : ' (not significantly worse)'}` : ''));
