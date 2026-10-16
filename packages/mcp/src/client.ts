import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Action, GameEvent, GameOptions, GameView } from '@risk/engine';

export interface Identity {
  gameId: string;
  playerId: string;
  token: string;
  name: string;
}

export class RiskHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Thin HTTP client for the Risky Business game server, with persisted per-game identities. */
export class RiskClient {
  private identities = new Map<string, Identity>();

  constructor(
    public baseUrl: string,
    private sessionFile: string | null,
  ) {
    this.load();
  }

  private load() {
    if (!this.sessionFile || !existsSync(this.sessionFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.sessionFile, 'utf8')) as Record<string, Record<string, Identity>>;
      for (const id of Object.values(data[this.baseUrl] ?? {})) this.identities.set(id.gameId, id);
    } catch {
      /* ignore corrupt file */
    }
  }

  private save() {
    if (!this.sessionFile) return;
    try {
      let data: Record<string, Record<string, Identity>> = {};
      if (existsSync(this.sessionFile)) data = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
      data[this.baseUrl] = Object.fromEntries(this.identities);
      mkdirSync(dirname(this.sessionFile), { recursive: true });
      writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
    } catch {
      /* ignore */
    }
  }

  identity(gameId: string): Identity | undefined {
    return this.identities.get(gameId.toUpperCase());
  }

  setIdentity(id: Identity) {
    this.identities.set(id.gameId.toUpperCase(), id);
    this.save();
  }

  forget(gameId: string) {
    this.identities.delete(gameId.toUpperCase());
    this.save();
  }

  async request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
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
    return this.request<{ territories: unknown[]; continents: unknown[]; adjacency: Record<string, string[]> }>('/map');
  }
  listGames() {
    return this.request<{ games: unknown[] }>('/games');
  }
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined) {
    return this.request<{ gameId: string; playerId: string; token: string; state: GameView }>('/games', {
      method: 'POST',
      body: JSON.stringify({ playerName, gameName, options }),
    });
  }
  joinGame(gameId: string, playerName: string) {
    return this.request<{ gameId: string; playerId: string; token: string; state: GameView }>(`/games/${gameId}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerName }),
    });
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
    return this.request<{ state: GameView; host: string; name: string; playerId: string | null }>(`/games/${gameId}`, {}, token);
  }
  act(gameId: string, token: string, action: Action) {
    return this.request<{ events: GameEvent[]; state: GameView }>(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }, token);
  }
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (since !== undefined) q.set('since', String(since));
    return this.request<{ reason: string; yourTurn: boolean; state: GameView; events: { version: number; events: GameEvent[]; playerId: string | null }[] }>(
      `/games/${gameId}/wait?${q}`,
      {},
      token,
    );
  }
  events(gameId: string, since: number) {
    return this.request<{ version: number; entries: { version: number; at: number; playerId: string | null; events: GameEvent[] }[] }>(`/games/${gameId}/events?since=${since}`);
  }
  chat(gameId: string, since: number) {
    return this.request<{ messages: { id: number; name: string; message: string; at: number }[] }>(`/games/${gameId}/chat?since=${since}`);
  }
  sendChat(gameId: string, token: string, message: string) {
    return this.request(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message }) }, token);
  }
  leave(gameId: string, token: string) {
    return this.request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token);
  }
}

export function defaultSessionFile(): string {
  return process.env.RISK_MCP_SESSION_FILE ?? join(homedir(), '.risk-mcp', 'sessions.json');
}
