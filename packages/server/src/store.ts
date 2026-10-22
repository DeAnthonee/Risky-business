import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RuleError,
  endByStanding,
  onlySideLeft,
  addPlayer,
  applyAction,
  createGame,
  removePlayer,
  renamePlayer,
  scenarioState,
  setOptions,
  setPlayerBot,
  startGame,
  viewFor,
  type Action,
  type GameEvent,
  type GameOptions,
  type GameState,
  type GameRecord,
  type GameView,
  type PlayerId,
  type ScenarioRef,
  type ScenarioSeat,
} from '@risk/engine';
import { chooseSeatAction, isZergSeat, seatIdPrefix, zergName, type BotKind } from './bot.js';
import { DEFAULT_TOURNAMENT_LIMITS, TournamentManager } from './tournaments.js';
import { TournamentRankings } from './tournament-scoring.js';
import { Rankings } from './rankings.js';
import { DEFAULT_KEEP, GameArchive, type CommitInfo } from './archive.js';

export interface ChatMessage {
  id: number;
  playerId: PlayerId | null;
  name: string;
  message: string;
  at: number;
  /** Posted by someone watching, not a seated player. */
  spectator?: boolean;
  /** Whisper: only the sender, this player and spectators can read it (a spectator may whisper to a player too). */
  to?: PlayerId;
  /** Display name of the whisper's recipient. */
  toName?: string;
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
  characterIds?: Record<string, string>;
  /** Each seat's self-declared player type ("claude-sonnet-5-5", "delove@10", "bot", "zerg"), shown to spectators only. */
  agents?: Record<string, string>;
  eliminationOrder?: string[];
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
  /** The game record this room's game is being journalled to (see archive.ts). */
  recordId?: string;
  /** Set on a tournament table: the tournament that seated it. Nobody hosts such a room. */
  tournamentId?: string;
  /** Set on a scenario: the recorded moment its game began from. Nobody hosts such a room. */
  scenarioOf?: ScenarioRef;
  /** "training": ranked on the training leaderboard (rankings-training.json), never the public one. Absent = public. */
  board?: RankingBoard;
}

/** The leaderboard a room's result goes to when it is not the public one (see docs/character-league.md). */
export type RankingBoard = 'training';

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
  /** Close a finished game this long after it ended (spectators may still be watching). 0 disables. */
  finishedClose: number;
  /** Close a lobby or running game once no seat has been present (socket or authenticated request) this long. 0 disables. */
  abandonedClose: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  lobby: 60 * 60_000,
  playing: 12 * 3600_000,
  botsOnly: 30 * 60_000,
  finished: 2 * 3600_000,
  max: 7 * 24 * 3600_000,
  finishedClose: 2 * 60_000,
  abandonedClose: 2 * 60_000,
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
  /** A scenario: the recorded game and step it began from. */
  scenarioOf?: ScenarioRef;
  /** Set on a tournament table: the tournament it belongs to. */
  tournamentId?: string;
  /** "training": a yardstick game ranked on the training leaderboard. Absent = public. */
  board?: RankingBoard;
}

export interface ChangeMessage {
  state: GameState;
  events: GameEvent[];
  version: number;
  playerId: PlayerId | null;
}

const BOT_DELAY_MS = Number(process.env.RISK_BOT_DELAY_MS ?? 700);
/**
 * A game seated with Zergs only ends right after the deal, decided by standing (owner, 2026-10-22); false would let it
 * play out. Games with any non-Zerg seat always end once only Zergs are left.
 */
