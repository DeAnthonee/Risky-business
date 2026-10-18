#!/usr/bin/env node
import { bootstrapCharacterHistory } from './history-bootstrap.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MAPS, type GameOptions } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
import { OllamaLlm } from './llm.js';
import { LoopControl, runLoop } from './loop.js';
import { mapMaxPlayers, RANDOM_MAX_PLAYERS, RANDOM_MIN_PLAYERS, rotationMaps, type MapChoice, type PlayerCount } from './presets.js';
import { withRetry } from './resilient.js';
import { discoverRoster, findAiDir, loadCharacter } from './roster.js';
import { DEFAULT_SEATS, joinGame, leaveSeats, parseSeats } from './setup.js';
import { SeatRunner } from './seat.js';
import { Diplomat } from './diplomat.js';

const DEFAULT_LEARNINGS_DIR = join(homedir(), 'risk-runner');

const USAGE = `risk-runner: plays Risk games back to back from one machine (plan-aware bot moves, a local Ollama model
sets plans, talks, and writes up what it learned after every game)

  --server URL            game server (default http://localhost:8080; the shared one is https://risky.deanthoneeking.com)
  --map ID|random|rotate  map per game (default random: any map except skirmish and the legacy europe that seats the lineup)
  --players N|random      players per game (default random: ${RANDOM_MIN_PLAYERS} to ${RANDOM_MAX_PLAYERS} within the map's limit; seats are random league/* characters)
  --seats LIST            explicit seats instead of random lineups: "Shen=league/shen,Shaco=league/shaco,Vex" (name=characterId, or a bare name)
  --lobbies N             simultaneous lobbies sharing model queue, character memory and global learnings (default 1)
  --games N               games to play back to back, 0 = forever (default 1)
  --options JSON          overrides for the settings preset (random fog/capitals, 0 or 8 blizzards, random progressive/fixed/exponential cards, ...)
  --max-game-minutes N    give up on a game after N minutes: every seat leaves and the next game starts (default 120, 0 = no cap)
  --ai-dir DIR            the repo's AI folder, for profiles the server lacks (default: found next to this package)
  --learnings-dir DIR     shared learnings folder (default ${DEFAULT_LEARNINGS_DIR})
  --characters-key KEY    bind seats to their characters (leaderboard) and save diary entries and relationship updates
  --model NAME            Ollama model (default qwen3:14b)
  --ollama URL            Ollama base URL (default http://localhost:11434)
  --ctx N                 Ollama context window, num_ctx (default 20480)
  --llm-concurrency N     simultaneous model requests (default 1)
  --plan-timeout SEC      how long a move waits for the commander's plan (default 45)
  --no-commander          plain planned bot, no model call per turn
  --no-learn              skip every post-game write (results, notes, learnings file, scouting log)
  --no-chat               no table talk
  --mechanics-only        fast mechanics training for RISK_LEARNINGS.md: generic seats, no chat, pace 0, and no character profile/memory updates
  --curation-interval N   curate RISK_LEARNINGS.md once every N games (default 1)
  --pace MS               pause after each action (default 800, or 0 with --mechanics-only)
  --max-chat-per-turn N   messages per seat per game turn (default 2)
  --game ID               join this existing lobby instead of creating games (one game; see --start; default seats: the six League ones)
  --start                 with --game: start it if one of our seats is the host
  --verbose               log every chat line and failure detail

First Ctrl+C finishes the current game and its write-ups, then stops. A second one stops at once and the seats leave.`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      server: { type: 'string', default: 'http://localhost:8080' },
      game: { type: 'string' },
      start: { type: 'boolean', default: false },
      seats: { type: 'string' },
      players: { type: 'string', default: 'random' },
      games: { type: 'string', default: '1' },
      lobbies: { type: 'string', default: '1' },
      map: { type: 'string', default: 'random' },
      options: { type: 'string' },
      'max-game-minutes': { type: 'string', default: '120' },
      'ai-dir': { type: 'string' },
      'learnings-dir': { type: 'string', default: DEFAULT_LEARNINGS_DIR },
      'characters-key': { type: 'string' },
      model: { type: 'string', default: 'qwen3:14b' },
      ollama: { type: 'string', default: 'http://localhost:11434' },
      ctx: { type: 'string', default: '20480' },
      'llm-concurrency': { type: 'string', default: '1' },
      'plan-timeout': { type: 'string', default: '45' },
      'no-commander': { type: 'boolean', default: false },
      'no-learn': { type: 'boolean', default: false },
      'no-chat': { type: 'boolean', default: false },
      'mechanics-only': { type: 'boolean', default: false },
      'curation-interval': { type: 'string', default: '1' },
      pace: { type: 'string' },
      'max-chat-per-turn': { type: 'string', default: '2' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (v.help) {
    console.log(USAGE);
    return;
  }
  const num = (s: string, name: string) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
    return n;
  };
  let extra: Partial<GameOptions> = {};
  if (v.options) {
    try {
      extra = JSON.parse(v.options);
    } catch {
      fail('--options must be valid JSON');
    }
  }
  const explicitSeats = v.seats !== undefined;
  let specs: ReturnType<typeof parseSeats> | undefined;
  if (explicitSeats || v.game) {
    try {
      specs = parseSeats(v.seats ?? DEFAULT_SEATS);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const mapChoice = v.map!;
  if (mapChoice !== 'rotate' && mapChoice !== 'random' && !(mapChoice in MAPS)) fail(`--map must be rotate, random or one of: ${Object.keys(MAPS).join(', ')}`);
  let players: PlayerCount = 'random';
  if (v.players !== 'random') {
    players = Number(v.players);
    if (!Number.isInteger(players) || players < 2) fail('--players must be random or a whole number of at least 2');
    if (mapChoice in MAPS && players > mapMaxPlayers(mapChoice)) fail(`${mapChoice} seats at most ${mapMaxPlayers(mapChoice)} players`);
    if (players > RANDOM_MAX_PLAYERS) fail(`--players is at most ${RANDOM_MAX_PLAYERS}`);
  }
  if (specs && !v.game && (mapChoice === 'rotate' || mapChoice === 'random') && rotationMaps(specs.length).length === 0) fail(`No map fits ${specs.length} players`);
  if (specs && mapChoice in MAPS && specs.length > mapMaxPlayers(mapChoice)) fail(`${mapChoice} seats at most ${mapMaxPlayers(mapChoice)} players`);

  const server = v.server!.replace(/\/+$/, '');
  const log = (line: string) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
  const mechanicsOnly = Boolean(v['mechanics-only']);
  const curationInterval = Math.max(1, num(v['curation-interval']!, 'curation-interval'));
  const api = withRetry(new HttpRiskApi(server, mechanicsOnly ? undefined : v['characters-key']), { log });
  const learn = !v['no-learn'];
  const commander = !v['no-commander'];
  const chat = !v['no-chat'] && !mechanicsOnly;
  const needLlm = commander || chat || learn;
  const llm = needLlm
    ? new OllamaLlm({ baseUrl: v.ollama, model: v.model, concurrency: num(v['llm-concurrency']!, 'llm-concurrency'), numCtx: num(v.ctx!, 'ctx') })
    : null;
  const paceMs = v.pace !== undefined ? num(v.pace, 'pace') : mechanicsOnly ? 0 : 800;
  const maxChatPerTurn = num(v['max-chat-per-turn']!, 'max-chat-per-turn');
  const aiDir = findAiDir(v['ai-dir']);
  if (v['ai-dir'] && !aiDir) fail(`--ai-dir ${v['ai-dir']} has no characters/ folder`);

  const lobbyCount = num(v.lobbies!, 'lobbies');
  if (lobbyCount < 1 || lobbyCount > 10) fail('--lobbies must be 1 to 10');
  if (v.game && lobbyCount !== 1) fail('--game supports one lobby only');
  const controls = Array.from({ length: lobbyCount }, () => new LoopControl());
  const control = controls[0];
  process.on('SIGINT', () => {
    if (controls.map(c => c.request()).some(Boolean)) {
      log('Stopping now; the seats leave their game.');
      const bail = setTimeout(() => process.exit(130), 5000);
      void Promise.all(controls.map(c => c.leaveNow())).finally(() => {
        clearTimeout(bail);
        process.exit(130);
      });
      return;
    }
    log('Finishing the current game and its write-ups, then stopping (Ctrl+C again to stop now).');
  });

  if (v.game) {
    await playLobby(v.game.toUpperCase());
    return;
  }

  const roster = explicitSeats || mechanicsOnly ? undefined : await discoverRoster(api, aiDir, log);
  if (!explicitSeats && !mechanicsOnly && (!roster || roster.length < 2)) fail('No league/* characters found on the server or in the AI folder (use --ai-dir, or --seats for explicit seats)');

  if (learn && !mechanicsOnly) await bootstrapCharacterHistory(v['learnings-dir']!, (specs ?? roster ?? []).flatMap(s => 'characterId' in s ? (s.characterId ? [s.characterId] : []) : 'id' in s ? [s.id] : []), log);
  let results: Awaited<ReturnType<typeof runLoop>>;
  try {
  results = (await Promise.all(controls.map((control, lobby) => runLoop({
    api,
    llm,
    seats: explicitSeats ? specs : undefined,
    roster,
    players,
    aiDir,
    maxGameMs: num(v['max-game-minutes']!, 'max-game-minutes') * 60_000,
    games: num(v.games!, 'games'),
    learningsDir: v['learnings-dir']!,
    map: mapChoice as MapChoice,
    options: extra,
    paceMs,
    planTimeoutMs: num(v['plan-timeout']!, 'plan-timeout') * 1000,
    commander,
    learn,
    chat,
    maxChatPerTurn,
    charactersKey: mechanicsOnly ? undefined : v['characters-key'],
    mechanicsOnly,
    curationInterval,
    serverUrl: server,
    control,
    log: line => log(lobbyCount > 1 ? `[Lobby ${lobby + 1}] ${line}` : line),
    verbose: v.verbose,
  })))).flat();
  } catch (e) {
    for (const c of controls) { c.request(); c.request(); }
    await Promise.all(controls.map(c => c.leaveNow()));
    throw e;
  }
  log(`Done: ${results.length} game${results.length === 1 ? '' : 's'} played.`);

  /** Join and play one game in an existing lobby (no write-ups: seats may be shared with other runners). */
  async function playLobby(gameId: string) {
    const seatSpecs = specs!;
    const setup = await joinGame(api, gameId, seatSpecs, { start: v.start });
    log(`Game ${setup.gameId}`);
    log(`Watch: ${server}/?game=${setup.gameId}&spectate=1`);
    if (!setup.started && v.start) log('Seats joined; waiting for the game to be started.');
    const runners = await Promise.all(
      setup.identities.map(async (id) => {
        const characterId = seatSpecs.find((s) => s.name === id.name)?.characterId;
        const character = llm && chat && characterId ? await loadCharacter(api, characterId, aiDir) : null;
        return new SeatRunner({
          api,
          gameId: id.gameId,
          playerId: id.playerId,
          token: id.token,
          name: id.name,
          paceMs,
          log,
          diplomat:
            llm && chat
              ? new Diplomat({ llm, seatName: id.name, playerId: id.playerId, characterMarkdown: character?.markdown ?? null, relationships: character?.relationships ?? null, maxPerTurn: maxChatPerTurn })
              : null,
        });
      }),
    );
    control.attach(runners, () => leaveSeats(api, setup.identities));
    const views = await Promise.all(runners.map((r) => r.run()));
    const final = views.find((x) => x?.phase === 'finished') ?? null;
    const winner = final?.players.find((p) => p.id === final.winner);
    log(winner ? `Game over. Winner: ${winner.name}` : 'Game ended without a winner.');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
