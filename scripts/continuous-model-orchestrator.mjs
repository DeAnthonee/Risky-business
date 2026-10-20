import { createRiskServer } from '../packages/server/dist/app.js';
import { Store } from '../packages/server/dist/store.js';
import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_DIR = 'C:/Users/makey/Documents/Claude gaming/Risky-business';
const LEARNINGS_DIR = 'C:/Users/makey/Documents/Claude gaming/Risk';
const PORT = 55125;
const TOTAL_GAMES = 60; // 60 games to let Delove@3 and Sensei@2 catch up on the board

const log = (msg) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [ORCHESTRATOR] ${msg}`);
};

// Start Risk Server
const store = new Store('none');
const { server } = createRiskServer(store, { sweepIntervalMs: 0 });
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
log(`Risk server listening on http://127.0.0.1:${PORT}`);
log(`Spectator UI available via proxy or http://127.0.0.1:${PORT}/?spectate=1`);

let gamesCompleted = 0;

for (let g = 1; g <= TOTAL_GAMES; g++) {
  log(`================================================================`);
  log(`Starting Match ${g}/${TOTAL_GAMES} (Delove@3 + Sensei@2 + 4 LLM Characters, No Fog)`);
  log(`================================================================`);

  // Spawn runner for 1 game: 4 LLM characters + 2 open seats = 6 total
  const runner = spawn('node', [
    'packages/runner/dist/cli.js',
    '--server', `http://127.0.0.1:${PORT}`,
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

      seatProcess = spawn('node', [
        'packages/delove/dist/seat-cli.js',
        '--server', `http://127.0.0.1:${PORT}`,
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

  // Small breath between games
  await new Promise((r) => setTimeout(r, 1000));
}

log(`All ${TOTAL_GAMES} scheduled matches completed.`);
server.close();
process.exit(0);
