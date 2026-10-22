import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { GameOptions, ZergParams } from '@risk/engine';
import { makeZergAgent, resolveAgent } from '@risk/selfplay';
import { playHordeGame, type HordeGame, type HordeTable } from './horde.js';

/**
 * Runs horde games in worker threads (the gate, src/horde-cli.ts, and the Zerg tuner, src/zerg-tune.ts). A worker
 * resolves the agents by id (register.ts is loaded in every worker through `node --import`), or builds the Zergs from
 * `zergParams` when given, so a tuner's candidate numbers need no registration.
 */
export interface HordeJob {
  agent: string;
  filler: string;
  zerg: string;
  /** Build the Zerg seats from these numbers (agent id `zerg`) instead of resolving `zerg`. */
  zergParams?: ZergParams;
  games: { table: HordeTable; seed: number; shift: number }[];
  options: Partial<GameOptions>;
  maxTurns: number;
}

export function runHordeJob(job: HordeJob): HordeGame[] {
  const agent = resolveAgent(job.agent);
  const filler = resolveAgent(job.filler);
  const zerg = job.zergParams ? makeZergAgent(job.zerg, job.zergParams) : resolveAgent(job.zerg);
  return job.games.map((g) => playHordeGame(agent, filler, g.table, g.seed, g.shift, job.options, job.maxTurns, zerg));
}

/** Results in schedule order, so two runs over the same schedule pair up game by game. */
export async function runHordeParallel(job: HordeJob, procs: number): Promise<HordeGame[]> {
  if (procs <= 1) return runHordeJob(job);
  const chunks: HordeJob[] = Array.from({ length: procs }, () => ({ ...job, games: [] }));
  job.games.forEach((g, i) => chunks[i % procs].games.push(g));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<HordeGame[]>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: chunk });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    ),
  );
  const out: HordeGame[] = new Array(job.games.length);
  results.forEach((r, c) => r.forEach((g, k) => (out[k * procs + c] = g)));
  return out;
}

if (!isMainThread && workerData && (workerData as HordeJob).games) parentPort!.postMessage(runHordeJob(workerData as HordeJob));
