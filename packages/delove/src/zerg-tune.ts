#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createRng, nextFloat, ZERG_1_PARAMS, type ZergParams } from '@risk/engine';
import { compareHorde, DEFAULT_HORDE_TABLES, hordeSchedule, parseHordeTables, type HordeGame, type HordeTable } from './horde.js';
import { runHordeParallel } from './horde-run.js';

/**
 * Tunes the Zerg's judgement numbers (docs/zergs.md): a hill climb from zerg@1's numbers. Each generation perturbs a
 * couple of numbers, plays the candidate horde and the current best on the same fresh games (same seeds, tables and
 * seats) against each prey player, and keeps the candidate only if the prey's `hold` drops: a stronger horde. A
 * promising candidate is confirmed on a second set of fresh games and accepted when the pooled difference's 95%
 * interval is below 0.
 *
 *   npm run delove:zerg-tune -- --out models/delove/zerg@2.json [--prey delove@10,jacob-sensei@2] [--generations 20]
 *
 * The result (numbers plus history) goes to --out, under models/ on the training PC, never into git; register.ts
 * loads models/delove/zerg@N.json (N >= 2) as agent zerg@N.
 */

interface Knob {
  key: keyof ZergParams;
  min: number;
  max: number;
  step: number;
}

const KNOBS: Knob[] = [
  { key: 'targetOdds', min: 0.2, max: 0.95, step: 0.1 },
  { key: 'killOdds', min: 0.2, max: 0.95, step: 0.1 },
  { key: 'cardOdds', min: 0.3, max: 0.95, step: 0.1 },
  { key: 'extraOdds', min: 0.3, max: 0.99, step: 0.1 },
  { key: 'neutralRoadOdds', min: 0.3, max: 0.99, step: 0.1 },
  { key: 'neutralOdds', min: 0.3, max: 0.99, step: 0.1 },
  { key: 'killBonus', min: 0, max: 12, step: 2 },
  { key: 'territoryWeight', min: 0, max: 6, step: 1 },
  { key: 'exposureWeight', min: 0, max: 2, step: 0.25 },
  { key: 'occupyShare', min: 0.3, max: 1, step: 0.15 },
  { key: 'stagingDistance', min: 0, max: 30, step: 5 },
  { key: 'sacrifice', min: 0, max: 1, step: 1 },
];

export function perturb(p: ZergParams, random: () => number, count = 2): ZergParams {
  const next = { ...p };
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(random() * KNOBS.length));
  for (const i of picked) {
    const k = KNOBS[i];
    const delta = (random() < 0.5 ? -1 : 1) * k.step * (random() < 0.25 ? 2 : 1);
    const v = Math.min(k.max, Math.max(k.min, next[k.key] + delta));
    next[k.key] = Math.round(v * 1000) / 1000;
  }
  return next;
}

async function play(prey: string[], tables: HordeTable[], games: number, seed: number, params: ZergParams, procs: number, filler: string): Promise<HordeGame[]> {
  const out: HordeGame[] = [];
  for (const [i, agent] of prey.entries()) {
    const schedule = hordeSchedule(tables, games, seed + 100_003 * i);
    out.push(...(await runHordeParallel({ agent, filler, zerg: 'zerg-tune', zergParams: params, games: schedule, options: {}, maxTurns: 500 }, procs)));
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      prey: { type: 'string', default: 'delove@10,jacob-sensei@2' },
      filler: { type: 'string', default: 'jacob-sensei@2' },
      tables: { type: 'string', default: DEFAULT_HORDE_TABLES },
      games: { type: 'string', default: '40' },
      generations: { type: 'string', default: '20' },
      seed: { type: 'string', default: '1' },
      procs: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
    },
  });
  if (!values.out) throw new Error('--out is required (e.g. models/delove/zerg@2.json)');
  const prey = values.prey!.split(',').map((s) => s.trim());
  const tables = parseHordeTables(values.tables!);
  const games = Number(values.games);
  const procs = Number(values.procs);
  const seed = Number(values.seed);
  const rng = createRng(seed ^ 0x2e79);
  const random = () => nextFloat(rng);
  let best: ZergParams = { ...ZERG_1_PARAMS };
  const history: Record<string, unknown>[] = [];
  const save = () => {
    mkdirSync(dirname(values.out!), { recursive: true });
    writeFileSync(values.out!, JSON.stringify({ about: 'Zerg judgement numbers (src/zerg-tune.ts); the agent id is the file name.', params: best, from: 'zerg@1', prey, tables: values.tables, games, history }, null, 2) + '\n');
  };

  for (let gen = 1; gen <= Number(values.generations); gen++) {
    const cand = perturb(best, random);
    const changed = (Object.keys(cand) as (keyof ZergParams)[]).filter((k) => cand[k] !== best[k]).map((k) => `${k} ${best[k]}->${cand[k]}`);
    if (changed.length === 0) continue;
    const s1 = seed * 7919 + gen * 2;
    const [c1, b1] = [await play(prey, tables, games, s1, cand, procs, values.filler!), await play(prey, tables, games, s1, best, procs, values.filler!)];
    const first = compareHorde(c1, b1, 'hold');
    let verdict = 'rejected';
    let pooled = first.diff;
    if (first.diff.mean < -0.01) {
      const s2 = s1 + 1;
      const [c2, b2] = [await play(prey, tables, games, s2, cand, procs, values.filler!), await play(prey, tables, games, s2, best, procs, values.filler!)];
      pooled = compareHorde([...c1, ...c2], [...b1, ...b2], 'hold').diff;
      if (pooled.high < 0) {
        best = cand;
        verdict = 'accepted';
      } else verdict = 'not confirmed';
    }
    history.push({ gen, changed, first: first.diff, pooled, verdict });
    console.error(`gen ${gen}: ${changed.join(', ')} | prey hold diff ${first.diff.mean.toFixed(3)} [${first.diff.low.toFixed(3)}, ${first.diff.high.toFixed(3)}]${verdict !== 'rejected' ? `, pooled ${pooled.mean.toFixed(3)} [${pooled.low.toFixed(3)}, ${pooled.high.toFixed(3)}]` : ''} -> ${verdict}`);
    save();
  }
  save();
  console.log(JSON.stringify({ out: values.out, params: best, accepted: history.filter((h) => h.verdict === 'accepted').length }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
