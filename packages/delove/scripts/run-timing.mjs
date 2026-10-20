// Where a Delove cycle's time went, from the files cycle.sh leaves in its run folder: the phase stamps of every
// invocation (times.tsv, times-<stamp>.tsv), the CPU chunk and gate chunk files (start = the .err file's birth, end =
// the .done / .json write), each GPU step's gpu.json and gpu.log, train.log and, when the dashboard was running,
// dashboard/samples.jsonl. Used by timing-report.mjs (Markdown) and dashboard.mjs (history and run comparison).
// Read-only.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const json = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const lines = (p) => (read(p) ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
const stat = (p) => { try { return statSync(p); } catch { return null; } };
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
/** When a file was created (Windows and macOS keep it; elsewhere 0, so the caller falls back). */
const born = (s) => (s && s.birthtimeMs > 0 ? s.birthtimeMs : null);

/** Every invocation of cycle.sh on this run: its phase stamps (seconds from its start) and its start time. */
export function invocations(dir) {
  const files = ls(dir).filter((f) => /^times(-.+)?\.tsv$/.test(f));
  const out = [];
  const seen = new Set();
  // Copies first, so times.tsv (the latest invocation, also copied by cycle.sh) is the duplicate that is dropped.
  for (const f of files.sort((a, b) => (a === 'times.tsv') - (b === 'times.tsv') || (a < b ? -1 : 1))) {
    const text = read(join(dir, f)) ?? '';
    if (!text.trim() || seen.has(text)) continue;
    seen.add(text);
    const rows = lines(join(dir, f)).map((l) => { const [phase, s] = l.split('\t'); return { phase, s: Number(s) }; }).filter((r) => Number.isFinite(r.s));
    if (!rows.length) continue;
    const m = f.match(/^times-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.tsv$/);
    const st = stat(join(dir, f));
    const last = rows.at(-1).s;
    const start = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : st.mtimeMs - last * 1000;
    out.push({ file: f, start, end: start + last * 1000, rows });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Phases of one invocation, as [start, end] intervals; a phase shorter than `min` seconds did nothing (a resume). */
function invocationPhases(inv, min = 10) {
  const at = (s) => inv.start + s * 1000;
  const ph = [];
  const add = (name, kind, s0, s1, extra = {}) => { if (s1 - s0 >= min) ph.push({ name, kind, start: at(s0), end: at(s1), seconds: s1 - s0, ...extra }); };
  const t = Object.fromEntries(inv.rows.map((r) => [r.phase, r.s]));
  let gpuPrev = 0;
  for (const r of inv.rows) {
    let m;
    if ((m = r.phase.match(/^generated and exported (\S+) \(GPU\)$/))) { add(`GPU ${m[1]}`, 'gpu', gpuPrev, r.s, { step: m[1] }); gpuPrev = r.s; }
    else if ((m = r.phase.match(/^exported (\S+)$/)) && t[`generated ${m[1]}`] !== undefined) add(`export ${m[1]}`, 'export', t[`generated ${m[1]}`], r.s, { step: m[1], minor: true });
  }
  const genDone = t['generation done'];
  if (genDone !== undefined) add('CPU pool', 'cpu', 0, genDone);
  const exportsDone = t['exports done'];
  if (exportsDone !== undefined) add('generation (all steps)', 'generation', 0, exportsDone, { minor: true });
  const trained = Object.keys(t).find((k) => k.startsWith('trained '));
  const trainStart = exportsDone ?? 0;
  if (trained) add('training', 'train', trainStart, t[trained]);
  const gates = t['gates done'];
  if (gates !== undefined) add('gates', 'gates', trained ? t[trained] : trainStart, gates);
  return ph;
}

/** Union of intervals [[s, e], ...] → sorted, non-overlapping. */
function union(iv) {
  const s = iv.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) { if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b); else out.push([a, b]); }
  return out;
}
const len = (iv) => iv.reduce((a, [s, e]) => a + e - s, 0);
function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}
function complement(iv, s0, s1) {
  const out = [];
  let c = s0;
  for (const [a, b] of iv) { if (a > c) out.push([c, Math.min(a, s1)]); c = Math.max(c, b); if (c >= s1) break; }
  if (c < s1) out.push([c, s1]);
  return out.filter(([a, b]) => b > a);
}

/**
 * Chunk intervals and the pool's tail: the time from the moment fewer chunks than the pool's peak were running (for
 * good) to its end, when threads sat idle waiting for the last, slowest chunks.
 */
