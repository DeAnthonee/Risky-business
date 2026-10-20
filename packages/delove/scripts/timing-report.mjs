#!/usr/bin/env node
// Where each Delove cycle's time went, as Markdown: time per phase, per step and per map / table size; how much of the
// cycle the GPU and the CPU were busy; idle gaps; throughput (games/min, decisions/s, training samples/s); the slowest
// tail (stragglers at the turn limit); and a short list of bottlenecks. Works from the files cycle.sh writes (times*.tsv,
// chunk files, gpu.json / gpu.log, train.log, gates/), plus the dashboard's saved samples when there are any.
//
//   node packages/delove/scripts/timing-report.mjs <run dir> [<run dir> ...] [--batch 512] [--out report.md]
//
// --batch: the training batch size, when the cycle config (found next to the jobs files in plan.tsv) is not at hand.
import { writeFileSync, existsSync } from 'node:fs';
import { runTiming } from './run-timing.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const outFile = opt('--out');
const batch = opt('--batch');
if (!args.length || args.some((d) => !existsSync(d))) {
  console.error('usage: timing-report.mjs <run dir> [...more] [--batch N] [--out file.md]');
  process.exit(2);
}

const m = (s) => (s == null ? '–' : (s / 60).toFixed(1));
const n = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const big = (x) => (x == null ? '–' : x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${(x / 1e3).toFixed(1)}k` : n(x));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '–');
const clock = (t) => new Date(t).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const span = ([s, e]) => `${clock(s)}–${new Date(e).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${m((e - s) / 1000)} min)`;

function report(r) {
  const L = [`## ${r.name}: timing`, ''];
  const wall = r.totals.wallSeconds;
  L.push(`${r.invocations.length} invocation${r.invocations.length === 1 ? '' : 's'} of cycle.sh, ${m(wall)} min of running` +
    (r.invocations.length ? `, from ${clock(r.invocations[0].start)} to ${clock(r.invocations.at(-1).end)} (${m(r.busy.span)} min end to end)` : '') + '.');
  if (r.invocations.length > 1) {
    L.push('', '| invocation | started | minutes | phases |', '| --- | --- | --- | --- |');
    for (const i of r.invocations) L.push(`| ${i.file} | ${clock(i.start)} | ${m(i.seconds)} | ${i.rows.filter((x) => x.phase !== 'start').map((x) => x.phase).join(', ')} |`);
  }

  L.push('', '### Phases', '', '| phase | start | minutes | share |', '| --- | --- | --- | --- |');
  for (const p of r.phases) L.push(`| ${p.minor ? '&nbsp;&nbsp;' : ''}${p.name} | ${clock(p.start)} | ${m(p.seconds)} | ${p.minor ? '' : pct(p.seconds, wall)} |`);

  L.push('', '### Generation by step and by map / table size', '');
  L.push('| step | where | map / seats | games | minutes | games/min | decisions | decisions/s | turn limit | mean turns | batch | peak GB | last 5% of games |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.steps) {
    for (const c of s.cfgs ?? []) {
      // GPU: wall minutes of the configuration; CPU: thread-minutes summed over its chunks.
      const sec = s.where === 'gpu' ? c.seconds : c.threadSeconds;
      L.push(`| ${s.step} | ${s.where.toUpperCase()}${s.where === 'cpu' ? ' (thread-min)' : ''} | ${c.cfg} | ${n(c.games)} | ${m(sec)} | ${sec ? n(c.games / (sec / 60), 1) : '–'} | ${big(c.decisions)} | ${sec && c.decisions ? n(c.decisions / sec) : '–'} | ${c.turnLimit == null ? '–' : `${n(c.turnLimit)} (${pct(c.turnLimit, c.games)})`} | ${c.meanTurns ? c.meanTurns.toFixed(1) : '–'} | ${c.batch ?? ''} | ${c.peakGb ?? ''} | ${c.tailSeconds == null ? '' : `${m(c.tailSeconds)} min (${pct(c.tailSeconds, c.seconds)})`} |`);
    }
    const sec = s.where === 'gpu' ? s.seconds ?? s.wallSeconds : s.pool ? (s.pool.end - s.pool.start) / 1000 : null;
    L.push(`| **${s.step}** | **${s.where.toUpperCase()}** | all${s.running ? ' (running)' : ''} | **${n(s.games)}** | **${m(sec)}**${s.where === 'cpu' ? ' wall' : ''} | ${sec ? n(s.games / (sec / 60), 1) : '–'} | ${big(s.decisions)} | ${sec && s.decisions ? n(s.decisions / sec) : '–'} | ${n(s.turnLimit)} (${pct(s.turnLimit, s.games)}) | | | | ${s.exportSeconds ? `export ${m(s.exportSeconds)} min` : ''} |`);
  }
  const cpuSteps = r.steps.filter((s) => s.pool);
  if (cpuSteps.length) {
    // The CPU steps share one pool (most expensive step first), so a step's own tail is filled by the next step's chunks.
    L.push('', '| CPU pool | chunks at once (peak) | wall min | thread-min | threads busy | tail (fewer than peak running) | slowest chunks |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const [label, p] of [...cpuSteps.map((s) => [s.step, s.pool]), ...(cpuSteps.length > 1 && r.cpuPool ? [['**all CPU steps**', r.cpuPool]] : [])]) L.push(`| ${label} | ${p.peak} | ${m((p.end - p.start) / 1000)} | ${m(p.busySeconds)} | ${pct(p.occupancy, 1)} | ${m(p.tailSeconds)} min | ${p.slowest.map((c) => `${c.name} ${m(c.seconds)} min`).join(', ')} |`);
  }

  L.push('', '### Throughput', '');
  const t = r.totals;
  L.push(`- Generation: ${n(t.games)} games, ${big(t.decisions)} decisions in ${m(t.generationSeconds)} min: **${n(t.gamesPerHour)} games/hour, ${big(t.decisionsPerHour)} decisions/hour** (${n(t.decisionsPerHour / 3600)} decisions/s); ${n(t.turnLimit)} games (${pct(t.turnLimit, t.games)}) at the turn limit.`);
  if (r.train) {
    const tr = r.train;
    L.push(`- Training: ${m(tr.seconds)} min (${m(tr.stepSeconds)} of training steps), ${n(tr.steps)} steps` + (tr.batch ? ` of ${tr.batch} (batch from ${tr.batchFrom === '--batch' ? '--batch' : 'the cycle config'})` : ' (batch size unknown: pass --batch)') +
      ` over ${big(tr.trainDecisions)} training decisions: **${tr.samplesPerSec ? n(tr.samplesPerSec) : '–'} samples/s**, ${tr.steps && tr.stepSeconds ? n(tr.steps / tr.stepSeconds, 1) : '–'} steps/s.`);
  }
  if (r.gates) {
    const g = r.gates;
    const sec = g.pool ? (g.pool.end - g.pool.start) / 1000 : null;
    L.push(`- Gates: ${n(g.games)} games in ${m(sec)} min (${sec ? n(g.games / (sec / 60), 1) : '–'} games/min), ${g.pool ? `${g.pool.peak} chunks at once, threads ${pct(g.pool.occupancy, 1)} busy, tail ${m(g.pool.tailSeconds)} min` : ''}.`);
    L.push('', '| gate | players | options | games | thread-min | wall min | turn limit |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const x of g.byGate) L.push(`| ${x.opp} | ${x.players} | ${x.options} | ${n(x.games)} | ${m(x.threadSeconds)} | ${Number.isFinite(x.start) ? m((x.end - x.start) / 1000) : '–'} | ${n(x.turnLimit)} |`);
  }

  const b = r.busy;
  L.push('', '### GPU and CPU', '');
  L.push(`From the files (CPU: chunks, exports, gate chunks; GPU: GPU steps and training), over ${m(b.span)} min end to end:`, '',
    '| | minutes | share |', '| --- | --- | --- |',
    `| GPU busy | ${m(b.gpu)} | ${pct(b.gpu, b.span)} |`, `| CPU busy | ${m(b.cpu)} | ${pct(b.cpu, b.span)} |`, `| both at once | ${m(b.both)} | ${pct(b.both, b.span)} |`,
    `| GPU only (CPU idle) | ${m(b.gpuOnly)} | ${pct(b.gpuOnly, b.span)} |`, `| CPU only (GPU idle) | ${m(b.cpuOnly)} | ${pct(b.cpuOnly, b.span)} |`, `| neither | ${m(b.neither)} | ${pct(b.neither, b.span)} |`);
  if (b.idleGaps.length) L.push('', `Idle gaps (neither busy, a minute or more): ${b.idleGaps.map(span).join('; ')}.`);
  if (b.cpuIdleWhileGpu.length) L.push('', `CPU idle while the GPU worked: ${b.cpuIdleWhileGpu.map(span).join('; ')}.`);
  if (b.gpuIdleWhileCpu.length) L.push('', `GPU idle while the CPU worked: ${b.gpuIdleWhileCpu.map(span).join('; ')}.`);
  if (r.sampled) {
    const s = r.sampled;
    L.push('', `Dashboard samples (${s.n}, ${clock(s.from)} to ${clock(s.to)}): mean GPU ${n(s.gpuMean)}%, CPU ${n(s.cpuMean)}%; GPU ${n(s.gpuMeanWhileGenerating)}% while generating, ${n(s.gpuMeanWhileTraining)}% while training; peak GPU memory ${n(s.memMax, 1)} GB, ${n(s.tempMax)}°C.` +
      (s.idle.length ? ` Machine idle (GPU < 10%, CPU < 15%) for two minutes or more: ${s.idle.map(span).join('; ')}.` : ' No idle stretches of two minutes or more.'));
  } else {
    L.push('', '_No dashboard samples for this run (dashboard/samples.jsonl); GPU and CPU load are inferred from the files only._');
  }

  L.push('', '### Bottlenecks', '');
  if (!r.bottlenecks.length) L.push('Nothing stands out.');
  r.bottlenecks.forEach((x, i) => L.push(`${i + 1}. ${x.text}`));
  return L.join('\n');
}

const md = args.map((d) => report(runTiming(d, { batch: batch ? Number(batch) : undefined }))).join('\n\n') + '\n';
if (outFile) writeFileSync(outFile, md);
process.stdout.write(md);
