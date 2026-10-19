#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { runMatch, gameSeed, seededRandom } from '@risk/selfplay';
import { DEFAULT_TEACHER_PARAMS, makeTeacher, type TeacherParams } from './teacher.js';

/**
 * Tune the teacher's judgement numbers with self-play: a (1 + lambda) evolution strategy.
 *
 * Each generation mutates the current best `pop` times (each number multiplied by exp(N(0, sigma)) with probability
 * `rate`), plays every mutant against the best in mirrored pairs (2- and 4-player tables), and confirms the top
 * mutant on fresh seeds. It replaces the best only when both its screening and confirmation scores clear the bar,
 * so noise rarely gets promoted. Progress is saved after every generation and resumed from the file.
 *
 *   node packages/delove/dist/tune.js --out runs/delove/tune/state.json [--gens 30] [--pop 12] [--games 120]
 *     [--from models/delove/delove-teacher@2.json] [--mix 2:0.2,4:0.4,6:0.4]
 */

interface Job {
  candidate: TeacherParams;
  best: TeacherParams;
  games: number;
  seed: number;
  players: number;
}

interface TuneState {
  generation: number;
  best: TeacherParams;
  history: { generation: number; screen: number; confirm: number | null; accepted: boolean; changed: string[] }[];
}

/**
 * Fitness of one chunk: the candidate's share of decisive games, minus half the share of games that stalled to the
 * turn limit, so a version that wins by never losing (turtling into draws) is not rewarded.
 */
async function evaluate(job: Job): Promise<number> {
  const r = await runMatch({
    candidate: makeTeacher('cand@1', job.candidate),
    best: makeTeacher('best@1', job.best),
    games: job.games,
    seed: job.seed,
    players: job.players,
    // Badly tuned teachers can stall; a stalled game is a draw and costs no more than 300 turns.
    maxTurns: 300,
  });
  const decisive = r.wins + r.losses;
  return (decisive ? r.wins / decisive : 0.5) - (0.5 * r.draws) / (decisive + r.draws);
}

class Pool {
  private idle: Worker[] = [];
  private queue: { job: Job; resolve: (v: number) => void; reject: (e: unknown) => void }[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.idle.push(new Worker(new URL(import.meta.url)));
  }

  run(job: Job): Promise<number> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const { job, resolve, reject } = this.queue.shift()!;
      const done = () => {
        w.off('message', onMsg);
        w.off('error', onErr);
        this.idle.push(w);
        this.pump();
      };
      const onMsg = (v: number) => (done(), resolve(v));
      const onErr = (e: unknown) => (done(), reject(e));
      w.on('message', onMsg);
      w.on('error', onErr);
      w.postMessage(job);
    }
  }

  close() {
    for (const w of this.idle) void w.terminate();
  }
}

/** Score of `candidate` against `best`, games shared out over table sizes by `mix` (players -> share), in parallel chunks. */
async function match(pool: Pool, candidate: TeacherParams, best: TeacherParams, games: number, seed: number, mix: [number, number][]): Promise<number> {
  const chunk = 40;
  const jobs: Promise<number>[] = [];
  const weights: number[] = [];
  for (const [players, share] of mix) {
    const total = Math.max(2, Math.round((games * share) / 2) * 2);
    for (let g = 0; g < total; g += chunk) {
      const n = Math.min(chunk, total - g);
      jobs.push(pool.run({ candidate, best, games: n, seed: gameSeed(seed, players * 100_000 + g), players }));
      weights.push(n);
    }
  }
  const scores = await Promise.all(jobs);
  return scores.reduce((a, s, i) => a + s * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
}

function mutate(best: TeacherParams, random: () => number, sigma: number, rate: number): { params: TeacherParams; changed: string[] } {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const params = { ...best };
  const changed: string[] = [];
  const keys = Object.keys(best) as (keyof TeacherParams)[];
  for (const k of keys) {
    if (random() < rate) {
      params[k] = Math.round(best[k] * Math.exp(sigma * gauss()) * 1000) / 1000;
      changed.push(k);
    }
  }
  if (changed.length === 0) {
    const k = keys[Math.floor(random() * keys.length)];
    params[k] = Math.round(best[k] * Math.exp(sigma * gauss()) * 1000) / 1000;
    changed.push(k);
  }
  return { params, changed };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      gens: { type: 'string' },
      pop: { type: 'string' },
      games: { type: 'string' },
      confirm: { type: 'string' },
      workers: { type: 'string' },
      sigma: { type: 'string' },
      rate: { type: 'string' },
      threshold: { type: 'string' },
      seed: { type: 'string' },
      mix: { type: 'string' },
      from: { type: 'string' },
    },
  });
  if (!values.out) throw new Error('--out FILE is required (tuning state, resumed if it exists)');
  const gens = Number(values.gens ?? 30);
  const pop = Number(values.pop ?? 12);
  const games = Number(values.games ?? 120);
  const confirmGames = Number(values.confirm ?? 400);
  const sigma = Number(values.sigma ?? 0.25);
  const rate = Number(values.rate ?? 0.3);
  const threshold = Number(values.threshold ?? 0.54);
  const seed = Number(values.seed ?? 1);
  // Table sizes to judge on, as players:share (even player counts: ladder seats alternate the two versions).
  const mix = (values.mix ?? '2:0.5,4:0.5').split(',').map((x) => x.split(':').map(Number) as [number, number]);
  if (mix.some(([p, w]) => !(p >= 2 && p % 2 === 0) || !(w > 0))) throw new Error('--mix must look like 2:0.5,4:0.5 (even player counts)');
  const pool = new Pool(Number(values.workers ?? 12));

  const state: TuneState = existsSync(values.out)
    ? JSON.parse(readFileSync(values.out, 'utf8'))
    : { generation: 0, best: { ...DEFAULT_TEACHER_PARAMS, ...(values.from ? JSON.parse(readFileSync(values.from, 'utf8')) : {}) }, history: [] };
  mkdirSync(dirname(values.out), { recursive: true });
  const t0 = Date.now();
  const first = state.generation;
  for (let g = first; g < first + gens; g++) {
    const random = seededRandom(gameSeed(seed, 7_000_000 + g));
    const mutants = Array.from({ length: pop }, () => mutate(state.best, random, sigma, rate));
    const screen = await Promise.all(mutants.map((m, i) => match(pool, m.params, state.best, games, gameSeed(seed, g * 1000 + i), mix)));
    const top = screen.indexOf(Math.max(...screen));
    let confirm: number | null = null;
    let accepted = false;
    if (screen[top] >= threshold) {
      confirm = await match(pool, mutants[top].params, state.best, confirmGames, gameSeed(seed, 9_000_000 + g), mix);
      accepted = confirm >= threshold;
    }
    if (accepted) state.best = mutants[top].params;
    state.history.push({ generation: g, screen: screen[top], confirm, accepted, changed: mutants[top].changed });
    state.generation = g + 1;
    writeFileSync(values.out, JSON.stringify(state, null, 2));
    console.log(
      `gen ${g}: best mutant ${screen[top].toFixed(3)} (${mutants[top].changed.join(', ')})` +
        (confirm === null ? '' : `, confirm ${confirm.toFixed(3)}`) +
        (accepted ? ' -> ACCEPTED' : '') +
        ` [${((Date.now() - t0) / 60000).toFixed(1)} min]`,
    );
  }
  pool.close();
  process.exit(0);
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job) => parentPort!.postMessage(await evaluate(job)));
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
