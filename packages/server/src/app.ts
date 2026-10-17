import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocket } from 'ws';
import { Store } from './store.js';
import { createApi } from './http.js';
import { attachWebSocket } from './ws.js';
import { buildInfo } from './build-info.js';
import { createMcpRouter } from './mcp.js';
import { CharacterStore } from './characters.js';

export interface AppOptions {
  /** Directory holding the built web client (served if it exists). */
  clientDir?: string | null;
  /** Public label for the MCP endpoint's instructions (e.g. the site URL). */
  mcpLabel?: string;
  /** Enables /api/admin/* when set. */
  adminToken?: string | null;
  /** AI character profiles; defaults to the repo's AI/ folder with saves kept in memory. */
  characters?: CharacterStore;
  /**
   * TEMPORARY (testing): anyone may create and start tournaments, without the admin key (default true).
   * Turn off before launch (RISK_TOURNAMENTS_OPEN=0) so only the host can.
   */
  openTournaments?: boolean;
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
  persistence: string;
  shuttingDown: boolean;
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
  const characters = opts.characters ?? new CharacterStore(DEFAULT_AI_DIR, null);
  app.use('/api', createApi(store, { adminToken: opts.adminToken, openTournaments: opts.openTournaments ?? true, characters }));
  if (opts.sweepIntervalMs !== 0) store.startSweeper(opts.sweepIntervalMs ?? 5 * 60_000);

  // Remote MCP endpoint for AI agents (claude.ai connectors, any Streamable HTTP MCP client).
  const mcp = createMcpRouter(store, characters, opts.mcpLabel ?? 'Risky Business', opts.adminToken ?? null, opts.openTournaments ?? true);
  app.use('/mcp', mcp.router);

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
    };
  };

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(health());
  });

  const clientDir = opts.clientDir ?? null;
  if (clientDir && existsSync(join(clientDir, 'index.html'))) {
    const indexHtml = join(clientDir, 'index.html');
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
    app.get(/^(?!\/api|\/ws|\/healthz|\/mcp).*/, (_req, res) => {
      noCache(res);
      res.sendFile(indexHtml);
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
