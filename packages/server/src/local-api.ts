import { randomUUID } from 'node:crypto';
import { RULES_TEXT, RuleError, getMap, redactEvents, type Action, type GameOptions } from '@risk/engine';
import type { CharacterUpdate, DiaryInput, QuickPlaySpec, RelationshipInput, RiskApi } from '@risk/mcp';
import { RiskHttpError } from '@risk/mcp';
import { checkAdmin, mapInfo, parseAgent, parseBotKind, parseTournamentSpec, sanitizeOptions } from './http.js';
import { parseDecisionNote, type GameRoom, type Store } from './store.js';
import { QuickPlayBusyError } from './quick-play.js';
import { RateLimitedError } from './rate-limit.js';
import type { CharacterStore } from './characters.js';
import { NO_TOURNEY_CAPS, TournamentAccess } from './tournament-access.js';

/** RiskApi implemented directly over the in-memory store (for the embedded /mcp endpoint). */
export class LocalRiskApi implements RiskApi {
  constructor(
    private store: Store,
    private characters: CharacterStore,
    private adminToken: string | null = null,
    /** Open mode (RISK_TOURNAMENTS_OPEN): creating tournaments needs no code. */
    private openTournaments = false,
    /** The connection's client (IP address) for per-client limits (quick play, wrong hosting codes); null = not limited. */
    private client: string | null = null,
    /** Hosting codes, caps and expiry (shared with the HTTP API). */
    private access: TournamentAccess = new TournamentAccess(store.tournaments, NO_TOURNEY_CAPS),
    /** The X-Player-Key header the MCP connection was opened with, if any: its seats play as that registered player. */
    private playerKey: string | null = null,
  ) {}

  /**
   * This MCP session, the joiner counted by the pre-registration cap of scheduled tournaments. Not the IP: claude.ai
   * connectors share a few addresses, so a per-IP cap would lock out unrelated agents.
   */
  private readonly session = `mcp:${randomUUID()}`;

  /** The registered player of this connection's key, or null without one. A key that does not work is a 401. */
  private keyedPlayer() {
    if (this.playerKey === null) return null;
    const p = this.store.playerKeys.verify(this.playerKey);
    if (!p) throw new RiskHttpError('Unknown or revoked player key (X-Player-Key on the MCP connection)', 401);
    return p;
  }

  private room(gameId: string): GameRoom {
    const r = this.store.get(gameId);
    if (!r || r.closed) throw new RiskHttpError('Game not found', 404);
    return r;
  }
  private player(room: GameRoom, token: string | undefined): string {
    const p = room.playerForToken(token);
    if (!p) throw new RiskHttpError('A valid player token is required', 401);
    return p;
  }
  private admin(key: string) {
    const check = checkAdmin(this.adminToken, key);
    if (check === 'disabled') throw new RiskHttpError('Admin API disabled (set RISK_ADMIN_TOKEN)', 404);
    if (check === 'bad') throw new RiskHttpError('Invalid admin key', 401);
  }
  private tournament(id: string) {
    const t = this.store.tournaments.get(id);
    if (!t) throw new RiskHttpError('Tournament not found', 404);
    return t;
  }
  private host(room: GameRoom, token: string | undefined): string {
    const p = this.player(room, token);
    if (room.hostId !== p) throw new RiskHttpError('Only the host can do that', 403);
    return p;
  }

