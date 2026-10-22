import { RULES_TEXT, RuleError, getMap, redactEvents, type Action, type GameOptions } from '@risk/engine';
import type { CharacterUpdate, DiaryInput, RelationshipInput, RiskApi } from '@risk/mcp';
import { RiskHttpError } from '@risk/mcp';
import { checkAdmin, mapInfo, parseAgent, parseBotKind, parseTournamentSpec, sanitizeOptions } from './http.js';
import { parseDecisionNote, type GameRoom, type Store } from './store.js';
import type { CharacterStore } from './characters.js';

/** RiskApi implemented directly over the in-memory store (for the embedded /mcp endpoint). */
export class LocalRiskApi implements RiskApi {
  constructor(
    private store: Store,
    private characters: CharacterStore,
    private adminToken: string | null = null,
    /** TEMPORARY (testing): creating tournaments needs no admin key. */
    private openTournaments = false,
  ) {}

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
  /** Tournament creation: open to anyone while testing (openTournaments), otherwise the admin key. */
  private tournamentHost(key: string | undefined) {
    if (this.openTournaments) return;
    if (!key) throw new RiskHttpError('Creating tournaments needs the admin key', 401);
    this.admin(key);
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
    const { room, playerId, token } = this.store.create(gameName ?? '', sanitizeOptions(options), playerName, false, board, parseAgent(agent));
    return { gameId: room.id, playerId, token, state: room.view(playerId) };
  }
  async joinGame(gameId: string, playerName: string, agent?: string) {
    const room = this.room(gameId);
    const { playerId, token } = room.join(playerName, false, 'bot', parseAgent(agent));
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
  async listTournaments() {
    return { tournaments: this.store.tournaments.list() };
  }
  async nextTournament() {
    return { scheduled: !!this.store.schedule, ...(this.store.schedule?.next() ?? { next: null, running: null, cancelled: null }) };
  }
  async getTournament(tournamentId: string, token?: string) {
    const t = this.tournament(tournamentId);
    return { tournament: this.store.tournaments.view(t.id, token) };
  }
  async joinTournament(tournamentId: string, playerName: string, agent?: string) {
    const t = this.tournament(tournamentId);
    const { entrantId, token } = this.store.tournaments.join(t.id, playerName, parseAgent(agent));
    return { entrantId, token, tournament: this.store.tournaments.view(t.id, token) };
  }
  async waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const t = this.tournament(tournamentId);
    const reason = await this.store.tournaments.waitFor(t.id, since, Math.min(Math.max(timeoutMs, 0), 120_000));
    return { reason, tournament: this.store.tournaments.view(this.tournament(t.id).id, token) };
  }
  async createTournament(adminKey: string | undefined, spec: Record<string, unknown>) {
    this.tournamentHost(adminKey);
    const t = this.store.tournaments.create(parseTournamentSpec(spec));
    return { hostToken: t.hostToken!, tournament: this.store.tournaments.view(t.id) };
  }
  /** `key`: the tournament's host token or the admin key (tournaments saved before host tokens: the admin key only). */
  async startTournament(key: string | undefined, tournamentId: string) {
    const id = this.tournamentHostOf(key, tournamentId, 'Starting a tournament', 'start it');
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
