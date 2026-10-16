import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RuleError,
  addPlayer,
  applyAction,
  createGame,
  removePlayer,
  setOptions,
  startGame,
  viewFor,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
  type GameView,
  type PlayerId,
} from '@risk/engine';
import { chooseBotAction } from './bot.js';

export interface ChatMessage {
  id: number;
  playerId: PlayerId | null;
  name: string;
  message: string;
  at: number;
}

export interface HistoryEntry {
  version: number;
  at: number;
  playerId: PlayerId | null;
  action: Action | { type: 'start' } | { type: 'system'; note: string };
  events: GameEvent[];
}

export interface RoomSnapshot {
  id: string;
  name: string;
  hostId: PlayerId;
  state: GameState;
  tokens: Record<string, PlayerId>;
  chat: ChatMessage[];
  history: HistoryEntry[];
  updatedAt: number;
}

export interface GameSummary {
  id: string;
  name: string;
  phase: GameState['phase'];
  players: { id: PlayerId; name: string; isBot: boolean; alive: boolean; color: string }[];
  maxPlayers: number;
  createdAt: number;
  updatedAt: number;
  options: GameOptions;
  joinable: boolean;
  winner: PlayerId | null;
  turnNumber: number;
}

export interface ChangeMessage {
  state: GameState;
  events: GameEvent[];
  version: number;
  playerId: PlayerId | null;
}

const BOT_DELAY_MS = Number(process.env.RISK_BOT_DELAY_MS ?? 700);
const MAX_HISTORY = 2000;
const MAX_CHAT = 500;

function newId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function joinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export class GameRoom extends EventEmitter {
  id: string;
  name: string;
  hostId: PlayerId;
  state: GameState;
  tokens = new Map<string, PlayerId>();
  chat: ChatMessage[] = [];
  history: HistoryEntry[] = [];
  updatedAt = Date.now();
  private botTimer: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();

  constructor(snapshot: RoomSnapshot) {
    super();
    this.setMaxListeners(500);
    this.id = snapshot.id;
    this.name = snapshot.name;
    this.hostId = snapshot.hostId;
    this.state = snapshot.state;
    this.tokens = new Map(Object.entries(snapshot.tokens));
    this.chat = snapshot.chat;
    this.history = snapshot.history;
    this.updatedAt = snapshot.updatedAt;
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      state: this.state,
      tokens: Object.fromEntries(this.tokens),
      chat: this.chat,
      history: this.history,
      updatedAt: this.updatedAt,
    };
  }

  summary(): GameSummary {
    const s = this.state;
    return {
      id: this.id,
      name: this.name,
      phase: s.phase,
      players: s.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, alive: p.alive, color: p.color })),
      maxPlayers: s.options.maxPlayers,
      createdAt: s.createdAt,
      updatedAt: this.updatedAt,
      options: s.options,
      joinable: s.phase === 'lobby' && s.players.length < s.options.maxPlayers,
      winner: s.winner,
      turnNumber: s.turnNumber,
    };
  }

  playerForToken(token: string | undefined): PlayerId | null {
    if (!token) return null;
    return this.tokens.get(token) ?? null;
  }

  view(playerId: PlayerId | null): GameView {
    return viewFor(this.state, playerId);
  }

  private commit(next: GameState, events: GameEvent[], playerId: PlayerId | null, action: HistoryEntry['action']) {
    this.state = next;
    this.updatedAt = Date.now();
    this.history.push({ version: next.version, at: this.updatedAt, playerId, action, events });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    const msg: ChangeMessage = { state: next, events, version: next.version, playerId };
    this.emit('change', msg);
    this.scheduleBot();
  }

  // ---- lobby ----

  join(name: string, isBot = false): { playerId: PlayerId; token: string } {
    const playerId = (isBot ? 'bot_' : 'p_') + newId(6);
    const next = addPlayer(this.state, playerId, name, isBot);
    const token = newId(24);
    this.tokens.set(token, playerId);
    this.commit(next, [], playerId, { type: 'system', note: `${name} joined` });
    return { playerId, token };
  }

  leave(playerId: PlayerId) {
    const next = removePlayer(this.state, playerId);
    for (const [tok, pid] of this.tokens) if (pid === playerId) this.tokens.delete(tok);
    if (this.hostId === playerId) {
      const nextHost = next.players.find((p) => !p.isBot);
      if (nextHost) this.hostId = nextHost.id;
    }
    this.commit(next, [], playerId, { type: 'system', note: `${playerId} left` });
  }

  setOptions(options: Partial<GameOptions>) {
    const next = setOptions(this.state, options);
    this.commit(next, [], null, { type: 'system', note: 'options changed' });
  }

  start() {
    const { state, events } = startGame(this.state);
    this.commit(state, events, null, { type: 'start' });
  }

  // ---- play ----

  act(playerId: PlayerId, action: Action): { state: GameState; events: GameEvent[] } {
    const { state, events } = applyAction(this.state, playerId, action);
    this.commit(state, events, playerId, action);
    return { state, events };
  }

  addChat(playerId: PlayerId | null, name: string, message: string): ChatMessage {
    const msg: ChatMessage = {
      id: (this.chat.at(-1)?.id ?? 0) + 1,
      playerId,
      name,
      message: message.slice(0, 500),
      at: Date.now(),
    };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.updatedAt = Date.now();
    this.emit('chat', msg);
    return msg;
  }

  eventsSince(version: number): HistoryEntry[] {
    return this.history.filter((h) => h.version > version);
  }

  /**
   * Resolve when it's the player's turn (or the game is over), or when the
   * state version advances past `since`, or after `timeoutMs`.
   */
  waitFor(playerId: PlayerId | null, since: number | undefined, timeoutMs: number): Promise<'turn' | 'change' | 'timeout' | 'finished'> {
    const check = (): 'turn' | 'change' | 'finished' | null => {
      if (this.state.phase === 'finished') return 'finished';
      if (since !== undefined && this.state.version > since) return 'change';
      if (playerId && this.state.currentPlayer === playerId) return 'turn';
      return null;
    };
    const now = check();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const onChange = () => {
        const r = check();
        if (r) {
          cleanup();
          resolve(r);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve('timeout');
      }, timeoutMs);
      const release = () => {
        cleanup();
        resolve('timeout');
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('change', onChange);
        this.waiters.delete(release);
      };
      this.waiters.add(release);
      this.on('change', onChange);
    });
  }

  /** Resolve every pending long-poll immediately (used on shutdown). */
  releaseWaiters() {
    for (const w of [...this.waiters]) w();
  }

  stopBot() {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  // ---- bots ----

  scheduleBot() {
    if (this.botTimer) return;
    const cur = this.state.currentPlayer;
    if (!cur || this.state.phase === 'finished' || this.state.phase === 'lobby') return;
    const p = this.state.players.find((x) => x.id === cur);
    if (!p?.isBot) return;
    const delay = this.state.phase === 'setup' ? Math.min(BOT_DELAY_MS, 250) : BOT_DELAY_MS;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.runBotStep();
    }, delay);
  }

  private runBotStep() {
    const cur = this.state.currentPlayer;
    if (!cur) return;
    const p = this.state.players.find((x) => x.id === cur);
    if (!p?.isBot) return;
    try {
      const action = chooseBotAction(this.state, cur);
      if (!action) {
        // Should not happen; surrender to avoid a stuck game.
        this.act(cur, { type: 'surrender' });
        return;
      }
      this.act(cur, action);
    } catch (err) {
      console.error(`[bot ${cur}] failed:`, err);
      try {
        this.act(cur, { type: 'end_turn' });
      } catch {
        try {
          this.act(cur, { type: 'surrender' });
        } catch (e2) {
          console.error('bot could not recover', e2);
        }
      }
    }
  }
}

