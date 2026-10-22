#!/usr/bin/env node
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import type { GameOptions } from '@risk/engine';
import {
  compareHorde,
  DEFAULT_HORDE_TABLES,
  HORDE_METRICS,
  hordeSchedule,
  parseHordeTables,
  summarizeHorde,
  type HordeGame,
  type HordeMetric,
} from './horde.js';
import { runHordeParallel as runParallel } from './horde-run.js';

/**
 * The Zerg-horde gate (docs/zergs.md, section 5): a candidate seat against 2-3 coordinated Zergs, optionally compared
 * with a base on the same games.
 *
 *   npm run delove:horde -- --candidate delove@10 [--base jacob-sensei@2] [--games 200] [--tables classic:4:3,...] [--zerg zerg-branch@1] [--base-zerg zerg@1]
 *
 * Output: one JSON line on stdout, a table on stderr: per table and pooled, the candidate's (and base's) hold, win,
 * place, rounds, kills and leaderboard points with 95% intervals; with --base the paired differences (the verdict on
 * --metric, default hold). Seeds are fixed by --seed (default 1), so successive Delove versions meet the same games.
 */

async function main() {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      base: { type: 'string' },
      filler: { type: 'string', default: 'jacob-sensei@2' },
      zerg: { type: 'string', default: 'zerg@1' },
      'base-zerg': { type: 'string' },
      tables: { type: 'string', default: DEFAULT_HORDE_TABLES },
      games: { type: 'string', default: '100' },
      seed: { type: 'string', default: '1' },
      metric: { type: 'string', default: 'hold' },
      options: { type: 'string', default: '{}' },
      'max-turns': { type: 'string', default: '500' },
      procs: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
    },
  });
  if (!values.candidate) throw new Error('--candidate is required');
  const metric = values.metric as HordeMetric;
  if (!HORDE_METRICS.includes(metric)) throw new Error(`--metric must be one of ${HORDE_METRICS.join(', ')}`);
  const tables = parseHordeTables(values.tables!);
  const schedule = hordeSchedule(tables, Number(values.games), Number(values.seed));
  const common = { filler: values.filler!, zerg: values.zerg!, games: schedule, options: JSON.parse(values.options!) as Partial<GameOptions>, maxTurns: Number(values['max-turns']) };
  const procs = Number(values.procs);
  const t0 = Date.now();
  const cand = await runParallel({ ...common, agent: values.candidate }, procs);
  if (values.base && values['base-zerg']) throw new Error('use --base (another candidate) or --base-zerg (another horde), not both');
  // --base-zerg: the same candidate against another horde on the same games; a negative diff = the --zerg horde is stronger.
  const base = values.base
    ? await runParallel({ ...common, agent: values.base }, procs)
    : values['base-zerg']
      ? await runParallel({ ...common, agent: values.candidate, zerg: values['base-zerg'] }, procs)
      : null;

  const byTable = [...tables.map((t) => `${t.map}:${t.players}:${t.zergs}`), 'pooled'].map((name) => {
    const pick = (games: HordeGame[]) => (name === 'pooled' ? games : games.filter((g) => g.table === name));
    const c = pick(cand);
    const b = base ? pick(base) : null;
    return { table: name, candidate: summarizeHorde(c), ...(b ? { base: summarizeHorde(b), compare: compareHorde(c, b, metric) } : {}) };
  });
  console.log(JSON.stringify({ candidate: values.candidate, base: values.base ?? null, baseZerg: values['base-zerg'] ?? null, filler: values.filler, zerg: values.zerg, metric, seconds: (Date.now() - t0) / 1000, tables: byTable }));

  const f = (x: number) => x.toFixed(3);
  console.error(`horde gate: ${values.candidate}${values.base ? ` vs ${values.base}` : ''}${values['base-zerg'] ? ` (Zergs ${values.zerg} vs ${values['base-zerg']})` : ''} (filler ${values.filler}, Zergs ${values.zerg}), ${values.games} games per table`);
  for (const t of byTable) {
    const c = t.candidate.metrics;
    let line = `${t.table.padEnd(16)} hold ${f(c.hold.mean)} win ${f(c.win.mean)} place ${f(c.place.mean)} rounds ${c.rounds.mean.toFixed(1)} kills ${f(c.kills.mean)} points ${f(c.points.mean)} game ${t.candidate.gameRounds} rounds TL ${t.candidate.turnLimit}`;
    const d = (m: HordeMetric) => { const x = t.compare!.diffs[m]; return `${m} ${f(x.mean)} [${f(x.low)}, ${f(x.high)}]`; };
    if (t.base && t.compare) line += ` | base ${metric} ${f(t.base.metrics[metric].mean)} | diff ${d(metric)} ${t.compare.verdict}; ${(['points', 'kills'] as HordeMetric[]).filter((m) => m !== metric).map(d).join('; ')}`;
    console.error(line);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
