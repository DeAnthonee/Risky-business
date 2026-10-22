import type { Action, GameEvent, GameOptions, GameView, NestNode } from '@risk/engine';
import { getPlayerKey } from './session';

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

/** The X-Player-Key header when this browser holds a player key (only on the calls that take a seat). */
function keyed(): Record<string, string> {
  const key = getPlayerKey();
  return key ? { 'x-player-key': key } : {};
}

/** A registered player (POST /api/players, GET /api/players/me). `key` only right after issuing or rotating. */
export interface PlayerInfo {
  playerId: string;
  name: string;
  createdAt: number;
  key?: string;
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
  /** A tournament table: which tournament, round and table (the badge). */
  tournament?: TournamentTableRef;
}

/** Which tournament table a game is (the server's TournamentTableRef). */
export interface TournamentTableRef {
  id: string;
  name: string;
  round: number;
  table: number;
  tables: number;
  final: boolean;
}

/** "🏆 Cup · Round 2, table 3", or "🏆 Cup · the final". */
export function tableBadge(t: TournamentTableRef): string {
  return `🏆 ${t.name} · ${t.final ? 'the final' : t.tables > 1 ? `Round ${t.round}, table ${t.table}` : `Round ${t.round}`}`;
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
  next: {
    id: string | null;
    name: string;
    startsAt: number;
    opensAt: number;
    /** The check-in window opens; who has not checked in by the start is swapped for a Zerg. */
    checkinOpensAt?: number;
    entrants: number;
    /** Once check-in is open: how many have checked in. */
    checkedIn?: number;
    maxEntrants: number | null;
    minEntrants: number;
  } | null;
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
  /** 'standing': a nested tournament table decided on standing at its round's end (`decided`). */
  reason: 'domination' | 'capitals' | 'standing' | null;
  decided?: boolean;
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
  you?: {
    entrantId: string;
    name: string;
    status: EntrantStatus;
    match: { gameId: string; playerId: string; token: string; round: number } | null;
    /** Scheduled tournaments: whether you have checked in (this page checks you in while it is open in the window). */
    checkedIn?: boolean;
  };
  /** Made by the server's schedule: the start, the check-in window and, once it is open, how many checked in. */
  scheduled?: { startsAt: number; cancelled?: string; checkinMinutes?: number; checkedIn?: number; noShows?: number };
}

export interface JoinResponse {
  gameId: string;
  playerId: string;
  token: string;
  state: GameView;
  host: string;
}

/** A quick-play ticket (POST /api/queue). */
export interface QuickPlayTicket {
  ticket: string;
  status: 'waiting' | 'seated';
  name: string;
  map: string;
  seats: number;
  fog: boolean;
  waiting: number;
  startsAt: number | null;
  gameId?: string;
  playerId?: string;
  seatToken?: string;
}

/** A nested tournament's breakdown before it exists (POST /api/tournaments/preview). */
export interface TournamentPreview {
  counts: { zergs: number; delove: number; open: number };
  seats: number;
  plannerZergs: number;
  rounds: number;
  tablesPerRound: number[];
  seatsPerRound: number[][];
  finalists: number;
  finalBoard: { map: string | null; name: string; generated: boolean; territories: number };
  firstRound: { seats: number; people: number; zergs: number }[];
  timer: { mode: string; seconds: number } | null;
  minutes: { low: number; high: number; perRound: number };
  warnings: string[];
}

/** What the create form sends (nested format, seat counts, settings, the access code when there is one). */
export interface CreateTournamentRequest {
  format: 'nested';
  name?: string;
  zergs: number;
  delove: number;
  open: number;
  roundMinutes: number;
  finalMap?: string;
  options: Partial<GameOptions>;
  code?: string;
}

export const api = {
  previewTournament: (spec: CreateTournamentRequest) => request<{ preview: TournamentPreview }>('/tournaments/preview', { method: 'POST', body: JSON.stringify(spec) }),
  createTournament: (spec: CreateTournamentRequest) => request<{ hostToken: string; tournament: TournamentView }>('/tournaments', { method: 'POST', body: JSON.stringify(spec) }),
  startTournament: (id: string, hostToken: string) => request<{ tournament: TournamentView }>(`/tournaments/${id}/start`, { method: 'POST', body: '{}' }, hostToken),
  quickPlayJoin: (playerName: string, map: string, seats: number, fog: boolean) =>
    request<{ token: string; ticket: QuickPlayTicket }>('/queue', { method: 'POST', headers: keyed(), body: JSON.stringify({ playerName, map, seats, fog }) }),
  quickPlayWait: (ticket: string, token: string, timeoutMs: number) =>
    request<{ ticket: QuickPlayTicket }>(`/queue/${encodeURIComponent(ticket)}?timeoutMs=${timeoutMs}`, {}, token),
  quickPlayLeave: (ticket: string, token: string) => request(`/queue/${encodeURIComponent(ticket)}`, { method: 'DELETE' }, token),
  listGames: () => request<{ games: GameSummary[] }>('/games'),
  createGame: (playerName: string, gameName: string, options: Partial<GameOptions>) =>
    request<JoinResponse>('/games', { method: 'POST', headers: keyed(), body: JSON.stringify({ playerName, gameName, options }) }),
  joinGame: (gameId: string, playerName: string) =>
    request<JoinResponse>(`/games/${gameId}/join`, { method: 'POST', headers: keyed(), body: JSON.stringify({ playerName }) }),
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
    request<{ entrantId: string; token: string; tournament: TournamentView }>(`/tournaments/${id}/join`, { method: 'POST', headers: keyed(), body: JSON.stringify({ playerName }) }),
  registerPlayer: (name: string) => request<PlayerInfo>('/players', { method: 'POST', body: JSON.stringify({ name }) }),
  playerMe: (key: string) => request<PlayerInfo>('/players/me', { headers: { 'x-player-key': key } }),
  rotatePlayerKey: (key: string) => request<PlayerInfo>('/players/me/rotate', { method: 'POST', headers: { 'x-player-key': key }, body: '{}' }),
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
  /** First state of a tournament table: which tournament, round and table. */
  tournament?: TournamentTableRef;
}

export interface PresenceMessage {
  spectators: number;
  online: string[];
}

/** A big move (server reactions.ts): someone took a lot from someone in one turn, with a canned line and reply. */
export interface BigMoveMessage {
  type: 'big_move';
  gameId: string;
  version: number;
  kind: 'sweep' | 'knockout' | 'capital';
  attacker: { id: string; name: string };
  victim: { id: string; name: string };
  taken: number;
  anchor: string;
  line: string;
  reply: string;
}

type Listener = {
  onState: (m: StateMessage) => void;
  onBigMove?: (m: BigMoveMessage) => void;
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
        case 'big_move':
          this.listener.onBigMove?.(msg);
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
