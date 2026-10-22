import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { MemoryIdentityStore, createRiskMcpServer } from '@risk/mcp';
import { LocalRiskApi } from './local-api.js';
import type { Store } from './store.js';
import type { CharacterStore } from './characters.js';
import type { TournamentAccess } from './tournament-access.js';
import type { SeatRequests } from './seat-requests.js';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

const SESSION_IDLE_MS = Number(process.env.RISK_MCP_SESSION_IDLE_MS ?? 6 * 3600_000);

/**
 * Remote MCP endpoint (Streamable HTTP) at /mcp, so claude.ai connectors and other remote
 * MCP clients can play without installing anything. One MCP session = one agent seat holder:
 * its game identities live in memory for the life of the session; tools also accept an explicit
 * token, and resume_game recovers a seat after a reconnect.
 */
export function createMcpRouter(store: Store, characters: CharacterStore, label: string, adminToken: string | null = null, openTournaments = true, access?: TournamentAccess, seatRequests?: SeatRequests) {
  const router = express.Router();
  const sessions = new Map<string, McpSession>();

  router.use(express.json({ limit: '1mb' }));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'];
    const existing = typeof sid === 'string' ? sessions.get(sid) : undefined;
    try {
      if (existing) {
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (sid || !isInitializeRequest(req.body)) {
        res.status(sid ? 404 : 400).json({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Session not found' : 'Bad Request: expected an initialize request' }, id: null });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = createRiskMcpServer({
        // Per connection, so quick play can cap tickets by the client's address.
        // Per connection: the client's address for per-client limits, and its player key (X-Player-Key header) if any.
        api: new LocalRiskApi(store, characters, adminToken, openTournaments, req.ip ?? null, access, playerKeyHeader(req), seatRequests),
        identities: new MemoryIdentityStore(),
        defaultName: 'Agent',
        serverLabel: label,
        identityNote:
          'This connection remembers the seats you take only while it stays open and connections are often re-established between turns, so ALWAYS pass your token. If a call says you are not in the game, use resume_game with your token.',
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'];
    const s = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!s) {
      res.status(sid ? 404 : 400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null });
      return;
    }
    s.lastSeen = Date.now();
    try {
      await s.transport.handleRequest(req, res);
    } catch (err) {
      console.error('[mcp] session request failed', err);
      if (!res.headersSent) res.status(500).end();
    }
  };
  router.get('/', sessionRequest);
  router.delete('/', sessionRequest);

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void s.transport.close().catch(() => sessions.delete(id));
  }, 10 * 60_000);
  sweeper.unref();

  const closeAll = async () => {
    clearInterval(sweeper);
    await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => {})));
    sessions.clear();
  };

  return { router, sessions, closeAll };
}

/** The X-Player-Key header of an MCP request (never a query string), or null. */
function playerKeyHeader(req: Request): string | null {
  const raw = req.headers['x-player-key'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v ? v : null;
}
