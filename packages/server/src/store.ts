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
  renamePlayer,
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
  /** Posted by someone watching, not a seated player. */
  spectator?: boolean;
}

/** Spectator chat flood guard: at most this many messages per sender per window. */
const SPECTATOR_CHAT_LIMIT = 5;
const SPECTATOR_CHAT_WINDOW_MS = 10_000;

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
  /** Last time a person or agent did something here (bot moves do not count). */
  lastActivity?: number;
}

/** How long an idle room is kept, by phase. All values in milliseconds. */
export interface RetentionPolicy {
  /** Lobby with nobody connected. */
  lobby: number;
  /** Game in progress with at least one non-bot player alive and nobody connected. */
  playing: number;
  /** Game in progress where only built-in bots are left, with nobody watching. */
  botsOnly: number;
  /** Finished game with nobody connected. */
  finished: number;
  /** Hard cap on idle time, even while someone is connected. */
  max: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  lobby: 60 * 60_000,
  playing: 12 * 3600_000,
  botsOnly: 30 * 60_000,
  finished: 2 * 3600_000,
  max: 7 * 24 * 3600_000,
};

export type CloseReason = 'host' | 'admin' | 'idle' | 'empty';

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

function fmt(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
}

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
  private spectatorPosts = new Map<string, number[]>();
  history: HistoryEntry[] = [];
  updatedAt = Date.now();
  lastActivity = Date.now();
  /** WebSocket clients currently subscribed (players and spectators). */
  connections = 0;
  closed = false;
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
    this.lastActivity = snapshot.lastActivity ?? snapshot.updatedAt;
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
      lastActivity: this.lastActivity,
    };
  }

  /** Mark human/agent activity (keeps the room from being swept). */
  touch() {
    this.lastActivity = Date.now();
  }

  /** Is anyone attached right now: a WebSocket client or a long-poll waiter (agents)? */
  isWatched(): boolean {
    return this.connections > 0 || this.waiters.size > 0;
  }

  /** True when every living non-neutral player is a built-in bot. */
  botsOnly(): boolean {
    const alive = this.state.players.filter((p) => p.alive && !p.isNeutral);
    return alive.length > 0 && alive.every((p) => p.isBot);
  }

  hasHumans(): boolean {
    return this.state.players.some((p) => !p.isBot && !p.isNeutral);
  }

  /** Close the room: tell everyone attached, release waiters, stop bots. The store forgets it. */
  close(reason: CloseReason) {
    if (this.closed) return;
    this.closed = true;
    this.stopBot();
    this.emit('closed', reason);
    this.releaseWaiters();
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
    if (!isBot) this.touch();
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
    this.touch();
    this.commit(next, [], playerId, { type: 'system', note: `${playerId} left` });
  }

  rename(playerId: PlayerId, name: string) {
    const next = renamePlayer(this.state, playerId, name);
    this.touch();
    this.commit(next, [], playerId, { type: 'system', note: `${playerId} renamed to ${name}` });
  }

  setOptions(options: Partial<GameOptions>) {
    const next = setOptions(this.state, options);
    this.touch();
    this.commit(next, [], null, { type: 'system', note: 'options changed' });
  }

  start() {
    const { state, events } = startGame(this.state);
    this.touch();
    this.commit(state, events, null, { type: 'start' });
  }

  // ---- play ----

  act(playerId: PlayerId, action: Action): { state: GameState; events: GameEvent[] } {
    const { state, events } = applyAction(this.state, playerId, action);
    if (!this.state.players.find((p) => p.id === playerId)?.isBot) this.touch();
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
    if (playerId && !this.state.players.find((p) => p.id === playerId)?.isBot) this.touch();
    this.emit('chat', msg);
    return msg;
  }

  /**
   * Post a message from someone watching. `key` identifies the sender for the flood guard (a socket or an
   * IP). The name is trimmed to 24 characters and may not pose as a seated player.
   */
  addSpectatorChat(key: string, rawName: unknown, message: string): ChatMessage {
    if (this.state.options.spectatorChat === false) throw new RuleError('Spectator chat is turned off in this game');
    const now = Date.now();
    const recent = (this.spectatorPosts.get(key) ?? []).filter((t) => now - t < SPECTATOR_CHAT_WINDOW_MS);
    if (recent.length >= SPECTATOR_CHAT_LIMIT) throw new RuleError('Slow down: spectators can send 5 messages every 10 seconds');
    recent.push(now);
    this.spectatorPosts.set(key, recent);
    if (this.spectatorPosts.size > 1000) this.spectatorPosts.clear();
    let name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Spectator';
    if (this.state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${name.slice(0, 20)} (fan)`;
    const msg: ChatMessage = {
      id: (this.chat.at(-1)?.id ?? 0) + 1,
      playerId: null,
      name,
      message: message.slice(0, 500),
      at: now,
      spectator: true,
    };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.updatedAt = now;
    this.emit('chat', msg);
    return msg;
  }

  /** Whether a viewer (a seated player, or null for a spectator) may read a chat message. */
  canReadChat(_msg: ChatMessage, _viewer: PlayerId | null): boolean {
    // Everyone sees everything, fog or not: spectators are the crowd (or the gods) and are meant to be
    // heard by the players, tips and all. Kept as a hook in case a per-game filter is wanted later.
    return true;
  }

  /** Chat as a given viewer may see it. */
  chatFor(viewer: PlayerId | null, since = 0): ChatMessage[] {
    return this.chat.filter((m) => m.id > since && this.canReadChat(m, viewer));
  }

  eventsSince(version: number): HistoryEntry[] {
    return this.history.filter((h) => h.version > version);
  }

  /**
   * Resolve when it's the player's turn (or the game is over), or when the
   * state version advances past `since`, or after `timeoutMs`.
   */
  waitFor(playerId: PlayerId | null, since: number | undefined, timeoutMs: number): Promise<'turn' | 'change' | 'timeout' | 'finished'> {
    if (playerId) this.touch();
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
    if (this.botTimer || this.closed) return;
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

  retention: RetentionPolicy;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private file: string | null,
    retention: Partial<RetentionPolicy> = {},
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as RoomSnapshot[];
        for (const snap of data) {
          // Games saved before maps existed carry no "map" option: they are classic-board games.
          if (!snap.state.options.map) snap.state.options.map = 'classic';
          // Games saved before neutral territories existed have none.
          if (snap.state.options.neutrals === undefined) snap.state.options.neutrals = 0;
          if (snap.state.options.neutralArmies === undefined) snap.state.options.neutralArmies = 2;
          // Games saved before blizzards existed have none.
          if (snap.state.options.blizzards === undefined) snap.state.options.blizzards = 0;
          if (!snap.state.blizzards) snap.state.blizzards = [];
          // Spectator chat arrived later; on by default.
          if (snap.state.options.spectatorChat === undefined) snap.state.options.spectatorChat = true;
          // Late-turn bonus arrived later: off for games already saved, so running games keep their rules.
          if (snap.state.options.firstRoundBonus === undefined) snap.state.options.firstRoundBonus = false;
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

  /** Close and forget a room. Attached clients are told why. */
  delete(id: string, reason: CloseReason = 'admin') {
    const room = this.rooms.get(id.toUpperCase());
    if (!room) return false;
    room.close(reason);
    room.removeAllListeners('change');
    this.rooms.delete(room.id);
    this.scheduleSave();
    return true;
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const room of this.rooms.values()) room.stopBot();
  }

  /** Why a room would be swept right now, or null to keep it. */
  staleReason(room: GameRoom, now = Date.now()): string | null {
    const idle = now - room.lastActivity;
    const r = this.retention;
    if (idle > r.max) return `idle ${fmt(idle)} (hard limit)`;
    if (room.isWatched()) return null;
    const phase = room.state.phase;
    if (!room.hasHumans()) return 'no people or agents in the room';
    if (phase === 'lobby' && idle > r.lobby) return `lobby idle ${fmt(idle)}`;
    if (phase === 'finished' && idle > r.finished) return `finished, idle ${fmt(idle)}`;
    if (phase !== 'lobby' && phase !== 'finished') {
      if (room.botsOnly() && idle > r.botsOnly) return `only bots left, idle ${fmt(idle)}`;
      if (idle > r.playing) return `game idle ${fmt(idle)}`;
    }
    return null;
  }

  /** Delete stale rooms. Returns what was removed and why. */
  sweep(now = Date.now()): { id: string; name: string; reason: string }[] {
    const removed: { id: string; name: string; reason: string }[] = [];
    for (const room of [...this.rooms.values()]) {
      const reason = this.staleReason(room, now);
      if (!reason) continue;
      removed.push({ id: room.id, name: room.name, reason });
      this.delete(room.id, 'idle');
    }
    if (removed.length) console.log(`[sweep] removed ${removed.length} room(s): ${removed.map((r) => `${r.id} (${r.reason})`).join(', ')}`);
    return removed;
  }

  /** Run sweep() on an interval (unref'd so it never keeps the process alive). */
  startSweeper(intervalMs = 5 * 60_000) {
    if (this.sweepTimer) return;
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
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
