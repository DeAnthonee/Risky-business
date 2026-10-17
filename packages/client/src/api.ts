import type { Action, GameEvent, GameOptions, GameView } from '@risk/engine';

/** Root path of the app (supports hosting under a sub-path, e.g. /risk/). */
export const ROOT = new URL('.', window.location.href).pathname.replace(/\/?$/, '/');
export const API = `${ROOT}api`;
export const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${ROOT}ws`;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export interface GameSummary {
  id: string;
  name: string;
  phase: GameView['phase'];
  players: { id: string; name: string; isBot: boolean; alive: boolean; color: string }[];
  maxPlayers: number;
  createdAt: number;
  updatedAt: number;
  options: GameOptions;
  joinable: boolean;
  winner: string | null;
  turnNumber: number;
}

export interface JoinResponse {
  gameId: string;
  playerId: string;
  token: string;
  state: GameView;
  host: string;
}

export const api = {
  listGames: () => request<{ games: GameSummary[] }>('/games'),
  createGame: (playerName: string, gameName: string, options: Partial<GameOptions>) =>
    request<JoinResponse>('/games', { method: 'POST', body: JSON.stringify({ playerName, gameName, options }) }),
  joinGame: (gameId: string, playerName: string) =>
    request<JoinResponse>(`/games/${gameId}/join`, { method: 'POST', body: JSON.stringify({ playerName }) }),
  getGame: (gameId: string, token?: string) =>
    request<{ state: GameView; host: string; name: string; playerId: string | null }>(`/games/${gameId}`, {}, token),
  addBot: (gameId: string, token: string) => request(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token),
  kick: (gameId: string, token: string, playerId: string) =>
    request(`/games/${gameId}/kick`, { method: 'POST', body: JSON.stringify({ playerId }) }, token),
  leave: (gameId: string, token: string) => request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token),
  setOptions: (gameId: string, token: string, options: Partial<GameOptions>) =>
    request(`/games/${gameId}/options`, { method: 'POST', body: JSON.stringify({ options }) }, token),
  start: (gameId: string, token: string) => request(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token),
  act: (gameId: string, token: string, action: Action) =>
    request<{ events: GameEvent[]; state: GameView }>(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }, token),
};

export interface ChatMessage {
  id: number;
  playerId: string | null;
  name: string;
  message: string;
  at: number;
}

export interface StateMessage {
  type: 'state';
  state: GameView;
  events: GameEvent[];
  version: number;
  host: string;
  name: string;
  you: string | null;
  /** Git commit the server was built from; differs from the client's after a deploy. */
  commit?: string;
}

export interface PresenceMessage {
  spectators: number;
  online: string[];
}

type Listener = {
  onState: (m: StateMessage) => void;
  onChat: (m: ChatMessage) => void;
  onChatHistory: (m: ChatMessage[]) => void;
  onPresence: (m: PresenceMessage) => void;
  onStatus: (connected: boolean) => void;
};

/** Small reconnecting WebSocket client for one game. */
export class GameSocket {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private closed = false;
  private attempt = 0;
  private seq = 0;

  constructor(
    private gameId: string,
    private token: string | undefined,
    private listener: Listener,
  ) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.listener.onStatus(true);
      ws.send(JSON.stringify({ type: 'subscribe', gameId: this.gameId, token: this.token }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 'state':
          this.listener.onState(msg);
          break;
        case 'chat':
          this.listener.onChat(msg.message);
          break;
        case 'chat_history':
          this.listener.onChatHistory(msg.messages);
          break;
        case 'presence':
          this.listener.onPresence({ spectators: msg.spectators, online: msg.online });
          break;
        case 'ack': {
          const p = this.pending.get(msg.reqId);
          if (p) {
            this.pending.delete(msg.reqId);
            msg.ok ? p.resolve() : p.reject(new Error(msg.error ?? 'Rejected'));
          }
          break;
        }
        case 'error':
          console.warn('ws error', msg.error);
          break;
      }
    };
    ws.onclose = () => {
      this.listener.onStatus(false);
      for (const p of this.pending.values()) p.reject(new Error('Disconnected'));
      this.pending.clear();
      if (!this.closed) {
        const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
        setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }

  private send(obj: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = String(++this.seq);
      this.pending.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify({ ...obj, reqId }));
    });
  }

  act(action: Action) {
    return this.send({ type: 'action', action });
  }

  chat(message: string) {
    return this.send({ type: 'chat', message });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
