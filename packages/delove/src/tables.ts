#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import type { MapId } from '@risk/engine';
import { gameSeed, resolveAgent, runBatch, runMatch } from '@risk/selfplay';

/**
 * Turn-limit and points check over many tables at once (maps x table sizes), in parallel worker threads.
 *
 *   node --import ./packages/delove/dist/register.js packages/delove/dist/tables.js \
 *     --agent jacob-sensei@1 [--vs delove-teacher@2] --tables classic:2,world:6,greater_europe:10 [--games 64]
 *     [--workers 6] [--seed 1] [--max-turns 500]
 *
 * Without --vs every seat is --agent (self-play: does it stall?). With --vs the two alternate seats in mirrored pairs
 * (as on the ladder): it reports the agent's score, mean leaderboard points per seat for both, and turn-limit games.
 */

interface Job {
  agent: string;
  vs: string | null;
  map: MapId;
  players: number;
  games: number;
  seed: number;
  maxTurns: number;
}

interface Out {
  games: number;
  turnLimit: number;
  turns: number;
  /** Mirrored only: agent's score sum (win 1, draw 0.5) and points sums per side. */
  score: number;
  points: number;
  vsPoints: number;
  pairs: number[];
}

async function runJob(job: Job): Promise<Out> {
  const agent = resolveAgent(job.agent);
  const options = { map: job.map };
  if (!job.vs) {
    const results = await runBatch({ games: job.games, seed: job.seed, seats: () => Array.from({ length: job.players }, () => ({ agent })), options, maxTurns: job.maxTurns });
    return {
      games: results.length,
      turnLimit: results.filter((r) => r.winner === null).length,
      turns: results.reduce((a, r) => a + r.turns, 0),
      score: 0,
      points: 0,
      vsPoints: 0,
      pairs: [],
    };
  }
  const pairs: number[] = [];
  let pending = 0;
  const r = await runMatch({
    candidate: agent,
    best: resolveAgent(job.vs),
    games: job.games,
    seed: job.seed,
    players: job.players,
    options,
    maxTurns: job.maxTurns,
    onGame: (g, i) => {
      const s = g.winner === null ? 0.5 : (g.winner + i) % 2 === 0 ? 1 : 0;
      if (i % 2 === 0) pending = s;
      else pairs.push((pending + s) / 2);
    },
  });
  return { games: r.games, turnLimit: r.turnLimit, turns: r.meanTurns * r.games, score: r.score * r.games, points: (r.points ?? 0) * r.games, vsPoints: (r.bestPoints ?? 0) * r.games, pairs };
}

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      vs: { type: 'string' },
      tables: { type: 'string' },
      games: { type: 'string' },
      workers: { type: 'string' },
      seed: { type: 'string' },
      chunk: { type: 'string' },
      'max-turns': { type: 'string' },
    },
  });
  if (!values.agent || !values.tables) throw new Error('--agent and --tables are required');
  const games = Number(values.games ?? 64);
  const chunk = Number(values.chunk ?? 16);
  const seed = Number(values.seed ?? 1);
  const maxTurns = Number(values['max-turns'] ?? 500);
  const tables = values.tables.split(',').map((t) => {
    const [map, players] = t.split(':');
    return { map: map as MapId, players: Number(players) };
  });
  const jobs: { table: number; job: Job }[] = [];
  tables.forEach((t, ti) => {
    for (let g = 0; g < games; g += chunk) {
      const n = Math.min(chunk, games - g);
      jobs.push({ table: ti, job: { agent: values.agent!, vs: values.vs ?? null, map: t.map, players: t.players, games: n, seed: gameSeed(seed, ti * 1_000_000 + g), maxTurns } });
    }
  });
  const outs: Out[] = tables.map(() => ({ games: 0, turnLimit: 0, turns: 0, score: 0, points: 0, vsPoints: 0, pairs: [] }));
  const t0 = Date.now();
  const workers = Math.max(1, Math.min(Number(values.workers ?? 6), jobs.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const w = new Worker(new URL(import.meta.url));
      while (next < jobs.length) {
        const { table, job } = jobs[next++];
        const o = await new Promise<Out>((resolve, reject) => {
          const onMsg = (o: Out) => (w.off('error', onErr), resolve(o));
          const onErr = (e: unknown) => (w.off('message', onMsg), reject(e));
          w.once('message', onMsg);
          w.once('error', onErr);
          w.postMessage(job);
        });
        const acc = outs[table];
        acc.games += o.games;
        acc.turnLimit += o.turnLimit;
        acc.turns += o.turns;
        acc.score += o.score;
        acc.points += o.points;
        acc.vsPoints += o.vsPoints;
        acc.pairs.push(...o.pairs);
      }
      await w.terminate();
    }),
  );
  const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  const rows = tables.map((t, i) => {
    const o = outs[i];
    const row: Record<string, unknown> = { map: t.map, players: t.players, games: o.games, turnLimit: o.turnLimit, turnLimitPct: r((100 * o.turnLimit) / o.games, 1), meanTurns: r(o.turns / o.games, 1) };
    if (values.vs) {
      const mean = o.score / o.games;
      const u = o.pairs.length;
      const v = u > 1 ? o.pairs.reduce((a, s) => a + (s - mean) ** 2, 0) / (u - 1) : 0.25;
      const se = Math.sqrt(Math.max(v, 0.045) / Math.max(1, u));
      Object.assign(row, { score: r(mean), scoreLow: r(mean - 1.96 * se), scoreHigh: r(mean + 1.96 * se), points: r(o.points / o.games, 2), vsPoints: r(o.vsPoints / o.games, 2) });
    }
    return row;
  });
  console.log(JSON.stringify({ agent: values.agent, vs: values.vs ?? null, seconds: (Date.now() - t0) / 1000, tables: rows }));
  for (const row of rows) console.error(Object.values(row).join('\t'));
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job) => parentPort!.postMessage(await runJob(job)));
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
