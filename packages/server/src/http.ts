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
import { CHARACTER_DATA_NOTICE, RiskHttpError } from '@risk/mcp';
import type { GameRoom, Store } from './store.js';
import type { CharacterStore } from './characters.js';
import type { CreateTournamentSpec } from './tournaments.js';

/** Constant-time check of an admin token. 'disabled' when the server has none configured. */
export function checkAdmin(adminToken: string | null | undefined, given: string | undefined): 'ok' | 'bad' | 'disabled' {
  if (!adminToken) return 'disabled';
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'bad';
}

/** Tournament settings from an untrusted body. Game settings go through the same strict parser as games. */
export function parseTournamentSpec(body: Record<string, unknown>): CreateTournamentSpec {
  const int = (v: unknown, key: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new RuleError(`${key} must be a whole number`);
    return v;
  };
  if (body.fillBots !== undefined && typeof body.fillBots !== 'boolean') throw new RuleError('fillBots must be true or false');
  return {
    name: body.name === undefined ? undefined : String(body.name),
    options: body.options === undefined ? undefined : parseOptions(body.options),
    groupSize: int(body.groupSize, 'groupSize'),
    maxEntrants: int(body.maxEntrants, 'maxEntrants'),
    fillBots: body.fillBots as boolean | undefined,
  };
}

type Req = Request & { room?: GameRoom; playerId?: string | null };

export interface ApiOptions {
  /** Enables /api/admin/* when set (Authorization: Bearer <token>). */
  adminToken?: string | null;
  characters?: CharacterStore;
  /** TEMPORARY (testing): POST /tournaments and /tournaments/:id/start work without the admin token. */
  openTournaments?: boolean;
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

  // ---- AI character profiles (no auth, like /mcp: every save is a new version, so edits can be rolled back) ----
  const characters = opts.characters;
  if (characters) {
    const cid = (req: Request) => `${req.params.universe}/${req.params.name}`;
    const writeKey = (req: Request) => {
      const k = req.headers['x-characters-key'];
      return typeof k === 'string' ? k : undefined;
    };
    api.get('/characters', (req, res) => {
      const list = characters.list();
      // ?full=1 includes each latest profile, for syncing saves back into the repo's AI/ folder.
      // Saved text is untrusted: review it by hand before it goes into the repo.
      res.json(req.query.full ? { notice: CHARACTER_DATA_NOTICE, characters: list.map((c) => characters.get(c.id)) } : { characters: list });
    });
    api.get('/characters/:universe/:name', (req, res) => {
      const v = req.query.version;
      res.json(characters.get(cid(req), typeof v === 'string' && v !== '' ? Number(v) : undefined));
    });
    api.get('/characters/:universe/:name/history', (req, res) => res.json(characters.history(cid(req))));
    api.post('/characters/:universe/:name', (req, res) => {
      const b = req.body ?? {};
      const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
      res.json(
        characters.update(cid(req), {
          markdown: str(b.markdown),
          section: str(b.section),
          content: str(b.content),
          expectedVersion: typeof b.expectedVersion === 'number' ? b.expectedVersion : undefined,
          note: str(b.note),
        }, writeKey(req)),
      );
    });
    api.get('/characters/:universe/:name/memory', (req, res) => res.json(characters.memorySummary(cid(req))));
    api.get('/characters/:universe/:name/diary', (req, res) => {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      res.json(characters.readDiary(cid(req), Number.isFinite(limit) ? limit : undefined, typeof req.query.gameId === 'string' ? req.query.gameId : undefined));
    });
    api.post('/characters/:universe/:name/diary', (req, res) => res.status(201).json(characters.addDiaryEntry(cid(req), req.body ?? {}, writeKey(req))));
    api.post('/characters/:universe/:name/relationships', (req, res) => res.json(characters.updateRelationship(cid(req), req.body ?? {}, writeKey(req))));
    api.get('/model-info', (_req, res) => res.json(characters.modelInfo()));
  }

