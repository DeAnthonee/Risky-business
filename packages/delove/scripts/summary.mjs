#!/usr/bin/env node
// Summarise one step of a Delove cycle: the games played (generate.sh chunk results) and what branch-and-score did
// (stats-*.json written with DELOVE_BRANCH_STATS), or, for a step played on the GPU, its gpu.json (delove_gpu.generate
// --summary: the same per-table results and branch stats). Prints Markdown and writes <dir>/summary.json.
//
//   node packages/delove/scripts/summary.mjs runs/delove/c1/micro "Cycle 1, step 1: micro games"
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, title = dir] = process.argv.slice(2);
if (!dir || !existsSync(dir)) {
  console.error('usage: summary.mjs <step dir> [title]');
  process.exit(2);
}
const json = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const results = readdirSync(dir).filter((f) => /-c\d+\.json$/.test(f) && !f.startsWith('stats-')).map((f) => ({ group: f.replace(/-c\d+\.json$/, ''), ...json(f) }));
const stats = readdirSync(dir).filter((f) => /^stats-\d+(-[0-9a-f]+)?\.json$/.test(f)).map(json);
if (existsSync(join(dir, 'gpu.json'))) {
  const gpu = json('gpu.json');
  for (const t of [...gpu.tables].sort((a, b) => (a.table < b.table ? -1 : 1))) {
    results.push({ group: t.table, agents: t.agents, games: t.games, winsBySeat: t.wins, meanTurns: t.turns / t.games, decisions: t.decisions, turnLimit: t.turnLimit, seconds: 0 });
  }
  stats.push(gpu.branch);
}

const groups = new Map();
for (const r of results) {
  const g = groups.get(r.group) ?? { agents: r.agents, games: 0, wins: new Array(r.agents.length).fill(0), turns: 0, decisions: 0, limit: 0, seconds: 0 };
  g.games += r.games;
  r.winsBySeat.forEach((w, i) => (g.wins[i] += w));
  g.turns += r.meanTurns * r.games;
  g.decisions += r.decisions;
  g.limit += r.turnLimit;
  g.seconds += r.seconds;
  groups.set(r.group, g);
}

const total = { decisions: 0, branched: 0, simulations: 0, simulatedMoves: 0, changed: 0, gain: 0, changedByKind: {}, branchedByKind: {}, chosen: {} };
for (const s of stats) {
  for (const k of ['decisions', 'branched', 'simulations', 'simulatedMoves', 'changed', 'gain']) total[k] += s[k];
  for (const k of ['changedByKind', 'branchedByKind', 'chosen']) for (const [kk, v] of Object.entries(s[k])) total[k][kk] = (total[k][kk] ?? 0) + v;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const n = (x) => Math.round(x).toLocaleString('en-US');
const lines = [`### ${title}`, '', '| table | games | seat wins | mean turns | turn limit | decisions |', '| --- | --- | --- | --- | --- | --- |'];
for (const [name, g] of groups) {
  const seats = g.agents.map((a, i) => `${a.replace('delove-', '')} ${g.wins[i]}`).join(', ');
  lines.push(`| ${name} | ${n(g.games)} | ${seats} | ${(g.turns / g.games).toFixed(1)} | ${g.limit} | ${n(g.decisions)} |`);
}
const games = [...groups.values()].reduce((a, g) => a + g.games, 0);
lines.push('', `**${n(games)} games.**`);
if (total.decisions) {
  const b = total.branched || 1;
  lines.push(
    '',
    '| branch and score | |',
    '| --- | --- |',
    `| branching player's decisions | ${n(total.decisions)} |`,
    `| branched (compared options) | ${n(total.branched)} (${pct(total.branched, total.decisions)}) |`,
    `| simulations run | ${n(total.simulations)} (${n(total.simulatedMoves)} simulated moves) |`,
    `| changed the teacher's move | ${n(total.changed)} (${pct(total.changed, total.branched)} of branched) |`,
    `| average score gain per branched decision | +${(total.gain / b).toFixed(4)} |`,
    `| changes by kind | ${Object.entries(total.changedByKind).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${n(v)}/${n(total.branchedByKind[k] ?? 0)}`).join(', ')} |`,
    `| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | ${['armies', 'income', 'territories', 'cards', 'continents'].map((k) => ((total.chosen[k] ?? 0) / b).toFixed(3)).join(' / ')} |`,
    `| chosen branches that had won / lost within the horizon | ${pct(total.chosen.won ?? 0, b)} / ${pct(total.chosen.lost ?? 0, b)} |`,
  );
}
const md = lines.join('\n');
console.log(md);
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ title, groups: Object.fromEntries(groups), branch: total }, null, 2));
writeFileSync(join(dir, 'summary.md'), md + '\n');
