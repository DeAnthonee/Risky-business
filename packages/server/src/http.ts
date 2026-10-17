import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { MAP_IDS, RULES_TEXT, RuleError, getMap, optionCatalogue, parseOptions, redactEvents, type Action, type GameOptions, type MapDef } from '@risk/engine';

/** Static map description for agents: no SVG paths, which are only useful to the web client. */
export function mapInfo(m: MapDef) {
  return {
    id: m.id,
    name: m.name,
    maxPlayers: m.maxPlayers,
    territories: m.territories.map(({ id, name, continent }) => ({ id, name, continent })),
    continents: m.continents.map(({ id, name, bonus, territories }) => ({ id, name, bonus, territories })),
    adjacency: m.adjacency,
  };
}
import type { GameRoom, Store } from './store.js';

type Req = Request & { room?: GameRoom; playerId?: string | null };

export interface ApiOptions {
  /** Enables /api/admin/* when set (Authorization: Bearer <token>). */
  adminToken?: string | null;
}

export function createApi(store: Store, opts: ApiOptions = {}) {
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  const wrap =
    (fn: (req: Req, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req as Req, res)).catch(next);
    };

  function tokenOf(req: Request): string | undefined {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    const q = req.query.token;
    return typeof q === 'string' ? q : undefined;
  }

  function loadRoom(req: Req, res: Response, next: NextFunction) {
    const room = store.get(String(req.params.id));
    if (!room || room.closed) return res.status(404).json({ error: 'Game not found' });
    req.room = room;
    req.playerId = room.playerForToken(tokenOf(req));
    next();
  }

  function requirePlayer(req: Req, res: Response, next: NextFunction) {
    if (!req.playerId) return res.status(401).json({ error: 'A valid player token is required' });
    next();
  }

  function requireHost(req: Req, res: Response, next: NextFunction) {
    if (!req.playerId || req.room!.hostId !== req.playerId) return res.status(403).json({ error: 'Only the host can do that' });
    next();
  }

  // ---- static info ----
  api.get('/rules', (_req, res) => res.json({ rules: RULES_TEXT }));
  api.get('/map', (req, res) => {
    const m = getMap(typeof req.query.map === 'string' ? req.query.map : 'classic');
    res.json(mapInfo(m));
  });
  api.get('/options', (_req, res) => res.json(optionCatalogue()));
  api.get('/maps', (_req, res) => res.json({ maps: MAP_IDS.map((id) => ({ id, name: getMap(id).name, territories: getMap(id).territoryIds.length, maxPlayers: getMap(id).maxPlayers })) }));

  // ---- games ----
  api.get('/games', (_req, res) => res.json({ games: store.list() }));

  api.post(
    '/games',
    wrap((req, res) => {
      const body = req.body ?? {};
      const playerName = String(body.playerName ?? body.name ?? 'Player');
      const options = sanitizeOptions(body.options);
      const { room, playerId, token } = store.create(String(body.gameName ?? body.name ?? ''), options, playerName, Boolean(body.asBot));
      res.status(201).json({ gameId: room.id, playerId, token, state: room.view(playerId), host: room.hostId });
    }),
  );

  api.get(
    '/games/:id',
    loadRoom,
    wrap((req, res) => {
      const room = req.room!;
      res.json({ state: room.view(req.playerId ?? null), host: room.hostId, name: room.name, playerId: req.playerId ?? null });
    }),
  );

  api.post(
    '/games/:id/join',
    loadRoom,
    wrap((req, res) => {
      const room = req.room!;
      const name = String(req.body?.playerName ?? req.body?.name ?? 'Player');
      const { playerId, token } = room.join(name, Boolean(req.body?.asBot));
      res.status(201).json({ gameId: room.id, playerId, token, state: room.view(playerId), host: room.hostId });
    }),
  );

  api.post(
    '/games/:id/bots',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      const room = req.room!;
      const n = room.state.players.filter((p) => p.isBot).length + 1;
      const name = String(req.body?.name ?? `Bot ${n}`);
      const { playerId } = room.join(name, true);
      res.status(201).json({ playerId, state: room.view(req.playerId!) });
    }),
  );

  api.post(
    '/games/:id/close',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      store.delete(req.room!.id, 'host');
      res.json({ ok: true });
    }),
  );

  // ---- admin (only when RISK_ADMIN_TOKEN is configured) ----
  const adminToken = opts.adminToken || null;
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!adminToken) return res.status(404).json({ error: 'Admin API disabled (set RISK_ADMIN_TOKEN)' });
    const given = tokenOf(req) ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(adminToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid admin token' });
    next();
  }
  api.get(
    '/admin/games',
    requireAdmin,
    wrap((_req, res) => {
      const now = Date.now();
      res.json({
        retention: store.retention,
        games: [...store.rooms.values()].map((r) => ({
          ...r.summary(),
          lastActivity: r.lastActivity,
          idleMinutes: Math.round((now - r.lastActivity) / 60_000),
          connections: r.connections,
          watched: r.isWatched(),
          wouldSweep: store.staleReason(r, now),
        })),
      });
    }),
  );
  api.delete(
    '/admin/games/:id',
    requireAdmin,
    wrap((req, res) => {
      const ok = store.delete(String(req.params.id), 'admin');
      if (!ok) return res.status(404).json({ error: 'Game not found' });
      res.json({ ok: true });
    }),
  );
  api.post(
    '/admin/sweep',
    requireAdmin,
    wrap((_req, res) => res.json({ removed: store.sweep() })),
  );

  api.post(
    '/games/:id/kick',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      const room = req.room!;
      const target = String(req.body?.playerId ?? '');
      if (target === room.hostId) return res.status(400).json({ error: 'Cannot kick the host' });
      room.leave(target);
      res.json({ state: room.view(req.playerId!) });
    }),
  );

  api.post(
    '/games/:id/leave',
    loadRoom,
    requirePlayer,
    wrap((req, res) => {
      const room = req.room!;
      if (room.state.phase === 'lobby') {
        room.leave(req.playerId!);
        if (!room.hasHumans()) store.delete(room.id, 'empty');
      } else {
        room.act(req.playerId!, { type: 'surrender' });
      }
      res.json({ ok: true });
    }),
  );

  api.post(
    '/games/:id/name',
    loadRoom,
    requirePlayer,
    wrap((req, res) => {
      const room = req.room!;
      room.rename(req.playerId!, String(req.body?.name ?? ''));
      res.json({ state: room.view(req.playerId!) });
    }),
  );

  api.post(
    '/games/:id/options',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      const room = req.room!;
      room.setOptions(sanitizeOptions(req.body?.options ?? req.body));
      res.json({ state: room.view(req.playerId!) });
    }),
  );

  api.post(
    '/games/:id/start',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      const room = req.room!;
      room.start();
      res.json({ state: room.view(req.playerId!) });
    }),
  );

  api.post(
    '/games/:id/actions',
    loadRoom,
    requirePlayer,
    wrap((req, res) => {
      const room = req.room!;
      const action = (req.body?.action ?? req.body) as Action;
      if (!action || typeof action !== 'object' || typeof action.type !== 'string')
        return res.status(400).json({ error: 'Body must be an action object with a "type"' });
      const { events } = room.act(req.playerId!, action);
      res.json({ ok: true, events: redactEvents(room.state, req.playerId!, events), state: room.view(req.playerId!) });
    }),
  );

  api.get(
    '/games/:id/events',
    loadRoom,
    wrap((req, res) => {
      const since = Number(req.query.since ?? 0);
      const room = req.room!;
      res.json({ version: room.state.version, entries: room.eventsSince(since).map((h) => ({ ...h, events: redactEvents(room.state, req.playerId ?? null, h.events) })) });
    }),
  );

  api.get(
    '/games/:id/wait',
    loadRoom,
    wrap(async (req, res) => {
      const room = req.room!;
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 30000), 0), 120_000);
      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      const reason = await room.waitFor(req.playerId ?? null, since, timeoutMs);
      res.json({
        reason,
        yourTurn: !!req.playerId && room.state.currentPlayer === req.playerId,
        state: room.view(req.playerId ?? null),
        events: since !== undefined ? room.eventsSince(since).map((h) => ({ ...h, events: redactEvents(room.state, req.playerId ?? null, h.events) })) : [],
      });
    }),
  );

  // ---- chat ----
  api.get(
    '/games/:id/chat',
    loadRoom,
    wrap((req, res) => {
      const since = Number(req.query.since ?? 0);
      res.json({ messages: req.room!.chatFor(req.playerId ?? null, since) });
    }),
  );

  api.post(
    '/games/:id/chat',
    loadRoom,
    wrap((req, res) => {
      const room = req.room!;
      const message = String(req.body?.message ?? '').trim();
      if (!message) return res.status(400).json({ error: 'Empty message' });
      const to = req.body?.to;
      // No seat: post as a spectator under the given name (flood-guarded per IP). Spectators can't whisper.
      if (!req.playerId) {
        if (to) return res.status(400).json({ error: 'Only seated players can whisper' });
        return res.status(201).json({ message: room.addSpectatorChat(`ip:${req.ip}`, req.body?.name, message) });
      }
      const player = room.state.players.find((p) => p.id === req.playerId);
      const msg = room.addChat(req.playerId!, player?.name ?? 'Unknown', message, to);
      res.status(201).json({ message: msg });
    }),
  );

  // ---- error handling ----
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RuleError) return res.status(400).json({ error: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return api;
}

/** Options from an untrusted body: unknown keys and wrong types are a 400 with a message listing them. */
export function sanitizeOptions(raw: unknown): Partial<GameOptions> {
  return parseOptions(raw);
}
