#!/usr/bin/env node
// First: sets this process's search trace file for decision notes before branch.ts loads (notes-trace.ts).
import './notes-trace.js';
import { fork } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HttpRiskApi } from '@risk/mcp';
import { seededRandom } from '@risk/selfplay';
import { newestBaseModel } from './branch-env.js';
import { modelFogInputs, modelsDir } from './net-agent.js';
import { Noter } from './notes.js';
import { ChildPool, SeatPool, type FromChild, type ToChild } from './pool.js';
import { infos, makeAgents } from './seat-agents.js';
import { latencySummary, playEntrant } from './tournament-seat.js';

const USAGE = `delove-pool: the Delove seat pool, a daemon that fills tournaments' Delove seats on request
(docs/tournaments.md "Delove seats on request"; packages/delove/README.md "Seat pool")

  RISK_SEAT_POOL_KEY=... npm run delove-pool -- [--server URL] [--max-seats 40] [--max-search 20] [--procs 6]

  --server URL      game server (default RISK_SERVER_URL or http://localhost:8080)
  --model ID        the network the seats play (default: the newest delove@N in DELOVE_MODELS)
  --max-seats N     seats in play at most (default MAX_SEATS or 40)
  --max-search N    search seats in play at most (default MAX_SEARCH or 20); search only where a request allows it
                    (fog off); 0 = never search
  --preset NAME     the search seats' live preset (default js2-range)
  --procs P         child processes the seats are spread over (default 6)
  --poll-ms MS      how often to poll (default 30000)
  --state FILE      seats in play, kept so a restarted pool plays them on (default ~/.delove-pool/state.json)
  --pace MS         pause after each move (default 300)
  --no-notes        no decision notes on the moves

The key comes only from RISK_SEAT_POOL_KEY (sent in the x-seat-pool-key header; never printed or saved).
SIGTERM or Ctrl-C stops claiming and stops the children; seats in play stay in the state file for the next run.`;

const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

function int(v: string | undefined, name: string, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a whole number`);
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      'max-seats': { type: 'string' },
      'max-search': { type: 'string' },
      preset: { type: 'string' },
      procs: { type: 'string' },
      'poll-ms': { type: 'string' },
      state: { type: 'string' },
      pace: { type: 'string' },
      'no-notes': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(USAGE);
  const key = process.env.RISK_SEAT_POOL_KEY;
  if (!key) fail('RISK_SEAT_POOL_KEY is not set (the server owner gives it; keep it out of files and logs)');
  const server = values.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  const model = values.model ?? newestBaseModel() ?? fail(`no delove@N.onnx in ${modelsDir()} (set DELOVE_MODELS)`);
  const preset = values.preset;
  // fail now, before claiming anything, on a model or preset that does not load
  try {
    makeAgents([model, `${model}+search`], preset);
  } catch (e) {
    fail((e as Error).message);
  }
  const modelFog = modelFogInputs(join(modelsDir(), `${model}.onnx`)) > 0;
  const procs = Math.max(1, int(values.procs, '--procs', 6));
  const pace = int(values.pace, '--pace', 300);
  const self = fileURLToPath(import.meta.url);
  const children = new ChildPool(procs, () => fork(self, ['--pool-child', ...(values['no-notes'] ? ['--no-notes'] : []), ...(preset ? ['--preset', preset] : [])], { stdio: 'inherit' }), server, pace, log);
  const pool = new SeatPool({
    server,
    key,
    model,
    modelFog,
    maxSeats: int(values['max-seats'] ?? process.env.MAX_SEATS, '--max-seats', 40),
    maxSearch: int(values['max-search'] ?? process.env.MAX_SEARCH, '--max-search', 20),
    play: (e) => children.play(e),
    stateFile: values.state ?? join(homedir(), '.delove-pool', 'state.json'),
    log,
  });
  log(`delove-pool: ${server}, ${model}${modelFog ? ' (fog-trained: takes fog seats)' : ' (not fog-trained: leaves fog requests)'}, up to ${pool.free.free} seats (${pool.free.freeSearch} with search), ${procs} processes`);
  pool.resume();
  const pollMs = Math.max(1000, int(values['poll-ms'], '--poll-ms', 30_000));
  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    await pool.tick();
    timer = setTimeout(loop, pollMs);
  };
  const stop = (signal: string) => {
    log(`${signal}: stopping (no new claims; ${pool.seats.length} seat(s) in play stay in the state file)`);
    if (timer) clearTimeout(timer);
    pool.stop();
    children.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await loop();
}

/** A pool child: plays the seats the daemon sends it, one Noter and one set of players for all of them. */
function child() {
  const argv = process.argv;
  const preset = argv.includes('--preset') ? argv[argv.indexOf('--preset') + 1] : undefined;
  const notes = argv.includes('--no-notes') ? null : new Noter(infos);
  const agents = new Map<string, ReturnType<typeof makeAgents>[number]>();
  const decisions: number[] = [];
  const t0 = performance.now();
  const timer = setInterval(() => {
    const l = latencySummary(decisions);
    log(`pool child ${process.pid}: ${l.decisions} decisions, ms p50 ${l.p50} p90 ${l.p90} max ${l.max}; ${Math.round((performance.now() - t0) / 60000)} min`);
  }, 5 * 60_000);
  timer.unref();
  let n = 0;
  process.on('message', (m) => {
    const msg = m as ToChild;
    if (msg.type !== 'play') return;
    const e = msg.entrant;
    const k = `${e.tournamentId}/${e.name}`;
    let agent = agents.get(e.agentId);
    if (!agent) {
      try {
        agent = makeAgents([e.agentId], preset)[0];
      } catch (err) {
        process.send!({ type: 'error', key: k, message: (err as Error).message } satisfies FromChild);
        return;
      }
      agents.set(e.agentId, agent);
    }
    playEntrant({ api: new HttpRiskApi(msg.server), tournamentId: e.tournamentId, entrantToken: e.token, name: e.name, agent, paceMs: msg.pace, log, notes,
      random: seededRandom((Date.now() + 7919 * n++) >>> 0), onDecision: (ms) => decisions.push(ms) })
      .then((result) => process.send!({ type: 'end', key: k, result } satisfies FromChild))
      .catch((err) => process.send!({ type: 'error', key: k, message: (err as Error).message } satisfies FromChild));
  });
  process.once('SIGTERM', () => process.exit(0));
}

if (process.argv.includes('--pool-child')) child();
else
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
