import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Store } from './store.js';
import { DEFAULT_AI_DIR, createRiskServer } from './app.js';
import { CharacterStore } from './characters.js';
import { buildInfo } from './build-info.js';
import { parseSchedule, SAVED_SCHEDULE_FILE, scheduleFromEnv, scheduleFromSaved, type ScheduleEntry } from './tournament-schedule.js';
import { describeTourneyAccess, openModeFromEnv, tourneyAccessFromEnv } from './tournament-access.js';

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

const minutes = (name: string) => (process.env[name] ? Number(process.env[name]) * 60_000 : undefined);
const retention = Object.fromEntries(
  Object.entries({
    lobby: minutes('RISK_LOBBY_TTL_MIN'),
    playing: minutes('RISK_GAME_TTL_MIN'),
    botsOnly: minutes('RISK_BOTS_ONLY_TTL_MIN'),
    finished: minutes('RISK_FINISHED_TTL_MIN'),
  }).filter(([, v]) => v !== undefined && Number.isFinite(v) && v > 0),
);
// For these two 0 means off (the defaults are 2 minutes), so zero must pass through.
for (const [key, env] of [['finishedClose', 'RISK_FINISHED_CLOSE_MIN'], ['abandonedClose', 'RISK_ABANDONED_CLOSE_MIN']] as const) {
  const v = minutes(env);
  if (v !== undefined && Number.isFinite(v) && v >= 0) (retention as Record<string, number>)[key] = v;
}
const store = new Store(DATA_DIR ? join(DATA_DIR, 'games.json') : null, retention);
// Scheduled nested tournaments: off unless the owner sets a schedule. A bad schedule is logged and stays off.
let schedule: ScheduleEntry[] | null = null;
let scheduleNote = 'off (set RISK_TOURNAMENT_SCHEDULE or RISK_TOURNAMENT_SCHEDULE_FILE)';
const tourneyAccess = tourneyAccessFromEnv(process.env);
// The settings page's saved schedule (RISK_DATA_DIR) wins over the env's; a bad saved one falls back to the env's.
const savedScheduleFile = DATA_DIR ? join(DATA_DIR, SAVED_SCHEDULE_FILE) : null;
const describeSchedule = (list: ScheduleEntry[], source: string) => `${list.length} entr${list.length === 1 ? 'y' : 'ies'} from ${source}: ${list.map((e) => `${e.at} ${e.tz ?? 'UTC'}${e.roster ? ` (+${e.roster} roster seats)` : ''}`).join('; ')}`;
let envSchedule: { raw: unknown[]; source: string } | null = null;
let scheduleRaw: unknown[] = [];
let scheduleSource: string | null = null;
try {
  const found = scheduleFromEnv(process.env);
  if (found) {
    schedule = parseSchedule(found.raw, store.tournaments);
    envSchedule = { raw: Array.isArray(found.raw) ? found.raw : [found.raw], source: found.source };
    [scheduleRaw, scheduleSource] = [envSchedule.raw, found.source];
    scheduleNote = describeSchedule(schedule, found.source);
  }
} catch (err) {
  scheduleNote = `OFF: the schedule is invalid: ${(err as Error).message}`;
  console.error(`tournament schedule: ${scheduleNote}`);
}
try {
  const saved = scheduleFromSaved(savedScheduleFile);
  if (saved) {
    const raw = Array.isArray(saved.raw) ? saved.raw : [saved.raw];
    schedule = raw.length ? parseSchedule(raw, store.tournaments) : null;
    [scheduleRaw, scheduleSource] = [raw, saved.source];
    scheduleNote = schedule ? describeSchedule(schedule, saved.source) : `off (turned off on ${saved.source})`;
  }
} catch (err) {
  console.error(`tournament schedule: the saved schedule (${savedScheduleFile}) is invalid, using the environment's: ${(err as Error).message}`);
}
const risk = createRiskServer(store, {
  clientDir: CLIENT_DIR,
  mcpLabel: process.env.RISK_PUBLIC_URL ?? 'Risky Business',
  adminToken: process.env.RISK_ADMIN_TOKEN || null,
  // Read-only access to full game records (hidden hands, notes): the owner sets it; it is never printed.
  recordsKey: process.env.RISK_RECORDS_KEY || null,
  // Starting profiles come from the repo; saved versions live under RISK_DATA_DIR so they survive deploys.
  characters: new CharacterStore(resolve(process.env.RISK_AI_DIR ?? DEFAULT_AI_DIR), DATA_DIR ? join(DATA_DIR, 'characters') : null, [
    process.env.RISK_CHARACTERS_KEY,
    process.env.RISK_ADMIN_TOKEN,
  ]),
  // Hosting codes and caps (values never printed). Open mode (no code needed) is on by default only while no code is set.
  tourneyAccess,
  tourneyAccessFile: DATA_DIR ? join(DATA_DIR, 'tournament-access.json') : null,
  // The Delove seat pool's key (never printed); unset = Delove seats on request off.
  seatPoolKey: process.env.RISK_SEAT_POOL_KEY || null,
  seatRequestsFile: DATA_DIR ? join(DATA_DIR, 'seat-requests.json') : null,
  seatPoolLockFile: DATA_DIR ? join(DATA_DIR, 'seat-pool-lockout.json') : null,
  openTournaments: openModeFromEnv(process.env, tourneyAccess),
  // The site's "Archive season" button: unset = off.
  seasonKey: process.env.RISK_SEASON_KEY || null,
  // Wrong-try counts and lockouts survive restarts.
  seasonLockFile: DATA_DIR ? join(DATA_DIR, 'season-key-lockout.json') : null,
  tournamentSchedule: schedule,
  scheduleFile: DATA_DIR ? join(DATA_DIR, 'tournament-schedule.json') : null,
  scheduleRaw,
  scheduleSource,
  envSchedule,
  scheduleEntriesFile: savedScheduleFile,
});

risk.server.listen(PORT, HOST, () => {
  const info = buildInfo();
  console.log(`Risky Business ${info.version} (${info.build}) listening on http://${HOST}:${PORT}`);
  console.log(`  health:    http://localhost:${PORT}/healthz`);
  console.log(`  websocket: ws://localhost:${PORT}/ws`);
  console.log(`  mcp:       http://localhost:${PORT}/mcp (Streamable HTTP)`);
  console.log(`  data dir:  ${DATA_DIR ?? '(persistence disabled)'}`);
  console.log(`  archive:   ${store.archive.describe()}`);
  console.log(`  records:   ${process.env.RISK_RECORDS_KEY ? 'full records need the records key' : 'off (set RISK_RECORDS_KEY to read full records)'}`);
  console.log(`  characters: ${risk.characters.writable ? 'saves need the write key' : 'read-only (set RISK_CHARACTERS_KEY to allow saves)'}`);
  console.log(`  schedule:  ${scheduleNote}`);
  console.log(`  hosting:   ${tourneyAccess.adminCode || tourneyAccess.limitedCode ? 'creating tournaments needs a hosting code' : 'no hosting codes set'}`);
  console.log(describeTourneyAccess(tourneyAccess));
  console.log(`  seat pool: ${process.env.RISK_SEAT_POOL_KEY ? 'Delove seats on request are on (the pool needs its key)' : 'off (set RISK_SEAT_POOL_KEY)'}`);
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
