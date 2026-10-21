import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { getMap, type GameState, type MapDef } from '@risk/engine';
import { searchAgent } from './search.js';
import { decisionInput, encodeDecision, stepAgent, type Agent, type Features, type StepContext } from '@risk/selfplay';

/** Largest candidate list a decision can have (Greater Europe connected fortify stays far below this). */
const MAX_CANDIDATES = 1 << 16;
/** How long one decision may take before the game is aborted (the worker died or hung). */
const TIMEOUT_MS = 30_000;

/** The compiled worker next to this file, or in dist/ when this file runs from source (tests). */
function workerUrl(): URL {
  const sibling = new URL('./net-worker.js', import.meta.url);
  return existsSync(fileURLToPath(sibling)) ? sibling : new URL('../dist/net-worker.js', import.meta.url);
}

/** Scores decisions with one ONNX model in a worker thread, synchronously (see net-worker.ts). */
export class NetScorer {
  private worker: Worker | null = null;
  private readonly ctl = new Int32Array(new SharedArrayBuffer(8));
  private readonly out = new Float32Array(new SharedArrayBuffer((MAX_CANDIDATES + 1) * 4));
  private readonly errors = new MessageChannel();

  constructor(
    readonly modelPath: string,
    /** The batched value model (<model>.value.onnx), needed only for values(). */
    readonly valuePath: string | null = null,
  ) {}

  private wait(what: string): void {
    const r = Atomics.wait(this.ctl, 0, 0, TIMEOUT_MS);
    const state = Atomics.load(this.ctl, 0);
    if (state === 1) return;
    const msg = receiveMessageOnPort(this.errors.port2)?.message;
    throw new Error(`Delove model ${this.modelPath}: ${what} failed${r === 'timed-out' ? ' (timed out)' : ''}${msg ? `: ${msg}` : ''}`);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    Atomics.store(this.ctl, 0, 0);
    const worker = new Worker(workerUrl(), {
      workerData: { modelPath: this.modelPath, valuePath: this.valuePath, control: this.ctl.buffer, output: this.out.buffer, errors: this.errors.port1 },
      transferList: [this.errors.port1],
    });
    worker.unref();
    this.errors.port2.unref();
    this.worker = worker;
    this.wait('loading');
    return worker;
  }

  /** Logits for each candidate (higher = better) and the win probability for the decider. */
  score(ctx: StepContext): { logits: Float32Array; value: number } {
    const worker = this.start();
    const seatIds = seatOrder(ctx.state);
    const f = encodeDecision(decisionInput(ctx.state, seatIds, ctx.me, ctx.traits, ctx.candidates, ctx.fortifyFrom ?? -1));
    const C = f.candidates;
    if (C > MAX_CANDIDATES) throw new Error(`Delove: ${C} candidates, more than ${MAX_CANDIDATES}`);
    Atomics.store(this.ctl, 0, 0);
    worker.postMessage({
      kind: 'decision',
      T: f.territories,
      C,
      territory: f.territory,
      global: f.global,
      adj: adjacencyMatrix(getMap(ctx.state.options.map)),
      cand: f.cand,
      candFrom: BigInt64Array.from(f.candFrom, (x) => BigInt(x)),
      candTo: BigInt64Array.from(f.candTo, (x) => BigInt(x)),
    });
    this.wait('a decision');
    return { logits: this.out.slice(0, C), value: this.out[this.out.length - 1] };
  }

  /** Win probability for the decider of each encoded position (one batched call; all on one map). */
  values(positions: Features[], mapId: string): Float32Array {
    if (positions.length === 0) return new Float32Array(0);
    if (positions.length > MAX_CANDIDATES) throw new Error(`Delove: ${positions.length} positions in one batch`);
    const worker = this.start();
    const T = positions[0].territories;
    const territory = new Float32Array(positions.length * positions[0].territory.length);
    const global = new Float32Array(positions.length * positions[0].global.length);
    positions.forEach((p, i) => {
      territory.set(p.territory, i * p.territory.length);
      global.set(p.global, i * p.global.length);
    });
    Atomics.store(this.ctl, 0, 0);
    worker.postMessage({ kind: 'values', T, B: positions.length, territory, global, adj: adjacencyMatrix(getMap(mapId)) });
    this.wait('rating positions');
    return this.out.slice(0, positions.length);
  }
}

/** Seat ids in seating order: the order players joined, the Neutral left out (as the self-play harness seats them). */
export function seatOrder(state: GameState): string[] {
  return state.players.filter((p) => !p.isNeutral).map((p) => p.id);
}

const adjCache = new Map<string, Float32Array>();

/** The map's adjacency as a dense 0/1 matrix in territory order, the network's `adj` input. */
export function adjacencyMatrix(map: MapDef): Float32Array {
  let m = adjCache.get(map.id);
  if (!m) {
    const T = map.territoryIds.length;
    const idx = new Map(map.territoryIds.map((t, i) => [t, i]));
    m = new Float32Array(T * T);
    map.territoryIds.forEach((t, i) => map.adjacency[t].forEach((n) => (m![i * T + idx.get(n)!] = 1)));
    adjCache.set(map.id, m);
  }
  return m;
}

/**
 * A Delove network as a player version. With temperature 0 it plays its top-scored candidate (deterministic);
 * above 0 it samples from softmax(logits / temperature) with ctx.random, which self-play training uses to explore.
 */
