#!/usr/bin/env node
// First: sets this process's search trace file for decision notes before branch.ts loads (notes-trace.ts).
import './notes-trace.js';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { GameOptions } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
import { seededRandom, type Agent } from '@risk/selfplay';
import { Noter } from './notes.js';
import { infos, labels, makeAgents } from './seat-agents.js';
import { defaultName, playSeat } from './seat.js';
import { latencySummary, playEntrant, type EntrantResult } from './tournament-seat.js';

const USAGE = `delove-seat: seat Delove players in a real game over the HTTP API (no chat, no character)

  npm run delove-seat -- --join CODE [--agents delove-branch,delove@8]
  npm run delove-seat -- --create [--agents delove-branch,delove-teacher@1] [--bots 2] [--options '{"map":"classic"}'] [--no-start]
  npm run delove-seat -- --tournament CODE --entrants 20 [--procs 6] [--agents delove-branch] [--names ...] [--tokens FILE]

  --server URL     game server (default RISK_SERVER_URL or http://localhost:8080)
  --agents IDS     Delove versions, one seat each (default delove-branch: Delove with search at
                   play time, below): delove-teacher@1, every tuned
                   teacher models/delove/delove-teacher@N.json and every models/delove/delove@N.onnx
                   (or DELOVE_MODELS); sensei, sensei@1 and sensei@2 name the teachers;
                   jacob-sensei@1 (or jacob, sensei@3) is Jacob Sensei, jacob-sensei@2 (or jacob2) Jacob
                   Sensei 2; delove-branch@1 (or delove-branch) is Delove with
                   search at play time (branch and score): the newest delove@N ranks the moves, set
                   by --preset (below); any DELOVE_BRANCH_* variable overrides one setting, e.g.
                   DELOVE_BRANCH_RANKER=delove@6 (packages/delove/README.md).
                   The bare network (no search) is its own id: --agents delove@8; <model>+search
                   (e.g. delove@10+search) searches with that network ranking the moves
  --preset NAME    live search preset for delove-branch: js2-range (default: Jacob Sensei 2 rollouts,
                   5 options, range score, horizon 2, margin 0.02) or measured (Jacob Sensei 1,
                   share score, horizon 1, margin 0.01; about 4x faster)
  --names NAMES    seat names, same order (default "Delove 1", "Sensei 1", "Sensei 2", ...)
  --join CODE      join a game someone created; the host starts it
  --create         create a game (the first seat hosts), add --bots built-in bots, start it (unless --no-start)
  --pace MS        pause after each move so spectators can follow (default 400)
  --no-notes       send moves without decision notes (default: each move carries a short private note on what
                   Delove saw in it, kept on the game record; packages/delove/README.md "Decision notes")

Tournaments (docs/tournaments.md; join while it is registering, the host starts it):
  --tournament CODE  join it with --entrants N entrants ("Delove 1" ... "Delove N", or --names), the agents of
                   --agents in turn; each entrant waits for its table, plays it, waits for the next, until it is
                   out or the tournament is over
  --procs P        child processes the entrants are spread over (default min(6, N)): one process thinks for its
                   seats one after another, so P is how many decisions are made at once
  --tokens FILE    keep the entrant tokens here: a restarted runner reuses them instead of joining again

Fog of war: only Delove networks trained for it (fog inputs: train.py --fog-dropout, "fogInputs" in the model's
.json) take fog seats, playing on what their seat can see; other versions sit fog games out.`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: 'string' },
      agents: { type: 'string' },
      preset: { type: 'string' },
      names: { type: 'string' },
      join: { type: 'string' },
      create: { type: 'boolean' },
      bots: { type: 'string' },
      options: { type: 'string' },
      'no-start': { type: 'boolean' },
      'no-notes': { type: 'boolean' },
      pace: { type: 'string' },
      tournament: { type: 'string' },
      entrants: { type: 'string' },
      procs: { type: 'string' },
      tokens: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(USAGE);
  if ([values.join, values.create, values.tournament].filter(Boolean).length !== 1) fail('give exactly one of --join CODE, --create or --tournament CODE');
  if (values.tournament) return tournament(values);
  const ids = (values.agents ?? 'delove-branch').split(',').map((s) => s.trim()).filter(Boolean);
  const agents = buildAgents(ids, values.preset);
  const names = values.names ? values.names.split(',').map((s) => s.trim()) : ids.map(defaultName);
  if (names.length !== agents.length) fail('--names needs one name per agent');
  const pace = paceOf(values.pace);
  let options: Partial<GameOptions> | undefined;
  try {
    options = values.options ? JSON.parse(values.options) : undefined;
  } catch {
    fail('--options must be JSON');
  }
  const blind = ids.filter((_, i) => !agents[i].fogInputs);
  if (options?.fogOfWar && blind.length) fail(`fog of war: ${blind.join(', ')} not trained for fog (only networks with fog inputs play fog games)`);

  const server = values.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  const api = new HttpRiskApi(server);

  const seats: { gameId: string; playerId: string; token: string; name: string; agent: Agent }[] = [];
  let gameId = values.join?.trim().toUpperCase() ?? '';
  for (let i = 0; i < agents.length; i++) {
    // The seat's player type, for spectators only (players never see it): the Delove version it plays.
    const label = labels.get(agents[i]) ?? agents[i].id;
    const r = !gameId ? await api.createGame(names[i], 'Delove test game', options, undefined, undefined, label) : await api.joinGame(gameId, names[i], label);
    gameId = r.gameId;
    seats.push({ gameId, playerId: r.playerId, token: r.token, name: names[i], agent: agents[i] });
    log(`${names[i]} (${agents[i].id}) sits in game ${gameId}`);
  }

  if (values.create) {
    const host = seats[0];
    const bots = values.bots === undefined ? 0 : Number(values.bots);
    if (!Number.isInteger(bots) || bots < 0) fail('--bots must be a whole number');
    for (let i = 0; i < bots; i++) await api.addBot(gameId, host.token);
    if (seats.length + bots < 2) log('only one seat: add --bots, or have people join before starting');
    log(`spectate: ${server.replace(/\/+$/, '')}/?game=${gameId}   (code ${gameId})`);
    if (!values['no-start'] && seats.length + bots >= 2) {
      await api.start(gameId, host.token);
      log('game started');
    } else {
      log('waiting for the host to start the game');
    }
  } else {
    log('waiting for the host to start the game');
  }

  const notes = values['no-notes'] ? null : new Noter(infos);
  const finals = await Promise.all(seats.map((s) => playSeat({ api, ...s, paceMs: pace, log, notes })));
  const last = finals.find((v) => v?.phase === 'finished') ?? finals[0];
  if (last?.phase === 'finished') {
    const winner = last.players.find((p) => p.id === last.winner);
    log(`game over: ${winner ? winner.name : 'no winner'} wins after ${last.turnNumber} turns`);
  }
  process.exit(0);
}

