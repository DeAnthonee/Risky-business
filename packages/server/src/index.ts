import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Store } from './store.js';
import { createRiskServer } from './app.js';
import { buildInfo } from './build-info.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- configuration (all optional except PORT in production) ----
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Persistent state lives OUTSIDE the repo: RISK_DATA_DIR, default ~/.risky-business. "none" disables persistence. */
const DATA_DIR =
  process.env.RISK_DATA_DIR === 'none' ? null : resolve(process.env.RISK_DATA_DIR ?? join(homedir(), '.risky-business'));
const CLIENT_DIR = resolve(process.env.RISK_CLIENT_DIR ?? join(__dirname, '../../client/dist'));
/** Hard limit for graceful shutdown before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.RISK_SHUTDOWN_TIMEOUT_MS ?? 10_000);

const store = new Store(DATA_DIR ? join(DATA_DIR, 'games.json') : null);
const risk = createRiskServer(store, { clientDir: CLIENT_DIR });

risk.server.listen(PORT, HOST, () => {
  const info = buildInfo();
  console.log(`Risky Business ${info.version} (${info.build}) listening on http://${HOST}:${PORT}`);
  console.log(`  health:    http://localhost:${PORT}/healthz`);
  console.log(`  websocket: ws://localhost:${PORT}/ws`);
  console.log(`  data dir:  ${DATA_DIR ?? '(persistence disabled)'}`);
  console.log(`  client:    ${CLIENT_DIR}`);
});

let exiting = false;
async function exitGracefully(signal: string) {
  if (exiting) return;
  exiting = true;
  const hardStop = setTimeout(() => {
    console.error('shutdown timed out; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardStop.unref();
  try {
    await risk.shutdown(signal);
    process.exit(0);
  } catch (err) {
    console.error('shutdown failed', err);
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void exitGracefully(sig));
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  void exitGracefully('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
