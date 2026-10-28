import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { OG_IMAGE_CACHE, OgImages, ogTags, withOgTags } from './og.js';
import { createApi } from './http.js';
import { attachWebSocket } from './ws.js';
import { buildInfo } from './build-info.js';
import { createMcpRouter } from './mcp.js';
import { nameSkeleton } from './player-keys.js';
import { CharacterStore } from './characters.js';
import type { SeasonKeyGuard } from './season-key.js';
import { NO_TOURNEY_CAPS, TournamentAccess, type TourneyAccessConfig } from './tournament-access.js';
import { SeatRequests } from './seat-requests.js';
import { TournamentScheduler, type ScheduleEntry } from './tournament-schedule.js';
import { ScheduleSettings } from './schedule-settings.js';

export interface AppOptions {
  /** Directory holding the built web client (served if it exists). */
  clientDir?: string | null;
  /** Public label for the MCP endpoint's instructions (e.g. the site URL). */
  mcpLabel?: string;
  /** Enables /api/admin/* when set. */
  adminToken?: string | null;
  /** Read-only key for full game records (/api/records/*); unset turns those routes off. Never logged. */
  recordsKey?: string | null;
  /** AI character profiles; defaults to the repo's AI/ folder with saves kept in memory. */
  characters?: CharacterStore;
  /**
   * Open mode (RISK_TOURNAMENTS_OPEN): anyone may create tournaments without a code, within the caps (default true here;
   * index.ts turns it off by default once a hosting code is set). Each creator gets a host token.
   */
  openTournaments?: boolean;
  /** Hosting codes and caps (RISK_TOURNEY_*; tournament-access.ts). Unset: no codes and no caps (tests); index.ts passes the env. */
  tourneyAccess?: Partial<TourneyAccessConfig>;
  /** Where the day's create counts and wrong code tries are saved (under RISK_DATA_DIR). */
  tourneyAccessFile?: string | null;
  /** RISK_SEAT_POOL_KEY: the Delove seat pool's key for /api/seat-requests (unset = Delove seats on request off). */
  seatPoolKey?: string | null;
  /** Where the seat requests and the pool's wrong-key lockout are saved (under RISK_DATA_DIR). */
  seatRequestsFile?: string | null;
  seatPoolLockFile?: string | null;
  /** RISK_SEASON_KEY: lets the site archive the public leaderboard's season with this password (unset = off). */
  seasonKey?: string | null;
  /** Where the season-key lockout is saved (under RISK_DATA_DIR). */
  seasonLockFile?: string | null;
  /** Tests: the season-key guard (limits and clock). */
  seasonGuard?: SeasonKeyGuard;
  /** Scheduled nested tournaments (parsed RISK_TOURNAMENT_SCHEDULE); unset or empty = no schedule. */
  tournamentSchedule?: ScheduleEntry[] | null;
  /** Where the schedule's state is saved (under RISK_DATA_DIR), so a restart neither repeats nor skips a slot. */
  scheduleFile?: string | null;
  /** The running schedule as written (the settings page edits it) and where it came from. */
  scheduleRaw?: unknown[];
  scheduleSource?: string | null;
  /** The environment's schedule (RISK_TOURNAMENT_SCHEDULE), which the settings page's reset goes back to. */
  envSchedule?: { raw: unknown[]; source: string } | null;
  /** Where the settings page saves the schedule (RISK_DATA_DIR/tournament-schedule-entries.json); null = not kept. */
  scheduleEntriesFile?: string | null;
  /** Sweep interval for idle rooms; 0 disables the automatic sweeper (tests). */
  sweepIntervalMs?: number;
}

export interface RiskServer {
  app: express.Express;
  server: Server;
  store: Store;
  characters: CharacterStore;
  startedAt: number;
  /** Connected WebSocket clients. */
  connections(): number;
  health(): HealthReport;
  /** Graceful shutdown: snapshot state, close sockets, stop listening. Resolves when done. */
  shutdown(reason?: string): Promise<void>;
}

export interface HealthReport {
  ok: true;
  version: string;
  build: string;
  commit: string;
  builtAt: string;
  startedAt: string;
  uptimeSeconds: number;
  /** Games currently in progress (started, not finished). */
  playing: number;
  lobbies: number;
  finished: number;
  games: number;
  connections: number;
  mcpSessions: number;
  /** "disk" when games are saved under RISK_DATA_DIR, "disabled" otherwise; never the path. */
  persistence: 'disk' | 'disabled';
  shuttingDown: boolean;
  /** Event-loop lag: the 99th percentile over the last full minute (the current one until a minute has passed), in ms. */
  loopLagMs: number;
}

/** The repo's AI/ folder: three levels up from packages/server/src (tsx) or packages/server/dist (built). */
export const DEFAULT_AI_DIR = fileURLToPath(new URL('../../../AI', import.meta.url));

