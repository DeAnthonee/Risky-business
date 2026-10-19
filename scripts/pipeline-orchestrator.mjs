import { createRiskServer } from '../packages/server/dist/app.js';
import { Store } from '../packages/server/dist/store.js';
import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LEARNINGS_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risk';
const LOCAL_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risky-business';
const GEN1_LOG = 'C:\\Users\\makey\\.gemini\\antigravity\\brain\\b5ff85e3-4e32-4d33-9560-9c5ae9e51011\\.system_generated\\tasks\\task-1935.log';
const STATUS_FILE = path.join(LEARNINGS_DIR, 'pipeline-status.json');

const log = (msg) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [ORCHESTRATOR] ${msg}`);
};

async function getStatus() {
  if (existsSync(STATUS_FILE)) {
    try {
      return JSON.parse(await readFile(STATUS_FILE, 'utf8'));
    } catch {}
  }
  return {};
}

async function updateStatus(data) {
  try {
    const existing = existsSync(STATUS_FILE) ? JSON.parse(await readFile(STATUS_FILE, 'utf8')) : {};
    const updated = { ...existing, ...data, updatedAt: new Date().toISOString() };
    await writeFile(STATUS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    log(`Warning: could not update status file: ${e.message}`);
  }
}

async function snapshot(genName) {
  const src = path.join(LEARNINGS_DIR, 'RISK_LEARNINGS.md');
  const dstRisk = path.join(LEARNINGS_DIR, `RISK_LEARNINGS.${genName}.md`);
  const dstLocal = path.join(LOCAL_DIR, `RISK_LEARNINGS.${genName}.md`);
  
  if (existsSync(src)) {
    await copyFile(src, dstRisk);
    await copyFile(src, dstLocal);
    log(`Snapshotted ${genName}: ${dstRisk} and ${dstLocal}`);
  } else {
    log(`Warning: source file ${src} does not exist for snapshot`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForGen1() {
  log('Checking Generation 1 status...');
  await updateStatus({ currentGen: 'gen1', state: 'waiting_for_completion' });

  while (true) {
    // Check if task 1935 log indicates completion
    if (existsSync(GEN1_LOG)) {
      try {
        const content = await readFile(GEN1_LOG, 'utf8');
        if (content.includes('=== [GENERATION 1] Complete!')) {
          log('Generation 1 complete detected via task log!');
          break;
        }
      } catch {}
    }

    // Check if port 58338 is open
    const open = await isPortOpen(58338);
    if (!open) {
      if (existsSync(GEN1_LOG)) {
        const content = await readFile(GEN1_LOG, 'utf8');
        if (content.includes('=== [GENERATION 1] Complete!')) {
          log('Generation 1 finished and port closed.');
          break;
        }
      }
    }

    await sleep(15000);
  }

  await snapshot('gen1');
  await updateStatus({ gen1: 'completed', gen1CompletedAt: new Date().toISOString() });
}

async function runSimulation(title, cliArgs) {
  log(`================================================================`);
  log(`Starting ${title}`);
  log(`================================================================`);

  const clientDist = path.resolve(LOCAL_DIR, 'packages', 'client', 'dist');
  const risk = createRiskServer(new Store(null), { clientDir: existsSync(clientDist) ? clientDist : null, sweepIntervalMs: 0 });
  await new Promise((r) => risk.server.listen(0, '127.0.0.1', r));
  const port = risk.server.address().port;
  log(`Ephemeral risk server listening on http://127.0.0.1:${port}`);

  try {
    const dataDir = path.resolve(LOCAL_DIR, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.resolve(dataDir, 'active-port.txt'), String(port), 'utf8');
  } catch {}

  const fullArgs = [
    'packages/runner/dist/cli.js',
    '--server', `http://127.0.0.1:${port}`,
    ...cliArgs
  ];

  log(`Spawning runner: node ${fullArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, fullArgs, {
      cwd: LOCAL_DIR,
      stdio: 'inherit'
    });

    child.on('exit', async (code) => {
      log(`${title} finished with exit code ${code}`);
      try {
        await risk.shutdown('done');
      } catch (e) {
        log(`Error shutting down server: ${e.message}`);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${title} exited with code ${code}`));
      }
    });

    child.on('error', async (err) => {
      log(`Child process error: ${err.message}`);
      try {
        await risk.shutdown('error');
      } catch {}
      reject(err);
    });
  });
}