export function netAgent(id: string, modelPath: string, temperature = 0): Agent {
  const scorer = new NetScorer(modelPath);
  return stepAgent(id, (ctx) => {
    if (ctx.candidates.length === 1) return 0;
    const { logits } = scorer.score(ctx);
    return temperature > 0 ? sample(logits, temperature, ctx.random) : argmax(logits);
  });
}

/**
 * Which range specialist plays a decision, by players still alive: close (2), mid (3), long (4 or more). The neutral
 * army is not a player (it never takes a turn), as in the encoder's slot<i>_alive features that train.py --alive counts.
 */
export type Range = 'close' | 'mid' | 'long';
export function alivePlayers(state: GameState): number {
  return state.players.filter((p) => p.alive && !p.isNeutral).length;
}
export function rangeOf(state: GameState): Range {
  const alive = alivePlayers(state);
  return alive <= 2 ? 'close' : alive === 3 ? 'mid' : 'long';
}

/**
 * The range specialists as one player (the owner's plan): each decision is played by the network for the players
 * still alive (`rangeOf`): Delove Long Range for 4+, Mid Range for 3, Close Range for the final duel. Plays each
 * network's top move, like `delove@N`; deterministic.
 */
export function rangeAgent(id: string, modelPaths: Record<Range, string>): Agent {
  const scorers = new Map<string, NetScorer>();
  const scorer = (path: string) => scorers.get(path) ?? (scorers.set(path, new NetScorer(path)), scorers.get(path)!);
  return stepAgent(id, (ctx) => {
    if (ctx.candidates.length === 1) return 0;
    return argmax(scorer(modelPaths[rangeOf(ctx.state)]).score(ctx).logits);
  });
}

function argmax(xs: Float32Array): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

function sample(logits: Float32Array, temperature: number, random: () => number): number {
  const max = logits[argmax(logits)];
  const w = Array.from(logits, (l) => Math.exp((l - max) / temperature));
  let r = random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0) return i;
  return w.length - 1;
}

/** Folder Delove versions are loaded from: DELOVE_MODELS, or models/delove under the working directory. */
export function modelsDir(): string {
  return resolve(process.env.DELOVE_MODELS ?? join('models', 'delove'));
}

/**
 * Every model in the models folder as player versions. `delove@N.onnx` (a promoted version) and `rNN-candidate.onnx` or
 * `cNN-candidate.onnx` (a training round's or cycle's candidate, before the ladder decides) each give:
 * - `<id>` plays its policy's top move; `<id>-explore` samples it (temperature DELOVE_TEMPERATURE, default 1);
 * - with `<id>.value.onnx` next to it, `<id>+look` plays with the lookahead (search.ts) and `<id>+look-explore`
 *   samples among the lookahead's ratings (temperature DELOVE_LOOK_TEMPERATURE, default 0.03).
 */
export function discoverNetAgents(dir = modelsDir()): Agent[] {
  if (!existsSync(dir)) return [];
  const temperature = Number(process.env.DELOVE_TEMPERATURE ?? 1);
  const lookTemperature = Number(process.env.DELOVE_LOOK_TEMPERATURE ?? 0.03);
  // Lookahead settings for experiments (defaults in search.ts DEFAULT_SEARCH).
  const env = (k: string) => (process.env[k] === undefined ? undefined : Number(process.env[k]));
  const look = Object.fromEntries(
    Object.entries({ topK: env('DELOVE_LOOK_K'), samples: env('DELOVE_LOOK_SAMPLES'), priorWeight: env('DELOVE_LOOK_PRIOR'), confident: env('DELOVE_LOOK_CONFIDENT') }).filter(([, v]) => v !== undefined),
  );
  const files = new Set(readdirSync(dir));
  // delove-range@N.json: {"close": "<model id>", "mid": "<model id>", "long": "<model id>"}, each a <model id>.onnx here.
  const ranges = [...files]
    .filter((f) => /^delove-range@\d+\.json$/.test(f))
    .flatMap((f) => {
      let routes: Record<Range, string>;
      try {
        routes = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch (e) {
        // One bad routes file must not stop every other player from loading.
        console.warn(`Delove: skipping ${f}: ${(e as Error).message}`);
        return [];
      }
      const paths = Object.fromEntries((['close', 'mid', 'long'] as const).map((r) => [r, join(dir, `${routes[r]}.onnx`)])) as Record<Range, string>;
      if (!Object.values(paths).every((p) => existsSync(p))) return [];
      return [rangeAgent(basename(f, '.json'), paths)];
    });
  return [...ranges, ...[...files]
    .filter((f) => /^(delove@\d+|delove-(?:long|mid|close)(?:-range)?@\d+|[rc]\d+-candidate|c\d+-(?:long|mid|close))\.onnx$/.test(f))
    .sort()
    .flatMap((f) => {
      const id = basename(f, '.onnx');
      const path = join(dir, f);
      const agents = [netAgent(id, path), netAgent(`${id}-explore`, path, temperature)];
      if (files.has(`${id}.value.onnx`)) {
        const valuePath = join(dir, `${id}.value.onnx`);
        agents.push(searchAgent(`${id}+look`, path, valuePath, look), searchAgent(`${id}+look-explore`, path, valuePath, { ...look, temperature: lookTemperature }));
      }
      return agents;
    })];
}
