import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Action, GameEvent, GameOptions, GameView } from '@risk/engine';

/** A player's seat in one game. */
export interface Identity {
  gameId: string;
  playerId: string;
  token: string;
  name: string;
}

export interface GameInfo {
  state: GameView;
  host: string;
  name: string;
  playerId: string | null;
}

export interface JoinResult {
  gameId: string;
  playerId: string;
  token: string;
  state: GameView;
}

export interface WaitResult {
  reason: string;
  yourTurn: boolean;
  state: GameView;
  events: { version: number; events: GameEvent[]; playerId: string | null }[];
}

export interface EventsResult {
  version: number;
  entries: { version: number; at: number; playerId: string | null; events: GameEvent[] }[];
}

/** A tournament as the server describes it (see the server's TournamentView). */
export interface TournamentInfo {
  id: string;
  name: string;
  status: 'registering' | 'running' | 'finished';
  map: string;
  groupSize: number;
  maxEntrants: number;
  fillBots: boolean;
  entrants: { id: string; name: string; isBot: boolean; status: string }[];
  rounds: { round: number; matches: { gameId: string | null; status: string; players: { entrantId: string; name: string }[]; winner: string | null }[] }[];
  champion: { entrantId: string; name: string } | null;
  version: number;
  you?: { entrantId: string; name: string; status: string; match: { gameId: string; playerId: string; token: string; round: number } | null };
}

export interface TournamentSpec {
  name?: string;
  options?: Partial<GameOptions>;
  groupSize?: number;
  maxEntrants?: number;
  fillBots?: boolean;
}

export interface ChatResult {
  /** `to`/`toName`: a whisper, readable only by its two players and spectators. */
  messages: { id: number; name: string; message: string; at: number; spectator?: boolean; to?: string; toName?: string }[];
}

/**
 * Everything the MCP tools need from a Risk game server. Implemented over HTTP by
 * `HttpRiskApi` (stdio MCP talking to a remote server) and directly over the in-memory
 * store when the MCP endpoint is embedded in the game server itself.
 */
export interface RiskApi {
  rules(): Promise<{ rules: string }>;
  map(mapId?: string): Promise<unknown>;
  listGames(): Promise<{ games: unknown[] }>;
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined): Promise<JoinResult>;
  joinGame(gameId: string, playerName: string): Promise<JoinResult>;
  addBot(gameId: string, token: string, name?: string): Promise<{ playerId: string }>;
  setOptions(gameId: string, token: string, options: Partial<GameOptions>): Promise<{ state: GameView }>;
  start(gameId: string, token: string): Promise<{ state: GameView }>;
  getGame(gameId: string, token?: string): Promise<GameInfo>;
  act(gameId: string, token: string, action: Action): Promise<{ events: GameEvent[]; state: GameView }>;
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number): Promise<WaitResult>;
  events(gameId: string, since: number, token?: string): Promise<EventsResult>;
  /** Pass the reader's token so fog-of-war games hide spectator messages from players. */
  chat(gameId: string, since: number, token?: string): Promise<ChatResult>;
  /** `to`: whisper to one player (name or id) instead of posting to everyone. */
  sendChat(gameId: string, token: string, message: string, to?: string): Promise<unknown>;
  leave(gameId: string, token: string): Promise<unknown>;
  closeGame(gameId: string, token: string): Promise<unknown>;

  listTournaments(): Promise<{ tournaments: unknown[] }>;
  /** Pass your entrant token to get `you` (your status and your current table's seat). */
  getTournament(tournamentId: string, token?: string): Promise<{ tournament: TournamentInfo }>;
  joinTournament(tournamentId: string, playerName: string): Promise<{ entrantId: string; token: string; tournament: TournamentInfo }>;
  /** Long-poll until the tournament changes past `since`. */
  waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number): Promise<{ reason: string; tournament: TournamentInfo }>;
  // TEMPORARY (testing): while the server has tournaments open, no admin key is needed; otherwise pass the
  // server's admin token. Remove from the MCP tools before launch.
  createTournament(adminKey: string | undefined, spec: TournamentSpec): Promise<{ tournament: TournamentInfo }>;
  startTournament(adminKey: string | undefined, tournamentId: string): Promise<{ tournament: TournamentInfo }>;
}

/** Seats held by one agent connection. Several seats per game are allowed (one chat can run two players). */
export interface IdentityStore {
  /** All seats in a game. */
  seats(gameId: string): Identity[];
  /** A seat in a game by player name (case-insensitive) or by token. */
  find(gameId: string, nameOrToken: string): Identity | undefined;
  set(id: Identity): void;
  forget(gameId: string, token?: string): void;
  gameIds(): string[];
  all(): Identity[];
}

export class RiskHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'RiskHttpError';
  }
}

/** Identities kept in memory only (one MCP session over HTTP). */
export class MemoryIdentityStore implements IdentityStore {
  private byGame = new Map<string, Identity[]>();
  seats(gameId: string) {
    return this.byGame.get(gameId.toUpperCase()) ?? [];
  }
  find(gameId: string, nameOrToken: string) {
    const key = nameOrToken.trim().toLowerCase();
    return this.seats(gameId).find((s) => s.token === nameOrToken || s.name.toLowerCase() === key || s.playerId === nameOrToken);
  }
  set(id: Identity) {
    const g = id.gameId.toUpperCase();
    const list = (this.byGame.get(g) ?? []).filter((s) => s.token !== id.token && s.playerId !== id.playerId);
    list.push({ ...id, gameId: g });
    this.byGame.set(g, list);
  }
  forget(gameId: string, token?: string) {
    const g = gameId.toUpperCase();
    if (!token) {
      this.byGame.delete(g);
      return;
    }
    const left = this.seats(g).filter((s) => s.token !== token);
    if (left.length) this.byGame.set(g, left);
    else this.byGame.delete(g);
  }
  gameIds() {
    return [...this.byGame.keys()];
  }
  all() {
    return [...this.byGame.values()].flat();
  }
}

