#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createRng, nextFloat, ZERG_1_PARAMS, type ZergParams } from '@risk/engine';
import { compareHorde, DEFAULT_HORDE_TABLES, hordeSchedule, parseHordeTables, type HordeGame, type HordeTable } from './horde.js';
import { runHordeParallel } from './horde-run.js';

/**
 * Tunes the Zerg's judgement numbers (docs/zergs.md), from zerg@1's. Each generation makes `--children` candidates, each
 * moving `--knobs` numbers at once (joint moves: single changes barely register), and plays every child and the
 * current best on the same fresh games (same seeds, tables and seats) against each `--prey`. The child with the best
 * paired difference on `--fitness` goes to confirmation on a second, larger set of fresh games and replaces the best
 * when the pooled 95% interval clears 0.
 *
 * Fitness `rush` (default) is the horde's own goal, per game: 1 if the prey was knocked out, up to +0.5 for doing it
 * fast, -1 at the turn limit (higher = stronger horde). `hold` is the prey's survival score (lower = stronger horde);
 * it saturates, so it is the gate's verdict but a flat tuning signal.
 *
 *   npm run delove:zerg-tune -- --out models/delove/zerg-tune-run2.json [--prey delove@10] [--generations 15]
 *
 * The result (numbers plus history) goes to --out, under models/ on the training PC, never into git; register.ts
 * loads models/delove/zerg@N.json (N >= 2) as agent zerg@N, so copy a gated result there.
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
  // later behaviours (0 = off in zerg@1)
  { key: 'strikeRatio', min: 0, max: 3, step: 0.5 },
  { key: 'cardHoard', min: 0, max: 1, step: 1 },
  { key: 'hoardFinish', min: 1, max: 6, step: 1 },
  { key: 'capitalBonus', min: 0, max: 6, step: 2 },
  { key: 'wallWeight', min: 0, max: 1, step: 0.25 },
];

/** The later behaviours' knobs (0 = off in zerg@1): `--knob-set new` moves only these. */
const NEW_KNOBS = new Set<keyof ZergParams>(['strikeRatio', 'cardHoard', 'hoardFinish', 'capitalBonus', 'wallWeight']);

export function perturb(p: ZergParams, random: () => number, count = 2, knobs: Knob[] = KNOBS): ZergParams {
  const next = { ...p };
  const picked = new Set<number>();
  while (picked.size < Math.min(count, knobs.length)) picked.add(Math.floor(random() * knobs.length));
  for (const i of picked) {
    const k = knobs[i];
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
      prey: { type: 'string', default: 'delove@10' },
      filler: { type: 'string', default: 'jacob-sensei@2' },
      tables: { type: 'string', default: DEFAULT_HORDE_TABLES },
      fitness: { type: 'string', default: 'rush' },
      games: { type: 'string', default: '30' },
      'confirm-games': { type: 'string', default: '80' },
      children: { type: 'string', default: '8' },
      knobs: { type: 'string', default: '3' },
      'knob-set': { type: 'string', default: 'all' },
      generations: { type: 'string', default: '15' },
      seed: { type: 'string', default: '1' },
      procs: { type: 'string', default: String(Math.max(1, availableParallelism() - 1)) },
    },
  });
  if (!values.out) throw new Error('--out is required (e.g. models/delove/zerg-tune-run2.json)');
  const fitness = values.fitness as 'rush' | 'hold';
  if (fitness !== 'rush' && fitness !== 'hold') throw new Error('--fitness must be rush or hold');
  // Positive gain = a stronger horde, whichever the fitness.
  const sign = fitness === 'rush' ? 1 : -1;
  const prey = values.prey!.split(',').map((s) => s.trim());
  const tables = parseHordeTables(values.tables!);
  const [games, confirmGames, children, knobs, procs, seed] = ['games', 'confirm-games', 'children', 'knobs', 'procs', 'seed'].map((k) => Number(values[k as keyof typeof values]));
  const knobSet = values['knob-set'] === 'new' ? KNOBS.filter((k) => NEW_KNOBS.has(k.key)) : KNOBS;
  if (values['knob-set'] !== 'new' && values['knob-set'] !== 'all') throw new Error('--knob-set must be all or new');
  const rng = createRng(seed ^ 0x2e79);
  const random = () => nextFloat(rng);
  let best: ZergParams = { ...ZERG_1_PARAMS };
  const history: Record<string, unknown>[] = [];
  const save = () => {
    mkdirSync(dirname(values.out!), { recursive: true });
    writeFileSync(values.out!, JSON.stringify({ about: 'Zerg judgement numbers (src/zerg-tune.ts); the agent id is the file name.', params: best, from: 'zerg@1', fitness, prey, tables: values.tables, games, children, knobs, history }, null, 2) + '\n');
  };
  const run = (params: ZergParams, n: number, s: number) => play(prey, tables, n, s, params, procs, values.filler!);
  const gain = (c: HordeGame[], b: HordeGame[]) => {
    const d = compareHorde(c, b, fitness).diff;
    return { mean: sign * d.mean, low: sign === 1 ? d.low : -d.high, high: sign === 1 ? d.high : -d.low };
  };
  const diffOf = (a: ZergParams, b: ZergParams) => (Object.keys(a) as (keyof ZergParams)[]).filter((k) => a[k] !== b[k]).map((k) => `${k} ${b[k]}->${a[k]}`);

  for (let gen = 1; gen <= Number(values.generations); gen++) {
    const s1 = seed * 7919 + gen * 2;
    const base = await run(best, games, s1);
    let top: { params: ZergParams; gain: ReturnType<typeof gain>; games: HordeGame[] } | null = null;
    const tried: { changed: string[]; gain: number }[] = [];
    for (let c = 0; c < children; c++) {
      const child = perturb(best, random, knobs, knobSet);
      if (diffOf(child, best).length === 0) continue;
      const g = await run(child, games, s1);
      const gn = gain(g, base);
      tried.push({ changed: diffOf(child, best), gain: Math.round(gn.mean * 1000) / 1000 });
      if (!top || gn.mean > top.gain.mean) top = { params: child, gain: gn, games: g };
    }
    // What the best child changes from the current best, recorded before a possible acceptance replaces it.
    const changed = top ? diffOf(top.params, best) : [];
    let verdict = 'rejected';
    let confirm: ReturnType<typeof gain> | null = null;
    if (top && top.gain.mean > 0.02) {
      const s2 = s1 + 1;
      const [c2, b2] = [await run(top.params, confirmGames, s2), await run(best, confirmGames, s2)];
      // Confirmation on fresh games only: the first set picked the winner, so it would flatter it.
      confirm = gain(c2, b2);
      if (confirm.low > 0) {
        best = top.params;
        verdict = 'accepted';
      } else verdict = 'not confirmed';
    }
    history.push({ gen, tried, top: top ? { changed, gain: top.gain } : null, confirm, verdict, best });
    const f = (x: number) => x.toFixed(3);
    const topText = top ? `${f(top.gain.mean)} [${f(top.gain.low)}, ${f(top.gain.high)}] (${changed.join(', ')})` : 'none';
    const confirmText = confirm ? `, confirm ${f(confirm.mean)} [${f(confirm.low)}, ${f(confirm.high)}]` : '';
    console.error(`gen ${gen}: best of ${tried.length} children ${topText}${confirmText} -> ${verdict}`);
    save();
  }
  save();
  console.log(JSON.stringify({ out: values.out, params: best, accepted: history.filter((h) => h.verdict === 'accepted').length }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
