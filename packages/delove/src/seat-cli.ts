#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { GameOptions } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
import type { Agent } from '@risk/selfplay';
import { discoverNetAgents, modelsDir } from './net-agent.js';
import { playSeat } from './seat.js';
import { DEFAULT_TEACHER_PARAMS, makeTeacher, teacher, type TeacherParams } from './teacher.js';

const USAGE = `delove-seat: seat Delove players in a real game over the HTTP API (no chat, no character)

  npm run delove-seat -- --join CODE [--agents delove@1,delove-teacher@1]
  npm run delove-seat -- --create [--agents delove@1,delove-teacher@1] [--bots 2] [--options '{"map":"classic"}'] [--no-start]

  --server URL     game server (default RISK_SERVER_URL or http://localhost:8080)
  --agents IDS     Delove versions, one seat each (default delove@1): delove-teacher@1 and every
                   models/delove/delove@N.onnx (or DELOVE_MODELS) as delove@N
  --names NAMES    seat names, same order (default "Delove 1", "Delove Teacher", ...)
  --join CODE      join a game someone created; the host starts it
  --create         create a game (the first seat hosts), add --bots built-in bots, start it (unless --no-start)
  --pace MS        pause after each move so spectators can follow (default 400)

Fog of war games are refused: Delove was trained on the full board.`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

function discoverTunedTeachers(dir = modelsDir()): Agent[] {
  if (!existsSync(dir)) return [];
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir).filter((f) => /^delove-teacher@\d+\.json$/.test(f));
  return files.sort((a, b) => version(a) - version(b)).map((f) => {
    const id = f.replace(/\.json$/, '');
    const params: TeacherParams = { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
    return makeTeacher(id, params);
  });
}

function defaultName(id: string): string {
  if (id === teacher.id || id === 'sensei@1' || id === 'sensei') return 'Sensei 1';
  if (id === 'delove-teacher@2' || id === 'sensei@2') return 'Sensei 2';
  const m = /^delove@(\d+)(-explore)?$/.exec(id);
  return m ? `Delove ${m[1]}${m[2] ? ' (explore)' : ''}` : id;
}

async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: 'string' },
      agents: { type: 'string' },
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
  const allAgents = [teacher, ...tuned, ...discoverNetAgents()];
  const known = new Map<string, Agent>(
    allAgents.flatMap((a) => {
      const entries: [string, Agent][] = [[a.id, a]];
      if (a.id === 'delove-teacher@1') entries.push(['sensei@1', a], ['sensei', a]);
      if (a.id === 'delove-teacher@2') entries.push(['sensei@2', a]);
      return entries;
    }),
  );
  const ids = (values.agents ?? 'delove@1').split(',').map((s) => s.trim()).filter(Boolean);
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
  if (options?.fogOfWar) fail('Delove does not play fog of war games yet');

  const server = values.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  const api = new HttpRiskApi(server);
  const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

  const seats: { gameId: string; playerId: string; token: string; name: string; agent: Agent }[] = [];
  let gameId = values.join?.trim().toUpperCase() ?? '';
  for (let i = 0; i < agents.length; i++) {
    const r = !gameId ? await api.createGame(names[i], 'Delove test game', options) : await api.joinGame(gameId, names[i]);
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
