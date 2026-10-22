#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { registerAgent, resolveAgent } from '@risk/selfplay';
import { loadPool, playDeals, pooledSprt, scorecard, scorecardMarkdown, tableStats, type DealResult, type GatePool } from './abtest.js';
import { netAgent } from './net-agent.js';

const USAGE = `delove:abtest: score a candidate against a base version on the frozen gate pool (packages/delove/README.md "A/B scorecard")

  npm run delove:abtest -- <candidate> [--base delove@13] [--pool packages/delove/configs/abtest-pool.json]
       [--workers 6] [--chunk 10] [--scale 1] [--tables name,name] [--out <dir>]

  <candidate>   an agent id (c19-candidate, delove@14, delove-branch@1, ...) or a path to a .onnx network
  --base ID     the version to beat (default: the pool's base, delove@13)
  --scale F     multiply every table's deals by F (0.25 for a quick look; the verdict needs the full pool)
  --tables      play only these tables (by name)
  --chunk N     deals per job (default 10)
  --out DIR     write scorecard.json and scorecard.md there (default: print only)

Every table plays its deals; the deciding tables (fog) then go on, a chunk at a time, until the pooled sequential test
decides or they reach the pool's maxDeals. The scorecard prints as Markdown (stdout) and JSON (with --out).`;

interface Job {
  table: number;
  from: number;
  n: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POOL = join(here, '..', 'configs', 'abtest-pool.json');

/** A candidate given as a path to a .onnx file plays as its file name; every worker registers it the same way. */
function registerModelFromEnv(): void {
  const path = process.env.DELOVE_ABTEST_MODEL;
  if (path) registerAgent(netAgent(basename(path, '.onnx'), path));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      pool: { type: 'string' },
      workers: { type: 'string' },
      chunk: { type: 'string' },
      scale: { type: 'string' },
      tables: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  let candidate = positionals[0];
  if (candidate.endsWith('.onnx')) {
    process.env.DELOVE_ABTEST_MODEL = candidate;
    registerModelFromEnv();
    candidate = basename(candidate, '.onnx');
  }
  const { pool, hash } = loadPool(values.pool ?? DEFAULT_POOL);
  const base = values.base ?? pool.base;
  if (candidate === base) throw new Error(`the candidate is the base (${base})`);
  // Fail before playing anything on an id that does not load (the field included).
  for (const id of new Set([candidate, base, ...pool.tables.flatMap((t) => t.field.filter((f) => f !== '$base'))])) resolveAgent(id);
  const only = values.tables ? new Set(values.tables.split(',')) : null;
  const scale = Number(values.scale ?? 1);
  const chunk = Math.max(1, Number(values.chunk ?? 10));
  const planned = pool.tables.map((t) => (only && !only.has(t.name) ? 0 : Math.max(2, Math.round(t.deals * scale))));
  const maxDeals = Math.round(pool.sprt.maxDeals * scale);
  const deals: DealResult[][] = pool.tables.map(() => []);
  const queued = pool.tables.map(() => 0);
  const jobs: Job[] = [];
  const plan = (ti: number, upTo: number) => {
    for (; queued[ti] < upTo; queued[ti] += chunk) jobs.push({ table: ti, from: queued[ti], n: Math.min(chunk, upTo - queued[ti]) });
  };
  planned.forEach((n, ti) => plan(ti, n));
  const t0 = Date.now();
  const workers = Math.max(1, Number(values.workers ?? 6));
  const decider = (p: GatePool) => p.tables.map((t, ti) => (t.decides && planned[ti] > 0 ? ti : -1)).filter((ti) => ti >= 0);
  const log = (s: string) => console.error(`[${new Date().toLocaleTimeString()}] ${s}`);
  log(`${candidate} vs ${base} on ${pool.name} (${hash}): ${jobs.length} jobs over ${workers} workers`);

  const threads = await Promise.all(Array.from({ length: workers }, () => new Worker(new URL(import.meta.url))));
  const run = (w: Worker, job: Job) =>
    new Promise<DealResult[]>((resolve, reject) => {
      const onMsg = (r: DealResult[]) => (w.off('error', onErr), resolve(r));
      const onErr = (e: unknown) => (w.off('message', onMsg), reject(e));
      w.once('message', onMsg);
      w.once('error', onErr);
      w.postMessage({ job, candidate, base, pool });
    });
  try {
    // Rounds: play every queued job; then, while the test is undecided, queue more chunks per open deciding table.
    for (;;) {
      await Promise.all(
        threads.map(async (w) => {
          for (let job = jobs.shift(); job; job = jobs.shift()) {
            deals[job.table].push(...(await run(w, job)));
            const t = pool.tables[job.table];
            const s = tableStats(t, deals[job.table]);
            log(`${t.name}: ${s.deals} deals, ${s.diff >= 0 ? '+' : ''}${s.diff} points/seat (${s.low} to ${s.high})`);
          }
        }),
      );
      const sprt = pooledSprt(pool.tables.map((t, ti) => tableStats(t, deals[ti])), pool.sprt);
      const open = decider(pool).filter((ti) => queued[ti] < maxDeals);
      log(`pooled test: ${sprt.status} (mean ${sprt.mean}, LLR ${sprt.llr} in [${sprt.lower}, ${sprt.upper}])`);
      if (sprt.status !== 'continue' || !open.length) break;
      // Enough new chunks per table to keep every worker busy.
      const more = chunk * Math.max(1, Math.ceil(workers / open.length));
      for (const ti of open) plan(ti, Math.min(maxDeals, queued[ti] + more));
    }
  } finally {
    await Promise.all(threads.map((w) => w.terminate()));
  }
  for (const d of deals) d.sort((a, b) => a.deal - b.deal);
  const card = scorecard(pool, hash, candidate, base, deals, (Date.now() - t0) / 1000);
  const md = scorecardMarkdown(card);
  console.log(md);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'scorecard.json'), JSON.stringify({ ...card, deals }, null, 1) + '\n');
    writeFileSync(join(values.out, 'scorecard.md'), md);
    log(`wrote ${join(values.out, 'scorecard.json')} and scorecard.md`);
  }
}

if (!isMainThread) {
  registerModelFromEnv();
  parentPort!.on('message', async (m: { job: Job; candidate: string; base: string; pool: GatePool }) => {
    parentPort!.postMessage(await playDeals(m.pool, m.job.table, m.job.from, m.job.n, m.candidate, m.base));
  });
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
