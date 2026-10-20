#!/usr/bin/env node
// A live view of Delove training runs: which phase a cycle is in; each step's games (CPU chunks or GPU progress per
// map and table size) with turn-limit counts, throughput and charts over time; branch-and-score statistics; training
// curves; the ladder gates (score and leaderboard points with 95% intervals) as they finish; and the machine's GPU and
// CPU load. Read-only: it only reads the run folders cycle.sh (and delove_gpu.generate) write.
//
//   node packages/delove/scripts/dashboard.mjs --runs C:/Users/espii/Projects/Risky-business-stage2/runs/delove [--port 8790]
//
// then open http://127.0.0.1:8790 (binds 127.0.0.1 only). ?run=<name> picks a run; the default is the newest one.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const runsDir = arg('--runs', 'runs/delove');
const port = Number(arg('--port', 8790));

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const json = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const lines = (p) => (read(p) ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
const stat = (p) => { try { return statSync(p); } catch { return null; } };
const mtime = (p) => stat(p)?.mtimeMs ?? 0;

// ---- machine history: GPU and CPU every 5 s, the last 2 hours ---------------------------------------------------
const history = [];
let lastCpu = cpus().map((c) => c.times);
function cpuPercent() {
  const now = cpus().map((c) => c.times);
  let busy = 0, all = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? t;
    const d = (k) => t[k] - p[k];
    const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    busy += tot - d('idle');
    all += tot;
  });
  lastCpu = now;
  return all ? (100 * busy) / all : 0;
}
function gpuNow() {
  return new Promise((res) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, out) => {
      if (err) return res(null);
      const [util, used, total, temp, power] = out.trim().split(/\s*,\s*/).map(Number);
      res({ util, used, total, temp, power: Number.isFinite(power) ? power : null });
    });
  });
}
async function sample() {
  const g = await gpuNow();
  history.push({ t: Date.now(), cpu: Math.round(cpuPercent()), gpu: g?.util ?? null, mem: g ? g.used / 1024 : null, memTotal: g ? g.total / 1024 : null, temp: g?.temp ?? null });
  while (history.length > 1440) history.shift();
}
sample();
setInterval(sample, 5000);

// ---- reading runs -------------------------------------------------------------------------------------------------
/** Runs: folders with a cycle (times.tsv) or a GPU log, newest first. */
function listRuns() {
  let names = [];
  try { names = readdirSync(runsDir); } catch { return []; }
  return names
    .map((n) => ({ name: n, dir: join(runsDir, n) }))
    .filter((r) => stat(r.dir)?.isDirectory() && (existsSync(join(r.dir, 'times.tsv')) || existsSync(join(r.dir, 'gpu.log'))))
    .map((r) => ({ ...r, t: Math.max(mtime(join(r.dir, 'times.tsv')), mtime(join(r.dir, 'gpu.log')), mtime(r.dir)) }))
    .sort((a, b) => b.t - a.t);
}

/** Tables of a jobs file: name, games, agents, seats, map. */
function jobsTables(path) {
  return lines(path).map((l) => {
    const [name, games, agents, ...rest] = l.trim().split(/\s+/);
    let options = {};
    try { options = rest.length ? JSON.parse(rest.join(' ')) : {}; } catch { /* keep {} */ }
    return { name, games: Number(games), agents, seats: agents.split(',').length, map: options.map ?? 'classic' };
  });
}

/**
 * A GPU log: per configuration (map / seats) its progress over time (seconds since the configuration started, games
 * done, turn-limit games), whether it finished, its batch; the latest branch statistics; error lines.
 */
function gpuLog(path) {
  const text = read(path) ?? '';
  const cfgs = new Map();
  let branch = null;
  const get = (k) => cfgs.get(k) ?? (cfgs.set(k, { cfg: k, series: [], done: 0, total: 0, turnLimit: null, seconds: 0, step: 0 }), cfgs.get(k));
  for (const l of text.split(/\r?\n/)) {
    let m = l.match(/^\s+(\S+\/\d+p) step (\d+): (\d+)\/(\d+) games(?:, (\d+) at the turn limit)?, (\d+)s(?: \| branch (.*))?$/);
    if (m) {
      const c = get(m[1]);
      Object.assign(c, { step: +m[2], done: +m[3], total: +m[4], turnLimit: m[5] === undefined ? null : +m[5], seconds: +m[6] });
      c.series.push([+m[6], +m[3], m[5] === undefined ? null : +m[5]]);
      if (m[7]) { try { branch = JSON.parse(m[7]); } catch { /* partial line */ } }
      continue;
    }
    m = l.match(/^\s+(\S+\/\d+p): (\d+) games in ([\d.]+)s \(batch (\d+)\)/);
    if (m) {
      const c = get(m[1]);
      Object.assign(c, { done: +m[2], total: +m[2], seconds: +m[3], batch: +m[4], finished: true });
      c.series.push([+m[3], +m[2], c.turnLimit]);
    }
  }
  const errors = text.split(/\r?\n/).filter((l) => /Traceback|Error|FAILED|StaleMirror/.test(l)).slice(-5);
  return { cfgs: [...cfgs.values()], branch, errors };
}

/** Games per second over the last `window` seconds of a configuration's series. */
function rate(series, window = 300) {
  if (series.length < 2) return null;
  const [t1, d1] = series.at(-1);
  let j = series.length - 2;
  while (j > 0 && t1 - series[j][0] < window) j--;
  const [t0, d0] = series[j];
  return t1 > t0 ? (d1 - d0) / (t1 - t0) : null;
}