export function createRiskServer(store: Store, opts: AppOptions = {}): RiskServer {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(cors());

  const startedAt = Date.now();
  let shuttingDown = false;

  // API and health responses must never be cached by browsers or the CDN.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Link previews: the board picture for a shared game link, outside /api (which stays no-store, hard rule 6). A cache
  // may keep it for a minute: crawlers fetch it rarely, and the page's og:image URL carries the game version.
  const ogImages = new OgImages();
  app.get('/og/game/:file', (req, res, next) => {
    const m = /^([A-Za-z0-9]+)\.png$/.exec(String(req.params.file));
    const room = m ? store.get(m[1]) : undefined;
    if (!room || room.closed || room.state.phase === 'lobby') return res.status(404).json({ error: 'Game not found' });
    ogImages
      .gamePng(room)
      .then((png) => res.setHeader('Cache-Control', OG_IMAGE_CACHE).type('image/png').send(png))
      .catch(next);
  });
  const characters = opts.characters ?? new CharacterStore(DEFAULT_AI_DIR, null);
  // Nobody may register an AI character's id or name as a player name (player-keys.ts).
  const characterName = (name: string) => {
    const n = nameSkeleton(name);
    return characters.list().some((c) => nameSkeleton(c.id) === n || nameSkeleton(c.name) === n || nameSkeleton(c.id.split('/').pop()!) === n) ? 'that is an AI character' : null;
  };
  // The house roster's names (roster.ts) are the house's: nobody registers one, nor seats under one or a look-alike.
  store.playerKeys.reserved = (name) => characterName(name) ?? store.roster.reservedWhy(name);
  store.playerKeys.seatReserved = (name) => store.roster.reservedWhy(name);
  // A new roster name may not be a registered player's or an AI character's.
  store.roster.taken = (name) => (store.playerKeys.isRegistered(name) ? "that is a registered player's name" : characterName(name));
  // Hosting codes, caps and expiry: one instance for the HTTP API and the MCP. Creates pause while the loop lags.
  // The brake reads only a finished minute's p99, so it acts on lag that stayed high, not on a start-up blip.
  const tourneyAccess = new TournamentAccess(store.tournaments, opts.tourneyAccess ?? NO_TOURNEY_CAPS, opts.tourneyAccessFile ?? null, () => lastMinuteLagMs ?? 0);
  if (opts.sweepIntervalMs !== 0) tourneyAccess.startSweeper();
  // Delove seats on request: the pool claims seats; unfilled ones become Zergs at the start; the preview shows the pool.
  const seatRequests = new SeatRequests(store.tournaments, tourneyAccess.config, opts.seatPoolKey ?? null, opts.seatRequestsFile ?? null, opts.seatPoolLockFile ?? null);
  store.tournaments.beforeStart = (t) => seatRequests.onStart(t);
  // Disconnected seats: the pool may take a dropped seat over from the house bot ("<name>-Delove").
  seatRequests.rooms = (id) => store.get(id);
  // A claim of a request with roster names hands the pool their names and models (the pool key holds the answer key).
  seatRequests.rosterEntry = (id) => store.roster.get(id);
  store.tournaments.onSeatDropped = (d) => seatRequests.openTakeover(d.tournamentId, d.gameId, d.playerId, d.name, d.fog);
  // House AI (nested seating and round close): the seats the Delove seat pool joined.
  store.tournaments.houseAiEntrants = (id) => seatRequests.boundEntrants(id);
  // A full daily tournament: a person or agent joining takes a house-roster seat's place (roster seats yield).
  store.tournaments.roomFor = (t) => seatRequests.roomFor(t.id);
  store.tournaments.delovePool = seatRequests.enabled ? () => seatRequests.pool() : null;
  // The daily tournament's house roster: when a slot with `roster: N` opens, its seat request goes out with N roster
  // names (roster.ts pick: spread over the models, rotating day to day). The pool seats those names with their models
  // first; with fewer active names than N, the rest are plain "Delove N" seats.
  const onScheduleOpened = (t: Parameters<typeof seatRequests.openFor>[0], e: ScheduleEntry) => seatRequests.openFor(t, store.roster.pick(e.roster));
  if (opts.tournamentSchedule?.length) store.schedule = new TournamentScheduler(store.tournaments, opts.tournamentSchedule, opts.scheduleFile ?? null, onScheduleOpened);
  // The recurring tournaments' settings page (schedule-settings.ts) edits and replaces that schedule.
  const scheduleSettings = new ScheduleSettings(store, opts.scheduleEntriesFile ?? null, opts.scheduleFile ?? null, onScheduleOpened, opts.scheduleRaw ?? [], opts.tournamentSchedule?.length ? (opts.scheduleSource ?? null) : null, opts.envSchedule ?? null);
  app.use('/api', createApi(store, { adminToken: opts.adminToken, recordsKey: opts.recordsKey, openTournaments: opts.openTournaments ?? true, tourneyAccess, seatRequests, characters, seasonKey: opts.seasonKey, seasonGuard: opts.seasonGuard, seasonLockFile: opts.seasonLockFile, scheduleSettings }));
  if (opts.sweepIntervalMs !== 0) store.startSweeper(opts.sweepIntervalMs ?? 30_000);

  // Remote MCP endpoint for AI agents (claude.ai connectors, any Streamable HTTP MCP client).
  const mcp = createMcpRouter(store, characters, opts.mcpLabel ?? 'Risky Business', opts.adminToken ?? null, opts.openTournaments ?? true, tourneyAccess, seatRequests);
  app.use('/mcp', mcp.router);

  // Event-loop lag for /healthz: a histogram read and reset every minute.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let lastMinuteLagMs: number | null = null;
  const lagTimer = setInterval(() => {
    lastMinuteLagMs = loopDelay.count ? Math.round(loopDelay.percentile(99) / 1e6) : 0;
    loopDelay.reset();
  }, 60_000);
  lagTimer.unref();
  const loopLagMs = () => lastMinuteLagMs ?? (loopDelay.count ? Math.round(loopDelay.percentile(99) / 1e6) : 0);

  const health = (): HealthReport => {
    const info = buildInfo();
    let playing = 0;
    let lobbies = 0;
    let finished = 0;
    for (const r of store.rooms.values()) {
      if (r.state.phase === 'lobby') lobbies++;
      else if (r.state.phase === 'finished') finished++;
      else playing++;
    }
    return {
      ok: true,
      version: info.version,
      build: info.build,
      commit: info.commit,
      builtAt: info.builtAt,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      playing,
      lobbies,
      finished,
      games: store.rooms.size,
      connections: wss.clients.size,
      mcpSessions: mcp.sessions.size,
      persistence: store.describePersistence(),
      shuttingDown,
      loopLagMs: loopLagMs(),
    };
  };

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(health());
  });

  const clientDir = opts.clientDir ?? null;
  if (clientDir && existsSync(join(clientDir, 'index.html'))) {
    const noCache = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache');
    app.use(
      express.static(clientDir, {
        index: false,
        etag: true,
        setHeaders: (res, path) => {
          // Vite emits content-hashed files under /assets: safe to cache forever.
          if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // SPA entry + history fallback: always revalidated so a new deploy is picked up on next load.
    // The page carries link-preview tags for the game or tournament in its query (og:/twitter:, see og.ts). The built
    // index.html is read again whenever it changes on disk: a rebuild in place replaces the hashed /assets it names, so
    // a copy held from startup would point at deleted files (a blank page) until the next restart, e.g. when the
    // deploy's test gate fails after the build. Absolute URLs come from this request (no hard-coded host).
    const indexPath = join(clientDir, 'index.html');
    let indexHtml = readFileSync(indexPath, 'utf8');
    let indexMtime = statSync(indexPath).mtimeMs;
    const currentIndex = () => {
      try {
        const mtime = statSync(indexPath).mtimeMs;
        if (mtime !== indexMtime) {
          indexHtml = readFileSync(indexPath, 'utf8');
          indexMtime = mtime;
        }
      } catch {
        // Mid-rebuild (the file is briefly gone): keep the last copy.
      }
      return indexHtml;
    };
    app.get(/^(?!\/api|\/ws|\/healthz|\/mcp|\/og\/).*/, (req, res) => {
      noCache(res);
      const origin = `${req.protocol}://${req.get('host')}`;
      res.type('html').send(withOgTags(currentIndex(), ogTags(store, req.query, origin)));
    });
  } else {
    app.get('/', (_req, res) =>
      res
        .type('text')
        .set('Cache-Control', 'no-store')
        .send(`Risk server running. Client build not found${clientDir ? ` at ${clientDir}` : ''} - run "npm run build" to serve the web UI.\nAPI: /api/games`),
    );
  }

  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const wss = attachWebSocket(server, store, () => buildInfo().commit);

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason = 'shutdown'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`[${reason}] shutting down: saving ${store.rooms.size} game(s)…`);
      store.save();
      // Tell browsers to reconnect (1012 = service restart); they back off and retry.
      for (const c of wss.clients) {
        try {
          if (c.readyState === WebSocket.OPEN) c.close(1012, 'server restarting');
        } catch {
          /* ignore */
        }
      }
      // Release long-poll waiters so in-flight HTTP requests finish quickly, and end MCP streams.
      store.releaseWaiters();
      await mcp.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        setTimeout(resolve, 3000).unref();
      });
      store.stopTimers();
      clearInterval(lagTimer);
      tourneyAccess.stopSweeper();
      loopDelay.disable();
      console.log('shutdown complete');
    })();
    return shutdownPromise;
  };

  return {
    app,
    server,
    store,
    characters,
    startedAt,
    connections: () => wss.clients.size,
    health,
    shutdown,
  };
}
