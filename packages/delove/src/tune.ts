#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { MapId } from '@risk/engine';
import { runBatch, runMatch, gameSeed, seededRandom } from '@risk/selfplay';
import { DEFAULT_JACOB_PARAMS, makeJacob } from './jacob.js';
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
 *
 * --teacher jacob tunes Jacob Sensei's numbers (src/jacob.ts) instead of Sensei's. --mix entries can name a map
 * (classic:2:0.2,world:6:0.3,greater_europe:10:0.2); --max-turns (default 300) is the stall limit and --stall (default
 * 0.5) the weight of the stalled share in the fitness. --selfplay greater_europe:10,world:6 also plays every
 * candidate against itself on those tables (--selfplay-games each, default 16) and subtracts --stall x its turn-limit
 * share + --length x its mean game length / --max-turns: a version that wins mixed tables by sitting back
 * makes slow, stalling games when every seat plays it, which is what a rollout teacher does.
 */

/** Numbers being tuned: Sensei's (TeacherParams) or Jacob Sensei's (a superset). */
type Params = TeacherParams & Record<string, number>;
type Kind = 'sensei' | 'jacob';
const KINDS: Record<Kind, { defaults: Params; make: (id: string, p: Params) => ReturnType<typeof makeTeacher> }> = {
  sensei: { defaults: DEFAULT_TEACHER_PARAMS as Params, make: (id, p) => makeTeacher(id, p) },
  jacob: { defaults: DEFAULT_JACOB_PARAMS as unknown as Params, make: (id, p) => makeJacob(id, p) },
};

interface Job {
  kind: Kind;
  candidate: Params;
  best: Params;
  games: number;
  seed: number;
  players: number;
  map?: MapId;
  maxTurns: number;
  stall: number;
  /** Self-play job: every seat plays `candidate`; the result is the length and stall penalty (<= 0). */
  selfplay?: boolean;
  length?: number;
}

/** One table size of the mix: optional map, players, share of the games. */
type MixEntry = { map?: MapId; players: number; share: number };

interface TuneState {
  generation: number;
  best: Params;
  history: { generation: number; screen: number; confirm: number | null; accepted: boolean; changed: string[] }[];
}

/**
 * Fitness of one chunk: the candidate's share of decisive games, minus half the share of games that stalled to the
 * turn limit, so a version that wins by never losing (turtling into draws) is not rewarded.
 */
