#!/usr/bin/env node
/**
 * A whole nested ("Inception") tournament without the website: plan, boards, every table played by server bots, the
 * 51% round ends (people's tables only, after 3 full rounds; all-bot rounds count every table), tables decided on standing, winners on their portals, the champion. Reads the built server and engine
 * (run `npm run build` first); never selfplay or Delove. Nothing is written to the repo.
 *
 * Headless (default): one process, no network, a fake clock that jumps to a round's deadline when no table can move,
 * and the bots driven step by step (round-robin over the tables). With the same --seed the run is the same: the same
 * plan, boards, tables, standings and champion (Math.random is replaced by a seeded generator for the run).
 *
 *   npm run nested:sim -- --seats 100 [--seed 7] [--final world] [--tps 5] [--runs 2]
 *
 * Live (--live): a real server on 127.0.0.1 (port 0) with real timers, bots at --delay ms per move, and --spectators
 * fake WebSocket spectators on every table. It reports event-loop lag (p50/p99/max), commits/s, spectator messages/s,
 * snapshot save time and heap every 10 s, for --minutes, then exits. This is the load check before a live 100-seat run.
 *
 *   npm run nested:sim -- --live --seats 100 --delay 300 --spectators 20 --minutes 3
 *
 * Seats are server bots for now: the 20-Delove + 80-Zerg event seats Zerg entrants once those land (#182), and Delove
 * joins from the training PC over /api.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const seats = Number(opt('seats', 100));
const seed = Number(opt('seed', 7));
const finalMap = opt('final', undefined);
const tps = Number(opt('tps', 5));
const live = flag('live');

/** mulberry32: the run's Math.random, so game seeds and bot choices repeat with --seed. */
function seededRandom(s) {
  let state = s >>> 0;
  return () => {
    let t = (state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const load = (p) => import(pathToFileURL(join(root, p)).href);
const { Store } = await load('packages/server/dist/store.js');

/** Entrants: "Delove n" stand-ins (a fifth) and "Zerg n" (the rest), all server bots for now. */
function addEntrants(t) {
  const delove = Math.round(seats / 5);
  for (let i = 1; i <= seats; i++) t.entrants.push({ id: `e_sim${i}`, name: i <= delove ? `Delove ${i}` : `Zerg ${i - delove}`, isBot: true, joinedAt: 0 });
}

const spec = (extra) => ({ format: 'nested', name: 'Nested sim', seed, territoriesPerSeat: tps, ...(finalMap ? { finalMap } : {}), options: { autoSetup: true, turnTimer: 'off' }, ...extra });

function planLine(t) {
  return t.nested.plan.rounds.map((r) => {
    const sizes = new Map();
    for (const x of r) sizes.set(x.seats, (sizes.get(x.seats) ?? 0) + 1);
    return [...sizes].sort((a, b) => b[0] - a[0]).map(([s, n]) => `${n}x${s}`).join('+');
  }).join(' > ');
}

// ---------------------------------------------------------------------------------------------------------------------
// headless

class FakeClock {
  t = 1_700_000_000_000;
  timers = [];
  now = () => this.t;
  setTimeout = (fn, ms) => {
    const h = { at: this.t + ms, fn };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  /** Jump to the next timer and fire it. */
  next() {
    const h = this.timers.sort((a, b) => a.at - b.at)[0];
    if (!h) return false;
    this.t = Math.max(this.t, h.at);
    this.timers = this.timers.filter((x) => x !== h);
    h.fn();
    return true;
  }
}

function headless(run) {
  const realRandom = Math.random;
  Math.random = seededRandom(seed);
  const clock = new FakeClock();
  const store = new Store(null, {}, { clock });
  const started = Date.now();
  try {
    // Bots never move by their own timer here (the loop below moves them); 2 s is the longest pace allowed.
    const t = store.tournaments.create(spec({ botDelayMs: 2000 }));
    addEntrants(t);
    store.tournaments.start(t.id);
    const name = (eid) => t.entrants.find((e) => e.id === eid)?.name ?? '?';
    if (run === 1) console.log(`plan for ${seats} seats: ${planLine(t)} (${t.nested.plan.zergs} bots added), seed ${seed}`);
    const steps = new Map();
    const STEP_CAP = 400_000;
    let roundSteps = 0;
    let roundAt = t.rounds.length;
    while (t.status === 'running') {
      if (t.rounds.length !== roundAt) {
        roundAt = t.rounds.length;
        roundSteps = 0;
      }
      let moved = false;
      for (const m of t.rounds.at(-1).matches) {
        if (m.status !== 'playing') continue;
        const room = store.get(m.gameId);
        if (room?.stepBot()) {
          moved = true;
          roundSteps++;
          steps.set(m.gameId, (steps.get(m.gameId) ?? 0) + 1);
        }
        if (t.rounds.length !== roundAt || t.status !== 'running') break;
      }
      // Nobody can move (or a table loops forever): the clock runs to the round's deadline.
      if ((!moved || roundSteps > STEP_CAP) && t.status === 'running' && !clock.next()) throw new Error('stuck: no move and no deadline');
    }
    const wall = Date.now() - started;
    const rounds = t.rounds.map((r) => ({
      round: r.round,
      tables: r.matches.length,
      finished: r.matches.filter((m) => m.status === 'finished').length,
      decided: r.matches.filter((m) => m.status === 'decided').length,
      byes: r.matches.filter((m) => m.status === 'bye').length,
      steps: r.matches.map((m) => steps.get(m.gameId) ?? 0),
      by: r.endedAt >= r.deadline ? 'its deadline' : `the ${Math.round(t.nested.finishShare * 100)}% rule`,
    }));
    const bracket = t.rounds.map((r) => r.matches.map((m) => ({ map: m.map, seats: m.entrants.map(name), status: m.status, winner: m.winner && name(m.winner), standing: m.standing?.order.map(name) })));
    const digest = createHash('sha256').update(JSON.stringify({ bracket, champion: name(t.champion) })).digest('hex').slice(0, 16);
    return { wall, rounds, champion: name(t.champion), digest, totalSteps: [...steps.values()].reduce((a, b) => a + b, 0) };
  } finally {
    store.stopTimers();
    Math.random = realRandom;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// live

async function liveRun() {
  const { createRiskServer } = await load('packages/server/dist/app.js');
  const dir = mkdtempSync(join(tmpdir(), 'risk-nested-sim-'));
  const store = new Store(join(dir, 'games.json'));
  // Snapshot cost: time every whole-store save.
  const saves = [];
  const save = store.save.bind(store);
  store.save = () => {
    const t0 = performance.now();
    save();
    saves.push(performance.now() - t0);
  };
  let commits = 0;
  const createTable = store.createTable.bind(store);
  store.createTable = (...a) => {
    const out = createTable(...a);
    out.room.on('commit', () => commits++);
    return out;
  };
  const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
  try {
    await liveTournament(store, risk, () => commits, saves);
  } finally {
    // The temp data dir goes even when the run fails.
    await risk.shutdown('sim').catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function liveTournament(store, risk, commitCount, saves) {
  const { WebSocket } = await import('ws');
  const delay = Number(opt('delay', 300));
  const spectators = Number(opt('spectators', 20));
  const minutes = Number(opt('minutes', 3));
  await new Promise((r) => risk.server.listen(0, '127.0.0.1', r));
  const port = risk.server.address().port;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();

  const t = store.tournaments.create(spec({ botDelayMs: delay, roundMinutes: Number(opt('round-minutes', 30)) }));
  addEntrants(t);
  store.tournaments.start(t.id);
  console.log(`live: ${seats} seats, plan ${planLine(t)}, bots every ${delay} ms, ${spectators} spectators per table, ${minutes} min, port ${port}`);

  const sockets = new Map();
  let messages = 0;
  let bytes = 0;
  const watch = () => {
    for (const m of t.rounds.at(-1)?.matches ?? []) {
      if (m.status !== 'playing' || sockets.has(m.gameId)) continue;
      const list = [];
      for (let i = 0; i < spectators; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: m.gameId })));
        ws.on('message', (data) => {
          messages++;
          bytes += data.length;
        });
        ws.on('error', () => {});
        list.push(ws);
      }
      sockets.set(m.gameId, list);
    }
  };
  watch();
  const started = Date.now();
  let last = { at: started, commits: 0, messages: 0, saves: 0 };
  const rows = [];
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      watch();
      const now = Date.now();
      const secs = (now - last.at) / 1000;
      const newSaves = saves.slice(last.saves);
      const row = {
        at: Math.round((now - started) / 1000),
        round: t.rounds.length,
        playing: t.rounds.at(-1).matches.filter((m) => m.status === 'playing').length,
        commitsPerSec: Math.round((commitCount() - last.commits) / secs),
        msgsPerSec: Math.round((messages - last.messages) / secs),
        lagP50: +(lag.percentile(50) / 1e6).toFixed(1),
        lagP99: +(lag.percentile(99) / 1e6).toFixed(1),
        lagMax: +(lag.max / 1e6).toFixed(1),
        saveAvg: newSaves.length ? +(newSaves.reduce((a, b) => a + b, 0) / newSaves.length).toFixed(1) : 0,
        saveMax: newSaves.length ? +Math.max(...newSaves).toFixed(1) : 0,
        heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      lag.reset();
      last = { at: now, commits: commitCount(), messages, saves: saves.length };
      if (now - started >= minutes * 60_000 || t.status === 'finished') {
        clearInterval(tick);
        resolve();
      }
    }, 10_000);
  });
  for (const list of sockets.values()) for (const ws of list) ws.terminate();
  const busy = rows.filter((r) => r.playing > 0);
  const max = (k) => (busy.length ? Math.max(...busy.map((r) => r[k])) : 0);
  console.log(
    `summary: ${busy.length} samples with tables playing; commits/s max ${max('commitsPerSec')}, spectator msgs/s max ${max('msgsPerSec')} (${(bytes / 2 ** 20).toFixed(0)} MB sent), ` +
      `loop lag p99 max ${max('lagP99')} ms (worst ${max('lagMax')} ms), save max ${max('saveMax')} ms, heap max ${max('heapMB')} MB; tournament ${t.status}${t.champion ? `, champion ${t.entrants.find((e) => e.id === t.champion)?.name}` : ''}`,
  );
}

if (live) {
  await liveRun();
} else {
  const runs = Number(opt('runs', 1));
  const results = [];
  for (let run = 1; run <= runs; run++) {
    const r = headless(run);
    results.push(r);
    for (const x of r.rounds)
      console.log(`round ${x.round}: ${x.tables} tables, ${x.finished} finished, ${x.decided} decided on standing, ${x.byes} byes, ended by ${x.by}; bot moves per table ${Math.min(...x.steps)}-${Math.max(...x.steps)}`);
    console.log(`run ${run}: champion ${r.champion}, ${r.totalSteps} bot moves, ${(r.wall / 1000).toFixed(1)} s wall, bracket digest ${r.digest}`);
  }
  if (runs > 1) {
    const same = results.every((r) => r.digest === results[0].digest);
    console.log(same ? 'deterministic: every run gave the same bracket and champion' : 'NOT deterministic: the runs differ');
    if (!same) process.exitCode = 1;
  }
}
