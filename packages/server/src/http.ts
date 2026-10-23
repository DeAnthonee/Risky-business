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
import { parseDecisionNote, type GameRoom, type RankingBoard, type Store } from './store.js';
import { BOT_KINDS, type BotKind } from './bot.js';
import { narrate, playByPlayText } from './playbyplay.js';
import type { CharacterStore } from './characters.js';
import type { CreateTournamentSpec } from './tournaments.js';
import { NO_TOURNEY_CAPS, TournamentAccess } from './tournament-access.js';
import { NO_SEAT_CAPS, SeatRequests, type SeatRequest } from './seat-requests.js';
import { droppedMessage } from './seat-health.js';
import { SeasonKeyGuard } from './season-key.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';
import { PLAYER_KEY_HEADER, PlayerKeyLimitError, type PlayerAccount } from './player-keys.js';
import { QuickPlayBusyError } from './quick-play.js';

/** Constant-time check of an admin token. 'disabled' when the server has none configured. */
export function checkAdmin(adminToken: string | null | undefined, given: string | undefined): 'ok' | 'bad' | 'disabled' {
  if (!adminToken) return 'disabled';
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'bad';
}

/**
 * Tournament settings from an untrusted body. Game settings go through the same strict parser as games. A fixed nested
 * `seed` decides the boards, seating and tie-break dice before anyone joins, so only the admin may set it (`admin`).
 */
export function parseTournamentSpec(body: Record<string, unknown>, admin = false): CreateTournamentSpec {
  if (body.seed !== undefined && !admin) throw new RiskHttpError('Only the admin key can fix a tournament seed', 403);
  const int = (v: unknown, key: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new RuleError(`${key} must be a whole number`);
    return v;
  };
  if (body.fillBots !== undefined && typeof body.fillBots !== 'boolean') throw new RuleError('fillBots must be true or false');
  if (body.format !== undefined && body.format !== 'knockout' && body.format !== 'nested') throw new RuleError('format must be "knockout" or "nested"');
  if (body.finalMap !== undefined && typeof body.finalMap !== 'string') throw new RuleError('finalMap must be a map id');
  if (body.finishShare !== undefined && typeof body.finishShare !== 'number') throw new RuleError('finishShare must be a number');
  return {
    name: body.name === undefined ? undefined : String(body.name),
    options: body.options === undefined ? undefined : parseOptions(body.options),
    groupSize: int(body.groupSize, 'groupSize'),
    maxEntrants: int(body.maxEntrants, 'maxEntrants'),
    fillBots: body.fillBots as boolean | undefined,
    format: body.format as CreateTournamentSpec['format'],
    finalMap: body.finalMap as string | undefined,
    territoriesPerSeat: int(body.territoriesPerSeat, 'territoriesPerSeat'),
    roundMinutes: int(body.roundMinutes, 'roundMinutes'),
    finishShare: body.finishShare as number | undefined,
    botDelayMs: int(body.botDelayMs, 'botDelayMs'),
    zergs: int(body.zergs, 'zergs'),
    delove: int(body.delove, 'delove'),
    open: int(body.open, 'open'),
    ...(admin ? { seed: int(body.seed, 'seed') } : {}),
  };
}

type Req = Request & { room?: GameRoom; playerId?: string | null };

export interface ApiOptions {
  /** Enables /api/admin/* when set (Authorization: Bearer <token>). */
  adminToken?: string | null;
  /** Read-only key for /api/records/* (x-records-key); unset turns those routes off. The admin token also works. */
  recordsKey?: string | null;
  characters?: CharacterStore;
  /** Open mode (RISK_TOURNAMENTS_OPEN): POST /tournaments creates without a code; off by default once a code is set. */
  openTournaments?: boolean;
  /** Hosting codes, caps and expiry (tournament-access.ts); defaults to no codes and the default caps. */
  tourneyAccess?: TournamentAccess;
  /** Delove seats on request (seat-requests.ts); unset = no pool (the routes answer 404). */
  seatRequests?: SeatRequests;
  /** RISK_SEASON_KEY: the password that archives the public leaderboard's season from the site (unset = off). */
  seasonKey?: string | null;
  /** Where the season-key lockout is saved (under RISK_DATA_DIR), so a restart does not reset it. */
  seasonLockFile?: string | null;
  /** Tests: the season-key guard to use (limits and clock). */
  seasonGuard?: SeasonKeyGuard;
}

