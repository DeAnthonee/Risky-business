#!/usr/bin/env node
// Load test for a 100-seat mega table (owner's request 2026-10-28: "make the mega run much faster").
//
// Starts a real server on 127.0.0.1 (port 0, temp data dir), creates a `mega` tournament with --seats outside entrants
// (labelled like the house roster) and starts it. A child process then plays every seat over HTTP the way the Delove
// pool does (packages/delove/src/seat.ts playSeat): GET /wait with `since`, act on its turn with the fresh state each
// move returns, a --pace pause after each move. The moves come from the engine's built-in bot on the seat's view, so
// the seats cost almost nothing to "think" and what is measured is the server. --spectators WebSockets watch the table.
//
// Every --sample seconds it prints a JSON row; at the end a summary (and --out FILE writes all of it as JSON):
//   movesPerSec, msPerMove (wall clock between commits), lagP50/P99/max (the server's event loop), sent MB per move
//   (HTTP responses + WebSocket frames), KB per move each spectator receives, save ms, heap.
//
//   npm run build && node scripts/mega-load.mjs --minutes 3 --seats 100 --spectators 3 --out /tmp/x.json
//   --frames delta: the spectators ask for compact frames (server spectator-delta.ts), as the web client does
//   node --cpu-prof --cpu-prof-dir DIR scripts/mega-load.mjs ...   (profiles the server process; the seats run apart)
//
// Never point it at a real server: it starts its own.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(join(root, p)).href);
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

if (args.includes('--seat-child')) await seatChild();
else await main();

async function main() {
  const seats = Number(opt('seats', 100));
  const minutes = Number(opt('minutes', 3));
  const spectators = Number(opt('spectators', 3));
  const pace = Number(opt('pace', 300));
  const sampleSecs = Number(opt('sample', 10));
  const out = opt('out', null);
  const frames = opt('frames', null);

  const { Store } = await load('packages/server/dist/store.js');
  const { createRiskServer } = await load('packages/server/dist/app.js');
  const { WebSocket } = await import('ws');
  const dir = mkdtempSync(join(tmpdir(), 'risk-mega-load-'));
  const store = new Store(join(dir, 'games.json'));
  const saves = [];
  const save = store.save.bind(store);
  store.save = () => {
    const t0 = performance.now();
    save();
    saves.push(performance.now() - t0);
  };
  const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
  await new Promise((r) => risk.server.listen(0, '127.0.0.1', r));
  const port = risk.server.address().port;

  // Bytes the server writes: every HTTP response and WebSocket frame passes through a socket.
  let sent = 0;
  risk.server.on('connection', (sock) => {
    const write = sock.write.bind(sock);
    sock.write = (chunk, ...rest) => {
      sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      return write(chunk, ...rest);
    };
  });

  const t = store.tournaments.create({ format: 'nested', style: 'mega', name: 'Mega load test' });
  const tokens = [];
  for (let i = 1; i <= seats; i++) tokens.push(store.tournaments.join(t.id, `Seat ${i}`, 'AI agent'));
  store.tournaments.start(t.id);
  const match = t.rounds[0].matches[0];
  const room = store.get(match.gameId);
  let commits = 0;
  room.on('commit', () => commits++);
  const seatList = tokens.map((e) => ({ gameId: match.gameId, ...match.seats[e.entrantId] }));
  console.log(`mega load: ${seats} seats on ${room.state.options.map}, ${spectators} spectators${frames ? ` (${frames} frames)` : ''}, pace ${pace} ms, ${minutes} min, port ${port}, build ${process.env.MEGA_LOAD_LABEL ?? ''}`);

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const sockets = [];
  let spectatorBytes = 0;
  for (let i = 0; i < spectators; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: match.gameId, ...(frames ? { frames } : {}) })));
    ws.on('message', (data) => (spectatorBytes += data.length));
    ws.on('error', () => {});
    sockets.push(ws);
  }
  const child = fork(fileURLToPath(import.meta.url), ['--seat-child'], { stdio: 'inherit', execArgv: [] });
  child.send({ port, pace, seats: seatList });

  const started = Date.now();
  const rows = [];
  let last = { at: started, commits: 0, sent: 0, spectatorBytes: 0, saves: 0, cpu: process.cpuUsage() };
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now();
      const secs = (now - last.at) / 1000;
      const moves = commits - last.commits;
      const cpu = process.cpuUsage(last.cpu);
      const newSaves = saves.slice(last.saves);
      const row = {
        at: Math.round((now - started) / 1000),
        version: room.state.version,
        turn: room.state.turnNumber,
        movesPerSec: +(moves / secs).toFixed(2),
        msPerMove: moves ? Math.round((secs * 1000) / moves) : null,
        lagP50: +(lag.percentile(50) / 1e6).toFixed(1),
        lagP99: +(lag.percentile(99) / 1e6).toFixed(1),
        lagMax: +(lag.max / 1e6).toFixed(1),
        cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / (secs * 1000)) * 100),
        mbPerMove: moves ? +((sent - last.sent) / moves / 2 ** 20).toFixed(2) : null,
        spectatorKBPerMove: moves && spectators ? +((spectatorBytes - last.spectatorBytes) / spectators / moves / 1024).toFixed(1) : null,
        saveAvgMs: newSaves.length ? +(newSaves.reduce((a, b) => a + b, 0) / newSaves.length).toFixed(1) : 0,
        heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      lag.reset();
      last = { at: now, commits, sent, spectatorBytes, saves: saves.length, cpu: process.cpuUsage() };
      if (now - started >= minutes * 60_000 || room.state.phase === 'finished') {
        clearInterval(tick);
        resolve();
      }
    }, sampleSecs * 1000);
  });
  child.kill();
  for (const ws of sockets) ws.terminate();
  // The first sample includes the start; the summary leaves it out when there are others.
  const steady = rows.length > 2 ? rows.slice(1) : rows;
  const avg = (k) => +(steady.reduce((a, r) => a + (r[k] ?? 0), 0) / steady.length).toFixed(2);
  const elapsed = (Date.now() - started) / 1000;
  const summary = {
    label: process.env.MEGA_LOAD_LABEL ?? null,
    seats,
    spectators,
    pace,
    seconds: Math.round(elapsed),
    moves: commits,
    turns: room.state.turnNumber,
    movesPerSec: +(commits / elapsed).toFixed(2),
    msPerMove: commits ? Math.round((elapsed * 1000) / commits) : null,
    secondsPerTurn: room.state.turnNumber > 1 ? +(elapsed / (room.state.turnNumber - 1)).toFixed(1) : null,
    lagP99: avg('lagP99'),
    lagMax: Math.max(...steady.map((r) => r.lagMax)),
    cpuPct: avg('cpuPct'),
    mbPerMove: avg('mbPerMove'),
    spectatorKBPerMove: avg('spectatorKBPerMove'),
    saveAvgMs: avg('saveAvgMs'),
    heapMB: Math.max(...steady.map((r) => r.heapMB)),
  };
  console.log(`summary: ${JSON.stringify(summary)}`);
  if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  await risk.shutdown('load test').catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// ---- the seats (a child process, so their work never shows in the server's numbers) ----