function poolStats(chunks) {
  if (!chunks.length) return null;
  const ev = chunks.flatMap((c) => [[c.start, 1], [c.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, peak = 0;
  for (const [, d] of ev) { n += d; peak = Math.max(peak, n); }
  // The last moment the pool ran at its peak.
  n = 0;
  let lastPeak = ev[0][0];
  for (const [t, d] of ev) { n += d; if (n >= peak) lastPeak = t; }
  const start = Math.min(...chunks.map((c) => c.start)), end = Math.max(...chunks.map((c) => c.end));
  const busy = chunks.reduce((a, c) => a + c.end - c.start, 0);
  return { start, end, peak, busySeconds: busy / 1000, occupancy: busy / (peak * (end - start) || 1), tailSeconds: (end - lastPeak) / 1000, slowest: [...chunks].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3).map((c) => ({ name: c.name, seconds: (c.end - c.start) / 1000, games: c.games, turnLimit: c.turnLimit })) };
}

/** A GPU log's per-configuration progress: [seconds, games done, turn-limit games]. */
function gpuSeries(path) {
  const by = new Map();
  for (const l of (read(path) ?? '').split(/\r?\n/)) {
    const m = l.match(/^\s+(\S+\/\d+p) step \d+: (\d+)\/(\d+) games(?:, (\d+) at the turn limit)?, (\d+)s/);
    if (m) (by.get(m[1]) ?? by.set(m[1], []).get(m[1])).push([+m[5], +m[2], m[4] === undefined ? null : +m[4], +m[3]]);
  }
  return by;
}

function cpuStep(sdir, step) {
  const chunks = [];
  const groups = new Map();
  for (const l of lines(join(sdir, 'chunks.txt'))) {
    const [, g, st, agents, , options] = l.split(' ');
    const base = join(sdir, `${g}-c${st}`);
    const done = stat(`${base}.done`);
    const r = json(`${base}.json`);
    if (!done || !r) continue;
    const end = done.mtimeMs;
    const start = born(stat(`${base}.err`)) ?? end - (r.seconds ?? 0) * 1000;
    let map = 'classic';
    try { map = JSON.parse(options || '{}').map ?? 'classic'; } catch { /* default */ }
    const seats = agents.split(',').length;
    chunks.push({ name: `${g}-c${st}`, start, end, games: r.games, turnLimit: r.turnLimit ?? 0 });
    const k = `${map}/${seats}p`;
    const e = groups.get(k) ?? { cfg: k, tables: new Set(), games: 0, decisions: 0, turnLimit: 0, threadSeconds: 0 };
    e.tables.add(g); e.games += r.games; e.decisions += r.decisions ?? 0; e.turnLimit += r.turnLimit ?? 0; e.threadSeconds += (end - start) / 1000;
    groups.set(k, e);
  }
  const cfgs = [...groups.values()].map((e) => ({ ...e, tables: [...e.tables] }));
  return { step, where: 'cpu', chunks, cfgs, games: cfgs.reduce((a, c) => a + c.games, 0), decisions: cfgs.reduce((a, c) => a + c.decisions, 0), turnLimit: cfgs.reduce((a, c) => a + c.turnLimit, 0), pool: poolStats(chunks) };
}

function gpuStep(sdir, step) {
  const g = json(join(sdir, 'gpu.json'));
  const series = gpuSeries(join(sdir, 'gpu.log'));
  if (!g) {
    // Still running (or failed): the log's progress only.
    const cfgs = [...series].map(([cfg, s]) => ({ cfg, games: s.at(-1)[1], total: s.at(-1)[3], seconds: s.at(-1)[0], turnLimit: s.at(-1)[2], running: true }));
    return { step, where: 'gpu', running: true, cfgs, games: cfgs.reduce((a, c) => a + c.games, 0), decisions: 0, turnLimit: cfgs.reduce((a, c) => a + (c.turnLimit ?? 0), 0) };
  }
  const tables = new Map((g.tables ?? []).map((t) => [t.table, t]));
  const cfgs = (g.groups ?? []).map((gr) => {
    const ts = (gr.tables ?? []).map((t) => tables.get(t)).filter(Boolean);
    const s = series.get(gr.config) ?? [];
    // When 95% of the configuration's games had finished; the rest of its time went to the slowest games.
    const t95 = s.find((p) => p[1] >= 0.95 * gr.games)?.[0] ?? null;
    return {
      cfg: gr.config, games: gr.games, seconds: gr.seconds, batch: gr.batch, steps: gr.steps, peakGb: gr.peak_gpu_gb, tables: gr.tables,
      decisions: ts.reduce((a, t) => a + (t.decisions ?? 0), 0), turnLimit: ts.reduce((a, t) => a + (t.turnLimit ?? 0), 0),
      meanTurns: ts.length ? ts.reduce((a, t) => a + (t.turns ?? 0), 0) / ts.reduce((a, t) => a + t.games, 0) : null,
      t95, tailSeconds: t95 == null ? null : Math.max(0, gr.seconds - t95),
    };
  });
  return { step, where: 'gpu', cfgs, seconds: g.seconds, games: g.games, decisions: cfgs.reduce((a, c) => a + c.decisions, 0), turnLimit: cfgs.reduce((a, c) => a + c.turnLimit, 0) };
}

/** The cycle config's train_args (next to the jobs files plan.tsv names), for the training batch size. */
function trainBatch(dir, plan) {
  const jobs = plan.find((p) => p[2] && /\.jobs$/.test(p[2]))?.[2];
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1);
  const candidates = [jobs && join(dirname(jobs), `${name}.cycle`), join(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'cycles', `${name}.cycle`)].filter(Boolean);
  for (const c of candidates) {
    const m = (read(c) ?? '').match(/^train_args=.*--batch (\d+)/m);
    if (m) return { batch: +m[1], from: c };
    // train.py's default when the config gives no --batch.
    if (existsSync(c)) return { batch: 1024, from: c };
  }
  return { batch: null, from: null };
}

function trainInfo(dir, phase, batchOpt, plan) {
  const log = read(join(dir, 'train.log'));
  if (log === null) return null;
  let head = null;
  try { head = JSON.parse(log.split(/\r?\n/).find((l) => l.startsWith('{"device"')) ?? 'null'); } catch { /* none */ }
  const steps = [...log.matchAll(/step (\d+)\/(\d+) .* ([\d.]+) min/g)];
  const last = steps.at(-1);
  const minutes = last ? +last[3] : null;
  const st = stat(join(dir, 'train.log'));
  const { batch, from } = batchOpt ? { batch: batchOpt, from: '--batch' } : trainBatch(dir, plan);
  const nSteps = last ? +last[1] : null;
  const seconds = phase?.seconds ?? (st && born(st) ? (st.mtimeMs - born(st)) / 1000 : null);
  const decisions = head?.datasets ? Object.values(head.datasets).reduce((a, d) => a + (d.decisions ?? 0), 0) : null;
  return {
    seconds, stepSeconds: minutes == null ? null : minutes * 60, steps: nSteps, totalSteps: last ? +last[2] : null, batch, batchFrom: from,
    trainDecisions: head?.train ?? null, datasetDecisions: decisions, params: head?.params ?? null,
    samplesPerSec: batch && nSteps && minutes ? (nSteps * batch) / (minutes * 60) : null,
    overheadSeconds: seconds != null && minutes != null ? seconds - minutes * 60 : null,
  };
}

function gateInfo(dir) {
  const pool = lines(join(dir, 'gates', 'pool.txt')).map((l) => l.split(' '));
  if (!pool.length) return null;
  const chunks = [];
  const gates = new Map();
  for (const [i, k, opp, players, games, ...opt] of pool) {
    const f = join(dir, 'gates', `g${i}-${k}.json`);
    const s = stat(f);
    const r = s && json(f);
    const g = gates.get(i) ?? { i: +i, opp, players: +players, options: opt.join(' ') || '{}', games: 0, threadSeconds: 0, turnLimit: 0, start: Infinity, end: 0 };
    if (r) {
      const end = s.mtimeMs;
      const start = born(stat(join(dir, 'gates', `g${i}-${k}.err`))) ?? born(s) ?? end;
      chunks.push({ name: `g${i}-${k}`, start, end, games: r.games, turnLimit: r.turnLimit ?? 0 });
      g.games += r.games; g.turnLimit += r.turnLimit ?? 0; g.threadSeconds += (end - start) / 1000; g.start = Math.min(g.start, start); g.end = Math.max(g.end, end);
    }
    gates.set(i, g);
  }
  return { chunks, byGate: [...gates.values()], games: chunks.reduce((a, c) => a + c.games, 0), pool: poolStats(chunks) };
}

/** Saved dashboard samples of a run (dashboard/samples.jsonl). */
export function runSamples(dir) {
  return (read(join(dir, 'dashboard', 'samples.jsonl')) ?? '').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Stretches of at least `minSeconds` where the samples show neither the GPU nor the CPU busy. */
function sampleIdle(samples, minSeconds = 120) {
  const out = [];
  let s0 = null, prev = null;
  for (const s of samples) {
    const idle = (s.gpu ?? 0) < 10 && (s.cpu ?? 0) < 15;
    // A hole of more than 5 minutes in the samples is the dashboard being off, not the machine being idle.
    if (prev && s.t - prev.t > 300_000) { if (s0 != null && prev.t - s0 >= minSeconds * 1000) out.push([s0, prev.t]); s0 = null; }
    if (idle && s0 == null) s0 = s.t;
    if (!idle && s0 != null) { if (s.t - s0 >= minSeconds * 1000) out.push([s0, s.t]); s0 = null; }
    prev = s;
  }
  if (s0 != null && prev && prev.t - s0 >= minSeconds * 1000) out.push([s0, prev.t]);
  return out;
}

const mins = (s) => s / 60;

/**
 * Everything the timing report and the run comparison need about one run folder. `opts.batch` overrides the
 * training batch size (otherwise read from the cycle config).
 */
export function runTiming(dir, opts = {}) {
  const name = dir.split(/[\\/]/).filter(Boolean).at(-1);
  const invs = invocations(dir);
  const plan = lines(join(dir, 'plan.tsv')).map((l) => l.split('\t'));
  const phases = invs.flatMap((inv) => invocationPhases(inv).map((p) => ({ ...p, invocation: inv.file })));
  // Gaps between invocations (a cycle stopped and resumed by hand).
  const gaps = [];
  for (let i = 1; i < invs.length; i++) if (invs[i].start - invs[i - 1].end > 60_000) gaps.push({ name: 'between invocations', kind: 'gap', start: invs[i - 1].end, end: invs[i].start, seconds: (invs[i].start - invs[i - 1].end) / 1000 });

  // Steps: from plan.tsv, else from the step folders (older cycles have no plan).
  let stepList = plan.filter((p) => p[0] !== 'train' && p[0] !== 'gates').map((p) => ({ step: p[0], where: p[1] }));
  if (!stepList.length) stepList = ls(dir).filter((f) => existsSync(join(dir, f, 'chunks.txt')) || existsSync(join(dir, f, 'gpu.json'))).map((f) => ({ step: f, where: existsSync(join(dir, f, 'gpu.json')) ? 'gpu' : 'cpu' }));
  const steps = stepList.map(({ step, where }) => (where === 'gpu' ? gpuStep(join(dir, step), step) : cpuStep(join(dir, step), step)));
  for (const s of steps) {
    const p = phases.find((ph) => ph.kind === 'gpu' && ph.step === s.step);
    if (p) s.wallSeconds = p.seconds;
    const ex = phases.find((ph) => ph.kind === 'export' && ph.step === s.step);
    if (ex) s.exportSeconds = ex.seconds;
  }
  // The CPU steps share one pool of chunks: its tail is where threads waited on the last, slowest chunks.
  const cpuPool = poolStats(steps.flatMap((s) => s.chunks ?? []));
  const trainPhase = phases.find((p) => p.kind === 'train');
  const train = trainInfo(dir, trainPhase, opts.batch, plan);
  const gates = gateInfo(dir);

  // Activity: CPU = chunks, exports and gate chunks; GPU = GPU steps and training.
  const cpuIv = union([
    ...steps.flatMap((s) => (s.chunks ?? []).map((c) => [c.start, c.end])),
    ...phases.filter((p) => p.kind === 'export').map((p) => [p.start, p.end]),
    ...(gates?.chunks ?? []).map((c) => [c.start, c.end]),
  ]);
  const gpuIv = union(phases.filter((p) => p.kind === 'gpu' || p.kind === 'train').map((p) => [p.start, p.end]));
  const t0 = invs.length ? invs[0].start : Math.min(...[...cpuIv, ...gpuIv].map((x) => x[0]));
  const t1 = invs.length ? Math.max(invs.at(-1).end, ...[...cpuIv, ...gpuIv].map((x) => x[1])) : Math.max(...[...cpuIv, ...gpuIv].map((x) => x[1]));
  const span = Number.isFinite(t1 - t0) ? (t1 - t0) / 1000 : 0;
  const both = intersect(cpuIv, gpuIv);
  const any = union([...cpuIv, ...gpuIv]);
  const neither = Number.isFinite(t0) ? complement(any, t0, t1) : [];
  const cpuOnly = len(cpuIv) - len(both), gpuOnly = len(gpuIv) - len(both);
  // GPU idle while the CPU worked, and the other way round, as stretches of at least a minute.
  const stretches = (a, b) => intersect(a, complement(b, t0, t1)).filter(([s, e]) => e - s >= 60_000);
  const busy = {
    span, cpu: len(cpuIv) / 1000, gpu: len(gpuIv) / 1000, both: len(both) / 1000, cpuOnly: cpuOnly / 1000, gpuOnly: gpuOnly / 1000, neither: len(neither) / 1000,
    idleGaps: neither.filter(([s, e]) => e - s >= 60_000), cpuIdleWhileGpu: stretches(gpuIv, cpuIv), gpuIdleWhileCpu: stretches(cpuIv, gpuIv),
  };
  const samples = runSamples(dir);
  const sampled = samples.length ? {
    n: samples.length, from: samples[0].t, to: samples.at(-1).t, idle: sampleIdle(samples),
    gpuMean: avg(samples.map((s) => s.gpu)), cpuMean: avg(samples.map((s) => s.cpu)),
    gpuMeanWhileGenerating: avg(samples.filter((s) => s.phase === 'generating').map((s) => s.gpu)),
    gpuMeanWhileTraining: avg(samples.filter((s) => s.phase === 'training').map((s) => s.gpu)),
    memMax: Math.max(...samples.map((s) => s.mem ?? 0)), tempMax: Math.max(...samples.map((s) => s.temp ?? 0)),
  } : null;

  const genPhase = phases.find((p) => p.kind === 'generation') ?? null;
  const genSeconds = genPhase?.seconds ?? steps.reduce((a, s) => a + (s.wallSeconds ?? 0), 0) ?? null;
  const games = steps.reduce((a, s) => a + (s.games ?? 0), 0), decisions = steps.reduce((a, s) => a + (s.decisions ?? 0), 0);
  const totals = {
    games, decisions, turnLimit: steps.reduce((a, s) => a + (s.turnLimit ?? 0), 0), generationSeconds: genSeconds,
    gamesPerHour: genSeconds ? games / (genSeconds / 3600) : null, decisionsPerHour: genSeconds ? decisions / (genSeconds / 3600) : null,
    wallSeconds: invs.reduce((a, i) => a + (i.end - i.start) / 1000, 0),
  };
  const out = { name, dir, invocations: invs.map(({ file, start, end, rows }) => ({ file, start, end, seconds: (end - start) / 1000, rows })), phases: [...phases, ...gaps].sort((a, b) => a.start - b.start), steps: steps.map(({ chunks, ...s }) => s), cpuPool, train, gates: gates && { ...gates, chunks: undefined }, busy, sampled, totals, start: t0, end: t1 };
  out.bottlenecks = bottlenecks(out);
  return out;
}

function avg(xs) { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

/** A short list of where time was lost, biggest first: [{ minutes, text }]. */
function bottlenecks(r) {
  const out = [];
  const wall = r.totals.wallSeconds || r.busy.span || 1;
  const big = r.phases.filter((p) => !p.minor && p.kind !== 'gap').sort((a, b) => b.seconds - a.seconds)[0];
  if (big) out.push({ minutes: mins(big.seconds), text: `Longest phase: ${big.name}, ${mins(big.seconds).toFixed(0)} min (${(100 * big.seconds / wall).toFixed(0)}% of the cycle's ${mins(wall).toFixed(0)} min).` });
  const cpuIdle = len(r.busy.cpuIdleWhileGpu) / 1000;
  if (cpuIdle > 600) out.push({ minutes: mins(cpuIdle), text: `CPU idle while the GPU worked: ${mins(cpuIdle).toFixed(0)} min. CPU work (more CPU steps, the next cycle's CPU games, or gates of the previous candidate) could run alongside, or the GPU steps could be split so the CPU pool and the GPU finish together.` });
  const gpuIdle = len(r.busy.gpuIdleWhileCpu) / 1000;
  if (gpuIdle > 600) out.push({ minutes: mins(gpuIdle), text: `GPU idle while the CPU worked: ${mins(gpuIdle).toFixed(0)} min (${r.busy.gpuIdleWhileCpu.length} stretch${r.busy.gpuIdleWhileCpu.length === 1 ? '' : 'es'}; e.g. CPU gates and CPU-only generation). Moving that work to the GPU, or overlapping it with GPU steps, saves up to that much.` });
  const idle = r.busy.neither;
  if (idle > 300) out.push({ minutes: mins(idle), text: `Neither CPU nor GPU busy: ${mins(idle).toFixed(0)} min in ${r.busy.idleGaps.length} gap${r.busy.idleGaps.length === 1 ? '' : 's'} of a minute or more (mostly between invocations or stamps with nothing running).` });
  const tails = r.steps.flatMap((s) => (s.cfgs ?? []).filter((c) => c.tailSeconds != null).map((c) => ({ ...c, step: s.step })));
  const tailSum = tails.reduce((a, c) => a + c.tailSeconds, 0);
  if (tailSum > 300) {
    const worst = [...tails].sort((a, b) => b.tailSeconds - a.tailSeconds).slice(0, 3);
    out.push({ minutes: mins(tailSum), text: `GPU straggler tails: the last 5% of each configuration's games took ${mins(tailSum).toFixed(0)} min in all, with the GPU batch mostly empty. Worst: ${worst.map((c) => `${c.cfg} ${mins(c.tailSeconds).toFixed(0)} of ${mins(c.seconds).toFixed(0)} min`).join(', ')}. A lower turn limit, starting the next configuration's games as slots free up, or running two configurations at once would cut this.` });
  }
  for (const [label, pool] of [['CPU generation', r.cpuPool], ['Gate', r.gates?.pool]]) {
    if (pool && pool.tailSeconds > 300) out.push({ minutes: mins(pool.tailSeconds) * (1 - pool.occupancy), text: `${label} pool tail: ${mins(pool.tailSeconds).toFixed(0)} of ${mins((pool.end - pool.start) / 1000).toFixed(0)} min with fewer than ${pool.peak} chunks running; threads ${(100 * pool.occupancy).toFixed(0)}% busy over the pool. Slowest chunks: ${pool.slowest.map((c) => `${c.name} ${mins(c.seconds).toFixed(0)} min`).join(', ')}. Splitting the slowest tables into smaller chunks, or starting them first, would keep threads busy.` });
  }
  const slowGate = [...(r.gates?.byGate ?? [])].filter((g) => Number.isFinite(g.start)).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  if (slowGate && r.gates.pool && (slowGate.end - slowGate.start) > 0.5 * (r.gates.pool.end - r.gates.pool.start)) out.push({ minutes: 0, text: `Slowest gate: ${slowGate.opp} ${slowGate.players}p ${slowGate.options}, ${mins((slowGate.end - slowGate.start) / 1000).toFixed(0)} of the gates' ${mins((r.gates.pool.end - r.gates.pool.start) / 1000).toFixed(0)} min, ${slowGate.turnLimit} of ${slowGate.games} games at the turn limit.` });
  const slow = r.steps.flatMap((s) => (s.cfgs ?? []).filter((c) => c.seconds && c.games).map((c) => ({ ...c, per: c.seconds / c.games }))).sort((a, b) => b.seconds - a.seconds)[0];
  if (slow && slow.seconds > 900) out.push({ minutes: 0, text: `Slowest GPU configuration: ${slow.cfg}, ${mins(slow.seconds).toFixed(0)} min for ${slow.games} games (${(1000 * slow.per).toFixed(0)} ms per game, batch ${slow.batch}, peak ${slow.peakGb ?? '?'} GB).` });
  const peak = Math.max(0, ...r.steps.flatMap((s) => (s.cfgs ?? []).map((c) => c.peakGb ?? 0)));
  if (peak && peak < 2) out.push({ minutes: 0, text: `GPU memory: no configuration used more than ${peak.toFixed(2)} GB of game state; there is room for bigger batches or two configurations in flight at once.` });
  if (r.train?.overheadSeconds > 300) out.push({ minutes: mins(r.train.overheadSeconds), text: `Training overhead (loading data, ONNX export): ${mins(r.train.overheadSeconds).toFixed(0)} min outside the training steps.` });
  return out.sort((a, b) => b.minutes - a.minutes);
}