async function evaluate(job: Job): Promise<number> {
  if (job.selfplay) {
    const agent = KINDS[job.kind].make('cand@1', job.candidate);
    const rs = await runBatch({ games: job.games, seed: job.seed, seats: () => Array.from({ length: job.players }, () => ({ agent })), options: job.map ? { map: job.map } : {}, maxTurns: job.maxTurns });
    const limit = rs.filter((r) => r.winner === null).length / rs.length;
    const turns = rs.reduce((a, r) => a + r.turns, 0) / rs.length;
    return -(job.stall * limit + (job.length ?? 0) * (turns / job.maxTurns));
  }
  const r = await runMatch({
    candidate: KINDS[job.kind].make('cand@1', job.candidate),
    best: KINDS[job.kind].make('best@1', job.best),
    games: job.games,
    seed: job.seed,
    players: job.players,
    ...(job.map ? { options: { map: job.map } } : {}),
    // Badly tuned teachers can stall; a stalled game is a draw and costs no more than maxTurns turns.
    maxTurns: job.maxTurns,
  });
  const decisive = r.wins + r.losses;
  return (decisive ? r.wins / decisive : 0.5) - (job.stall * r.draws) / (decisive + r.draws);
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
interface MatchSetup {
  kind: Kind;
  mix: MixEntry[];
  maxTurns: number;
  stall: number;
  selfplay: { map?: MapId; players: number }[];
  selfplayGames: number;
  length: number;
  /** Seed of this generation's self-play games, and the best's penalty on them (worked out once per generation). */
  selfplaySeed: number;
  bestPenalty?: Promise<number[]>;
}

async function match(pool: Pool, candidate: Params, best: Params, games: number, seed: number, setup: MatchSetup): Promise<number> {
  const chunk = 40;
  const jobs: Promise<number>[] = [];
  const weights: number[] = [];
  setup.mix.forEach(({ map, players, share }, mi) => {
    const total = Math.max(2, Math.round((games * share) / 2) * 2);
    // Entries without a map keep the original seeds (players x 100,000 + g); mapped ones get their own range.
    const base = map ? (mi + 1) * 10_000_000 + players * 100_000 : players * 100_000;
    for (let g = 0; g < total; g += chunk) {
      const n = Math.min(chunk, total - g);
      jobs.push(pool.run({ kind: setup.kind, candidate, best, games: n, seed: gameSeed(seed, base + g), players, map, maxTurns: setup.maxTurns, stall: setup.stall }));
      weights.push(n);
    }
  });
  // Self-play penalty of the candidate minus the best's, on the same seeds (one set per generation), averaged over tables.
  const penalty = (who: Params) =>
    setup.selfplay.map(({ map, players }, si) =>
      pool.run({ kind: setup.kind, candidate: who, best, games: setup.selfplayGames, seed: gameSeed(setup.selfplaySeed, si), players, map, maxTurns: setup.maxTurns, stall: setup.stall, selfplay: true, length: setup.length }),
    );
  const penCand = penalty(candidate);
  const penBest = setup.bestPenalty ?? (setup.bestPenalty = Promise.all(penalty(best)));
  const scores = await Promise.all(jobs);
  const pc = await Promise.all(penCand);
  const pb = await penBest;
  const mixScore = scores.reduce((a, s, i) => a + s * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
  return mixScore + (pc.length ? (pc.reduce((a, b) => a + b, 0) - pb.reduce((a, b) => a + b, 0)) / pc.length : 0);
}

function mutate(best: Params, random: () => number, sigma: number, rate: number): { params: Params; changed: string[] } {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const params = { ...best };
  const changed: string[] = [];
  const keys = Object.keys(best);
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
      teacher: { type: 'string' },
      'max-turns': { type: 'string' },
      stall: { type: 'string' },
      selfplay: { type: 'string' },
      'selfplay-games': { type: 'string' },
      length: { type: 'string' },
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
  const mix: MixEntry[] = (values.mix ?? '2:0.5,4:0.5').split(',').map((x) => {
    const parts = x.split(':');
    const map = parts.length === 3 ? (parts.shift() as MapId) : undefined;
    return { map, players: Number(parts[0]), share: Number(parts[1]) };
  });
  if (mix.some((m) => !(m.players >= 2 && m.players % 2 === 0) || !(m.share > 0))) throw new Error('--mix must look like 2:0.5,4:0.5 or classic:2:0.5,world:6:0.5 (even player counts)');
  const kind = (values.teacher ?? 'sensei') as Kind;
  if (!KINDS[kind]) throw new Error('--teacher must be sensei or jacob');
  const selfplay = (values.selfplay ? values.selfplay.split(',') : []).map((x) => {
    const parts = x.split(':');
    return parts.length === 2 ? { map: parts[0] as MapId, players: Number(parts[1]) } : { players: Number(parts[0]) };
  });
  const setup: MatchSetup = {
    kind,
    mix,
    maxTurns: Number(values['max-turns'] ?? 300),
    stall: Number(values.stall ?? 0.5),
    selfplay,
    selfplayGames: Number(values['selfplay-games'] ?? 16),
    length: Number(values.length ?? 0),
    selfplaySeed: 0,
  };
  const pool = new Pool(Number(values.workers ?? 12));

  const state: TuneState = existsSync(values.out)
    ? JSON.parse(readFileSync(values.out, 'utf8'))
    : { generation: 0, best: { ...KINDS[kind].defaults, ...(values.from ? JSON.parse(readFileSync(values.from, 'utf8')) : {}) }, history: [] };
  mkdirSync(dirname(values.out), { recursive: true });
  const t0 = Date.now();
  const first = state.generation;
  for (let g = first; g < first + gens; g++) {
    const random = seededRandom(gameSeed(seed, 7_000_000 + g));
    setup.selfplaySeed = gameSeed(seed, 8_000_000 + g);
    setup.bestPenalty = undefined;
    const mutants = Array.from({ length: pop }, () => mutate(state.best, random, sigma, rate));
    const screen = await Promise.all(mutants.map((m, i) => match(pool, m.params, state.best, games, gameSeed(seed, g * 1000 + i), setup)));
    const top = screen.indexOf(Math.max(...screen));
    let confirm: number | null = null;
    let accepted = false;
    if (screen[top] >= threshold) {
      confirm = await match(pool, mutants[top].params, state.best, confirmGames, gameSeed(seed, 9_000_000 + g), setup);
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
