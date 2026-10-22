import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { existsSync, readFileSync } from 'node:fs';
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
import { CharacterStore } from './characters.js';
import type { SeasonKeyGuard } from './season-key.js';
import { NO_TOURNEY_CAPS, TournamentAccess, type TourneyAccessConfig } from './tournament-access.js';
import { SeatRequests } from './seat-requests.js';
import { TournamentScheduler, type ScheduleEntry } from './tournament-schedule.js';

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
  store.playerKeys.reserved = (name) => {
    const n = name.trim().toLowerCase();
    return characters.list().some((c) => c.id.toLowerCase() === n || c.name.toLowerCase() === n || c.id.split('/').pop()!.toLowerCase() === n) ? 'that is an AI character' : null;
  };
  // Hosting codes, caps and expiry: one instance for the HTTP API and the MCP. Creates pause while the loop lags.
  // The brake reads only a finished minute's p99, so it acts on lag that stayed high, not on a start-up blip.
  const tourneyAccess = new TournamentAccess(store.tournaments, opts.tourneyAccess ?? NO_TOURNEY_CAPS, opts.tourneyAccessFile ?? null, () => lastMinuteLagMs ?? 0);
  if (opts.sweepIntervalMs !== 0) tourneyAccess.startSweeper();
  // Delove seats on request: the pool claims seats; unfilled ones become Zergs at the start; the preview shows the pool.
  const seatRequests = new SeatRequests(store.tournaments, tourneyAccess.config, opts.seatPoolKey ?? null, opts.seatRequestsFile ?? null, opts.seatPoolLockFile ?? null);
  store.tournaments.beforeStart = (t) => seatRequests.onStart(t);
  store.tournaments.delovePool = seatRequests.enabled ? () => seatRequests.pool() : null;
  app.use('/api', createApi(store, { adminToken: opts.adminToken, recordsKey: opts.recordsKey, openTournaments: opts.openTournaments ?? true, tourneyAccess, seatRequests, characters, seasonKey: opts.seasonKey, seasonGuard: opts.seasonGuard, seasonLockFile: opts.seasonLockFile }));
  if (opts.sweepIntervalMs !== 0) store.startSweeper(opts.sweepIntervalMs ?? 30_000);
  if (opts.tournamentSchedule?.length) store.schedule = new TournamentScheduler(store.tournaments, opts.tournamentSchedule, opts.scheduleFile ?? null);

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
    // index.html is read once; absolute URLs come from this request (no hard-coded host).
    const indexHtml = readFileSync(join(clientDir, 'index.html'), 'utf8');
    app.get(/^(?!\/api|\/ws|\/healthz|\/mcp|\/og\/).*/, (req, res) => {
      noCache(res);
      const origin = `${req.protocol}://${req.get('host')}`;
      res.type('html').send(withOgTags(indexHtml, ogTags(store, req.query, origin)));
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
