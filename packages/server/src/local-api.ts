import { RULES_TEXT, RuleError, getMap, redactEvents, type Action, type GameOptions } from '@risk/engine';
import type { RiskApi } from '@risk/mcp';
import { RiskHttpError } from '@risk/mcp';
import { mapInfo, sanitizeOptions } from './http.js';
import type { GameRoom, Store } from './store.js';

/** RiskApi implemented directly over the in-memory store (for the embedded /mcp endpoint). */
export class LocalRiskApi implements RiskApi {
  constructor(private store: Store) {}

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
  async listGames() {
    return { games: this.store.list() };
  }
  async createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined) {
    const { room, playerId, token } = this.store.create(gameName ?? '', sanitizeOptions(options), playerName);
    return { gameId: room.id, playerId, token, state: room.view(playerId) };
  }
  async joinGame(gameId: string, playerName: string) {
    const room = this.room(gameId);
    const { playerId, token } = room.join(playerName);
    return { gameId: room.id, playerId, token, state: room.view(playerId) };
  }
  async addBot(gameId: string, token: string, name?: string) {
    const room = this.room(gameId);
    this.host(room, token);
    const n = room.state.players.filter((p) => p.isBot).length + 1;
    const { playerId } = room.join(name ?? `Bot ${n}`, true);
    return { playerId };
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
  async act(gameId: string, token: string, action: Action) {
    const room = this.room(gameId);
    const me = this.player(room, token);
    const { events } = room.act(me, action);
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
}

export { RuleError };