const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

function paceOf(v: string | undefined): number {
  const pace = v === undefined ? 400 : Number(v);
  if (!Number.isFinite(pace) || pace < 0) fail('--pace must be a number of milliseconds');
  return pace;
}

/** The players for these ids (seat-agents.ts); a bad id ends the command with its message. */
function buildAgents(ids: string[], presetName: string | undefined): Agent[] {
  try {
    return makeAgents(ids, presetName);
  } catch (e) {
    fail((e as Error).message);
  }
}

interface Entrant {
  name: string;
  token: string;
  agentId: string;
}

/** A child process's job: its entrants (tokens included), sent over IPC, never on the command line. */
interface ChildJob {
  server: string;
  tournamentId: string;
  entrants: Entrant[];
  preset?: string;
  pace: number;
  /** Decision notes on (no --no-notes). */
  notes: boolean;
}

interface ChildReport {
  pid: number;
  results: EntrantResult[];
  decisionsMs: number[];
  cpuMs: number;
  wallMs: number;
}

/** --tournament: join the entrants (or reuse --tokens), spread them over --procs child processes, report latency. */
async function tournament(values: Record<string, string | boolean | undefined>): Promise<void> {
  const id = String(values.tournament).trim().toUpperCase();
  const server = (values.server as string | undefined) ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  const api = new HttpRiskApi(server);
  const n = Number(values.entrants ?? 1);
  if (!Number.isInteger(n) || n < 1) fail('--entrants must be a whole number of at least 1');
  const ids = String(values.agents ?? 'delove-branch').split(',').map((s) => s.trim()).filter(Boolean);
  const names = values.names ? String(values.names).split(',').map((s) => s.trim()) : Array.from({ length: n }, (_, i) => `Delove ${i + 1}`);
  if (names.length !== n) fail('--names needs one name per entrant');
  const built = buildAgents(ids, values.preset as string | undefined); // fails now on an unknown id, before anyone joins
  const procs = values.procs === undefined ? Math.min(6, n) : Number(values.procs);
  if (!Number.isInteger(procs) || procs < 1) fail('--procs must be a whole number of at least 1');
  const pace = paceOf(values.pace as string | undefined);

  const tokensFile = values.tokens as string | undefined;
  let entrants: Entrant[] = tokensFile && existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, 'utf8')).entrants : [];
  if (entrants.length) log(`reusing ${entrants.length} entrants from ${tokensFile}`);
  else {
    for (let i = 0; i < n; i++) {
      const agent = built[i % ids.length];
      const r = await api.joinTournament(id, names[i], labels.get(agent) ?? agent.id);
      entrants.push({ name: names[i], token: r.token, agentId: ids[i % ids.length] });
      log(`${names[i]} (${ids[i % ids.length]}) joined tournament ${id}`);
    }
    if (tokensFile) writeFileSync(tokensFile, JSON.stringify({ tournament: id, entrants }, null, 1));
  }
  log(`watch: ${server.replace(/\/+$/, '')}/?tournament=${id}; ${entrants.length} entrants over ${Math.min(procs, entrants.length)} processes`);

  const groups = Array.from({ length: Math.min(procs, entrants.length) }, (_, k) => entrants.filter((_, i) => i % procs === k));
  const self = fileURLToPath(import.meta.url);
  const reports = await Promise.all(
    groups.map(
      (group) =>
        new Promise<ChildReport | null>((resolve) => {
          const child = fork(self, ['--child', ...(values['no-notes'] ? ['--no-notes'] : [])], { stdio: 'inherit' });
          let report: ChildReport | null = null;
          child.on('message', (m) => (report = m as ChildReport));
          child.on('exit', (code) => {
            if (code) log(`process ${child.pid} exited with ${code}`);
            resolve(report);
          });
          const job: ChildJob = { server, tournamentId: id, entrants: group, preset: values.preset as string | undefined, pace, notes: !values['no-notes'] };
          child.send(job);
        }),
    ),
  );
  const all: number[] = [];
  for (const r of reports) {
    if (!r) continue;
    all.push(...r.decisionsMs);
    const l = latencySummary(r.decisionsMs);
    log(`process ${r.pid}: ${r.results.map((e) => `${e.name} ${e.status} (${e.tables} tables)`).join(', ')}; ${l.decisions} decisions, ms p50 ${l.p50} p90 ${l.p90} max ${l.max}; CPU ${(r.cpuMs / 1000).toFixed(0)} s in ${(r.wallMs / 1000).toFixed(0)} s (${Math.round((100 * r.cpuMs) / Math.max(1, r.wallMs))}%)`);
  }
  const l = latencySummary(all);
  log(`all: ${l.decisions} decisions, ms p50 ${l.p50} p90 ${l.p90} max ${l.max}`);
  process.exit(0);
}

