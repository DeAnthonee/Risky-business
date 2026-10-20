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
log(`Testing Delove@3 & Sensei@2 (no learnings) vs 4 LLM Characters (with shared learnings, qwen3:14b)`);
log(`Fog of War: OFF. Mode: Generation 5.`);

let gamesCompleted = 0;

for (let g = 1; g <= TOTAL_GAMES; g++) {
  log(`================================================================`);
  log(`Starting Generation 5 Match ${g}/${TOTAL_GAMES} on ${SERVER_URL}`);
  log(`================================================================`);

  // Spawn runner for 1 game: 4 LLM characters + 2 open seats = 6 total
  const runner = spawn('node', [
    'packages/runner/dist/cli.js',
    '--server', SERVER_URL,
    '--players', '6',
    '--open-seats', '2',
    '--options', JSON.stringify({ fogOfWar: false }),
    '--games', '1',
    '--pace', '0',
    '--model', 'qwen3:14b',
    '--ctx', '20480',
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
      log(`Lobby detected: ${gameId}. Slotting Delove@3 and Sensei@2 into open seats...`);
      log(`Spectator link: ${SERVER_URL}/?game=${gameId}&spectate=1`);

      seatProcess = spawn('node', [
        'packages/delove/dist/seat-cli.js',
        '--server', SERVER_URL,
        '--join', gameId,
        '--agents', 'delove@3,delove-teacher@2',
        '--names', 'Delove@3,Sensei@2',
        '--pace', '0',
      ], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

      seatProcess.stdout.on('data', (s) => process.stdout.write('[DELOVE] ' + s.toString()));
      seatProcess.stderr.on('data', (s) => process.stderr.write('[DELOVE ERR] ' + s.toString()));
      seatProcess.on('exit', (code) => {
        log(`Delove seat process for ${gameId} exited (code ${code})`);
      });
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