/** Identities persisted to a JSON file, keyed by server URL, so a restarted stdio agent keeps its seats. */
export class FileIdentityStore extends MemoryIdentityStore {
  constructor(
    private scope: string,
    private file: string | null,
  ) {
    super();
    this.load();
  }
  private load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Identity[] | Record<string, Identity>>;
      const mine = data[this.scope];
      const list = Array.isArray(mine) ? mine : Object.values(mine ?? {});
      for (const id of list) super.set(id);
    } catch {
      /* ignore corrupt file */
    }
  }
  private save() {
    if (!this.file) return;
    try {
      let data: Record<string, unknown> = {};
      if (existsSync(this.file)) data = JSON.parse(readFileSync(this.file, 'utf8'));
      data[this.scope] = this.all();
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch {
      /* ignore */
    }
  }
  override set(id: Identity) {
    super.set(id);
    this.save();
  }
  override forget(gameId: string, token?: string) {
    super.forget(gameId, token);
    this.save();
  }
}

export function defaultSessionFile(): string {
  return process.env.RISK_MCP_SESSION_FILE ?? join(homedir(), '.risk-mcp', 'sessions.json');
}

/** RiskApi over the game server's HTTP API. */
export class HttpRiskApi implements RiskApi {
  constructor(public baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${this.baseUrl}/api${path}`, { ...init, headers });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new RiskHttpError(`Non-JSON response from server (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new RiskHttpError(String(body.error ?? `HTTP ${res.status}`), res.status);
    return body as T;
  }

  rules() {
    return this.request<{ rules: string }>('/rules');
  }
  map(mapId?: string) {
    return this.request<unknown>(`/map${mapId ? `?map=${encodeURIComponent(mapId)}` : ''}`);
  }
  listGames() {
    return this.request<{ games: unknown[] }>('/games');
  }
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined) {
    return this.request<JoinResult>('/games', { method: 'POST', body: JSON.stringify({ playerName, gameName, options }) });
  }
  joinGame(gameId: string, playerName: string) {
    return this.request<JoinResult>(`/games/${gameId}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
  }
  addBot(gameId: string, token: string, name?: string) {
    return this.request<{ playerId: string }>(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ name }) }, token);
  }
  setOptions(gameId: string, token: string, options: Partial<GameOptions>) {
    return this.request<{ state: GameView }>(`/games/${gameId}/options`, { method: 'POST', body: JSON.stringify({ options }) }, token);
  }
  start(gameId: string, token: string) {
    return this.request<{ state: GameView }>(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
  }
  getGame(gameId: string, token?: string) {
    return this.request<GameInfo>(`/games/${gameId}`, {}, token);
  }
  act(gameId: string, token: string, action: Action) {
    return this.request<{ events: GameEvent[]; state: GameView }>(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }, token);
  }
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (since !== undefined) q.set('since', String(since));
    return this.request<WaitResult>(`/games/${gameId}/wait?${q}`, {}, token);
  }
  events(gameId: string, since: number, token?: string) {
    return this.request<EventsResult>(`/games/${gameId}/events?since=${since}`, {}, token);
  }
  chat(gameId: string, since: number, token?: string) {
    return this.request<ChatResult>(`/games/${gameId}/chat?since=${since}`, {}, token);
  }
  sendChat(gameId: string, token: string, message: string, to?: string) {
    return this.request(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message, to }) }, token);
  }
  leave(gameId: string, token: string) {
    return this.request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token);
  }
  closeGame(gameId: string, token: string) {
    return this.request(`/games/${gameId}/close`, { method: 'POST', body: '{}' }, token);
  }
  listTournaments() {
    return this.request<{ tournaments: unknown[] }>('/tournaments');
  }
  getTournament(tournamentId: string, token?: string) {
    return this.request<{ tournament: TournamentInfo }>(`/tournaments/${tournamentId}`, {}, token);
  }
  joinTournament(tournamentId: string, playerName: string) {
    return this.request<{ entrantId: string; token: string; tournament: TournamentInfo }>(`/tournaments/${tournamentId}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
  }
  waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (since !== undefined) q.set('since', String(since));
    return this.request<{ reason: string; tournament: TournamentInfo }>(`/tournaments/${tournamentId}/wait?${q}`, {}, token);
  }
  createTournament(adminKey: string | undefined, spec: TournamentSpec) {
    return this.request<{ tournament: TournamentInfo }>(adminKey ? '/admin/tournaments' : '/tournaments', { method: 'POST', body: JSON.stringify(spec) }, adminKey);
  }
  startTournament(adminKey: string | undefined, tournamentId: string) {
    return this.request<{ tournament: TournamentInfo }>(`${adminKey ? '/admin' : ''}/tournaments/${tournamentId}/start`, { method: 'POST', body: '{}' }, adminKey);
  }
}
