#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { GameOptions } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
import type { Agent } from '@risk/selfplay';
import { branchFromEnv, LIVE_BRANCH_DEFAULT_PRESET, LIVE_BRANCH_PRESETS, liveBranchEnv, type LiveBranchPresetName } from './branch-env.js';
import { discoverNetAgents } from './net-agent.js';
import { defaultName, discoverTunedTeachers, playSeat } from './seat.js';
import { jacob, jacob2 } from './jacob.js';
import { teacher } from './teacher.js';

const USAGE = `delove-seat: seat Delove players in a real game over the HTTP API (no chat, no character)

  npm run delove-seat -- --join CODE [--agents delove-branch,delove@8]
  npm run delove-seat -- --create [--agents delove-branch,delove-teacher@1] [--bots 2] [--options '{"map":"classic"}'] [--no-start]

  --server URL     game server (default RISK_SERVER_URL or http://localhost:8080)
  --agents IDS     Delove versions, one seat each (default delove-branch: Delove with search at
                   play time, below): delove-teacher@1, every tuned
                   teacher models/delove/delove-teacher@N.json and every models/delove/delove@N.onnx
                   (or DELOVE_MODELS); sensei, sensei@1 and sensei@2 name the teachers;
                   jacob-sensei@1 (or jacob) is Jacob Sensei, jacob-sensei@2 (or jacob2) Jacob
                   Sensei 2; delove-branch@1 (or delove-branch) is Delove with
                   search at play time (branch and score): the newest delove@N ranks the moves, set
                   by --preset (below); any DELOVE_BRANCH_* variable overrides one setting, e.g.
                   DELOVE_BRANCH_RANKER=delove@6 (packages/delove/README.md).
                   The bare network (no search) is its own id: --agents delove@8
  --preset NAME    live search preset for delove-branch: js2-range (default: Jacob Sensei 2 rollouts,
                   5 options, range score, horizon 2, margin 0.02) or measured (Jacob Sensei 1,
                   share score, horizon 1, margin 0.01; about 4x faster)
  --names NAMES    seat names, same order (default "Delove 1", "Sensei 1", "Sensei 2", ...)
  --join CODE      join a game someone created; the host starts it
  --create         create a game (the first seat hosts), add --bots built-in bots, start it (unless --no-start)
  --pace MS        pause after each move so spectators can follow (default 400)

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
      pace: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return console.log(USAGE);
  if (!values.join === !values.create) fail('give exactly one of --join CODE or --create');

  const tuned = discoverTunedTeachers();
  const allAgents = [teacher, ...tuned, jacob, jacob2, ...discoverNetAgents()];
  const known = new Map<string, Agent>(
    allAgents.flatMap((a) => {
      const entries: [string, Agent][] = [[a.id, a]];
      if (a.id === 'delove-teacher@1') entries.push(['sensei@1', a], ['sensei', a]);
      if (a.id === 'delove-teacher@2') entries.push(['sensei@2', a]);
      if (a.id === jacob.id) entries.push(['jacob', a]);
      if (a.id === jacob2.id) entries.push(['jacob2', a]);
      return entries;
    }),
  );
  const ids = (values.agents ?? 'delove-branch').split(',').map((s) => s.trim()).filter(Boolean);
  // Branch and score loads its ranker network, so it is only built when a seat asks for it.
  if (ids.some((id) => id === 'delove-branch' || id === 'delove-branch@1')) {
    const preset = (values.preset ?? LIVE_BRANCH_DEFAULT_PRESET) as LiveBranchPresetName;
    if (!(preset in LIVE_BRANCH_PRESETS)) fail(`--preset must be one of ${Object.keys(LIVE_BRANCH_PRESETS).join(', ')}`);
    const env = liveBranchEnv(undefined, process.env, preset);
    const branch = branchFromEnv(undefined, env);
    console.log(`delove-branch (${preset}): ranker ${env.DELOVE_BRANCH_RANKER ?? 'none'}, rollouts by ${env.DELOVE_BRANCH_TEACHER}, ${env.DELOVE_BRANCH_OPTIONS} options, ${env.DELOVE_BRANCH_SCORE} score, horizon ${env.DELOVE_BRANCH_HORIZON}, margin ${env.DELOVE_BRANCH_MARGIN}`);
    known.set(branch.id, branch).set('delove-branch', branch);
  }
  const agents = ids.map((id) => known.get(id) ?? fail(`unknown Delove version "${id}" (known: ${[...known.keys()].join(', ')})`));
  const names = values.names ? values.names.split(',').map((s) => s.trim()) : ids.map(defaultName);
  if (names.length !== agents.length) fail('--names needs one name per agent');
  const pace = values.pace === undefined ? 400 : Number(values.pace);
  if (!Number.isFinite(pace) || pace < 0) fail('--pace must be a number of milliseconds');
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
  const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

  const seats: { gameId: string; playerId: string; token: string; name: string; agent: Agent }[] = [];
  let gameId = values.join?.trim().toUpperCase() ?? '';
  for (let i = 0; i < agents.length; i++) {
    // The seat's player type, for spectators only (players never see it): the Delove version it plays.
    const r = !gameId ? await api.createGame(names[i], 'Delove test game', options, undefined, undefined, agents[i].id) : await api.joinGame(gameId, names[i], agents[i].id);
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

  const finals = await Promise.all(seats.map((s) => playSeat({ api, ...s, paceMs: pace, log })));
  const last = finals.find((v) => v?.phase === 'finished') ?? finals[0];
  if (last?.phase === 'finished') {
    const winner = last.players.find((p) => p.id === last.winner);
    log(`game over: ${winner ? winner.name : 'no winner'} wins after ${last.turnNumber} turns`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