async function main() {
  log('Pipeline Orchestrator started.');
  log(`Learnings directory: ${LEARNINGS_DIR}`);

  const status = await getStatus();

  // Step 1: Gen 1
  if (status.gen1 !== 'completed') {
    await waitForGen1();
  } else {
    log('Generation 1 already marked completed, skipping.');
  }

  // Step 2: Gen 2 (1,000 games mechanics simulation, 4 lobbies x 250 games)
  if (status.gen2 !== 'completed') {
    await updateStatus({ currentGen: 'gen2', state: 'running', gen2StartedAt: new Date().toISOString() });
    await runSimulation('GENERATION 2 (1,000 Games Mechanics Self-Play)', [
      '--mechanics-only',
      '--no-commander',
      '--lobbies', '4',
      '--games', '250',
      '--curation-interval', '10',
      '--learnings-dir', LEARNINGS_DIR
    ]);
    await snapshot('gen2');
    await updateStatus({ gen2: 'completed', gen2CompletedAt: new Date().toISOString() });
  } else {
    log('Generation 2 already marked completed, skipping.');
  }

  // Step 3: Gen 3 (1,000 games mechanics simulation, 4 lobbies x 250 games)
  if (status.gen3 !== 'completed') {
    await updateStatus({ currentGen: 'gen3', state: 'running', gen3StartedAt: new Date().toISOString() });
    await runSimulation('GENERATION 3 (1,000 Games Mechanics Self-Play)', [
      '--mechanics-only',
      '--no-commander',
      '--lobbies', '4',
      '--games', '250',
      '--curation-interval', '10',
      '--learnings-dir', LEARNINGS_DIR
    ]);
    await snapshot('gen3');
    await updateStatus({ gen3: 'completed', gen3CompletedAt: new Date().toISOString() });
  } else {
    log('Generation 3 already marked completed, skipping.');
  }

  // Step 4: Gen 4 (100 games: 1 smart LLM player vs 5 mechanics bots)
  if (status.gen4 !== 'completed') {
    await updateStatus({ currentGen: 'gen4', state: 'running', gen4StartedAt: new Date().toISOString() });
    await runSimulation('GENERATION 4 (100 Games: 1 Smart LLM Player vs 5 Bots)', [
      '--players', '6',
      '--smart-seats', '1',
      '--lobbies', '1',
      '--games', '100',
      '--pace', '0',
      '--model', 'qwen3:14b',
      '--ctx', '20480',
      '--curation-interval', '5',
      '--learnings-dir', LEARNINGS_DIR
    ]);
    await snapshot('gen4');
    await updateStatus({ gen4: 'completed', gen4CompletedAt: new Date().toISOString() });
  } else {
    log('Generation 4 already marked completed, skipping.');
  }

  // Step 5: Gen 5 (100 games: 6 smart LLM players vs 6 smart LLM players)
  if (status.gen5 !== 'completed') {
    let gen5GamesPlayed = 0;
    const resultsFile = path.join(LEARNINGS_DIR, 'results.jsonl');
    if (existsSync(resultsFile)) {
      try {
        const raw = await readFile(resultsFile, 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.generation === 'gen5' || (status.gen5StartedAt && parsed.date >= status.gen5StartedAt)) {
            gen5GamesPlayed++;
          }
        }
      } catch {}
    }
    const remainingGames = Math.max(1, 100 - gen5GamesPlayed);
    log(`Generation 5: ${gen5GamesPlayed}/100 games already recorded. Running remaining ${remainingGames} games.`);

    await updateStatus({ currentGen: 'gen5', state: 'running' });
    await runSimulation(`GENERATION 5 (${remainingGames} Games: Smart LLM vs Smart LLM FFA)`, [
      '--players', '6',
      '--lobbies', '1',
      '--games', String(remainingGames),
      '--pace', '0',
      '--model', 'qwen3:14b',
      '--ctx', '20480',
      '--curation-interval', '5',
      '--skip-rivalries',
      '--learnings-dir', LEARNINGS_DIR
    ]);
    await snapshot('gen5');
    await updateStatus({ gen5: 'completed', gen5CompletedAt: new Date().toISOString(), currentGen: 'done', state: 'all_generations_completed' });
  } else {
    log('Generation 5 already marked completed.');
  }

  log('================================================================');
  log('ALL 5 GENERATIONS COMPLETED SUCCESSFULLY!');
  log('================================================================');
}

main().catch(async (err) => {
  log(`FATAL: Orchestrator failed: ${err.message}`);
  await updateStatus({ state: 'failed', error: err.message });
  process.exit(1);
});
