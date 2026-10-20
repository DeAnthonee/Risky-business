import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_DIR = 'C:/Users/makey/Documents/Claude gaming/Risky-business';
const LEARNINGS_DIR = 'C:/Users/makey/Documents/Claude gaming/Risk';
const SERVER_URL = process.env.RISK_SERVER ?? 'https://risky.deanthoneeking.com';
const TOTAL_GAMES = 60; // Games to let Delove@3 and Sensei@2 battle the LLMs

const log = (msg) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [ORCHESTRATOR] ${msg}`);
};

log(`Risk continuous model orchestrator targeting ${SERVER_URL}`);
log(`Pool of 20: 10 League LLMs + 10 Delove Models (6 to 10 players, any composition)`);
log(`Mode: Generation 5 (50/50 Fog of War setting).`);

let gamesCompleted = 0;
let lastMap = 'fantasy'; // ensure Match 3+ never duplicates previous

const MAP_POOL = [
  'classic',
  'world',
  'world_large',
  'europe',
  'greater_europe',
  'europe_classic',
  'usa',
  'asia',
  'fantasy',
];

const MAP_MAX_PLAYERS = {
  classic: 6,
  europe_classic: 6,
  europe: 8,
  asia: 8,
  world: 10,
  world_large: 10,
  greater_europe: 10,
  usa: 10,
  fantasy: 10,
};

const LLM_POOL = [
  { name: 'Ahri', id: 'league/ahri' },
  { name: 'Darius', id: 'league/darius' },
  { name: 'Jinx', id: 'league/jinx' },
  { name: 'Leona', id: 'league/leona' },
  { name: 'Lux', id: 'league/lux' },
  { name: 'Shaco', id: 'league/shaco' },
  { name: 'Shen', id: 'league/shen' },
  { name: 'Teemo', id: 'league/teemo' },
  { name: 'Thresh', id: 'league/thresh' },
  { name: 'Tryndamere', id: 'league/tryndamere' },
];

const MODEL_POOL = [
  { name: 'Sensei@3', agent: 'jacob-sensei@1' },
  { name: 'Ronny@3', agent: 'delove@3' },
  { name: 'Joey@3', agent: 'delove@3' },
  { name: 'Hans@3', agent: 'delove@3' },
  { name: 'Demonte@3', agent: 'delove@3' },
  { name: 'Dejean@3', agent: 'delove@3' },
  { name: 'Demario@3', agent: 'delove@3' },
  { name: 'Kai@3', agent: 'delove@3' },
  { name: 'Lauren@3', agent: 'delove@3' },
  { name: 'Diane@3', agent: 'delove@3' },
  { name: 'Jason@3', agent: 'delove@3' },
];

const POOL_OF_20 = [
  ...LLM_POOL.map((p) => ({ ...p, type: 'llm' })),
  ...MODEL_POOL.map((p) => ({ ...p, type: 'model' })),
];

function pickNextMap(prevMap) {
  const eligible = MAP_POOL.filter((m) => m !== prevMap);
  return eligible[Math.floor(Math.random() * eligible.length)];
}

for (let g = 1; g <= TOTAL_GAMES; g++) {
  const selectedMap = pickNextMap(lastMap);
  lastMap = selectedMap;

  const fogOfWar = Math.random() < 0.5;
  const mapCap = MAP_MAX_PLAYERS[selectedMap] ?? 6;
  const targetPlayers = 6 + Math.floor(Math.random() * 5); // 6 to 10
  const playerCount = Math.min(targetPlayers, mapCap);

  // Randomly select playerCount from the pool of 20
  const shuffled = [...POOL_OF_20].sort(() => Math.random() - 0.5);
  let selected = shuffled.slice(0, playerCount);

  // Guarantee at least 1 LLM so runner hosts the game, captures the logs, and updates the leaderboard
  let selectedLLMs = selected.filter((p) => p.type === 'llm');
  let selectedModels = selected.filter((p) => p.type === 'model');
  if (selectedLLMs.length === 0) {
    const pickLLM = LLM_POOL[Math.floor(Math.random() * LLM_POOL.length)];
    selected[0] = { ...pickLLM, type: 'llm' };
    selectedLLMs = selected.filter((p) => p.type === 'llm');
    selectedModels = selected.filter((p) => p.type === 'model');
  }

  const llmSeatsArg = selectedLLMs.map((s) => `${s.name}=${s.id}`).join(',');
  const openSeats = selectedModels.length;
  const agentsArg = selectedModels.map((s) => s.agent).join(',');
  const namesArg = selectedModels.map((s) => s.name).join(',');

  log(`================================================================`);
  log(`Starting Generation 5 Match ${g}/${TOTAL_GAMES} on ${SERVER_URL} (Map: ${selectedMap}, Players: ${playerCount} [${selectedLLMs.length} LLMs: ${selectedLLMs.map((s) => s.name).join(', ')} + ${openSeats} Models: ${openSeats > 0 ? namesArg : 'None'}], Fog: ${fogOfWar ? 'ON' : 'OFF'})`);
  log(`================================================================`);

  // Spawn runner for 1 game
  const runner = spawn('node', [
    'packages/runner/dist/cli.js',
    '--server', SERVER_URL,
    '--map', selectedMap,
    '--seats', llmSeatsArg,
    '--open-seats', String(openSeats),
    '--options', JSON.stringify({ fogOfWar }),
    '--games', '1',
    '--pace', '0',
    '--model', 'qwen3:14b',
    '--ctx', '12288',
    '--curation-interval', '5',
    '--skip-rivalries',
    '--no-chat',
    '--generation', 'gen5',
    '--learnings-dir', LEARNINGS_DIR,
  ], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

  let gameId = null;
  let seatProcess = null;

  runner.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(text);
    const m = /Lobby ([A-Z0-9]+) on/i.exec(text);
    if (m && !gameId) {
      gameId = m[1];
      log(`Lobby detected: ${gameId}. Spectator link: ${SERVER_URL}/?game=${gameId}&spectate=1`);

      if (openSeats > 0) {
        log(`Slotting ${namesArg} into ${openSeats} open seats...`);
        seatProcess = spawn('node', [
          'packages/delove/dist/seat-cli.js',
          '--server', SERVER_URL,
          '--join', gameId,
          '--agents', agentsArg,
          '--names', namesArg,
          '--pace', '0',
        ], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

        seatProcess.stdout.on('data', (s) => process.stdout.write('[DELOVE] ' + s.toString()));
        seatProcess.stderr.on('data', (s) => process.stderr.write('[DELOVE ERR] ' + s.toString()));
        seatProcess.on('exit', (code) => {
          log(`Delove seat process for ${gameId} exited (code ${code})`);
        });
      }
    }
  });

  runner.stderr.on('data', (d) => process.stderr.write('[RUNNER ERR] ' + d.toString()));

  await new Promise((resolve) => runner.on('exit', resolve));
  gamesCompleted++;
  log(`Match ${g}/${TOTAL_GAMES} finished. Games completed: ${gamesCompleted}`);

  // Sync LEADERBOARD.md to repo
  try {
    const srcLb = path.join(LEARNINGS_DIR, 'LEADERBOARD.md');
    const dstLb = path.join(REPO_DIR, 'LEADERBOARD.md');
    if (existsSync(srcLb)) {
      await copyFile(srcLb, dstLb);
      log(`Synced LEADERBOARD.md to repository.`);
    }
  } catch (e) {
    log(`Warning: could not sync LEADERBOARD.md: ${e.message}`);
  }

  // Small pause between games
  await new Promise((r) => setTimeout(r, 2000));
}

log(`All ${TOTAL_GAMES} scheduled matches completed.`);
