#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import type { GameOptions } from '@risk/engine';
import { resolveAgent, type Agent } from '@risk/selfplay';
import { capturePosition, parseTables, playPair, routedAgent, stagedAgent, STAGES, summarize, type PairResult, type Stage, type StagePosition, type StageSpec } from './stage-eval.js';

/**
 * Range specialist against the base model on its own stage (docs/delove-status.md, "Range specialists: how they are
 * compared"), in parallel worker threads:
 *
 *   npm run delove:stages -- --stage close --candidate delove-close-range@1 --base delove@5 [--positions 400]
 *   npm run delove:stages -- --stage full --trio delove-long-range@1,delove-mid-range@1,delove-close-range@1 --base delove@5
 *
 * Every position is played twice (candidate on alternate alive seats, then the other ones; same seed), the candidate
 * seats played by the specialist only while the game is in its range (the base outside it). Output: one JSON line on
 * stdout, a table on stderr, with 95% intervals over positions of the candidate's and base's metric and their
 * difference. `--save-positions FILE` / `--load-positions FILE` keep a position set (local only, not for git).
 */

interface Job {
  stage: Stage;
  spec: StageSpec;
  candidate: string | null;
  trio: string[] | null;
  base: string;
  seed: number;
  capture: string;
  options: Partial<GameOptions>;
  maxTurns: number;
  indexes: number[];
  positions: StagePosition[] | null;
}

interface JobOut {
  pairs: PairResult[];
  positions: StagePosition[];
}

function candidateOf(job: Job): Agent {
  const base = resolveAgent(job.base);
  if (job.trio) {
    const [long, mid, close] = job.trio.map((id) => resolveAgent(id));
    return routedAgent(`trio(${job.trio.join(',')})`, { long, mid, close });
  }
  const spec = resolveAgent(job.candidate!);
  return job.spec.range ? stagedAgent(`${spec.id}/${job.spec.range}`, spec, base, job.spec.range) : spec;
}

function runJob(job: Job): JobOut {
  const base = resolveAgent(job.base);
  const candidate = candidateOf(job);
  const capture = resolveAgent(job.capture);
  const positions = job.positions ?? job.indexes.map((i) => capturePosition(job.spec, i, job.seed, capture, job.options, job.maxTurns));
  return { pairs: positions.map((p) => playPair(p, candidate, base, job.options, job.maxTurns)), positions };
}

function readOptions(v: string | undefined): Partial<GameOptions> {
  if (!v) return {};
  return JSON.parse(v.trim().startsWith('{') ? v : readFileSync(v, 'utf8'));
}

async function main() {
  const { values } = parseArgs({
    options: {
      stage: { type: 'string' },
      candidate: { type: 'string' },
      trio: { type: 'string' },
      base: { type: 'string' },
      positions: { type: 'string' },
      tables: { type: 'string' },
      seed: { type: 'string' },
      capture: { type: 'string' },
      options: { type: 'string' },
      workers: { type: 'string' },
      chunk: { type: 'string' },
      'max-turns': { type: 'string' },
      'save-positions': { type: 'string' },
      'load-positions': { type: 'string' },
    },
  });
  const stage = values.stage as Stage;
  if (!STAGES[stage]) throw new Error('--stage must be long, mid, close or full');
  if (!values.base) throw new Error('--base is required (the current delove@N)');
  if (!values.candidate === !values.trio) throw new Error('give exactly one of --candidate ID or --trio LONG,MID,CLOSE');
  const trio = values.trio ? values.trio.split(',') : null;
  if (trio && trio.length !== 3) throw new Error('--trio takes three ids: long,mid,close');
  const spec: StageSpec = { ...STAGES[stage], ...(values.tables ? { tables: parseTables(values.tables) } : {}) };
  const options = readOptions(values.options);
  if (options.fogOfWar) throw new Error('Delove refuses fog-of-war games (docs/delove-fog.md); use a no-fog option set');
  const seed = Number(values.seed ?? 1);
  const maxTurns = Number(values['max-turns'] ?? 500);
  const chunk = Number(values.chunk ?? 8);
  const loaded: StagePosition[] | null = values['load-positions'] ? JSON.parse(readFileSync(values['load-positions'], 'utf8')).positions : null;
  const n = loaded ? loaded.length : Number(values.positions ?? spec.positions);
  const base: Omit<Job, 'indexes' | 'positions'> = {
    stage,
    spec,
    candidate: values.candidate ?? null,
    trio,
    base: values.base,
    seed,
    capture: values.capture ?? 'jacob-sensei@1',
    options,
    maxTurns,
  };
  // Fail fast on a bad id, before any worker starts.
  for (const id of [values.base, base.capture, ...(trio ?? [values.candidate!])]) resolveAgent(id);
  const jobs: Job[] = [];
  for (let i = 0; i < n; i += chunk) {
    const indexes = Array.from({ length: Math.min(chunk, n - i) }, (_, k) => i + k);
    jobs.push({ ...base, spec: { ...spec, alive: null }, indexes, positions: loaded ? loaded.slice(i, i + indexes.length) : null });
  }
  const t0 = Date.now();
  const pairs: PairResult[] = [];
  const positions: StagePosition[] = [];
  const workers = Math.max(1, Math.min(Number(values.workers ?? 6), jobs.length));
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const w = new Worker(new URL(import.meta.url));
      while (next < jobs.length) {
        const job = jobs[next++];
        const o = await new Promise<JobOut>((resolve, reject) => {
          const onMsg = (o: JobOut) => (w.off('error', onErr), resolve(o));
          const onErr = (e: unknown) => (w.off('message', onMsg), reject(e));
          w.once('message', onMsg);
          w.once('error', onErr);
          w.postMessage({ ...job, stage });
        });
        pairs.push(...o.pairs);
        positions.push(...o.positions);
        done += o.pairs.length;
        process.stderr.write(`\r${done}/${n} positions`);
      }
      await w.terminate();
    }),
  );
  process.stderr.write('\n');
  pairs.sort((a, b) => a.index - b.index);
  positions.sort((a, b) => a.index - b.index);
  if (values['save-positions']) writeFileSync(values['save-positions'], JSON.stringify({ v: 1, stage, seed, capture: base.capture, options, positions }));
  const pooled = summarize(pairs, spec.metrics);
  const byTable = [...new Set(pairs.map((p) => p.table))].map((t) => ({ table: t, ...summarize(pairs.filter((p) => p.table === t), spec.metrics) }));
  const candidate = trio ? `trio(${trio.join(',')})` : values.candidate!;
  console.log(JSON.stringify({ stage, candidate, base: values.base, seed, capture: base.capture, seconds: (Date.now() - t0) / 1000, pooled, byTable }));
  const line = (label: string, s: ReturnType<typeof summarize>) =>
    [label, s.games, ...spec.metrics.map((m) => {
      const x = s.metrics[m]!;
      return `${m} ${x.candidate.mean} vs ${x.base.mean}, diff ${x.diff.mean} (${x.diff.low} to ${x.diff.high})`;
    }), `turn-limit ${s.turnLimit}`, `decided ${s.decided}/${s.positions}`, s.verdict].join('\t');
  console.error(`${stage}: ${candidate} vs ${values.base}`);
  for (const t of byTable) console.error(line(t.table, t));
  console.error(line('pooled', pooled));
}

if (!isMainThread) {
  // Workers rebuild the stage's alive test (functions do not cross threads).
  parentPort!.on('message', (job: Job) => parentPort!.postMessage(runJob({ ...job, spec: { ...job.spec, alive: STAGES[job.stage].alive } })));
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