function stepStatus(sdir, step, where, jobs, title) {
  const tables = jobs ? jobsTables(jobs) : [];
  const total = tables.reduce((a, t) => a + t.games, 0);
  // Planned configurations (map / seats) and their games, in the order delove_gpu meets them.
  const planned = new Map();
  for (const t of tables) { const k = `${t.map}/${t.seats}p`; planned.set(k, (planned.get(k) ?? 0) + t.games); }
  const st = { step, where, title, total, tables };
  if (where === 'gpu') {
    const summary = json(join(sdir, 'gpu.json'));
    const log = gpuLog(join(sdir, 'gpu.log'));
    const seen = new Set(log.cfgs.map((c) => c.cfg));
    st.cfgs = [...log.cfgs, ...[...planned].filter(([k]) => !seen.has(k)).map(([k, n]) => ({ cfg: k, series: [], done: 0, total: n, turnLimit: null, seconds: 0, step: 0, waiting: true }))];
    for (const c of st.cfgs) {
      c.rate = c.finished ? (c.seconds ? c.done / c.seconds : null) : rate(c.series);
      c.eta = !c.finished && c.rate ? (c.total - c.done) / c.rate : null;
    }
    st.branch = summary?.branch ?? log.branch;
    st.errors = log.errors;
    const logStat = stat(join(sdir, 'gpu.log'));
    st.startedAt = logStat ? logStat.birthtimeMs || logStat.ctimeMs : null;
    if (summary) {
      st.state = 'done';
      st.done = summary.games ?? total;
      st.results = summary.tables ?? [];
      st.turnLimit = st.results.reduce((a, t) => a + (t.turnLimit ?? 0), 0);
      st.seconds = summary.seconds;
    } else {
      st.done = log.cfgs.reduce((a, c) => a + c.done, 0);
      st.turnLimit = log.cfgs.reduce((a, c) => a + (c.turnLimit ?? 0), 0);
      st.turnLimitKnown = log.cfgs.every((c) => c.turnLimit !== null);
      st.state = logStat ? (log.errors.length ? 'failed' : 'running') : 'waiting';
      st.seconds = log.cfgs.reduce((a, c) => a + c.seconds, 0);
    }
  } else {
    const chunks = lines(join(sdir, 'chunks.txt')).map((l) => l.split(' '));
    let done = 0, turnLimit = 0, nDone = 0;
    const times = [];
    const branch = { decisions: 0, branched: 0, simulations: 0, simulatedMoves: 0, changed: 0, gain: 0, changedByKind: {}, branchedByKind: {} };
    for (const c of chunks) {
      const base = join(sdir, `${c[1]}-c${c[2]}`);
      const ds = stat(`${base}.done`);
      if (!ds) continue;
      nDone++;
      done += Number(c[4]);
      times.push([ds.mtimeMs, Number(c[4])]);
      const r = json(`${base}.json`);
      if (r) turnLimit += r.turnLimit ?? 0;
    }
    try {
      for (const f of readdirSync(sdir).filter((f) => /^stats-.*\.json$/.test(f))) {
        const s = json(join(sdir, f));
        if (!s) continue;
        for (const k of ['decisions', 'branched', 'simulations', 'simulatedMoves', 'changed', 'gain']) branch[k] += s[k] ?? 0;
        for (const k of ['changedByKind', 'branchedByKind']) for (const [kk, v] of Object.entries(s[k] ?? {})) branch[k][kk] = (branch[k][kk] ?? 0) + v;
      }
    } catch { /* no folder yet */ }
    times.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    st.timeline = times.map(([t, n]) => [t, (acc += n)]);
    st.branch = branch.decisions ? branch : null;
    Object.assign(st, { done, turnLimit, chunks: chunks.length, chunksDone: nDone, turnLimitKnown: true });
    st.state = existsSync(join(sdir, 'export.json')) ? 'done' : nDone === chunks.length && chunks.length ? 'exporting' : nDone ? 'running' : 'waiting';
  }
  return st;
}

