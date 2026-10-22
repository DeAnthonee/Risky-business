import type { Action, GameEvent, GameOptions, GameView, NestNode } from '@risk/engine';

/** Root path of the app (supports hosting under a sub-path, e.g. /risk/). */
const loc = typeof window !== 'undefined' ? window.location : { href: 'http://localhost/', protocol: 'http:', host: 'localhost' };
export const ROOT = new URL('.', loc.href).pathname.replace(/\/?$/, '/');
export const API = `${ROOT}api`;
export const WS_URL = `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${ROOT}ws`;

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
  /** Set on a tournament table. */
  tournamentId?: string;
}

export interface TournamentSummary {
  id: string;
  name: string;
  status: 'registering' | 'running' | 'finished';
  map: string;
  entrants: number;
  maxEntrants: number;
  round: number;
  champion: string | null;
  /** Scheduled: when it starts (ms), and why it was called off, if it was. */
  startsAt?: number;
  cancelled?: string;
  updatedAt: number;
}

/** The server's next scheduled tournament (GET /api/tournaments/next); `scheduled` false = no schedule. */
export interface NextTournament {
  scheduled: boolean;
  next: { id: string | null; name: string; startsAt: number; opensAt: number; entrants: number; maxEntrants: number | null; minEntrants: number } | null;
  running: { id: string; name: string; startsAt: number; round: number } | null;
  cancelled: { id: string; name: string; startsAt: number; reason: string } | null;
}

/** One finished game in the match history (GET /api/history): the outcome only, never a board. */
export interface MatchSummary {
  id: string;
  /** The room it was played in (still open for a while after the game ends). */
  room: string;
  name: string;
  map: string;
  fog: boolean;
  /** "training": a yardstick game, ranked on the training board instead of the public leaderboard. */
  board?: 'training';
  tournamentId?: string;
  scenario: boolean;
  startedAt: number;
  endedAt: number;
  winner: { id: string; name: string };
  reason: 'domination' | 'capitals' | null;
  turns: number;
  players: { id: string; name: string; isBot: boolean; characterId: string | null; place: number | null }[];
}

export type EntrantStatus = 'registered' | 'playing' | 'waiting' | 'out' | 'champion';

export interface TournamentView {
  id: string;
  name: string;
  status: TournamentSummary['status'];
  map: string;
  groupSize: number;
  maxEntrants: number;
  fillBots: boolean;
  entrants: { id: string; name: string; isBot: boolean; status: EntrantStatus }[];
  rounds: {
    round: number;
    /** Nested: the round's deadline and end (ms since the epoch). */
    deadline?: number;
    endedAt?: number;
    matches: {
      gameId: string | null;
      /** decided: a nested table stopped at its round's end and decided on standing. */
      status: 'playing' | 'finished' | 'bye' | 'abandoned' | 'decided';
      players: { entrantId: string; name: string }[];
      winner: string | null;
      /** Nested: the table's board, its place in `nested.nodes`, and how it was decided on standing. */
      map?: string;
      node?: number;
      standing?: { order: string[]; rolls: Record<string, number[]> };
    }[];
  }[];
  champion: { entrantId: string; name: string } | null;
  /** "knockout" (absent on older servers) or "nested" (Inception tournaments). */
  format?: 'knockout' | 'nested';
  nested?: {
    finalMap: string | null;
    territoriesPerSeat: number;
    roundMinutes: number;
    finishShare: number;
    plan: number[][] | null;
    zergs: number;
    /** The resolved boards (resolveNest order), once the tournament has started. */
    nodes?: NestNode[] | null;
  };
  version: number;
  you?: { entrantId: string; name: string; status: EntrantStatus; match: { gameId: string; playerId: string; token: string; round: number } | null };
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
  addBot: (gameId: string, token: string, kind: 'bot' | 'zerg' = 'bot') =>
    request(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind }) }, token),
  closeGame: (gameId: string, token: string) => request(`/games/${gameId}/close`, { method: 'POST', body: '{}' }, token),
  kick: (gameId: string, token: string, playerId: string) =>
    request(`/games/${gameId}/kick`, { method: 'POST', body: JSON.stringify({ playerId }) }, token),
  leave: (gameId: string, token: string) => request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token),
  rename: (gameId: string, token: string, name: string) => request(`/games/${gameId}/name`, { method: 'POST', body: JSON.stringify({ name }) }, token),
  setOptions: (gameId: string, token: string, options: Partial<GameOptions>) =>
    request(`/games/${gameId}/options`, { method: 'POST', body: JSON.stringify({ options }) }, token),
  start: (gameId: string, token: string) => request(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token),
  listHistory: (limit = 12) => request<{ enabled: boolean; games: MatchSummary[] }>(`/history?limit=${limit}`),
  listTournaments: () => request<{ tournaments: TournamentSummary[] }>('/tournaments'),
  nextTournament: () => request<NextTournament>('/tournaments/next'),
  getTournament: (id: string, token?: string) => request<{ tournament: TournamentView }>(`/tournaments/${id}`, {}, token),
  joinTournament: (id: string, playerName: string) =>
    request<{ entrantId: string; token: string; tournament: TournamentView }>(`/tournaments/${id}/join`, { method: 'POST', body: JSON.stringify({ playerName }) }),
  waitTournament: (id: string, since: number, token?: string) =>
    request<{ reason: string; tournament: TournamentView }>(`/tournaments/${id}/wait?since=${since}&timeoutMs=25000`, {}, token),
  act: (gameId: string, token: string, action: Action) =>
    request<{ events: GameEvent[]; state: GameView }>(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }, token),
};

export interface ChatMessage {
  id: number;
  playerId: string | null;
  name: string;
  message: string;
  at: number;
  /** Posted by someone watching, not a seated player. */
  spectator?: boolean;
  /** Whisper recipient: only the sender, this player and spectators receive the message. */
  to?: string;
  toName?: string;
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
  onClosed: (reason: string) => void;
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
        case 'closed':
          // The room is gone for good: stop reconnecting.
          this.closed = true;
          this.listener.onClosed(msg.reason);
          this.ws?.close();
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

  /** `name` is used only when this socket is watching rather than seated; `to` whispers to one player. */
  chat(message: string, name?: string, to?: string) {
    return this.send({ type: 'chat', message, name, to });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