  async rules() {
    return { rules: RULES_TEXT };
  }
  async map(mapId?: string) {
    return mapInfo(getMap(mapId ?? 'classic'));
  }
  async setCharacter(gameId: string, token: string, characterId: string, key?: string) {
    const room = this.room(gameId);
    const player = this.player(room, token);
    this.characters.checkWrite(key);
    const canonical = this.characters.get(characterId).id;
    room.bindCharacter(player, canonical);
    return { ok: true };
  }
  async tournamentRankings() { return { board: 'tournament' as const, current: true as const, rankings: this.store.tournamentBoard.rows() }; }
  async tournamentProfile(key: string) {
    let profile: string | null = null;
    try { profile = this.characters.get(key).markdown; } catch { /* a plain player */ }
    return { stats: this.store.tournamentBoard.profile(key, key), profile };
  }
  async rankings(season?: string, board?: 'training') {
    if (board) return { board, season: String(this.store.training.season), current: true, rankings: this.store.training.rows() };
    const r = this.store.rankings;
    const rankings = r.seasonRows(season);
    if (!rankings) throw new RiskHttpError(`No leaderboard season ${season}`, 404);
    return { season: season || String(r.season), current: !season || season === String(r.season), rankings };
  }
  async rankingSeasons() { return { current: this.store.rankings.season, seasons: this.store.rankings.seasons() }; }
  async rankedProfile(key: string, board?: 'training') {
    let profile: string | null = null;
    try { profile = this.characters.get(key).markdown; } catch { /* a plain player */ }
    return { stats: this.store.board(board).profile(key, key), profile };
  }
  async listGames() {
    return { games: this.store.list() };
  }
  async createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined, board?: 'training', key?: string, agent?: string) {
    if (board) {
      try {
        this.characters.checkWrite(key);
      } catch {
        throw new RiskHttpError('A training-board game needs the characters write key ("key")', 403);
      }
    }
    const player = this.keyedPlayer();
    const { room, playerId, token } = this.store.create(gameName ?? '', sanitizeOptions(options), this.store.playerKeys.seatName(playerName, player), false, board, parseAgent(agent), player?.id);
    return { gameId: room.id, playerId, token, state: room.view(playerId) };
  }
  async joinGame(gameId: string, playerName: string, agent?: string) {
    const room = this.room(gameId);
    const player = this.keyedPlayer();
    const { playerId, token } = room.join(this.store.playerKeys.seatName(playerName, player), false, 'bot', parseAgent(agent), player?.id);
    return { gameId: room.id, playerId, token, state: room.view(playerId) };
  }
  async addBot(gameId: string, token: string, name?: string, kind?: 'bot' | 'zerg', count?: number) {
    const room = this.room(gameId);
    this.host(room, token);
    const added = room.addBots(parseBotKind(kind), count ?? 1, name);
    return { playerId: added[0].playerId, name: added[0].name, added };
  }
  async setOptions(gameId: string, token: string, options: Partial<GameOptions>) {
    const room = this.room(gameId);
    const me = this.host(room, token);
    room.setOptions(sanitizeOptions(options));
    return { state: room.view(me) };
  }
  async start(gameId: string, token: string) {
    const room = this.room(gameId);
    const me = this.host(room, token);
    room.start();
    return { state: room.view(me) };
  }
  async getGame(gameId: string, token?: string) {
    const room = this.room(gameId);
    const playerId = room.playerForToken(token);
    return { state: room.view(playerId), host: room.hostId, name: room.name, playerId };
  }
  async act(gameId: string, token: string, action: Action, note?: unknown) {
    const room = this.room(gameId);
    const me = this.player(room, token);
    const { events } = room.act(me, action, parseDecisionNote(note));
    return { events: redactEvents(room.state, me, events), state: room.view(me) };
  }
  async wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const room = this.room(gameId);
    const playerId = room.playerForToken(token);
    const reason = await room.waitFor(playerId, since, Math.min(Math.max(timeoutMs, 0), 120_000));
    return {
      reason,
      yourTurn: !!playerId && room.state.currentPlayer === playerId,
      state: room.view(playerId),
      events: since !== undefined ? room.eventsSince(since).map((h) => ({ version: h.version, events: redactEvents(room.state, playerId, h.events), playerId: h.playerId })) : [],
    };
  }
  async events(gameId: string, since: number, token?: string) {
    const room = this.room(gameId);
    const viewer = room.playerForToken(token);
    return { version: room.state.version, entries: room.eventsSince(since).map((h) => ({ ...h, events: redactEvents(room.state, viewer, h.events) })) };
  }
  async chat(gameId: string, since: number, token?: string) {
    const room = this.room(gameId);
    const viewer = token ? room.playerForToken(token) : null;
    if (token && !viewer) throw new RuleError('Unknown token for this game');
    return { messages: room.chatFor(viewer, since) };
  }
  async sendChat(gameId: string, token: string, message: string, to?: string) {
    const room = this.room(gameId);
    const me = this.player(room, token);
    const p = room.state.players.find((x) => x.id === me);
    return room.addChat(me, p?.name ?? 'Unknown', message, to);
  }
  async closeGame(gameId: string, token: string) {
    const room = this.room(gameId);
    this.host(room, token);
    this.store.delete(room.id, 'host');
    return { ok: true };
  }
  async quickPlayJoin(spec: QuickPlaySpec) {
    try {
      const player = this.keyedPlayer();
      return this.store.quickPlay.join({ ...spec, playerName: this.store.playerKeys.seatName(spec.playerName ?? '', player), agent: parseAgent(spec.agent), ...(player ? { playerKey: player.id } : {}) }, this.client);
    } catch (e) {
      if (e instanceof QuickPlayBusyError) throw new RiskHttpError(e.message, e.status);
      throw e;
    }
  }
  async quickPlayWait(ticket: string, token: string, timeoutMs: number) {
    const t = await this.store.quickPlay.wait(ticket, token, Math.min(Math.max(timeoutMs, 0), 120_000));
    if (!t) throw new RiskHttpError('Ticket not found (or not yours): join the queue again', 404);
    return { ticket: t };
  }
  /** Bind a key to this connection (use_player_key): limited per client like a code, the key never echoed. */
  async usePlayerKey(key: string) {
    if (!this.store.playerKeys.tryLimiter.take(this.client ?? 'mcp')) throw new RiskHttpError('Too many player-key tries: wait a few minutes', 429);
    const p = this.store.playerKeys.verify(key);
    if (!p) throw new RiskHttpError('That player key does not work (unknown, rotated or revoked)', 401);
    this.playerKey = key;
    return { playerId: p.id, name: p.name };
  }
  async quickPlayLeave(ticket: string, token: string) {
    if (!this.store.quickPlay.leave(ticket, token)) throw new RiskHttpError('Ticket not found (or not yours)', 404);
    return { ok: true };
  }
  async previewTournament(spec: Record<string, unknown>) {
    try {
      return { preview: this.store.tournaments.preview(parseTournamentSpec({ ...spec, format: spec.format ?? 'nested' }), this.client ?? 'mcp') };
    } catch (e) {
      if (e instanceof RateLimitedError) throw new RiskHttpError(e.message, 429);
      throw e;
    }
  }
  async listTournaments() {
    return { tournaments: this.store.tournaments.list() };
  }
  async nextTournament() {
    return { scheduled: !!this.store.schedule, ...(this.store.schedule?.next() ?? { next: null, running: null, cancelled: null }) };
  }
  async getTournament(tournamentId: string, token?: string) {
    const t = this.tournament(tournamentId);
    this.store.tournaments.checkIn(t.id, token);
    return { tournament: this.store.tournaments.view(t.id, token) };
  }
  async joinTournament(tournamentId: string, playerName: string, agent?: string) {
    const t = this.tournament(tournamentId);
    const player = this.keyedPlayer();
    let joined: { entrantId: string; token: string };
    try {
      joined = this.store.tournaments.join(t.id, this.store.playerKeys.seatName(playerName, player), parseAgent(agent), player ? { id: player.id, name: player.name } : undefined, this.client !== null ? this.session : null);
    } catch (e) {
      // The site-wide daily pre-registration cap: 429, as over HTTP.
      if (e instanceof RateLimitedError) throw new RiskHttpError(e.message, 429);
      throw e;
    }
    const { entrantId, token } = joined;
    return { entrantId, token, tournament: this.store.tournaments.view(t.id, token) };
  }
  async waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const t = this.tournament(tournamentId);
    // wait_for_match inside a scheduled tournament's check-in window checks the entrant in.
    this.store.tournaments.checkIn(t.id, token);
    const reason = await this.store.tournaments.waitFor(t.id, since, Math.min(Math.max(timeoutMs, 0), 120_000));
    return { reason, tournament: this.store.tournaments.view(this.tournament(t.id).id, token) };
  }
  /** As POST /tournaments: a hosting code (`spec.code`) or open mode, within the caps; the admin key skips both. */
  async createTournament(adminKey: string | undefined, spec: Record<string, unknown>) {
    const { code, ...rest } = spec;
    if (adminKey) {
      this.admin(adminKey);
      const t = this.store.tournaments.create(parseTournamentSpec(rest));
      return { hostToken: t.hostToken!, tournament: this.store.tournaments.view(t.id) };
    }
    const tier = this.access.hostTier(this.client ?? '', code, this.openTournaments);
    const t = this.store.tournaments.create(this.access.checkCreate(tier, parseTournamentSpec(rest)));
    this.access.recordCreate(tier, t.id);
    return { hostToken: t.hostToken!, tournament: this.store.tournaments.view(t.id) };
  }
  /** `key`: the tournament's host token or the admin key (tournaments saved before host tokens: the admin key only). */
  async startTournament(key: string | undefined, tournamentId: string, code?: string) {
    const id = code
      ? this.tournament(tournamentId).id
      : this.tournamentHostOf(key, tournamentId, 'Starting a tournament', 'start it');
    if (code && !this.access.canStart(this.client ?? '', code, id)) throw new RiskHttpError("Only this tournament's host can start it", 403);
    const t = this.store.tournaments.start(id);
    return { tournament: this.store.tournaments.view(t.id) };
  }
  /** Same rules as POST /tournaments/:id/bots: the host only, while registering, within maxEntrants. */
  async addTournamentBots(key: string | undefined, tournamentId: string, kind: 'bot' | 'zerg', count: number) {
    const id = this.tournamentHostOf(key, tournamentId, 'Adding bots to a tournament', 'add bots');
    const added = this.store.tournaments.addBots(id, parseBotKind(kind), count);
    return { added, tournament: this.store.tournaments.view(id) };
  }
  /** The tournament's id when `key` is its host token or the admin key; 401 without a key, 403 with another. */
  private tournamentHostOf(key: string | undefined, tournamentId: string, doing: string, verb: string): string {
    const id = this.tournament(tournamentId).id;
    if (!key) throw new RiskHttpError(`${doing} needs its host token (from create_tournament) or the admin key`, 401);
    if (!this.store.tournaments.isHost(id, key) && checkAdmin(this.adminToken, key) !== 'ok') throw new RiskHttpError(`Only this tournament's host can ${verb}`, 403);
    return id;
  }
  async leave(gameId: string, token: string) {
    const room = this.room(gameId);
    const me = this.player(room, token);
    if (room.state.phase === 'lobby') {
      room.leave(me);
      if (!room.hasHumans()) this.store.delete(room.id, 'empty');
    } else {
      room.act(me, { type: 'surrender' });
    }
    return { ok: true };
  }
  async listCharacters() {
    return { characters: this.characters.list() };
  }
  async getCharacter(id: string, version?: number) {
    return this.characters.get(id, version);
  }
  async characterHistory(id: string) {
    return this.characters.history(id);
  }
  async updateCharacter(id: string, update: CharacterUpdate, key?: string) {
    return this.characters.update(id, update, key);
  }
  async modelInfo() {
    return this.characters.modelInfo();
  }
  async characterMemory(id: string) {
    return this.characters.memorySummary(id);
  }
  async readDiary(id: string, limit?: number, gameId?: string) {
    return this.characters.readDiary(id, limit, gameId);
  }
  async addDiaryEntry(id: string, entry: DiaryInput, key?: string) {
    return this.characters.addDiaryEntry(id, entry, key);
  }
  async updateRelationship(id: string, update: RelationshipInput, key?: string) {
    return this.characters.updateRelationship(id, update, key);
  }
}

export { RuleError };