export class Store {
  rooms = new Map<string, GameRoom>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as RoomSnapshot[];
        for (const snap of data) {
          const room = new GameRoom(snap);
          this.attach(room);
        }
        console.log(`Loaded ${this.rooms.size} game(s) from ${file}`);
      } catch (err) {
        console.error('Failed to load saved games:', err);
      }
    }
    for (const room of this.rooms.values()) room.scheduleBot();
  }

  private attach(room: GameRoom) {
    this.rooms.set(room.id, room);
    room.on('change', () => this.scheduleSave());
    room.on('chat', () => this.scheduleSave());
  }

  create(name: string, options: Partial<GameOptions>, hostName: string, hostIsBot = false): { room: GameRoom; playerId: PlayerId; token: string } {
    let id = joinCode();
    while (this.rooms.has(id)) id = joinCode();
    const state = createGame(id, options);
    const room = new GameRoom({
      id,
      name: name.trim().slice(0, 40) || `${hostName}'s game`,
      hostId: '',
      state,
      tokens: {},
      chat: [],
      history: [],
      updatedAt: Date.now(),
    });
    this.attach(room);
    const { playerId, token } = room.join(hostName, hostIsBot);
    room.hostId = playerId;
    this.scheduleSave();
    return { room, playerId, token };
  }

  get(id: string): GameRoom | undefined {
    return this.rooms.get(id.toUpperCase());
  }

  list(): GameSummary[] {
    return [...this.rooms.values()]
      .map((r) => r.summary())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string) {
    this.rooms.delete(id);
    this.scheduleSave();
  }

  describePersistence(): string {
    return this.file ?? 'disabled';
  }

  releaseWaiters() {
    for (const room of this.rooms.values()) room.releaseWaiters();
  }

  stopTimers() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const room of this.rooms.values()) room.stopBot();
  }

  /** Drop finished games older than a day and empty lobbies older than 2 hours. */
  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const age = now - room.updatedAt;
      if (room.state.phase === 'finished' && age > 24 * 3600_000) this.rooms.delete(room.id);
      else if (room.state.phase === 'lobby' && age > 2 * 3600_000) this.rooms.delete(room.id);
      else if (age > 7 * 24 * 3600_000) this.rooms.delete(room.id);
    }
  }

  private scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  /** Atomic snapshot: write to a temp file then rename, so a crash mid-write never corrupts the store. */
  save() {
    if (!this.file) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const data = [...this.rooms.values()].map((r) => r.snapshot());
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save games:', err);
    }
  }
}

export { RuleError };
