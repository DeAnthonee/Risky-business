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

export interface ChatResult {
  messages: { id: number; name: string; message: string; at: number }[];
}

/**
 * Everything the MCP tools need from a Risk game server. Implemented over HTTP by
 * `HttpRiskApi` (stdio MCP talking to a remote server) and directly over the in-memory
 * store when the MCP endpoint is embedded in the game server itself.
 */
export interface RiskApi {
  rules(): Promise<{ rules: string }>;
  map(): Promise<unknown>;
  listGames(): Promise<{ games: unknown[] }>;
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined): Promise<JoinResult>;
  joinGame(gameId: string, playerName: string): Promise<JoinResult>;
  addBot(gameId: string, token: string, name?: string): Promise<{ playerId: string }>;
  setOptions(gameId: string, token: string, options: Partial<GameOptions>): Promise<{ state: GameView }>;
  start(gameId: string, token: string): Promise<{ state: GameView }>;
  getGame(gameId: string, token?: string): Promise<GameInfo>;
  act(gameId: string, token: string, action: Action): Promise<{ events: GameEvent[]; state: GameView }>;
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number): Promise<WaitResult>;
  events(gameId: string, since: number): Promise<EventsResult>;
  chat(gameId: string, since: number): Promise<ChatResult>;
  sendChat(gameId: string, token: string, message: string): Promise<unknown>;
  leave(gameId: string, token: string): Promise<unknown>;
}

export interface IdentityStore {
  get(gameId: string): Identity | undefined;
  set(id: Identity): void;
  forget(gameId: string): void;
  gameIds(): string[];
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
  private identities = new Map<string, Identity>();
  get(gameId: string) {
    return this.identities.get(gameId.toUpperCase());
  }
  set(id: Identity) {
    this.identities.set(id.gameId.toUpperCase(), id);
  }
  forget(gameId: string) {
    this.identities.delete(gameId.toUpperCase());
  }
  gameIds() {
    return [...this.identities.keys()];
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
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Record<string, Identity>>;
      for (const id of Object.values(data[this.scope] ?? {})) super.set(id);
    } catch {
      /* ignore corrupt file */
    }
  }
  private save() {
    if (!this.file) return;
    try {
      let data: Record<string, Record<string, Identity>> = {};
      if (existsSync(this.file)) data = JSON.parse(readFileSync(this.file, 'utf8'));
      data[this.scope] = Object.fromEntries(this.gameIds().map((g) => [g, this.get(g)!]));
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
  override forget(gameId: string) {
    super.forget(gameId);
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
  map() {
    return this.request<unknown>('/map');
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
  events(gameId: string, since: number) {
    return this.request<EventsResult>(`/games/${gameId}/events?since=${since}`);
  }
  chat(gameId: string, since: number) {
    return this.request<ChatResult>(`/games/${gameId}/chat?since=${since}`);
  }
  sendChat(gameId: string, token: string, message: string) {
    return this.request(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message }) }, token);
  }
  leave(gameId: string, token: string) {
    return this.request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token);
  }
}