/** A child process: build the agents once, play every entrant of the job at once, send the report back. */
async function child(): Promise<void> {
  const job = await new Promise<ChildJob>((resolve) => process.once('message', (m) => resolve(m as ChildJob)));
  const api = new HttpRiskApi(job.server);
  const ids = [...new Set(job.entrants.map((e) => e.agentId))];
  const agents = new Map(buildAgents(ids, job.preset).map((a, i) => [ids[i], a]));
  const notes = job.notes ? new Noter(infos) : null;
  const decisionsMs: number[] = [];
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  // Every minute, how this process keeps up so far (a run stopped early still tells it; live, an operator sees it).
  const every = Number(process.env.DELOVE_SEAT_REPORT_MS ?? 60_000);
  const timer = setInterval(() => {
    const l = latencySummary(decisionsMs);
    const c = process.cpuUsage(cpu0);
    log(`process ${process.pid} so far: ${l.decisions} decisions, ms p50 ${l.p50} p90 ${l.p90} max ${l.max}; CPU ${Math.round((100 * (c.user + c.system)) / 1000 / Math.max(1, performance.now() - t0))}%`);
  }, every);
  timer.unref();
  const results = await Promise.all(
    job.entrants.map((e, i) =>
      playEntrant({ api, tournamentId: job.tournamentId, entrantToken: e.token, name: e.name, agent: agents.get(e.agentId)!, paceMs: job.pace, log,
        random: seededRandom((Date.now() + i * 7919) >>> 0), onDecision: (ms) => decisionsMs.push(ms), notes }),
    ),
  );
  clearInterval(timer);
  const cpu = process.cpuUsage(cpu0);
  const report: ChildReport = { pid: process.pid, results, decisionsMs, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - t0 };
  process.send!(report, () => process.exit(0));
}

// A child process (forked by --tournament) gets its job over IPC; otherwise this is the command itself.
(process.argv.includes('--child') ? child() : main()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
