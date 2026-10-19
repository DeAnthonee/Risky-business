import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { getMap, type GameState, type MapDef } from '@risk/engine';
import { decisionInput, encodeDecision, stepAgent, type Agent, type StepContext } from '@risk/selfplay';

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

  constructor(readonly modelPath: string) {}

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
      workerData: { modelPath: this.modelPath, control: this.ctl.buffer, output: this.out.buffer, errors: this.errors.port1 },
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
 * Every `<name>@<version>.onnx` in the models folder as a player version: `delove@1` plays its best move,
 * `delove@1-explore` samples (temperature DELOVE_TEMPERATURE, default 1) for self-play training games.
 */
export function discoverNetAgents(dir = modelsDir()): Agent[] {
  if (!existsSync(dir)) return [];
  const temperature = Number(process.env.DELOVE_TEMPERATURE ?? 1);
  return readdirSync(dir)
    .filter((f) => /^delove@\d+\.onnx$/.test(f))
    .sort()
    .flatMap((f) => {
      const id = basename(f, '.onnx');
      const path = join(dir, f);
      return [netAgent(id, path), netAgent(`${id}-explore`, path, temperature)];
    });
}