function trainStatus(dir) {
  const log = read(join(dir, 'train.log'));
  if (log === null) return null;
  const series = [...log.matchAll(/step (\d+)\/(\d+) policy ([\d.]+) value ([\d.]+) top1 ([\d.]+) ([\d.]+) min/g)].map((m) => m.slice(1).map(Number));
  const vals = [...log.matchAll(/^val (.*)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  let datasets = null;
  try { datasets = JSON.parse(log.split(/\r?\n/).find((l) => l.startsWith('{"device"')) ?? 'null')?.datasets ?? null; } catch { /* none */ }
  const last = series.at(-1);
  return {
    step: last?.[0] ?? 0, steps: last?.[1] ?? 0, policy: last?.[2] ?? null, value: last?.[3] ?? null, top1: last?.[4] ?? null, minutes: last?.[5] ?? 0,
    series: series.map((s) => [s[0], s[2], s[3], s[4]]), vals, datasets, saved: /^saved /m.test(log), onnx: /wrote .*\.onnx/.test(log),
    error: /Traceback/.test(log) ? log.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join('\n') : null,
  };
}

function gateStatus(dir) {
  const pool = lines(join(dir, 'gates', 'pool.txt')).map((l) => l.split(' '));
  if (!pool.length) return null;
  const gates = new Map();
  for (const [i, k, opp, players, games, ...opt] of pool) {
    const g = gates.get(i) ?? { i: +i, opp, players: +players, options: opt.join(' '), chunks: 0, done: 0, games: 0, total: 0, rs: [] };
    g.chunks++;
    g.total += +games;
    const r = json(join(dir, 'gates', `g${i}-${k}.json`));
    if (r) { g.done++; g.games += r.games; g.rs.push(r); }
    gates.set(i, g);
  }
  return [...gates.values()].map(({ rs, ...g }) => {
    const n = g.games;
    if (!n) return g;
    const w = (k) => rs.reduce((a, r) => a + (r[k] ?? 0) * r.games, 0) / n;
    const score = w('score');
    const se = Math.sqrt(rs.reduce((a, r) => a + (r.games * (r.scoreHigh - r.scoreLow) / 3.92) ** 2, 0)) / n;
    const withPts = rs.filter((r) => r.points !== undefined);
    const out = { ...g, score, scoreLow: score - 1.96 * se, scoreHigh: score + 1.96 * se, turnLimit: rs.reduce((a, r) => a + (r.turnLimit ?? 0), 0), meanTurns: w('meanTurns') };
    if (withPts.length) {
      const pn = withPts.reduce((a, r) => a + r.games, 0);
      const pw = (k) => withPts.reduce((a, r) => a + r[k] * r.games, 0) / pn;
      const d = pw('pointsDiff');
      const k = withPts.length;
      const dse = k > 1 ? Math.sqrt(withPts.reduce((a, r) => a + (r.pointsDiff - d) ** 2, 0) / (k - 1) / k) : null;
      Object.assign(out, { points: pw('points'), bestPoints: pw('bestPoints'), pointsDiff: d, pointsLow: dse == null ? null : d - 1.96 * dse, pointsHigh: dse == null ? null : d + 1.96 * dse, place: pw('meanPlacement'), kills: pw('killsPerGame') });
    }
    return out;
  });
}

async function status(runName) {
  const runs = listRuns();
  const run = runs.find((r) => r.name === runName) ?? runs[0];
  const latest = history.at(-1) ?? {};
  const out = { runs: runs.map((r) => r.name), now: Date.now(), machine: { history, latest, threads: cpus().length } };
  if (!run) return out;
  const dir = run.dir;
  out.run = run.name;
  out.phases = lines(join(dir, 'times.tsv')).map((l) => { const [phase, s] = l.split('\t'); return { phase, seconds: +s }; });
  out.lastUpdate = Math.max(mtime(join(dir, 'times.tsv')), mtime(join(dir, 'gpu.log')), mtime(join(dir, 'train.log')), mtime(join(dir, 'cycle.md')),
    ...(() => { try { return readdirSync(dir).map((s) => mtime(join(dir, s, 'gpu.log'))); } catch { return [0]; } })());
  const plan = lines(join(dir, 'plan.tsv')).map((l) => l.split('\t'));
  const timesStat = stat(join(dir, 'times.tsv'));
  if (plan.length) {
    out.steps = plan.filter((p) => p[0] !== 'train' && p[0] !== 'gates').map(([step, where, jobs, title]) => stepStatus(join(dir, step), step, where, jobs, title));
    out.candidate = plan.find((p) => p[0] === 'train')?.[1];
    out.startedAt = mtime(join(dir, 'plan.tsv'));
  } else if (existsSync(join(dir, 'gpu.log'))) {
    // A bare delove_gpu.generate run (a pilot or benchmark): its jobs file, if one sits next to the log.
    const jobs = readdirSync(dir).find((f) => f.endsWith('.jobs'));
    out.steps = [stepStatus(dir, run.name, 'gpu', jobs ? join(dir, jobs) : null, 'GPU run')];
    out.startedAt = out.steps[0].startedAt;
  } else if (timesStat) {
    out.startedAt = timesStat.birthtimeMs || null;
  }
  out.train = trainStatus(dir);
  out.gates = gateStatus(dir);
  out.finished = existsSync(join(dir, 'cycle.md')) && mtime(join(dir, 'cycle.md')) >= mtime(join(dir, 'times.tsv')) ||
    (!plan.length && out.steps?.[0]?.state === 'done');
  return out;
}

// ---- the page -----------------------------------------------------------------------------------------------------
const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delove training</title>
<style>
:root { --bg:#f6f6f3; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e3e2dd; --grid:#ecebe6; --accent:#2f6fde; --ok:#1e8a4c; --warn:#b26a00; --bad:#c0392b; --bar:#e9e8e3;
  --c1:#2f6fde; --c2:#d9730d; --c3:#1e8a4c; --c4:#9b4dca; --c5:#c0392b; --c6:#138d90; --c7:#a87d00; --c8:#d6338a; --c9:#5b6b7c; --c10:#6d8f00; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1e1e1c; --ink:#ecebe6; --muted:#9a9993; --line:#32322e; --grid:#2a2a27; --accent:#6f9cf0; --ok:#4cc27e; --warn:#e2a03a; --bad:#ef6b5b; --bar:#2c2c29;
  --c1:#6f9cf0; --c2:#f0a05a; --c3:#4cc27e; --c4:#c08cf0; --c5:#ef6b5b; --c6:#4cc9c6; --c7:#e0c04a; --c8:#f07ab8; --c9:#9fb0c2; --c10:#a8d04a; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1280px; margin:0 auto; padding:20px 16px 60px; }
header { display:flex; flex-wrap:wrap; align-items:baseline; gap:10px 18px; margin-bottom:14px; }
h1 { font-size:20px; margin:0; } h2 { font-size:15px; margin:0 0 4px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
h3 { font-size:13px; margin:12px 0 6px; color:var(--muted); font-weight:600; }
.sub { color:var(--muted); font-size:12px; margin-bottom:10px; }
select { font:inherit; padding:3px 6px; background:var(--card); color:var(--ink); border:1px solid var(--line); border-radius:6px; }
.muted { color:var(--muted); } .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:14px; }
.two { display:grid; grid-template-columns:repeat(auto-fit, minmax(420px, 1fr)); gap:14px; }
@media (max-width:520px) { .two { grid-template-columns:1fr; } }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:14px; overflow-x:auto; min-width:0; }
.stat { margin:0; } .stat .k { font-size:12px; color:var(--muted); } .stat .v { font-size:21px; font-weight:600; font-variant-numeric:tabular-nums; }
.stat .s { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
.bar { height:8px; background:var(--bar); border-radius:4px; overflow:hidden; margin:6px 0 2px; min-width:60px; }
.bar > i { display:block; height:100%; background:var(--accent); } .bar.done > i { background:var(--ok); }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { font-weight:600; color:var(--muted); font-size:12px; } td.r, th.r { text-align:right; }
.pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); font-weight:500; }
.pill.running, .pill.exporting { color:var(--accent); border-color:var(--accent); } .pill.done { color:var(--ok); border-color:var(--ok); } .pill.failed { color:var(--bad); border-color:var(--bad); }
.pipe { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.pipe .node { padding:6px 10px; border-radius:8px; border:1px solid var(--line); font-size:13px; background:var(--bg); }
.pipe .node.done { border-color:var(--ok); } .pipe .node.running, .pipe .node.exporting { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.pipe .node small { display:block; color:var(--muted); font-size:11px; } .pipe .arrow { color:var(--muted); }
svg text { fill:var(--muted); font-size:11px; font-family:inherit; }
svg .gridline { stroke:var(--grid); } svg .axis { stroke:var(--line); }
.legend { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:12px; color:var(--muted); margin-top:4px; }
.legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
pre { white-space:pre-wrap; color:var(--bad); margin:6px 0 0; }
.kv { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px 14px; }
.kv div b { display:block; font-size:16px; font-variant-numeric:tabular-nums; } .kv div span { font-size:12px; color:var(--muted); }
</style></head><body><main>
<header><h1>Delove training</h1><label class="muted">run <select id="run"></select></label><span id="meta" class="muted"></span></header>
<div id="app" class="muted">loading…</div>
</main><script>
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const big = (n) => n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : fmt(n);
const pct = (a, b) => b ? Math.min(100, 100 * a / b) : 0;
const dur = (s) => { if (s == null || !isFinite(s)) return '–'; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's'; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const bar = (a, b, done) => '<div class="bar' + (done ? ' done' : '') + '"><i style="width:' + pct(a, b).toFixed(1) + '%"></i></div>';
const tlClass = (tl, n) => !n || tl == null ? '' : tl / n > 0.5 ? 'bad' : tl / n > 0.1 ? 'warn' : 'ok';
const color = (i) => 'var(--c' + (i % 10 + 1) + ')';
const short = (a) => a.replace('delove-teacher@2', 'Sensei 2').replace('delove-branch@1', 'branch');
let chosen = new URLSearchParams(location.search).get('run') || '';
$('#run').onchange = (e) => { chosen = e.target.value; history.replaceState(null, '', '?run=' + encodeURIComponent(chosen)); tick(); };

// A small SVG line chart. series: [{ name, color, pts: [[x, y], ...], dash }]; opts: xFmt, yFmt, yMin, yMax, h, area.
function lineChart(series, o = {}) {
  const W = 560, H = o.h || 190, L = 44, R = 10, T = 8, B = 24;
  const all = series.flatMap((s) => s.pts.filter((p) => p[1] != null));
  if (all.length < 2) return '<div class="muted" style="padding:20px 0">' + (o.empty || 'not enough data yet') + '</div>';
  let x0 = o.xMin ?? Math.min(...all.map((p) => p[0])), x1 = o.xMax ?? Math.max(...all.map((p) => p[0]));
  let y0 = o.yMin ?? Math.min(0, ...all.map((p) => p[1])), y1 = o.yMax ?? Math.max(...all.map((p) => p[1]));
  if (x1 === x0) x1 = x0 + 1; if (y1 === y0) y1 = y0 + 1;
  if (o.yMax == null) {
    // Round tick steps (1, 2, 2.5 or 5 x 10^n) over 4 intervals.
    const raw = (y1 - y0) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
    y1 = y0 + 4 * step;
  }
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R), Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 4; i++) { const y = y0 + (y1 - y0) * i / 4; g += '<line class="gridline" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(y) + '" y2="' + Y(y) + '"/><text x="' + (L - 6) + '" y="' + (Y(y) + 4) + '" text-anchor="end">' + (o.yFmt || fmt)(y) + '</text>'; }
  for (let i = 0; i <= 5; i++) { const x = x0 + (x1 - x0) * i / 5; g += '<text x="' + X(x) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === 5 ? 'end' : 'middle') + '">' + (o.xFmt || fmt)(x) + '</text>'; }
  g += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>';
  for (const s of series) {
    const pts = s.pts.filter((p) => p[1] != null);
    if (!pts.length) continue;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
    if (o.area) g += '<path d="' + d + 'L' + X(pts.at(-1)[0]).toFixed(1) + ' ' + Y(y0) + 'L' + X(pts[0][0]).toFixed(1) + ' ' + Y(y0) + 'Z" fill="' + s.color + '" opacity="0.12"/>';
    g += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.8"' + (s.dash ? ' stroke-dasharray="4 3"' : '') + ' stroke-linejoin="round"/>';
    const p = pts.at(-1); g += '<circle cx="' + X(p[0]) + '" cy="' + Y(p[1]) + '" r="2.6" fill="' + s.color + '"><title>' + esc(s.name) + ': ' + (o.yFmt || fmt)(p[1]) + '</title></circle>';
  }
  const legend = series.length > 1 || o.legend ? '<div class="legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('') + '</div>' : '';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">' + g + '</svg>' + legend;
}

// Horizontal bars with optional 95% whiskers. rows: [{ label, v, lo, hi, color }]; a zero line when the range spans 0.
function barChart(rows, o = {}) {
  if (!rows.length) return '<div class="muted">no data yet</div>';
  const W = 560, rowH = 22, L = o.labelW || 170, R = 54, T = 6, H = T + rows.length * rowH + 18;
  const vals = rows.flatMap((r) => [r.v, r.lo, r.hi]).filter((v) => v != null);
  let x0 = o.min ?? Math.min(0, ...vals), x1 = o.max ?? Math.max(0, ...vals);
  if (x1 === x0) x1 = x0 + 1;
  const pad = (x1 - x0) * 0.05; if (o.min == null) x0 -= x0 < 0 ? pad : 0; if (o.max == null) x1 += pad;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R);
  let g = '';
  for (let i = 0; i <= 4; i++) { const x = x0 + (x1 - x0) * i / 4; g += '<line class="gridline" y1="' + T + '" y2="' + (H - 18) + '" x1="' + X(x) + '" x2="' + X(x) + '"/><text y="' + (H - 4) + '" x="' + X(x) + '" text-anchor="middle">' + (o.fmt || fmt)(x) + '</text>'; }
  if (o.ref != null) g += '<line class="axis" stroke-width="1.5" y1="' + T + '" y2="' + (H - 18) + '" x1="' + X(o.ref) + '" x2="' + X(o.ref) + '"/>';
  rows.forEach((r, i) => {
    const y = T + i * rowH, base = o.ref ?? 0, c = r.color || 'var(--c1)';
    g += '<text x="' + (L - 8) + '" y="' + (y + 15) + '" text-anchor="end">' + esc(r.label) + '</text>';
    if (r.v == null) return;
    g += '<rect x="' + Math.min(X(base), X(r.v)) + '" y="' + (y + 5) + '" width="' + Math.abs(X(r.v) - X(base)) + '" height="12" rx="2" fill="' + c + '" opacity="0.8"/>';
    if (r.lo != null && r.hi != null) g += '<line x1="' + X(r.lo) + '" x2="' + X(r.hi) + '" y1="' + (y + 11) + '" y2="' + (y + 11) + '" stroke="var(--ink)" stroke-width="1.3"/><line x1="' + X(r.lo) + '" x2="' + X(r.lo) + '" y1="' + (y + 7) + '" y2="' + (y + 15) + '" stroke="var(--ink)"/><line x1="' + X(r.hi) + '" x2="' + X(r.hi) + '" y1="' + (y + 7) + '" y2="' + (y + 15) + '" stroke="var(--ink)"/>';
    g += '<text x="' + (W - R + 6) + '" y="' + (y + 15) + '" style="fill:var(--ink)">' + (o.fmt || fmt)(r.v) + '</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W * 1.15 + 'px" role="img">' + g + '</svg>';
}

function stepCard(s, now) {
  let h = '<div class="card"><h2>' + esc(s.step) + ' <span class="pill ' + s.state + '">' + s.state + '</span><span class="pill">' + s.where.toUpperCase() + '</span><span class="muted" style="font-weight:400">' + esc(s.title || '') + '</span></h2>';
  const tlKnown = s.turnLimitKnown !== false || s.state === 'done';
  h += '<div class="sub">' + fmt(s.done) + ' / ' + fmt(s.total || null) + ' games' + (s.chunks ? ' · chunks ' + s.chunksDone + '/' + s.chunks : '') +
    ' · <span class="' + (tlKnown ? tlClass(s.turnLimit, s.done) : '') + '">' + (tlKnown ? fmt(s.turnLimit) + ' at the turn limit' + (s.done ? ' (' + (100 * s.turnLimit / s.done).toFixed(1) + '%)' : '') : 'turn-limit count not logged by this run') + '</span>' +
    (s.seconds ? ' · ' + dur(s.seconds) + ' of play' : '') + '</div>' + bar(s.done, s.total, s.state === 'done');
  if (s.cfgs && s.cfgs.length) {
    h += '<table><tr><th>map / seats</th><th class="r">games</th><th style="width:22%"></th><th class="r">turn limit</th><th class="r">games/min</th><th class="r">time</th><th class="r">ETA</th><th class="r">batch</th></tr>';
    for (const c of s.cfgs) {
      h += '<tr><td>' + esc(c.cfg) + '</td><td class="r">' + fmt(c.done) + ' / ' + fmt(c.total) + '</td><td>' + bar(c.done, c.total, c.finished) + '</td><td class="r ' + tlClass(c.turnLimit, c.done) + '">' + (c.turnLimit == null ? '–' : fmt(c.turnLimit) + (c.done ? ' (' + Math.round(100 * c.turnLimit / c.done) + '%)' : '')) +
        '</td><td class="r">' + (c.rate == null ? '–' : fmt(c.rate * 60, 1)) + '</td><td class="r">' + (c.waiting ? 'waiting' : dur(c.seconds) + (c.finished ? ' ✓' : '')) + '</td><td class="r">' + (c.finished || c.waiting ? '' : c.eta == null ? '–' : '~' + dur(c.eta)) + '</td><td class="r">' + (c.batch ? fmt(c.batch) : '') + '</td></tr>';
    }
    h += '</table>';
    const live = s.cfgs.filter((c) => c.series.length > 1);
    if (live.length) {
      h += '<div class="two"><div><h3>Games finished per map / seats (minutes since it started)</h3>' +
        lineChart(live.map((c, i) => ({ name: c.cfg, color: color(i), pts: c.series.map((p) => [p[0] / 60, p[1]]) })), { xFmt: (x) => fmt(x, 0) + 'm', xMin: 0 }) + '</div>';
      const tl = live.filter((c) => c.series.some((p) => p[2] != null));
      h += '<div><h3>Share of finished games at the turn limit</h3>' + (tl.length ? lineChart(tl.map((c, i) => ({ name: c.cfg, color: color(live.indexOf(c)), pts: c.series.filter((p) => p[1] > 0 && p[2] != null).map((p) => [p[0] / 60, 100 * p[2] / p[1]]) })), { xFmt: (x) => fmt(x, 0) + 'm', yFmt: (y) => fmt(y) + '%', yMin: 0, yMax: 100, xMin: 0 })
        : '<div class="muted" style="padding:20px 0">this run\'s log has no turn-limit counts (cycle 5 logs have them)</div>') + '</div></div>';
    }
  }
  if (s.timeline && s.timeline.length > 1) {
    const t0 = s.timeline[0][0];
    h += '<h3>Games finished (CPU chunks, minutes)</h3>' + lineChart([{ name: s.step, color: 'var(--c1)', pts: [[0, 0], ...s.timeline.map(([t, n]) => [(t - t0) / 60000, n])] }], { xFmt: (x) => fmt(x, 0) + 'm', area: true });
  }
  if (s.results && s.results.length) {
    h += '<h3>Tables</h3><table><tr><th>table</th><th class="r">games</th><th>wins by seat</th><th class="r">mean turns</th><th class="r">turn limit</th><th class="r">decisions</th></tr>';
    for (const t of s.results) h += '<tr><td>' + esc(t.table) + '</td><td class="r">' + fmt(t.games) + '</td><td>' + t.agents.map((a, i) => esc(short(a)) + ' <b>' + t.wins[i] + '</b>').join(', ') + '</td><td class="r">' + t.meanTurns + '</td><td class="r ' + tlClass(t.turnLimit, t.games) + '">' + fmt(t.turnLimit) + '</td><td class="r">' + big(t.decisions) + '</td></tr>';
    h += '</table>';
  }
  if (s.branch && s.branch.decisions) h += branchBlock(s.branch);
  if (s.errors && s.errors.length) h += '<pre>' + esc(s.errors.join('\n')) + '</pre>';
  return h + '</div>';
}

function branchBlock(b) {
  const br = b.branched || 1;
  let h = '<h3>Branch and score' + (b.decisions ? '' : '') + '</h3><div class="kv">' +
    '<div><b>' + big(b.decisions) + '</b><span>branch player decisions</span></div>' +
    '<div><b>' + big(b.branched) + ' <span class="muted">' + fmt(100 * b.branched / (b.decisions || 1), 1) + '%</span></b><span>branched (options compared)</span></div>' +
    '<div><b>' + big(b.changed) + ' <span class="muted">' + fmt(100 * b.changed / br, 1) + '%</span></b><span>changed Sensei\'s move</span></div>' +
    '<div><b>' + big(b.simulations) + '</b><span>simulations (' + big(b.simulatedMoves) + ' moves)</span></div>' +
    '<div><b>+' + fmt(b.gain / br, 4) + '</b><span>mean score gain per branched decision</span></div></div>';
  const kinds = Object.entries(b.branchedByKind || {}).sort((x, y) => y[1] - x[1]);
  if (kinds.length) h += '<h3>Changed / branched, by kind of move</h3>' + barChart(kinds.map(([k, n], i) => ({ label: k + ' (' + big(n) + ')', v: 100 * ((b.changedByKind || {})[k] || 0) / n, color: color(i) })), { min: 0, max: 100, fmt: (v) => fmt(v) + '%', labelW: 150 });
  return h;
}

function render(d) {
  const sel = $('#run');
  if (sel.options.length !== d.runs.length || [...sel.options].some((o, i) => o.value !== d.runs[i])) sel.innerHTML = d.runs.map((r) => '<option>' + esc(r) + '</option>').join('');
  sel.value = d.run || '';
  const ago = d.lastUpdate ? Math.round((d.now - d.lastUpdate) / 1000) : null;
  $('#meta').textContent = (d.finished ? 'finished' : 'in progress') + (ago != null ? ' · last write ' + dur(ago) + ' ago' : '') + ' · refreshes every 5 s';
  const steps = d.steps || [];
  const games = steps.reduce((a, s) => a + (s.done || 0), 0), total = steps.reduce((a, s) => a + (s.total || 0), 0);
  const tl = steps.reduce((a, s) => a + (s.turnLimit || 0), 0);
  const tlKnown = steps.every((s) => s.turnLimitKnown !== false || s.state === 'done');
  const phase = d.phases && d.phases.length ? d.phases[d.phases.length - 1] : null;
  const elapsed = d.finished && phase ? phase.seconds : d.startedAt ? (d.now - d.startedAt) / 1000 : null;
  const gatesRunning = d.gates && d.gates.some((g) => g.done < g.chunks);
  const where = d.finished ? 'finished' : d.gates && d.train && d.train.onnx ? (gatesRunning ? 'ladder gates' : 'summary')
    : d.train ? 'training' : steps.some((s) => s.state !== 'done') ? 'generating' : phase ? phase.phase : '–';
  const rateNow = steps.flatMap((s) => s.cfgs || []).filter((c) => !c.finished && !c.waiting && c.rate != null).reduce((a, c) => a + c.rate, 0);
  const m = d.machine || {}, L = m.latest || {};
  const branch = steps.map((s) => s.branch).filter(Boolean);
  const sims = branch.reduce((a, b) => a + (b.simulations || 0), 0);
  let h = '<div class="grid">';
  h += '<div class="card stat"><div class="k">phase</div><div class="v">' + esc(where) + '</div><div class="s">' + (phase ? 'last: ' + esc(phase.phase) : '') + '</div></div>';
  h += '<div class="card stat"><div class="k">games</div><div class="v">' + fmt(games) + '</div><div class="s">of ' + fmt(total || null) + ' · ' + fmt(pct(games, total), 1) + '%</div>' + bar(games, total, total && games >= total) + '</div>';
  h += '<div class="card stat"><div class="k">turn limit</div><div class="v ' + (tlKnown ? tlClass(tl, games) : '') + '">' + (tlKnown ? fmt(tl) : '–') + '</div><div class="s">' + (tlKnown && games ? (100 * tl / games).toFixed(1) + '% of finished games' : tlKnown ? '' : 'not logged by this run') + '</div></div>';
  h += '<div class="card stat"><div class="k">throughput now</div><div class="v">' + (rateNow ? fmt(rateNow * 60, 1) : '–') + '</div><div class="s">games / min (last 5 min)</div></div>';
  h += '<div class="card stat"><div class="k">simulations</div><div class="v">' + big(sims || null) + '</div><div class="s">branch rollouts so far</div></div>';
  h += '<div class="card stat"><div class="k">elapsed</div><div class="v">' + dur(elapsed) + '</div><div class="s">' + (d.startedAt ? 'since ' + new Date(d.startedAt).toLocaleTimeString() : '') + '</div></div>';
  h += '<div class="card stat"><div class="k">GPU</div><div class="v">' + fmt(L.gpu) + '%</div><div class="s">' + fmt(L.mem, 1) + ' / ' + fmt(L.memTotal, 1) + ' GB · ' + fmt(L.temp) + '°C</div></div>';
  h += '<div class="card stat"><div class="k">CPU</div><div class="v">' + fmt(L.cpu) + '%</div><div class="s">' + fmt(m.threads) + ' threads</div></div>';
  h += '</div>';

  // The cycle as a pipeline: steps, training, gates.
  if (steps.length > 1 || d.train || d.gates) {
    h += '<div class="card"><h2>Pipeline</h2><div class="pipe">';
    const node = (name, state, sub) => '<div class="node ' + state + '">' + esc(name) + '<small>' + sub + '</small></div>';
    h += steps.map((s) => node(s.step + ' · ' + s.where.toUpperCase(), s.state, fmt(s.done) + ' / ' + fmt(s.total) + ' games')).join('<span class="arrow">→</span>');
    const tState = !d.train ? 'waiting' : d.train.onnx ? 'done' : d.train.error ? 'failed' : 'running';
    h += '<span class="arrow">→</span>' + node('train ' + (d.candidate || ''), tState, d.train ? fmt(pct(d.train.step, d.train.steps), 0) + '%' : 'waiting');
    const gd = d.gates ? d.gates.reduce((a, g) => a + g.games, 0) : 0, gt = d.gates ? d.gates.reduce((a, g) => a + g.total, 0) : 0;
    h += '<span class="arrow">→</span>' + node('ladder gates', !d.gates ? 'waiting' : gatesRunning ? 'running' : 'done', d.gates ? fmt(gd) + ' / ' + fmt(gt) + ' games' : 'waiting');
    h += '</div>';
    if (d.phases && d.phases.length) h += '<h3>Phases (minutes from the start)</h3><div class="pipe">' + d.phases.map((p) => '<span class="pill">' + esc(p.phase) + ' · ' + (p.seconds / 60).toFixed(1) + '</span>').join('') + '</div>';
    h += '</div>';
  }

  for (const s of steps) h += stepCard(s, d.now);

  if (d.train) {
    const t = d.train;
    h += '<div class="card"><h2>Training ' + esc(d.candidate || '') + ' <span class="pill ' + (t.onnx ? 'done' : t.error ? 'failed' : 'running') + '">' + (t.onnx ? 'done' : t.error ? 'failed' : 'running') + '</span></h2>';
    const eta = t.step && !t.onnx ? t.minutes * 60 * (t.steps - t.step) / t.step : null;
    h += '<div class="sub">step ' + fmt(t.step) + ' / ' + fmt(t.steps) + ' · ' + t.minutes.toFixed(1) + ' min' + (eta ? ' · ~' + dur(eta) + ' left' : '') + ' · policy loss ' + (t.policy ?? '–') + ' · value loss ' + (t.value ?? '–') + ' · top-1 ' + (t.top1 ?? '–') + '</div>' + bar(t.step, t.steps, t.onnx);
    if (t.datasets) {
      // Datasets are folder paths, repeated to weight them: show "<dataset>/<map> xN: decisions".
      const ds = new Map();
      for (const [k, v] of Object.entries(t.datasets)) { const n = k.split(/[\\/]/).slice(-2).join('/'); const e = ds.get(n) || { n: 0, d: v.decisions }; e.n++; ds.set(n, e); }
      h += '<div class="sub">training data: ' + [...ds].map(([k, e]) => esc(k) + (e.n > 1 ? ' ×' + e.n : '') + ' ' + big(e.d)).join(' · ') + '</div>';
    }
    h += '<div class="two"><div><h3>Training losses (batch)</h3>' + lineChart([
      { name: 'policy loss', color: 'var(--c1)', pts: t.series.map((p) => [p[0], p[1]]) },
      { name: 'value loss', color: 'var(--c2)', pts: t.series.map((p) => [p[0], p[2]]) },
      ...(t.vals.length ? [{ name: 'validation policy loss', color: 'var(--c1)', dash: true, pts: t.vals.map((v) => [v.step, v.policy_loss]) }, { name: 'validation value loss', color: 'var(--c2)', dash: true, pts: t.vals.map((v) => [v.step, v.value_loss]) }] : []),
    ], { xFmt: big, yFmt: (y) => fmt(y, 2) }) + '</div>';
    h += '<div><h3>Agreement with the teacher\'s move (top-1)</h3>' + lineChart([
      { name: 'batch', color: 'var(--c3)', pts: t.series.map((p) => [p[0], 100 * p[3]]) },
      ...(t.vals.length ? [{ name: 'validation', color: 'var(--c4)', pts: t.vals.map((v) => [v.step, 100 * v.top1]) }] : []),
    ], { xFmt: big, yFmt: (y) => fmt(y) + '%', legend: true }) + '</div></div>';
    const last = t.vals.at(-1);
    if (last && last.top1_by_dataset) h += '<h3>Validation top-1 by dataset (latest)</h3>' + barChart(Object.entries(last.top1_by_dataset).map(([k, v], i) => ({ label: k, v: 100 * v, color: color(i) })), { min: 0, max: 100, fmt: (v) => fmt(v, 1) + '%' });
    if (t.error) h += '<pre>' + esc(t.error) + '</pre>';
    h += '</div>';
  }

  if (d.gates) {
    h += '<div class="card"><h2>Ladder gates</h2><div class="sub">candidate vs opponent on mirrored seeds. Score: share of games won (0.5 = even; turn-limit games count half). Points: the leaderboard\'s mean points per seat (placement + kills).</div>';
    h += '<table><tr><th>opponent</th><th class="r">players</th><th>options</th><th class="r">games</th><th style="width:10%"></th><th class="r">score (95%)</th><th class="r">points</th><th class="r">opp.</th><th class="r">diff (95%)</th><th class="r">place</th><th class="r">kills</th><th class="r">turn limit</th></tr>';
    for (const g of d.gates) {
      h += '<tr><td>' + esc(g.opp) + '</td><td class="r">' + g.players + '</td><td>' + esc(g.options) + '</td><td class="r">' + fmt(g.games) + ' / ' + fmt(g.total) + '</td><td>' + bar(g.done, g.chunks, g.done === g.chunks) + '</td>' +
        '<td class="r ' + (g.scoreLow > 0.5 ? 'ok' : g.scoreHigh < 0.5 ? 'bad' : '') + '">' + (g.score == null ? '–' : g.score.toFixed(3) + ' <span class="muted">' + g.scoreLow.toFixed(3) + '-' + g.scoreHigh.toFixed(3) + '</span>') + '</td>' +
        '<td class="r">' + (g.points == null ? '–' : g.points.toFixed(2)) + '</td><td class="r">' + (g.bestPoints == null ? '–' : g.bestPoints.toFixed(2)) + '</td>' +
        '<td class="r ' + (g.pointsLow > 0 ? 'ok' : g.pointsHigh < 0 ? 'bad' : '') + '">' + (g.pointsDiff == null ? '–' : (g.pointsDiff >= 0 ? '+' : '') + g.pointsDiff.toFixed(2) + (g.pointsLow != null ? ' <span class="muted">' + g.pointsLow.toFixed(2) + ' to ' + g.pointsHigh.toFixed(2) + '</span>' : '')) + '</td>' +
        '<td class="r">' + (g.place == null ? '–' : g.place.toFixed(2)) + '</td><td class="r">' + (g.kills == null ? '–' : g.kills.toFixed(2)) + '</td><td class="r ' + tlClass(g.turnLimit, g.games) + '">' + fmt(g.turnLimit) + '</td></tr>';
    }
    h += '</table>';
    const label = (g) => g.opp.replace('delove-teacher@2', 'Sensei 2') + ' · ' + g.players + 'p' + (g.options && g.options !== '{}' ? ' · ' + (JSON.parse(g.options).map || g.options) : '');
    const played = d.gates.filter((g) => g.games);
    h += '<div class="two"><div><h3>Score with 95% interval (line: even)</h3>' + barChart(played.map((g) => ({ label: label(g), v: g.score, lo: g.scoreLow, hi: g.scoreHigh, color: g.scoreLow > 0.5 ? 'var(--ok)' : g.scoreHigh < 0.5 ? 'var(--bad)' : 'var(--c1)' })), { min: 0.3, max: 0.8, ref: 0.5, fmt: (v) => v.toFixed(2), labelW: 200 }) + '</div>';
    const pts = played.filter((g) => g.pointsDiff != null);
    h += '<div><h3>Points difference per seat with 95% interval</h3>' + (pts.length ? barChart(pts.map((g) => ({ label: label(g), v: g.pointsDiff, lo: g.pointsLow, hi: g.pointsHigh, color: g.pointsLow > 0 ? 'var(--ok)' : g.pointsHigh < 0 ? 'var(--bad)' : 'var(--c1)' })), { ref: 0, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2), labelW: 200 }) : '<div class="muted">no points in these results</div>') + '</div></div>';
    h += '</div>';
  }

  if (m.history && m.history.length > 1) {
    const t0 = m.history[0].t, mins = (t) => (t - d.now) / 60000;
    h += '<div class="card"><h2>Machine</h2><div class="sub">sampled every 5 s while the dashboard runs (up to 2 hours)</div><div class="two">';
    h += '<div><h3>GPU and CPU load</h3>' + lineChart([{ name: 'GPU', color: 'var(--c1)', pts: m.history.map((p) => [mins(p.t), p.gpu]) }, { name: 'CPU', color: 'var(--c2)', pts: m.history.map((p) => [mins(p.t), p.cpu]) }], { yMin: 0, yMax: 100, yFmt: (y) => fmt(y) + '%', xFmt: (x) => fmt(x, 0) + 'm' }) + '</div>';
    h += '<div><h3>GPU memory and temperature</h3>' + lineChart([{ name: 'memory (GB)', color: 'var(--c3)', pts: m.history.map((p) => [mins(p.t), p.mem]) }, { name: 'temperature (°C / 10)', color: 'var(--c5)', pts: m.history.map((p) => [mins(p.t), p.temp == null ? null : p.temp / 10]) }], { yMin: 0, yMax: Math.max(8, L.memTotal || 8), yFmt: (y) => fmt(y, 0), xFmt: (x) => fmt(x, 0) + 'm' }) + '</div>';
    h += '</div></div>';
  }
  $('#app').className = '';
  $('#app').innerHTML = h || '<p class="muted">No run yet.</p>';
}
async function tick() {
  try { render(await (await fetch('api/status?run=' + encodeURIComponent(chosen))).json()); }
  catch (e) { $('#meta').textContent = 'dashboard error: ' + e.message; }
}
tick(); setInterval(tick, 5000);
</script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/status') {
    try {
      const body = JSON.stringify(await status(url.searchParams.get('run') || ''));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e?.stack ?? e));
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(page);
}).listen(port, '127.0.0.1', () => console.log(`Delove dashboard: http://127.0.0.1:${port}  (runs: ${runsDir})`));