export function createApi(store: Store, opts: ApiOptions = {}) {
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  const seasonGuard = opts.seasonGuard ?? new SeasonKeyGuard(opts.seasonKey, undefined, undefined, opts.seasonLockFile ?? null);
  const access = opts.tourneyAccess ?? new TournamentAccess(store.tournaments, NO_TOURNEY_CAPS);
  const seatReqs = opts.seatRequests ?? new SeatRequests(store.tournaments, NO_SEAT_CAPS);

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

  /**
   * The registered player whose key is in the X-Player-Key header, or null without one. Never read from a query
   * string (URLs end up in logs). A key that is malformed, unknown or revoked is a 401.
   */
  function playerOf(req: Request): PlayerAccount | null {
    const raw = req.headers[PLAYER_KEY_HEADER];
    if (raw === undefined) return null;
    const p = store.playerKeys.verify(Array.isArray(raw) ? raw[0] : raw);
    if (!p) throw new RiskHttpError('Unknown or revoked player key (X-Player-Key)', 401);
    return p;
  }

  function loadRoom(req: Req, res: Response, next: NextFunction) {
    const room = store.get(String(req.params.id));
    if (!room || room.closed) return res.status(404).json({ error: 'Game not found' });
    req.room = room;
    req.playerId = room.playerForToken(tokenOf(req));
    next();
  }

  function requirePlayer(req: Req, res: Response, next: NextFunction) {
    // A seat dropped as disconnected (seat-health.ts): its old token says why, instead of a bare 401.
    const dropped = !req.playerId && req.room ? req.room.droppedReason(tokenOf(req)) : null;
    if (dropped) return res.status(410).json({ error: droppedMessage(dropped) });
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
  // House bots (the home-page widget): fun stats for the server's bots, aggregated from the tournament results. Not a ranking.
  api.get('/house-bots', (_req, res) => res.json({ ...store.tournamentBoard.houseBots(), swarm: store.swarmReport() }));
  api.get('/rankings/seasons', (_req, res) => res.json({ current: store.rankings.season, seasons: store.rankings.seasons(), archiving: seasonGuard.enabled }));
  // The site's "Archive season" button: the public board's season only (the same archive as the admin route), behind
  // RISK_SEASON_KEY (or the admin token) with a per-IP and global lockout on wrong tries. Off when the key is unset.
  api.post(
    '/rankings/new-season',
    wrap((req, res) => {
      if (checkAdmin(opts.adminToken, tokenOf(req)) !== 'ok') {
        const verdict = seasonGuard.check(req.ip ?? 'unknown', req.body?.password);
        if (!verdict.ok) {
          if (verdict.retryAfterSec) res.setHeader('Retry-After', String(verdict.retryAfterSec));
          return res.status(verdict.status).json({ error: verdict.error });
        }
      }
      try {
        res.json(store.rankings.newSeason());
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
    }),
  );
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
      // ?aborted=1 adds the tables of aborted tournaments (no winner: `winner` is null, `aborted` is true).
      const withAborted = req.query.aborted === '1' || req.query.aborted === 'true';
      const games = store.archive
        .list(Infinity)
        // Won games, and tables decided on standing (nested tournaments), which have a decided winner.
        .filter((g) => ((g.finished || g.decided) && g.winner) || (withAborted && g.aborted))
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
          ...(g.decided ? { decided: true } : {}),
          ...(g.aborted ? { aborted: true } : {}),
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
    const roster = req.room!.rosterIds[player.id];
    const key = req.room!.characterIds[player.id] ?? (roster ? `roster:${roster}` : `${player.isBot ? 'bot' : 'player'}:${player.name.trim().toLowerCase()}`);
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
      const player = playerOf(req);
      const playerName = store.playerKeys.seatName(String(body.playerName ?? body.name ?? 'Player'), body.asBot ? null : player);
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
      const { room, playerId, token } = store.create(String(body.gameName ?? body.name ?? ''), options, playerName, Boolean(body.asBot), board, parseAgent(body.agent), body.asBot ? undefined : player?.id);
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
      const asBot = Boolean(req.body?.asBot);
      const player = asBot ? null : playerOf(req);
      const name = store.playerKeys.seatName(String(req.body?.playerName ?? req.body?.name ?? 'Player'), player);
      const { playerId, token } = room.join(name, asBot, 'bot', parseAgent(req.body?.agent), player?.id);
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
      const count = req.body?.count == null ? 1 : req.body.count;
      if (typeof count !== 'number') throw new RuleError('count must be a whole number');
      // `count` seats several at once (all or none); the first one is also given as playerId/name, as before.
      const added = room.addBots(kind, count, name);
      res.status(201).json({ playerId: added[0].playerId, name: added[0].name, added, state: room.view(req.playerId!) });
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
  // ---- full game records: read-only, behind the records key (or the admin token); they hold hidden hands ----
  const recordsKey = opts.recordsKey || null;
  function requireRecordsKey(req: Request, res: Response, next: NextFunction) {
    if (!recordsKey) return res.status(403).json({ error: 'Full records are off on this server' });
    const given = req.headers['x-records-key'];
    const key = typeof given === 'string' ? given : undefined;
    if (checkAdmin(recordsKey, key) === 'ok' || checkAdmin(adminToken, tokenOf(req)) === 'ok') return next();
    res.status(403).json({ error: 'A valid records key is required (x-records-key)' });
  }
  api.get(
    '/records/:id',
    requireRecordsKey,
    wrap((req, res) => {
      const record = store.archive.get(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'No recorded game with that id' });
      res.json(record);
    }),
  );
  api.get(
    '/records/:id/playbyplay',
    requireRecordsKey,
    wrap((req, res) => {
      const record = store.archive.get(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'No recorded game with that id' });
      const p = narrate(record);
      if (req.query.format === 'json') return res.json(p);
      res.type('text/plain; charset=utf-8').send(playByPlayText(p));
    }),
  );

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const check = checkAdmin(adminToken, tokenOf(req));
    if (check === 'disabled') return res.status(404).json({ error: 'Admin API disabled (set RISK_ADMIN_TOKEN)' });
    if (check === 'bad') return res.status(401).json({ error: 'Invalid admin token' });
    next();
  }
  api.get('/admin/players', requireAdmin, (_req, res) => res.json({ players: store.playerKeys.list() }));

  // ---- the house roster (roster.ts): names bound to Delove models. These routes are the only place the model shows ----
  const rosterView = () => {
    const roster = store.roster.list();
    const byModel: Record<string, { active: number; retired: number }> = {};
    for (const e of roster) (byModel[e.model] ??= { active: 0, retired: 0 })[e.status]++;
    return { roster, byModel };
  };
  api.get('/admin/roster', requireAdmin, (_req, res) => res.json(rosterView()));
  // {model, count}: the next free house names; or {model, names}: these names. All or none.
  api.post(
    '/admin/roster',
    requireAdmin,
    wrap((req, res) => {
      const b = (req.body ?? {}) as { model?: unknown; count?: unknown; names?: unknown };
      res.status(201).json({ created: store.roster.create(b.model, b.count, b.names), ...rosterView() });
    }),
  );
  // {ids}, or {model, count}: the oldest active names of that model. Their rows freeze; the names stay reserved.
  api.post(
    '/admin/roster/retire',
    requireAdmin,
    wrap((req, res) => {
      res.json({ retired: store.roster.retire((req.body ?? {}) as { ids?: unknown; model?: unknown; count?: unknown }), ...rosterView() });
    }),
  );
  api.post(
    '/admin/roster/:id/retire',
    requireAdmin,
    wrap((req, res) => {
      res.json({ retired: store.roster.retire({ ids: [String(req.params.id)] }), ...rosterView() });
    }),
  );
  api.delete(
    '/admin/players/:id',
    requireAdmin,
    wrap((req, res) => {
      if (!store.playerKeys.revoke(String(req.params.id))) return res.status(404).json({ error: 'Player not found' });
      res.json({ ok: true, player: store.playerKeys.info(store.playerKeys.get(String(req.params.id))!) });
    }),
  );
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

  // The Zerg report of a finished game (docs/zergs.md): swarm discipline, trades, knockouts, a per-seat table. Public:
  // it only uses what every seat saw (battles, conquests, knockouts), never a hidden board.
  api.get('/history/:id/report', (req, res) => {
    const report = store.recordReport(String(req.params.id));
    if (!report) return res.status(404).json({ error: 'No recorded game with that id' });
    res.json(report);
  });

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
    wrap((req, res) => {
      const spec = parseTournamentSpec(req.body ?? {}, true);
      // House roster names to seat (admin only): the Delove seats default to that many, and must hold them all.
      const roster = parseRosterIds(req.body?.rosterIds);
      if (roster) {
        store.roster.activeEntries(roster);
        if (!seatReqs.enabled) throw new RiskHttpError('Roster seats need the Delove seat pool (RISK_SEAT_POOL_KEY)', 400);
        spec.delove ??= roster.length;
        if (spec.delove < roster.length) throw new RuleError(`delove (${spec.delove}) must be at least the ${roster.length} roster names`);
      }
      seatReqs.checkCreate('key', spec.delove);
      const t = store.tournaments.create(spec);
      seatReqs.openFor(t, roster);
      created(res, t);
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
  api.post(
    '/admin/tournaments/:id/abort',
    requireAdmin,
    wrap((req, res) => {
      const t = store.tournaments.abort(String(req.params.id));
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

  // Anyone with a hosting code (or anyone at all in open mode) creates here, within the caps (tournament-access.ts).
  api.post(
    '/tournaments',
    wrap((req, res) => {
      const { code, ...body } = (req.body ?? {}) as Record<string, unknown>;
      if (body.rosterIds !== undefined) throw new RiskHttpError('Only the admin key can seat house roster names (POST /api/admin/tournaments)', 403);
      const tier = access.hostTier(req.ip ?? '', code, !!opts.openTournaments);
      const spec = access.checkCreate(tier, parseTournamentSpec(body));
      seatReqs.checkCreate(tier, spec.delove);
      const t = store.tournaments.create(spec);
      access.recordCreate(tier, t.id);
      seatReqs.openFor(t);
      created(res, t);
    }),
  );

  // ---- Delove seats on request: the seat-pool daemon (RISK_SEAT_POOL_KEY in x-seat-pool-key) polls, claims, reports ----
  const pool = (req: Request) => seatReqs.authorize(req.ip ?? '', req.headers['x-seat-pool-key']);
  const num = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : undefined);
  // Each poll carries the pool's free capacity (?free=&freeSearch=); it answers the open requests and the pool as kept.
  api.get(
    '/seat-requests',
    wrap((req, res) => {
      pool(req);
      if (req.query.free !== undefined || req.query.freeSearch !== undefined) seatReqs.report(num(req.query.free), num(req.query.freeSearch));
      res.json({ requests: seatReqs.list(typeof req.query.kind === 'string' ? req.query.kind : undefined, typeof req.query.modes === 'string' ? req.query.modes : undefined), pool: seatReqs.pool() });
    }),
  );
  // The house roster for the pool (its key holds the answer key): which model each name plays, to load them all.
  api.get(
    '/roster',
    wrap((req, res) => {
      pool(req);
      const status = req.query.status === undefined ? undefined : String(req.query.status);
      if (status !== undefined && status !== 'active' && status !== 'retired') throw new RuleError('status must be "active" or "retired"');
      res.json({ roster: store.roster.list().filter((e) => !status || e.status === status).map(({ id, name, model, status: s }) => ({ id, name, model, status: s })) });
    }),
  );
  api.post(
    '/seat-requests/:id/claim',
    wrap((req, res) => {
      pool(req);
      res.json(seatReqs.claim(String(req.params.id), (req.body as { n?: unknown } | undefined)?.n));
    }),
  );
  for (const outcome of ['done', 'failed'] as const)
    api.post(
      `/seat-requests/:id/${outcome}`,
      wrap((req, res) => {
        pool(req);
        const body = (req.body ?? {}) as { joined?: unknown; reason?: unknown };
        res.json({ request: seatReqs.finish(String(req.params.id), outcome, body.joined, body.reason) });
      }),
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
  // Start: the host token or the admin key, or a hosting code in the body (the admin code starts any; the limited code
  // those made with it).
  /** Open mode (testing: RISK_TOURNAMENTS_OPEN and no hosting codes): anyone may start a tournament (#280). */
  const openMode = () => access.openStart(!!opts.openTournaments);
  /** A tournament's public view, with `openMode` when anyone may start it (the client then shows the host controls). */
  const tournamentView = (id: string, token?: string) => ({ ...store.tournaments.view(id, token), ...(openMode() ? { openMode: true as const } : {}) });

  function requireHostOrCode(req: Request, res: Response, next: NextFunction) {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    const id = String(req.params.id);
    // No codes set on the server: a typed code is ignored, and in open mode anyone may start (testing).
    if (!access.usable(code)) {
      if (access.openStart(!!opts.openTournaments)) return store.tournaments.get(id) ? next() : res.status(404).json({ error: 'Tournament not found' });
      return requireTournamentHost(req, res, next);
    }
    if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
    try {
      if (access.canStart(req.ip ?? '', code, id)) return next();
      res.status(403).json({ error: "Only this tournament's host can do that" });
    } catch (err) {
      next(err);
    }
  }
  api.post(
    '/tournaments/:id/start',
    requireHostOrCode,
    wrap((req, res) => {
      const t = store.tournaments.start(String(req.params.id));
      res.json({ tournament: store.tournaments.view(t.id) });
    }),
  );
  // The host's live list of entrants: kinds, agent labels and join times, with counts (never an entrant token). In open
  // mode (testing: no codes, anyone may start) anyone may read it too, so a host in another browser still sees it.
  api.get(
    '/tournaments/:id/entrants',
    (req, res, next) => (openMode() && store.tournaments.get(String(req.params.id)) ? next() : requireTournamentHost(req, res, next)),
    wrap((req, res) => {
      const id = String(req.params.id);
      res.json(store.tournaments.hostEntrants(id, seatReqs.boundEntrants(id)));
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
  api.post(
    '/tournaments/:id/abort',
    requireTournamentHost,
    wrap((req, res) => {
      const t = store.tournaments.abort(String(req.params.id));
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

  // ---- live coach channel (quick play, coach.ts): the seat's owner, proven by their player key ----
  const coachLimiter = new RateLimiter(30, 60_000);
  /** The seat in this room that the key's player owns and may coach; 401 without a key, 403 otherwise. */
  function coachSeat(room: GameRoom, req: Request): string {
    const player = playerOf(req);
    if (!player) throw new RiskHttpError('Coaching needs your player key in the X-Player-Key header', 401);
    if (!room.quickPlay) throw new RiskHttpError('Coaching is for quick-play games only', 403);
    const seat = Object.entries(room.playerKeys).find(([, id]) => id === player.id)?.[0];
    if (!seat) throw new RiskHttpError('Your player key has no seat in this game', 403);
    return seat;
  }
  api.post(
    '/games/:id/coach',
    loadRoom,
    wrap((req, res) => {
      if (!coachLimiter.take(req.ip ?? 'unknown')) throw new RateLimitedError('Too many coach notes: slow down');
      const room = req.room!;
      const seat = coachSeat(room, req);
      room.addCoachNote(seat, req.body?.text);
      res.status(201).json({ seat, notes: room.coach.notes.filter((n) => n.player === seat).map((n) => ({ text: n.text, at: n.at })) });
    }),
  );
  // The coach's own page: the coached seat's view (fog applied: in a fog game the coach sees what the seat sees, not the
  // whole board) and the notes sent. Long-polls like /wait with since/timeoutMs; it never counts as the seat being present.
  api.get(
    '/games/:id/coach',
    loadRoom,
    wrap(async (req, res) => {
      const room = req.room!;
      const seat = coachSeat(room, req);
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 0) || 0, 0), 60_000);
      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      if (since !== undefined && timeoutMs > 0) await room.waitFor(null, since, timeoutMs);
      res.json({ seat, state: room.view(seat), notes: room.coach.notes.filter((n) => n.player === seat).map((n) => ({ text: n.text, at: n.at })) });
    }),
  );

  // ---- player keys: one named player on the leaderboard (player-keys.ts). The key travels in X-Player-Key only. ----
  api.post(
    '/players',
    wrap((req, res) => {
      const { player, key } = store.playerKeys.issue(req.body?.name ?? req.body?.playerName, req.ip ?? 'unknown');
      // The only time the key is ever sent: the server keeps its hash.
      res.status(201).json({ ...player, key });
    }),
  );
  api.get(
    '/players/me',
    wrap((req, res) => {
      const player = playerOf(req);
      if (!player) return res.status(401).json({ error: 'Send your player key in the X-Player-Key header' });
      res.json(store.playerKeys.info(player));
    }),
  );
  api.post(
    '/players/me/rotate',
    wrap((req, res) => {
      const raw = req.headers[PLAYER_KEY_HEADER];
      const r = store.playerKeys.rotate(Array.isArray(raw) ? raw[0] : raw);
      if (!r) return res.status(401).json({ error: 'Unknown or revoked player key (X-Player-Key)' });
      res.json({ ...r.player, key: r.key });
    }),
  );

  // ---- quick play: a queue that seats waiting entrants in a fresh room, the empty seats filled with Zergs ----
  api.get('/queue', (_req, res) => res.json({ waiting: store.quickPlay.list(), waitSeconds: store.quickPlay.config.waitMs / 1000 }));
  api.post(
    '/queue',
    wrap((req, res) => {
      const b = req.body ?? {};
      const player = playerOf(req);
      const playerName = store.playerKeys.seatName(String(b.playerName ?? b.name ?? ''), player);
      const { token, ticket } = store.quickPlay.join({ playerName, agent: parseAgent(b.agent), map: b.map, seats: b.seats, fog: b.fog, ...(player ? { playerKey: player.id } : {}) }, req.ip ?? null);
      res.status(201).json({ token, ticket });
    }),
  );
  api.get(
    '/queue/:ticket',
    wrap(async (req, res) => {
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 0) || 0, 0), 120_000);
      const ticket = await store.quickPlay.wait(String(req.params.ticket), tokenOf(req), timeoutMs);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found (or not yours): join the queue again' });
      res.json({ ticket });
    }),
  );
  api.delete(
    '/queue/:ticket',
    wrap((req, res) => {
      if (!store.quickPlay.leave(String(req.params.ticket), tokenOf(req))) return res.status(404).json({ error: 'Ticket not found (or not yours)' });
      res.json({ ok: true });
    }),
  );

  api.get('/tournaments', (_req, res) => res.json({ tournaments: store.tournaments.list() }));
  // What a nested tournament with these counts and settings would look like; creates nothing, open to anyone, rate-limited.
  api.post(
    '/tournaments/preview',
    wrap((req, res) => {
      res.json({ preview: store.tournaments.preview(parseTournamentSpec(req.body ?? {}), req.ip ?? 'unknown') });
    }),
  );
  // The next scheduled tournament (the home page's card, the MCP next_tournament tool); all null with no schedule.
  api.get('/tournaments/next', (_req, res) => res.json({ scheduled: !!store.schedule, ...(store.schedule?.next() ?? { next: null, running: null, cancelled: null }) }));
  api.get(
    '/tournaments/:id',
    wrap((req, res) => {
      if (!store.tournaments.get(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      store.tournaments.checkIn(String(req.params.id), tokenOf(req));
      res.json({ tournament: tournamentView(String(req.params.id), tokenOf(req)) });
    }),
  );
  api.post(
    '/tournaments/:id/join',
    wrap((req, res) => {
      if (!store.tournaments.get(String(req.params.id))) return res.status(404).json({ error: 'Tournament not found' });
      const id = String(req.params.id);
      // The joiner (this IP) is counted against the pre-registration cap of scheduled tournaments.
      // A house roster seat: the pool joins it with seatRequestId, its key and the rosterId a claim handed out. It plays
      // under the roster name, labelled "AI agent"; its name, model and agent fields are never taken from the body.
      const rosterId = req.body?.rosterId === undefined ? undefined : String(req.body.rosterId);
      if (rosterId !== undefined && req.body?.seatRequestId === undefined) throw new RiskHttpError('A roster seat joins with its seatRequestId (the Delove seat pool)', 400);
      const player = rosterId === undefined ? playerOf(req) : null;
      const rosterName = rosterId === undefined ? null : store.roster.get(rosterId)?.name;
      if (rosterId !== undefined && !rosterName) throw new RiskHttpError('No roster name has that id', 404);
      const name = rosterName ?? store.playerKeys.seatName(String(req.body?.playerName ?? req.body?.name ?? ''), player);
      // The Delove seat pool joins its claimed seats with seatRequestId and its key; those entrants are the request's.
      // Anyone else is refused the pool's names in a tournament with a seat request.
      let request: SeatRequest | null = null;
      if (req.body?.seatRequestId !== undefined) {
        pool(req);
        request = seatReqs.checkBind(req.body.seatRequestId, id, rosterId);
      } else seatReqs.checkJoinName(id, name);
      const agent = rosterId === undefined ? parseAgent(req.body?.agent) : undefined;
      // Pool seats are the house's: they never count against a joiner's pre-registration caps.
      const joiner = request ? null : `ip:${req.ip ?? 'unknown'}`;
      const { entrantId, token } = store.tournaments.join(id, name, agent, player ? { id: player.id, name: player.name } : undefined, joiner, rosterId);
      if (request) seatReqs.bind(request, entrantId, rosterId);
      res.status(201).json({ entrantId, token, tournament: store.tournaments.view(id, token) });
    }),
  );
  api.get(
    '/tournaments/:id/wait',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
      const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 30000), 0), 120_000);
      const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
      // Polling with an entrant token inside a scheduled tournament's check-in window checks that entrant in.
      store.tournaments.checkIn(id, tokenOf(req));
      const reason = await store.tournaments.waitFor(id, since, timeoutMs);
      if (!store.tournaments.get(id)) return res.status(404).json({ error: 'Tournament not found' });
      res.json({ reason, tournament: tournamentView(id, tokenOf(req)) });
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
      const name = String(req.body?.name ?? '');
      // Nobody renames into a house roster name (or a look-alike).
      const why = name.trim() ? store.playerKeys.seatReserved(name) : null;
      if (why) throw new RuleError(`"${name.trim()}" cannot be used: ${why}; pick another name`);
      room.rename(req.playerId!, name);
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
      // An optional private decision note, with {action, note}: stored with the move, never shown during the game.
      const note = req.body?.action ? parseDecisionNote(req.body.note) : undefined;
      const { events } = room.act(req.playerId!, action, note);
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
    if (err instanceof RateLimitedError) return res.status(429).json({ error: err.message });
    if (err instanceof PlayerKeyLimitError) {
      if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof QuickPlayBusyError) return res.status(err.status).json({ error: err.message });
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

/** House roster ids for a tournament (admin create): undefined when absent, else 1-256 distinct strings. */
export function parseRosterIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 256 || raw.some((x) => typeof x !== 'string'))
    throw new RuleError('rosterIds must be a list of 1-256 roster ids');
  return raw as string[];
}

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
