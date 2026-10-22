import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { MAP_IDS, RULES_TEXT, RuleError, getMap, observeStep, optionCatalogue, parseOptions, redactEvents, stateAtStep, type Action, type GameOptions, type MapDef } from '@risk/engine';

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
import type { GameRoom, RankingBoard, Store } from './store.js';
import { BOT_KINDS, type BotKind } from './bot.js';
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
  /** TEMPORARY (testing): POST /tournaments creates a tournament without the admin token. */
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

  const characterProfile = (key: string) => {
    if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(key) || !characters) return null;
    try { return characters.get(key).markdown; } catch { return null; /* historical character may have been removed */ }
  };
  const rankedProfile = (key: string, name: string, season?: string, board?: RankingBoard) => ({ stats: store.board(board).profile(key, name, season), profile: characterProfile(key) });
  // ?season=<id> reads an archived season (ids from /rankings/seasons); without it, the current one.
  const seasonOf = (req: Request) => (req.query.season === undefined ? undefined : String(req.query.season).slice(0, 20));
  // ?board=training reads the training leaderboard (yardstick games; no seasons), ?board=tournament the tournament one
  // (its own rows: points, tournaments, championships...); ?board=public or none, the public one.
  const boardOf = (req: Request): LeaderboardName | undefined => parseLeaderboard(req.query.board, true);
  api.get('/rankings', (req, res) => {
    const board = boardOf(req);
    if (board === 'tournament') return res.json({ board, current: true, rankings: store.tournamentBoard.rows() });
    if (board) return res.json({ board, season: String(store.training.season), current: true, rankings: store.training.rows() });
    const season = seasonOf(req);
    const rankings = store.rankings.seasonRows(season);
    if (!rankings) return res.status(404).json({ error: `No leaderboard season ${season}` });
    res.json({ season: season || String(store.rankings.season), current: !season || season === String(store.rankings.season), rankings });
  });
  api.get('/rankings/seasons', (_req, res) => res.json({ current: store.rankings.season, seasons: store.rankings.seasons() }));
  // Match history for the home page: finished games from the archive index, newest first. Only the public outcome
  // (seats, places, winner, turns), never a board, so fog games are safe to list. Empty when records are off.
  // ?board=training lists only training games (board "training"), ?board=tournament only tournament tables, ?board=public
  // only the others (the games the public leaderboard ranks).
  api.get(
    '/history',
    wrap((req, res) => {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100));
      const filter = req.query.board === undefined ? null : String(req.query.board);
      if (filter !== null) parseLeaderboard(filter, true);
      const boardOfGame = (g: { board?: string; tournamentId?: string }) => (g.board === 'training' ? 'training' : g.tournamentId ? 'tournament' : 'public');
      const games = store.archive
        .list(Infinity)
        .filter((g) => g.finished && g.winner)
        .filter((g) => filter === null || boardOfGame(g) === filter)
        .slice(0, limit)
        .map((g) => ({
          id: g.id,
          room: g.room,
          name: g.name,
          map: g.map,
          fog: g.fog,
          ...(g.tournamentId ? { tournamentId: g.tournamentId } : {}),
          ...(g.board ? { board: g.board } : {}),
          scenario: !!g.scenarioOf,
          startedAt: g.startedAt,
          endedAt: g.endedAt,
          winner: g.winner,
          reason: g.reason,
          turns: g.turns,
          players: g.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, characterId: p.characterId, place: p.place, ...(p.agent ? { agent: p.agent } : {}) })),
        }));
      res.json({ enabled: store.archive.enabled, games });
    }),
  );
  api.get('/rankings/profile', (req, res) => {
    const key = String(req.query.key ?? '').slice(0, 200);
    if (!key) return res.status(400).json({ error: 'Profile key is required' });
    const board = boardOf(req);
    if (board === 'tournament') return res.json({ stats: store.tournamentBoard.profile(key, key.split(/[/:]/).pop()!), profile: characterProfile(key), board });
    const season = board ? undefined : seasonOf(req);
    if (!store.rankings.seasonRows(season)) return res.status(404).json({ error: `No leaderboard season ${season}` });
    res.json({ ...rankedProfile(key, key.split('/').pop()!, season, board), ...(board ? { board } : {}) });
  });
  api.get('/games/:id/players/:player/profile', loadRoom, (req: Req, res) => {
    const player = req.room!.state.players.find(p => p.id === req.params.player && !p.isNeutral);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const key = req.room!.characterIds[player.id] ?? `${player.isBot ? 'bot' : 'player'}:${player.name.trim().toLowerCase()}`;
    // A training game shows its seats' training standing.
    res.json(rankedProfile(key, player.name, undefined, req.room!.board));
  });
  api.post('/games/:id/character', loadRoom, requirePlayer, (req: Req, res) => {
    const id = String(req.body?.characterId ?? '');
    if (!characters) return res.status(404).json({ error: 'Characters unavailable' });
    // Binding credits the character on the public leaderboard, so it needs the same write key as saves.
    const key = req.headers['x-characters-key'];
    characters.checkWrite(typeof key === 'string' ? key : undefined);
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
      // board "training": a yardstick game for the training leaderboard. Not a game setting (it changes no rule), and it
      // takes the characters write key, so nobody can hide a public game's result or fill the training board.
      const board = parseBoard(body.board);
      if (board) {
        const key = req.headers['x-characters-key'];
        try {
          if (!characters) throw new Error('no characters');
          characters.checkWrite(typeof key === 'string' ? key : undefined);
        } catch {
          return res.status(403).json({ error: 'A training-board game needs the characters write key in the x-characters-key header' });
        }
      }
      const { room, playerId, token } = store.create(String(body.gameName ?? body.name ?? ''), options, playerName, Boolean(body.asBot), board, parseAgent(body.agent));
      res.status(201).json({ gameId: room.id, playerId, token, state: room.view(playerId), host: room.hostId });
    }),
  );

  api.get(
    '/games/:id',
    loadRoom,
    wrap((req, res) => {
      const room = req.room!;
      // Only a watcher with no seat token sees the player-type labels.
      res.json({ state: req.playerId ? room.view(req.playerId) : room.spectatorView(), host: room.hostId, name: room.name, playerId: req.playerId ?? null });
    }),
  );

  api.post(
    '/games/:id/join',
    loadRoom,
    wrap((req, res) => {
      const room = req.room!;
      const name = String(req.body?.playerName ?? req.body?.name ?? 'Player');
      const { playerId, token } = room.join(name, Boolean(req.body?.asBot), 'bot', parseAgent(req.body?.agent));
      res.status(201).json({ gameId: room.id, playerId, token, state: room.view(playerId), host: room.hostId });
    }),
  );

  api.post(
    '/games/:id/bots',
    loadRoom,
    requireHost,
    wrap((req, res) => {
      const room = req.room!;
      const kind = parseBotKind(req.body?.kind);
      const name = req.body?.name == null ? undefined : String(req.body.name);
      const { playerId } = room.addBot(kind, name);
      const seat = room.state.players.find((p) => p.id === playerId)!;
      res.status(201).json({ playerId, name: seat.name, state: room.view(req.playerId!) });
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
  // Move a game to the training board: for yardstick games created before they could be flagged. Its result leaves the
  // public leaderboard (current season) for the training one, its open room is flagged and its records are marked.
  api.post(
    '/admin/games/:id/board',
    requireAdmin,
    wrap((req, res) => {
      if (req.body?.board !== 'training') return res.status(400).json({ error: 'board must be "training"' });
      let moved;
      try {
        moved = store.moveToTraining(String(req.params.id));
      } catch (e) {
        return res.status(500).json({ error: (e as Error).message });
      }
      if (!moved) return res.status(404).json({ error: 'No game, ranked result or record with that id' });
      res.json({ ok: true, board: 'training', ...moved });
    }),
  );
  // Archive the leaderboard now (kept as rankings.season-<N>.json, still readable) and start season N+1 empty.
  api.post(
    '/admin/rankings/new-season',
    requireAdmin,
    wrap((_req, res) => {
      try {
        res.json(store.rankings.newSeason());
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    }),
  );

  // ---- game archive: every recorded game, move by move, with fog of war views (admin only: it shows hidden boards) ----
  api.get(
    '/admin/archive',
    requireAdmin,
    wrap((req, res) => {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 10_000));
      res.json({ enabled: store.archive.enabled, games: store.archive.list(limit) });
    }),
  );
  api.get(
    '/admin/archive/:id',
    requireAdmin,
    wrap((req, res) => {
      const record = store.archive.get(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'No recorded game with that id' });
      res.json(record);
    }),
  );
  // One moment of a recorded game, rebuilt by replay: the exact state before step N (a scenario to play out),
  // and what ?viewer=<playerId> saw then (fog applied) along with that step's events as shown to them.
  api.get(
    '/admin/archive/:id/steps/:step',
    requireAdmin,
    wrap((req, res) => {
      const record = store.archive.get(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'No recorded game with that id' });
      const step = Number(req.params.step);
      if (!Number.isInteger(step) || step < 0 || step > record.steps.length) return res.status(400).json({ error: `step must be 0..${record.steps.length}` });
      const viewer = typeof req.query.viewer === 'string' ? req.query.viewer : null;
      if (viewer && !record.players.some((p) => p.id === viewer)) return res.status(400).json({ error: 'viewer is not a player in this game' });
      res.json({ step, state: stateAtStep(record, step), ...observeStep(record, step, viewer) });
    }),
  );

  // A scenario: a new live game that begins at one moment of a recorded game, for bots, agents or people to play
  // out differently. Body: {recordId, step, seats?: {<playerId>: 'bot' | 'open'}, keepDice?, name?}. Returns every
  // seat's token: an open seat is played by whoever holds it; a bot seat can be taken over with POST /games/:id/seat.
  api.post(
    '/admin/scenarios',
    requireAdmin,
    wrap((req, res) => {
      const body = req.body ?? {};
      if (!store.archive.enabled) return res.status(404).json({ error: 'Game records are off (no persistence or RISK_ARCHIVE=0)' });
      const record = typeof body.recordId === 'string' ? store.archive.get(body.recordId) : null;
      if (!record) return res.status(404).json({ error: 'No recorded game with that id' });
      const step = body.step;
      if (!Number.isInteger(step) || step < 0 || step > record.steps.length) return res.status(400).json({ error: `step must be 0..${record.steps.length}` });
      if (body.seats !== undefined && (typeof body.seats !== 'object' || body.seats === null || Array.isArray(body.seats)))
        throw new RuleError('seats must be an object: {<playerId>: "bot" | "open"}');
      if (body.keepDice !== undefined && typeof body.keepDice !== 'boolean') throw new RuleError('keepDice must be true or false');
      const { room, seats } = store.createScenario(record, step, {
        seats: body.seats,
        keepDice: body.keepDice,
        name: typeof body.name === 'string' ? body.name : undefined,
      });
      res.status(201).json({ gameId: room.id, name: room.name, scenarioOf: room.scenarioOf, seats, game: room.summary() });
    }),
  );

  // ---- tournaments: the host creates and runs them (host token or admin key); anyone can join, follow and watch ----
  // Create answers with the host token, once: it starts, forfeits for and deletes that tournament.
  const created = (res: Response, t: { id: string; hostToken?: string }) =>
    res.status(201).json({ hostToken: t.hostToken, tournament: store.tournaments.view(t.id) });
  api.post(
    '/admin/tournaments',
    requireAdmin,
    wrap((req, res) => created(res, store.tournaments.create(parseTournamentSpec(req.body ?? {})))),
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

  // TEMPORARY (testing): while tournaments are open, anyone can create one here, no admin token.
  // With openTournaments off this answers 403 and only POST /admin/tournaments creates.
  function requireOpenTournaments(_req: Request, res: Response, next: NextFunction) {
    if (!opts.openTournaments) return res.status(403).json({ error: 'Only the host can create tournaments' });
    next();
  }
  api.post(
    '/tournaments',
    requireOpenTournaments,
    wrap((req, res) => created(res, store.tournaments.create(parseTournamentSpec(req.body ?? {})))),
  );

  // The tournament's own host: its host token, or the admin key. Tournaments saved before host tokens are admin-only.
  function requireTournamentHost(req: Request, res: Response, next: NextFunction) {
    const id = String(req.params.id);
    if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
    const key = tokenOf(req);
    if (!key) return res.status(401).json({ error: "The tournament's host token (or the admin key) is required" });
    if (store.tournaments.isHost(id, key) || checkAdmin(adminToken, key) === 'ok') return next();
    res.status(403).json({ error: "Only this tournament's host can do that" });
  }
  api.post(
    '/tournaments/:id/start',
    requireTournamentHost,
    wrap((req, res) => {
      const t = store.tournaments.start(String(req.params.id));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  // The host adds server bots while registering: { kind: "bot" | "zerg" (default "bot"), count (default 1) }.
  api.post(
    '/tournaments/:id/bots',
    requireTournamentHost,
    wrap((req, res) => {
      const id = String(req.params.id);
      const count = req.body?.count === undefined ? 1 : Number(req.body.count);
      const added = store.tournaments.addBots(id, parseBotKind(req.body?.kind), count);
      res.status(201).json({ added, tournament: store.tournaments.view(id) });
    }),
  );
  api.post(
    '/tournaments/:id/forfeit',
    requireTournamentHost,
    wrap((req, res) => {
      const t = store.tournaments.forfeit(String(req.params.id), String(req.body?.entrantId ?? ''));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  api.delete(
    '/tournaments/:id',
    requireTournamentHost,
    wrap((req, res) => {
      store.tournaments.delete(String(req.params.id));
      res.json({ ok: true });
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
      const { entrantId, token } = store.tournaments.join(String(req.params.id), req.body?.playerName ?? req.body?.name, parseAgent(req.body?.agent));
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

  // Scenarios: the holder of a seat's token takes it over from its bot ({bot: false}, the default) or hands it back ({bot: true}).
  api.post(
    '/games/:id/seat',
    loadRoom,
    requirePlayer,
    wrap((req, res) => {
      const room = req.room!;
      const bot = req.body?.bot ?? false;
      if (typeof bot !== 'boolean') throw new RuleError('bot must be true or false');
      room.setSeatBot(req.playerId!, bot);
      res.json({ ok: true, state: room.view(req.playerId!) });
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
        state: req.playerId ? room.view(req.playerId) : room.spectatorView(),
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
      // No seat: post as a spectator under the given name (flood-guarded per IP), or whisper to one player.
      if (!req.playerId) {
        return res.status(201).json({ message: room.addSpectatorChat(`ip:${req.ip}`, req.body?.name, message, to) });
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

/**
 * A board name from an untrusted body or query: undefined for none (or "public" where `allowPublic`), "training", or a
 * 400 for anything else.
 */
/** A leaderboard to read: a room board ("training") or "tournament". */
export type LeaderboardName = RankingBoard | 'tournament';

/** A leaderboard name from an untrusted query: undefined for the public one, else "training" or "tournament". */
export function parseLeaderboard(raw: unknown, allowPublic = false): LeaderboardName | undefined {
  if (raw === 'tournament') return 'tournament';
  if (raw === undefined || raw === null || (allowPublic && raw === 'public') || raw === 'training') return parseBoard(raw, allowPublic);
  throw new RiskHttpError(`board must be "training" or "tournament"${allowPublic ? ' or "public"' : ''}`, 400);
}

export function parseBoard(raw: unknown, allowPublic = false): RankingBoard | undefined {
  if (raw === undefined || raw === null || (allowPublic && raw === 'public')) return undefined;
  if (raw === 'training') return 'training';
  throw new RiskHttpError(`board must be "training"${allowPublic ? ' or "public"' : ''}`, 400);
}

const AGENT = /^[A-Za-z0-9 @._:/()+-]{1,40}$/;

/**
 * A seat's self-declared player type from an untrusted body ("claude-sonnet-5-5", "delove@10", "human"): up to 40
 * letters, digits, spaces and @ . _ : / ( ) + -. Absent or empty is undefined (unknown); anything else is a 400.
 */
export function parseAgent(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const label = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (label === '' && typeof raw === 'string') return undefined;
  if (!AGENT.test(label)) throw new RiskHttpError('agent must be 1-40 letters, digits, spaces or @ . _ : / ( ) + -', 400);
  return label;
}

/** A bot kind from an untrusted body: "bot" (the default) or "zerg", or a 400 for anything else. */
export function parseBotKind(raw: unknown): BotKind {
  if (raw === undefined || raw === null) return 'bot';
  if (BOT_KINDS.includes(raw as BotKind)) return raw as BotKind;
  throw new RiskHttpError(`kind must be one of ${BOT_KINDS.map((k) => `"${k}"`).join(', ')}`, 400);
}

/** Options from an untrusted body: unknown keys and wrong types are a 400 with a message listing them. */
export function sanitizeOptions(raw: unknown): Partial<GameOptions> {
  return parseOptions(raw);
}