const ALL_ZERG_TABLES_END_AT_ONCE = true;
const MAX_HISTORY = 2000;
/** A tournament table saves only its newest history entries: the game record already journals the whole game. */
export const TABLE_SAVED_HISTORY = 500;
/** Snapshot debounce, and the longer one while many games are being played (each save stringifies every room). */
export const SAVE_DEBOUNCE_MS = 500;
export const BUSY_SAVE_DEBOUNCE_MS = 2000;
/** More rooms than this playing at once counts as busy. */
export const BUSY_PLAYING_ROOMS = 10;
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
  characterIds: Record<string, string> = {};
  /** Player-type labels by seat: spectators see them (`spectatorView`); a seated player's view never has them. */
  agents: Record<string, string> = {};
  eliminationOrder: string[] = [];
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
  /** When the game ended (set by commit; derived from the history for restored rooms). */
  finishedAt: number | null = null;
  /** Last time a seat (non-bot, living player) was present: a socket, an authenticated request or a long-poll. */
  lastSeatSeen = Date.now();
  private seatSockets = new Map<PlayerId, number>();
  private seatPolls = new Map<PlayerId, number>();
  /** Tournament that owns this table, if any. */
  tournamentId?: string;
  /** The game record this room's game is being journalled to, until it is finished. */
  recordId?: string;
  /** A scenario: the recorded moment this room's game began from. */
  scenarioOf?: ScenarioRef;
  /** "training": ranked on the training leaderboard. Absent = public. */
  board?: RankingBoard;
  private botTimer: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();

  constructor(snapshot: RoomSnapshot) {
    super();
    this.setMaxListeners(500);
    this.id = snapshot.id;
    this.characterIds = snapshot.characterIds ?? {};
    this.agents = snapshot.agents ?? {};
    this.eliminationOrder = snapshot.eliminationOrder ?? snapshot.history.flatMap(h => h.events.filter(e => e.type === 'eliminated').map(e => (e as { player: string }).player));
    this.name = snapshot.name;
    this.hostId = snapshot.hostId;
    this.state = snapshot.state;
    this.tokens = new Map(Object.entries(snapshot.tokens));
    this.chat = snapshot.chat;
    this.history = snapshot.history;
    this.updatedAt = snapshot.updatedAt;
    this.lastActivity = snapshot.lastActivity ?? snapshot.updatedAt;
    this.tournamentId = snapshot.tournamentId;
    this.recordId = snapshot.recordId;
    this.scenarioOf = snapshot.scenarioOf;
    // Rooms saved before the training board existed are public.
    if (snapshot.board === 'training') this.board = 'training';
    if (this.state.phase === 'finished') this.finishedAt = this.history.at(-1)?.at ?? this.updatedAt;
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      characterIds: this.characterIds,
      ...(Object.keys(this.agents).length ? { agents: this.agents } : {}),
      eliminationOrder: this.eliminationOrder,
      name: this.name,
      hostId: this.hostId,
      state: this.state,
      tokens: Object.fromEntries(this.tokens),
      chat: this.chat,
      // Tournament tables keep their full history in memory but save only the tail (the record has every move).
      history: this.tournamentId && this.history.length > TABLE_SAVED_HISTORY ? this.history.slice(-TABLE_SAVED_HISTORY) : this.history,
      updatedAt: this.updatedAt,
      lastActivity: this.lastActivity,
      ...(this.tournamentId ? { tournamentId: this.tournamentId } : {}),
      ...(this.recordId ? { recordId: this.recordId } : {}),
      ...(this.scenarioOf ? { scenarioOf: this.scenarioOf } : {}),
      ...(this.board ? { board: this.board } : {}),
    };
  }

  /** Mark human/agent activity (keeps the room from being swept). */
  touch() {
    this.lastActivity = Date.now();
  }

  private isSeat(playerId: PlayerId): boolean {
    const p = this.state.players.find((x) => x.id === playerId);
    return !!p && !p.isBot && !p.isNeutral && p.alive;
  }

  /** At least one human/agent player is still in (not left, not eliminated). Bots-only games follow the bots-only rule. */
  hasLivingSeats(): boolean {
    return this.state.players.some((p) => this.isSeat(p.id));
  }

  /** A seat did something (any authenticated request): it counts as present now. */
  markSeat(playerId: PlayerId | null) {
    if (playerId && this.isSeat(playerId)) this.lastSeatSeen = Date.now();
  }

  seatSocket(playerId: PlayerId, delta: 1 | -1) {
    const n = (this.seatSockets.get(playerId) ?? 0) + delta;
    if (n > 0) this.seatSockets.set(playerId, n);
    else this.seatSockets.delete(playerId);
    this.markSeat(playerId);
  }

  /** Is any living human/agent seat attached over a WebSocket or a long-poll in progress? */
  seatAttached(): boolean {
    for (const m of [this.seatSockets, this.seatPolls]) for (const id of m.keys()) if (this.isSeat(id)) return true;
    return false;
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
      ...(this.scenarioOf ? { scenarioOf: this.scenarioOf } : {}),
      ...(this.tournamentId ? { tournamentId: this.tournamentId } : {}),
      ...(this.board ? { board: this.board } : {}),
    };
  }

  playerForToken(token: string | undefined): PlayerId | null {
    if (!token) return null;
    const id = this.tokens.get(token) ?? null;
    this.markSeat(id);
    return id;
  }

  /** The game as a seat (or, with null, an anonymous spectator) sees it. Never carries player-type labels. */
  view(playerId: PlayerId | null): GameView {
    return viewFor(this.state, playerId);
  }

  /**
   * The spectator view plus each seat's player-type label (`agent`). Only for watchers on the web (HTTP or WebSocket
   * with no seat token); a seated player's view, the MCP and chat never get labels.
   */
  spectatorView(): GameView {
    const v = viewFor(this.state, null);
    return { ...v, players: v.players.map((p) => (this.agents[p.id] ? { ...p, agent: this.agents[p.id] } : p)) };
  }

  private commit(next: GameState, events: GameEvent[], playerId: PlayerId | null, action: HistoryEntry['action']) {
    for (const player of this.state.players) {
      if (!player.isNeutral && player.alive && next.players.some(p => p.id === player.id && !p.alive) && !this.eliminationOrder.includes(player.id)) this.eliminationOrder.push(player.id);
    }
    const before = this.state;
    this.state = next;
    this.updatedAt = Date.now();
    if (next.phase === 'finished' && this.finishedAt === null) this.finishedAt = this.updatedAt;
    this.history.push({ version: next.version, at: this.updatedAt, playerId, action, events });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    // The game archive listens here: every move, in full, before anything else reacts to it.
    const info: CommitInfo = { before, next, events, playerId, action, at: this.updatedAt };
    this.emit('commit', info);
    const msg: ChangeMessage = { state: next, events, version: next.version, playerId };
    this.emit('change', msg);
    this.scheduleBot();
    this.endIfOnlySwarm();
  }

  /**
   * Owner's rule A (docs/zergs.md): when every living seat is a Zerg, the game ends at once, as it stands. The
   * strongest Zerg wins (the engine's endByStanding), nobody surrenders and no land turns neutral. It goes through
   * commit like any move, so records, replays, rankings and tournaments see an ordinary finished game.
   */
  private endIfOnlySwarm() {
    const s = this.state;
    // The server only says which seats are Zergs (a seating concept); whether that side is all that is left, and not
    // mid-conquest, is the engine's call (onlySideLeft): the game ends on the occupy, never with a 0-army territory.
    const zergs = new Set(s.players.filter((p) => isZergSeat(p.id)).map((p) => p.id));
    // The last non-Zerg just fell to an attack and the armies have not moved in. The Zerg's own rule (no prey left and
    // not the strongest: surrender) would come before its occupy, so the server moves the minimum in for it, as an
    // ordinary move through commit; that commit then ends the game on a legal board.
    const pc = s.pendingConquest;
    if (pc && s.currentPlayer && zergs.has(s.currentPlayer) && onlySideLeft({ ...s, pendingConquest: null }, zergs)) {
      this.act(s.currentPlayer, { type: 'occupy', armies: pc.minArmies });
      return;
    }
    if (!onlySideLeft(s, zergs)) return;
    // A table seated with Zergs only (e.g. a tournament table) ends right after the deal too, unless switched off.
    if (!ALL_ZERG_TABLES_END_AT_ONCE && s.players.every((p) => p.isNeutral || isZergSeat(p.id))) return;
    const { state, events } = endByStanding(s, new Set(s.players.filter((p) => p.alive && zergs.has(p.id)).map((p) => p.id)));
    this.addChat(null, 'Game', 'Only Zergs are left: the swarm has won, and the game ends as it stands.');
    this.commit(state, events, null, { type: 'system', note: 'only Zergs are left: the swarm has won, the game ends by standing' });
  }

  bindCharacter(playerId: string, characterId: string) {
    if (this.state.phase !== 'lobby') throw new RuleError('Choose a character in the lobby before starting');
    if (Object.entries(this.characterIds).some(([id, c]) => id !== playerId && c === characterId && this.state.players.some(p => p.id === id))) throw new RuleError('This character already has a seat in this lobby');
    this.characterIds[playerId] = characterId;
    this.commit({ ...this.state, version: this.state.version + 1 }, [], playerId, { type: 'system', note: 'character selected' });
  }

  // ---- lobby ----

  /** Seat a bot (host only, checked by the caller). A Zerg always gets a Zerg name nobody in the room has. */
  addBot(kind: BotKind, name?: string): { playerId: PlayerId } {
    if (kind === 'zerg') {
      if (name !== undefined) throw new RuleError('A Zerg is named from the Zerg list; leave the name out');
      return this.join(zergName(this.state), true, 'zerg');
    }
    const n = this.state.players.filter((p) => p.isBot).length + 1;
    return this.join(name ?? `Bot ${n}`, true);
  }

  /**
   * Take a seat. `agent` is the seat's self-declared player type, shown to spectators only. A built-in bot or Zerg is
   * labelled by the server ("bot", "zerg"), whatever it declares.
   */
  join(name: string, isBot = false, kind: BotKind = 'bot', agent?: string): { playerId: PlayerId; token: string } {
    const playerId = seatIdPrefix(isBot ? kind : null) + newId(6);
    const next = addPlayer(this.state, playerId, name, isBot);
    const token = newId(24);
    this.tokens.set(token, playerId);
    const label = isBot ? kind : agent;
    if (label) this.agents[playerId] = label;
    if (!isBot) {
      this.touch();
      this.lastSeatSeen = Date.now();
    }
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

  /** Scenarios: hand a seat to its token holder (bot false) or back to a built-in bot (bot true). */
  setSeatBot(playerId: PlayerId, bot: boolean) {
    if (!this.scenarioOf) throw new RuleError('Only scenario seats can be taken over');
    const p = this.state.players.find((x) => x.id === playerId);
    if (p && !p.alive) throw new RuleError('That player is out of the game');
    const next = setPlayerBot(this.state, playerId, bot);
    if (next === this.state) return;
    if (!bot) {
      this.touch();
      this.lastSeatSeen = Date.now();
    }
    // Whoever plays the seat now: the built-in bot, or someone who has not said what they are.
    if (bot) this.agents[playerId] = 'bot';
    else delete this.agents[playerId];
    this.commit(next, [], playerId, { type: 'system', note: bot ? `${playerId} handed to a bot` : `${playerId} taken over` });
  }

  // ---- play ----

  act(playerId: PlayerId, action: Action): { state: GameState; events: GameEvent[] } {
    const { state, events } = applyAction(this.state, playerId, action);
    if (!this.state.players.find((p) => p.id === playerId)?.isBot) this.touch();
    this.commit(state, events, playerId, action);
    return { state, events };
  }

  /**
   * Post a message from a seated player. With `to` (a player id or name) it is a whisper: only the sender,
   * that player and spectators can read it.
   */
  addChat(playerId: PlayerId | null, name: string, message: string, to?: unknown): ChatMessage {
    const target = to === undefined || to === null || to === '' ? null : this.whisperTarget(playerId, to);
    const msg: ChatMessage = {
      id: (this.chat.at(-1)?.id ?? 0) + 1,
      playerId,
      name,
      message: message.slice(0, 500),
      at: Date.now(),
      ...(target ? { to: target.id, toName: target.name } : {}),
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
   * IP). The name is trimmed to 24 characters and may not pose as a seated player. With `to` (a player id
   * or name) it is a whisper to that player: only they and the other spectators can read it.
   */
  addSpectatorChat(key: string, rawName: unknown, message: string, to?: unknown): ChatMessage {
    if (this.state.options.spectatorChat === false) throw new RuleError('Spectator chat is turned off in this game');
    const target = to === undefined || to === null || to === '' ? null : this.whisperTarget(null, to);
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
      ...(target ? { to: target.id, toName: target.name } : {}),
    };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.updatedAt = now;
    this.emit('chat', msg);
    return msg;
  }

  /**
   * The player a whisper goes to: an exact player id, or else a name (any case) that exactly one player has.
   * Ids win so nobody can intercept whispers by naming themselves after another player's id. `from` is null
   * for a spectator.
   */
  private whisperTarget(from: PlayerId | null, to: unknown) {
    const raw = String(to).trim();
    const seated = this.state.players.filter((p) => !p.isNeutral);
    let target = seated.find((p) => p.id === raw);
    if (!target) {
      const named = seated.filter((p) => p.name.toLowerCase() === raw.toLowerCase());
      if (named.length > 1) throw new RuleError(`More than one player is called "${raw.slice(0, 40)}": whisper by player id instead`);
      target = named[0];
    }
    if (!target) throw new RuleError(`No player "${raw.slice(0, 40)}" to whisper to`);
    if (target.id === from) throw new RuleError("You can't whisper to yourself");
    return target;
  }

  /** Whether a viewer (a seated player, or null for a spectator) may read a chat message. */
  canReadChat(msg: ChatMessage, viewer: PlayerId | null): boolean {
    // Public messages (spectators' included, fog or not) reach everyone: the crowd is meant to be heard.
    // Whispers reach only their sender and recipient, plus spectators, who watch everything. A spectator's
    // whisper has no seated sender, so among the players only its recipient reads it.
    if (!msg.to || viewer === null) return true;
    return viewer === msg.playerId || viewer === msg.to;
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
    if (playerId) {
      this.touch();
      this.markSeat(playerId);
    }
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
      // A long-poll in progress keeps its seat present for its whole duration.
      if (playerId) this.seatPolls.set(playerId, (this.seatPolls.get(playerId) ?? 0) + 1);
      let ended = false;
      const cleanup = () => {
        if (!ended && playerId) {
          ended = true;
          const n = (this.seatPolls.get(playerId) ?? 1) - 1;
          if (n > 0) this.seatPolls.set(playerId, n);
          else this.seatPolls.delete(playerId);
          this.markSeat(playerId);
        }
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
      const action = chooseSeatAction(this.state, cur);
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
  tournaments: TournamentManager;
  rankings: Rankings;
  /** The training leaderboard: model-vs-model yardstick games (rooms with board "training"), same scoring, no seasons. */
  training: Rankings;
  /** The tournament leaderboard (rankings-tournament.json): one result per entrant per finished tournament. */
  tournamentBoard: TournamentRankings;
  /** Every game's record, move by move (under <data dir>/archive; off without persistence). */
  archive: GameArchive;
  private saveTimer: NodeJS.Timeout | null = null;

  retention: RetentionPolicy;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private file: string | null,
    retention: Partial<RetentionPolicy> = {},
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    this.rankings = new Rankings(file ? join(dirname(file), 'rankings.json') : null);
    this.training = new Rankings(file ? join(dirname(file), 'rankings-training.json') : null, 1);
    this.tournamentBoard = new TournamentRankings(file ? join(dirname(file), 'rankings-tournament.json') : null);
    const keep = Number(process.env.RISK_ARCHIVE_KEEP || DEFAULT_KEEP);
    this.archive = new GameArchive(
      file && process.env.RISK_ARCHIVE !== '0' ? join(dirname(file), 'archive') : null,
      Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_KEEP,
    );
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
          // Chosen capitals arrived later; older games keep automatic capitals.
          if (snap.state.options.chooseCapitals === undefined) snap.state.options.chooseCapitals = false;
          // Late-turn bonus arrived later: off for games already saved, so running games keep their rules.
          if (snap.state.options.firstRoundBonus === undefined) snap.state.options.firstRoundBonus = false;
          // Balanced blitz arrived later; off by default.
          if (snap.state.options.balancedBlitz === undefined) snap.state.options.balancedBlitz = false;
          const room = new GameRoom(snap);
          this.attach(room);
        }
        console.log(`Loaded ${this.rooms.size} game(s) from ${file}`);
      } catch (err) {
        console.error('Failed to load saved games:', err);
      }
    }
    // Tournaments are saved next to the games (tournaments.json) and re-attach to their tables.
    const envInt = (name: string, fallback: number, min: number) => {
      const v = Number(process.env[name] || fallback);
      return Number.isInteger(v) && v >= min ? v : fallback;
    };
    this.tournaments = new TournamentManager(this, file ? join(dirname(file), 'tournaments.json') : null, {
      maxActive: envInt('RISK_MAX_ACTIVE_TOURNAMENTS', DEFAULT_TOURNAMENT_LIMITS.maxActive, 0),
      keepFinished: envInt('RISK_TOURNAMENTS_KEEP', DEFAULT_TOURNAMENT_LIMITS.keepFinished, 1),
    });
    // A finished tournament goes on the tournament board once. On start, catch up on any that finished without being
    // recorded (a crash in between); tournaments that finished before the board existed have no table scores: skipped.
    this.tournaments.onFinished = (t) => this.tournamentBoard.record(t);
    for (const t of this.tournaments.tournaments.values()) {
      if (t.status === 'finished' && t.rounds.some((r) => r.matches.some((m) => m.order))) this.tournamentBoard.record(t, t.updatedAt);
    }
    for (const room of this.rooms.values()) room.scheduleBot();
  }

  private attach(room: GameRoom) {
    this.rooms.set(room.id, room);
    this.rank(room);
    room.on('commit', (c: CommitInfo) => this.archive.onCommit(room, c));
    room.on('change', () => {
      this.rank(room);
      this.scheduleSave();
    });
    room.on('chat', () => this.scheduleSave());
  }

  /**
   * Record a finished room's result on its board. A scenario starts from someone else's position, so it is not ranked.
   * A tournament table is never ranked on its own: its tournament scores it on the tournament board when it finishes.
   */
  private rank(room: GameRoom) {
    if (room.scenarioOf || room.tournamentId) return;
    this.board(room.board).record(room.state, room.characterIds, room.eliminationOrder);
  }

  /** The leaderboard for a board name: "training", or the public one when absent. */
  board(board?: RankingBoard): Rankings {
    return board === 'training' ? this.training : this.rankings;
  }

  /**
   * Admin: move a game to the training board, for yardstick games played before they could be created there. The room
   * (if still open) is flagged, a result already on the current public board moves to the training one (or a finished
   * room is recorded there), and its finished game records are marked. Null when no room, result or record has this id.
   */
  moveToTraining(rawId: string): { gameId: string; room: boolean; result: 'moved' | 'recorded' | 'already' | 'none'; records: number } | null {
    const id = rawId.toUpperCase();
    const room = this.rooms.get(id);
    const ranked = this.rankings.result(id);
    // First, as it is the step that can fail: nothing has changed if the public board cannot be saved.
    if (ranked) this.rankings.remove(id);
    const wasTraining = !!this.training.result(id);
    if (room && room.board !== 'training') {
      room.board = 'training';
      this.scheduleSave();
    }
    let result: 'moved' | 'recorded' | 'already' | 'none' = wasTraining ? 'already' : 'none';
    if (ranked && this.training.add(ranked)) result = 'moved';
    else if (room && !wasTraining) {
      this.rank(room);
      if (this.training.result(id)) result = 'recorded';
    }
    const records = this.archive.setBoard(id, 'training');
    if (!room && !ranked && !records && result === 'none') return null;
    return { gameId: id, room: !!room, result, records };
  }

  create(name: string, options: Partial<GameOptions>, hostName: string, hostIsBot = false, board?: RankingBoard, agent?: string): { room: GameRoom; playerId: PlayerId; token: string } {
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
      ...(board ? { board } : {}),
    });
    this.attach(room);
    const { playerId, token } = room.join(hostName, hostIsBot, 'bot', agent);
    room.hostId = playerId;
    this.scheduleSave();
    return { room, playerId, token };
  }

  /**
   * A tournament table: a room nobody hosts (so no seat can close it, kick or add players), seated with
   * the given players in order and started at once. Returns each player's seat in the same order.
   */
  createTable(name: string, options: Partial<GameOptions>, players: { name: string; isBot: boolean; kind?: BotKind; agent?: string }[], tournamentId: string): { room: GameRoom; seats: { playerId: PlayerId; token: string }[] } {
    let id = joinCode();
    while (this.rooms.has(id)) id = joinCode();
    const room = new GameRoom({ id, name, hostId: '', state: createGame(id, options), tokens: {}, chat: [], history: [], updatedAt: Date.now(), tournamentId });
    this.attach(room);
    // A Zerg entrant keeps its tournament name (a Zerg name, unique in the tournament, so unique at the table).
    const seats = players.map((p) => room.join(p.name, p.isBot, p.kind ?? 'bot', p.agent));
    room.start();
    this.scheduleSave();
    return { room, seats };
  }

  /**
   * A scenario: a new room whose game begins at one moment of a recorded game (the state just before `step`).
   * Nobody hosts it (the admin closes it). Every seat gets a fresh token; seats are bots unless `seats` opens
   * them, and a token holder can take a bot seat over later. New dice unless keepDice. Recorded like any game,
   * its record pointing back at the moment it began from.
   */
  createScenario(record: GameRecord, step: number, opts: { seats?: Record<PlayerId, ScenarioSeat>; keepDice?: boolean; name?: string } = {}) {
    let id = joinCode();
    while (this.rooms.has(id)) id = joinCode();
    const at = Date.now();
    const state = scenarioState(record, step, { id, at, seats: opts.seats, ...(opts.keepDice ? {} : { seed: randomBytes(4).readUInt32LE(0) }) });
    const scenarioOf: ScenarioRef = { recordId: record.id, step };
    const tokens: Record<string, PlayerId> = {};
    const seats = state.players
      .filter((p) => !p.isNeutral)
      .map((p) => {
        const token = newId(24);
        tokens[token] = p.id;
        return { playerId: p.id, name: p.name, alive: p.alive, bot: p.isBot, token };
      });
    const room = new GameRoom({
      id,
      name: (opts.name?.trim() || `${record.room.name} @ step ${step}`).slice(0, 40),
      hostId: '',
      state,
      tokens,
      chat: [],
      history: [],
      updatedAt: at,
      characterIds: {},
      scenarioOf,
    });
    this.attach(room);
    this.archive.begin(room, state, [], at);
    room.scheduleBot();
    this.scheduleSave();
    return { room, seats };
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
    // A game closed before anyone won still keeps its record, marked unfinished.
    this.archive.finish(room, `room closed (${reason})`);
    room.removeAllListeners('change');
    room.removeAllListeners('commit');
    this.rooms.delete(room.id);
    this.scheduleSave();
    return true;
  }

  /** For the public /healthz: "disk" or "disabled", never the path (it can name a folder on the host). */
  describePersistence(): 'disk' | 'disabled' {
    return this.file ? 'disk' : 'disabled';
  }

  releaseWaiters() {
    for (const room of this.rooms.values()) room.releaseWaiters();
    this.tournaments.releaseWaiters();
  }

  /** Save soon (debounced). */
  requestSave() {
    this.scheduleSave();
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
    // A table its tournament is still waiting on stays until it is decided, even with only bots at it.
    if (this.tournaments.isManagedTable(room)) return null;
    const phase = room.state.phase;
    // Finished games close shortly after the end, even with spectators attached.
    if (phase === 'finished' && r.finishedClose > 0 && room.finishedAt !== null && now - room.finishedAt > r.finishedClose) return `finished ${fmt(now - room.finishedAt)} ago`;
    // Every seat gone (no socket, no request, no long-poll) for a while: lobbies and running games.
    if (phase !== 'finished' && r.abandonedClose > 0 && room.hasLivingSeats() && !room.seatAttached() && now - room.lastSeatSeen > r.abandonedClose) {
      return `every seat gone ${fmt(now - room.lastSeatSeen)}`;
    }
    if (room.isWatched()) return null;
    // A scenario played by bots alone is meant to be watched or taken over: it follows the bots-only rule below.
    if (!room.hasHumans() && !room.scenarioOf) return 'no people or agents in the room';
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
    }, this.saveDelay());
  }

  /** How long changes wait before a snapshot: longer while more than BUSY_PLAYING_ROOMS games are being played. */
  saveDelay(): number {
    let playing = 0;
    for (const r of this.rooms.values()) if (r.state.phase !== 'lobby' && r.state.phase !== 'finished' && ++playing > BUSY_PLAYING_ROOMS) return BUSY_SAVE_DEBOUNCE_MS;
    return SAVE_DEBOUNCE_MS;
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
    this.tournaments.save();
  }
}

export { RuleError };