async function seatChild() {
  const { chooseBotAction } = await load('packages/engine/dist/index.js');
  const { port, pace, seats } = await new Promise((r) => process.once('message', r));
  const base = `http://127.0.0.1:${port}/api/games`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (url, token, body) => {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? res.status);
    return json;
  };
  // playSeat (packages/delove/src/seat.ts), with the built-in bot choosing.
  const play = async ({ gameId, playerId, token }) => {
    let since;
    for (;;) {
      let w;
      const started = Date.now();
      try {
        w = await call(`${base}/${gameId}/wait?timeoutMs=25000${since !== undefined ? `&since=${since}` : ''}`, token);
      } catch {
        await sleep(1000);
        continue;
      }
      let view = w.state;
      const unchanged = since !== undefined && view.version === since;
      since = view.version;
      if (view.phase === 'finished') return;
      const me = view.players.find((p) => p.id === playerId);
      if (me && !me.alive) return;
      if (!w.yourTurn) {
        if (unchanged && Date.now() - started < 1000) await sleep(1000);
        continue;
      }
      while (view.phase !== 'finished' && view.currentPlayer === playerId) {
        let action;
        try {
          action = chooseBotAction(view, playerId) ?? { type: 'end_turn' };
        } catch {
          action = { type: 'end_turn' };
        }
        try {
          view = (await call(`${base}/${gameId}/actions`, token, action)).state;
          since = view.version;
        } catch {
          await sleep(1000);
          break;
        }
        if (pace > 0) await sleep(pace);
      }
    }
  };
  await Promise.all(seats.map(play));
}