  const rankedProfile = (key: string, name: string) => {
    let profile: string | null = null;
    if (/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(key) && characters) {
      try { profile = characters.get(key).markdown; } catch { /* historical character may have been removed */ }
    }
    return { stats: store.rankings.profile(key, name), profile };
  };
  api.get('/rankings', (_req, res) => res.json({ rankings: store.rankings.rows() }));
  api.get('/rankings/profile', (req, res) => {
    const key = String(req.query.key ?? '').slice(0, 200);
    if (!key) return res.status(400).json({ error: 'Profile key is required' });
    res.json(rankedProfile(key, key.split('/').pop()!));
  });
  api.get('/games/:id/players/:player/profile', loadRoom, (req: Req, res) => {
    const player = req.room!.state.players.find(p => p.id === req.params.player && !p.isNeutral);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const key = req.room!.characterIds[player.id] ?? `${player.isBot ? 'bot' : 'player'}:${player.name.trim().toLowerCase()}`;
    res.json(rankedProfile(key, player.name));
  });
  api.post('/games/:id/character', loadRoom, requirePlayer, (req: Req, res) => {
    const id = String(req.body?.characterId ?? '');
    if (!characters) return res.status(404).json({ error: 'Characters unavailable' });
    const canonical = characters.get(id).id;
    req.room!.bindCharacter(req.playerId!, canonical);
    res.json({ ok: true });
  });

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
    const check = checkAdmin(adminToken, tokenOf(req));
    if (check === 'disabled') return res.status(404).json({ error: 'Admin API disabled (set RISK_ADMIN_TOKEN)' });
    if (check === 'bad') return res.status(401).json({ error: 'Invalid admin token' });
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

  // ---- tournaments: the admin creates and runs them; anyone can join, follow and watch ----
  api.post(
    '/admin/tournaments',
    requireAdmin,
    wrap((req, res) => {
      const t = store.tournaments.create(parseTournamentSpec(req.body ?? {}));
      res.status(201).json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  api.post(
    '/admin/tournaments/:id/start',
    requireAdmin,
    wrap((req, res) => {
      const t = store.tournaments.start(String(req.params.id));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  api.post(
    '/admin/tournaments/:id/forfeit',
    requireAdmin,
    wrap((req, res) => {
      const t = store.tournaments.forfeit(String(req.params.id), String(req.body?.entrantId ?? ''));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  api.delete(
    '/admin/tournaments/:id',
    requireAdmin,
    wrap((req, res) => {
      if (!store.tournaments.delete(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      res.json({ ok: true });
    }),
  );

  // TEMPORARY (testing): while tournaments are open, anyone can create and start one here, no admin token.
  // With openTournaments off these answer 403 and only the /admin routes above work.
  function requireOpenTournaments(_req: Request, res: Response, next: NextFunction) {
    if (!opts.openTournaments) return res.status(403).json({ error: 'Only the host can create or start tournaments' });
    next();
  }
  api.post(
    '/tournaments',
    requireOpenTournaments,
    wrap((req, res) => {
      const t = store.tournaments.create(parseTournamentSpec(req.body ?? {}));
      res.status(201).json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  api.post(
    '/tournaments/:id/start',
    requireOpenTournaments,
    wrap((req, res) => {
      if (!store.tournaments.get(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      const t = store.tournaments.start(String(req.params.id));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );

  api.get('/tournaments', (_req, res) => res.json({ tournaments: store.tournaments.list() }));
  api.get(
    '/tournaments/:id',
    wrap((req, res) => {
      if (!store.tournaments.get(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      res.json({ tournament: store.tournaments.view(String(req.params.id), tokenOf(req)) });
    }),
  );
  api.post(
    '/tournaments/:id/join',
    wrap((req, res) => {
      if (!store.tournaments.get(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      const { entrantId, token } = store.tournaments.join(String(req.params.id), req.body?.playerName ?? req.body?.name);
      res.status(201).json({ entrantId, token, tournament: store.tournaments.view(String(req.params.id), token) });
    }),
  );
  api.get(
    '/tournaments/:id/wait',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 30000), 0), 120_000);
      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      const reason = await store.tournaments.waitFor(id, since, timeoutMs);
      if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
      res.json({ reason, tournament: store.tournaments.view(id, tokenOf(req)) });
    }),
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
      // A token that is not a seat here is an error, not a silent downgrade to the spectator view
      // (which would show the caller every whisper between other players).
      if (tokenOf(req) && !req.playerId) return res.status(401).json({ error: 'Unknown token for this game' });
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
    if (err instanceof RiskHttpError) return res.status(err.status).json({ error: err.message });
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
