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
  type ActionResult,
  type GameEvent,
  type GameOptions,
  type GameState,
  type GameRecord,
  type GameView,
  type PlayerId,
  type ScenarioRef,
  type ScenarioSeat,
} from '@risk/engine';
import { timeoutSteps, timerOf, type RecordDecision } from '@risk/engine';
import { BigMoveTracker, ReactionPacer, bigMoveMessage } from './reactions.js';
import { chooseSeatAction, isZergSeat, seatIdPrefix, zergName, type BotKind } from './bot.js';
import { DEFAULT_TOURNAMENT_LIMITS, TournamentManager, type TournamentClock, type TournamentTableRef } from './tournaments.js';
import { QuickPlayQueue, quickPlayConfigFromEnv } from './quick-play.js';
import { PlayerKeyStore, playerKeyConfigFromEnv } from './player-keys.js';
import { CoachLog } from './coach.js';
import { TournamentRankings } from './tournament-scoring.js';
import type { TournamentScheduler } from './tournament-schedule.js';
import { SwarmSum, ZergTally, zergReport, type SwarmTotal, type ZergReport } from './zerg-report.js';
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
  /** The turn timer ran out and the server made this move for the player. */
  timeout?: true;
  /**
   * The acting seat's private decision note for this move (`act` with `note`): kept for after the game, never shown
   * to other players or spectators while it is played (eventsSince strips it).
   */
  decisionNote?: DecisionNote;
}

/** The turn timer as a game's state shows it (null when the game has none). */
export interface TurnTimerInfo {
  mode: 'move' | 'turn';
  seconds: number;
  /** Whose clock is running, or null between turns, in the lobby, for bots and once the game is over. */
  player: PlayerId | null;
  /** When the running clock runs out (epoch ms), or null. */
  deadline: number | null;
  /** Whole seconds left on the running clock, or null. */
  secondsLeft: number | null;
}

/** A seat's note on one move: a string or any JSON value, at most MAX_NOTE_BYTES once serialized. */
export type DecisionNote = string | number | boolean | Record<string, unknown> | unknown[];
export const MAX_NOTE_BYTES = 2048;

/** A decision note from an untrusted request: undefined when absent, else the value, or a RuleError when too big. */
export function parseDecisionNote(raw: unknown): DecisionNote | undefined {
  if (raw === undefined || raw === null) return undefined;
  const json = JSON.stringify(raw);
  if (json === undefined) throw new RuleError('note must be a string or JSON');
  if (Buffer.byteLength(json, 'utf8') > MAX_NOTE_BYTES) throw new RuleError(`note is too long: at most ${MAX_NOTE_BYTES} bytes once serialized as JSON`);
  return raw as DecisionNote;
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
  /** A nested-tournament table stopped at its round's end and decided on standing: frozen from then on. */
  decidedAt?: number;
  /** This room's bots wait this long between moves (a tournament's botDelayMs); absent = the server default. */
  botDelayMs?: number;
  /** Made by the quick-play queue (see quick-play.ts): no host, the turn timer on. */
  quickPlay?: true;
  /** Seats joined with a player key: player id -> registered player id (player-keys.ts). Never the key itself. */
  playerKeys?: Record<string, string>;
  /** Live coach notes (quick play, coach.ts). */
  coachNotes?: import('@risk/engine').RecordCoachNote[];
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
  /** A tournament table in the games list: which tournament, round and table (the lobby badge). */
  tournament?: TournamentTableRef;
  /** A nested-tournament table decided on standing at its round's end (ms): the game will not go on. */
  decidedAt?: number;
  /** "training": a yardstick game ranked on the training leaderboard. Absent = public. */
  board?: RankingBoard;
  /** A quick-play game (seated by the queue, filled with house players). */
  quickPlay?: true;
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
/** Most bots one add-bots call seats (MCP add_bot count, create_game zergs, POST /games/:id/bots count). */
export const MAX_BOTS_PER_CALL = 9;
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

/** Archived Zerg reports kept in memory (GET /api/history/:id/report), most recently used first out. */
const RECORD_REPORTS_KEPT = 200;

/** A finished record's Zerg report: the same walk as a live room's tally. */
function reportOfRecord(record: GameRecord): ZergReport {
  // The game's start is not a record step, but its first turn is: put it back first, as the live walk sees it (the
  // territories come from that turn's board), so a record and a live room give the same report.
  const t0 = record.turns[0];
  const owner = t0 ? record.players.find((p) => p.id === t0.player)?.index : undefined;
  const start = t0
    ? [{ player: null, action: { type: 'start' }, events: [{ type: 'turn_started', player: t0.player, turnNumber: t0.turn, round: t0.round, reinforcements: { territories: t0.board.filter(([o]) => o === owner).length } }] as unknown as GameEvent[] }]
    : [];
  return zergReport([...start, ...record.steps.map((s) => ({ player: s.player, action: s.action, events: s.events }))], record.players);
}

export class GameRoom extends EventEmitter {
  characterIds: Record<string, string> = {};
  /** Seats joined with a player key: player id -> registered player id. They rank as `key:<registered id>`. */
  playerKeys: Record<string, string> = {};
  /** Live coach notes, quick play only (coach.ts): each seat sees its own, nobody else does. */
  coach = new CoachLog();
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
  /** Set when a nested tournament decided this table on standing at its round's end: no more moves. */
  decidedAt: number | null = null;
  /** Bot pace in this room (ms between moves); null = RISK_BOT_DELAY_MS. */
  botDelayMs: number | null = null;
  /** Seated by the quick-play queue: the sweep leaves it running while its turn timer moves for absent seats. */
  quickPlay = false;
  private botTimer: NodeJS.Timeout | null = null;
  /** Big-move reactions (reactions.ts): the turn tally and the per-game pacing of pop-ups ('big_move' events). */
  private bigMoves = new BigMoveTracker();
  private reactionPacer = new ReactionPacer((m) => this.emit('big_move', m));
  /** The turn timer (turnTimer option): when the current human or agent decision runs out. In memory only. */
  private turnTimer: NodeJS.Timeout | null = null;
  turnDeadline: number | null = null;
  /** What the running clock is for: per move the state version, per turn the player and turn. */
  private turnTimerKey: string | null = null;
  private waiters = new Set<() => void>();

  constructor(snapshot: RoomSnapshot) {
    super();
    this.setMaxListeners(500);
    this.id = snapshot.id;
    this.characterIds = snapshot.characterIds ?? {};
    this.playerKeys = snapshot.playerKeys ?? {};
    this.coach = new CoachLog(snapshot.coachNotes ?? []);
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
    this.decidedAt = snapshot.decidedAt ?? null;
    this.botDelayMs = snapshot.botDelayMs ?? null;
    this.quickPlay = snapshot.quickPlay === true;
    if (this.state.phase === 'finished') this.finishedAt = this.history.at(-1)?.at ?? this.updatedAt;
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      characterIds: this.characterIds,
      ...(Object.keys(this.playerKeys).length ? { playerKeys: this.playerKeys } : {}),
      ...(this.coach.notes.length ? { coachNotes: this.coach.notes } : {}),
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
      ...(this.decidedAt !== null ? { decidedAt: this.decidedAt } : {}),
      ...(this.botDelayMs !== null ? { botDelayMs: this.botDelayMs } : {}),
      ...(this.quickPlay ? { quickPlay: true as const } : {}),
    };
  }

  /**
   * Freeze the table: its tournament decided it on standing at the round's end. Bots and the turn timer stop, every
   * move is refused from now on, and `note` (the standing) is posted to the chat for spectators. The game itself is
   * not finished in the engine (it has no adjudicated ending); the room closes like a finished one.
   */
  decide(note: string, at = Date.now(), decision?: RecordDecision) {
    if (this.decidedAt !== null) return;
    this.decidedAt = at;
    this.stopBot();
    this.addChat(null, 'Tournament', note);
    // The archive finishes the game's record here, with the standing it was decided on (outcome reason 'standing').
    this.emit('decided', decision);
    // Long-polls and sockets hear it as a change: waiters answer 'finished', clients get the view with decidedAt.
    const msg: ChangeMessage = { state: this.state, events: [], version: this.state.version, playerId: null };
    this.emit('change', msg);
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
    this.reactionPacer.stop();
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
      ...(this.quickPlay ? { quickPlay: true as const } : {}),
      ...this.decidedField(),
    };
  }

  playerForToken(token: string | undefined): PlayerId | null {
    if (!token) return null;
    const id = this.tokens.get(token) ?? null;
    this.markSeat(id);
    return id;
  }

  /** The game as a seat (or, with null, an anonymous spectator) sees it, with the turn timer. Never carries player-type labels. */
  view(playerId: PlayerId | null): GameView & { timer: TurnTimerInfo | null; decidedAt?: number; coach?: { text: string; at: number }[] } {
    // A seat's own coach notes (quick play), in its view only: never the spectators' or another seat's.
    const coach = playerId && this.quickPlay ? this.coach.shown(playerId) : [];
    return { ...viewFor(this.state, playerId), timer: this.timerInfo(), ...this.decidedField(), ...(coach.length ? { coach } : {}) };
  }

  /**
   * A coach note for `playerId` from the person who owns the seat (checked by the caller with their player key): quick
   * play only, while the seat is in a running game. Saved with the room; the seat sees it in its next view.
   */
  addCoachNote(playerId: PlayerId, text: unknown, now = Date.now()) {
    if (!this.quickPlay) throw new RuleError('Coaching is for quick-play games only');
    const seat = this.state.players.find((p) => p.id === playerId);
    if (!seat || !seat.alive || this.state.phase === 'lobby' || this.state.phase === 'finished' || this.decidedAt !== null)
      throw new RuleError('That seat is not playing right now');
    const note = this.coach.add(playerId, text, this.state.version, now);
    this.emit('coach', note);
    return note;
  }

  /** `decidedAt` for views and summaries, only on a table decided on standing. */
  private decidedField(): { decidedAt?: number } {
    return this.decidedAt !== null ? { decidedAt: this.decidedAt } : {};
  }

  /**
   * The spectator view plus each seat's player-type label (`agent`), with the turn timer. Only for watchers on the web
   * (HTTP or WebSocket with no seat token); a seated player's view, the MCP and chat never get labels.
   */
  spectatorView(): GameView & { timer: TurnTimerInfo | null; decidedAt?: number } {
    const v = viewFor(this.state, null);
    return { ...v, players: v.players.map((p) => (this.agents[p.id] ? { ...p, agent: this.agents[p.id] } : p)), timer: this.timerInfo(), ...this.decidedField() };
  }

  timerInfo(now = Date.now()): TurnTimerInfo | null {
    const t = timerOf(this.state.options);
    if (!t) return null;
    const running = this.turnDeadline !== null;
    return {
      mode: t.mode,
      seconds: t.seconds,
      player: running ? this.state.currentPlayer : null,
      deadline: this.turnDeadline,
      secondsLeft: running ? Math.max(0, Math.ceil((this.turnDeadline! - now) / 1000)) : null,
    };
  }

  private commit(next: GameState, events: GameEvent[], playerId: PlayerId | null, action: HistoryEntry['action'], opts: { timeout?: boolean; note?: DecisionNote } = {}) {
    const { timeout = false, note } = opts;
    for (const player of this.state.players) {
      if (!player.isNeutral && player.alive && next.players.some(p => p.id === player.id && !p.alive) && !this.eliminationOrder.includes(player.id)) this.eliminationOrder.push(player.id);
    }
    const before = this.state;
    this.state = next;
    this.updatedAt = Date.now();
    if (next.phase === 'finished' && this.finishedAt === null) this.finishedAt = this.updatedAt;
    this.history.push({ version: next.version, at: this.updatedAt, playerId, action, events, ...(timeout ? { timeout: true as const } : {}), ...(note !== undefined ? { decisionNote: note } : {}) });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    // The game archive listens here: every move, in full, before anything else reacts to it.
    const info: CommitInfo = { before, next, events, playerId, action, at: this.updatedAt, ...(timeout ? { timeout: true as const } : {}), ...(note !== undefined ? { note } : {}) };
    this.emit('commit', info);
    // The clock is set before anyone hears of the change, so the state they read carries the new deadline.
    this.armTurnTimer();
    const msg: ChangeMessage = { state: next, events, version: next.version, playerId };
    this.emit('change', msg);
    // A big move ends with its turn: the pop-up follows the change that showed it (presentation only, not state).
    for (const m of this.bigMoves.observe(next, events)) this.reactionPacer.push(bigMoveMessage(this.id, next, this.characterIds, m));
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
  /** Add `count` (1-9) bots of one kind in one go, all or none: fails when the lobby has fewer free seats. */
  addBots(kind: BotKind, count: number, name?: string): { playerId: PlayerId; name: string }[] {
    if (!Number.isInteger(count) || count < 1 || count > MAX_BOTS_PER_CALL) throw new RuleError(`count must be a whole number from 1 to ${MAX_BOTS_PER_CALL}`);
    if (name !== undefined && count > 1) throw new RuleError('A name is only for a single bot; leave it out with count');
    const free = this.state.options.maxPlayers - this.state.players.length;
    if (count > free) throw new RuleError(`Only ${free} free seat${free === 1 ? '' : 's'} in this lobby (maxPlayers ${this.state.options.maxPlayers}): add fewer, or raise maxPlayers`);
    return Array.from({ length: count }, () => {
      const { playerId } = this.addBot(kind, name);
      return { playerId, name: this.state.players.find((p) => p.id === playerId)!.name };
    });
  }

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
  /** `playerKey`: the registered player (player-keys.ts) this seat plays as; one seat per registered player per room. */
  join(name: string, isBot = false, kind: BotKind = 'bot', agent?: string, playerKey?: string): { playerId: PlayerId; token: string } {
    if (playerKey && Object.values(this.playerKeys).includes(playerKey) && this.state.players.some((p) => this.playerKeys[p.id] === playerKey))
      throw new RuleError('This player already has a seat in this game');
    const playerId = seatIdPrefix(isBot ? kind : null) + newId(6);
    const next = addPlayer(this.state, playerId, name, isBot);
    const token = newId(24);
    this.tokens.set(token, playerId);
    const label = isBot ? kind : agent;
    if (label) this.agents[playerId] = label;
    if (playerKey && !isBot) this.playerKeys[playerId] = playerKey;
    if (!isBot) {
      this.touch();
      this.lastSeatSeen = Date.now();
    }
    this.commit(next, [], playerId, { type: 'system', note: `${name} joined` });
    return { playerId, token };
  }

  leave(playerId: PlayerId) {
    const next = removePlayer(this.state, playerId);
    // A lobby seat that leaves frees its player for another seat (a started game keeps the seat as it was).
    if (this.state.phase === 'lobby') delete this.playerKeys[playerId];
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

  /** Start the game; `prepare` builds the start instead of startGame (engine rules, e.g. startOnSpots). */
  start(prepare?: (lobby: GameState) => ActionResult) {
    const { state, events } = prepare ? prepare(this.state) : startGame(this.state);
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

  /** Make a move. `note` is the seat's private decision note (see HistoryEntry.decisionNote); check it first. */
  act(playerId: PlayerId, action: Action, note?: DecisionNote): { state: GameState; events: GameEvent[] } {
    if (this.decidedAt !== null) throw new RuleError("This table was decided at the round's end");
    const { state, events } = applyAction(this.state, playerId, action);
    if (!this.state.players.find((p) => p.id === playerId)?.isBot) this.touch();
    this.commit(state, events, playerId, action, { note });
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

  /** History since `version`, as anyone may read it: decision notes are taken out. */
  eventsSince(version: number): HistoryEntry[] {
    return this.history.filter((h) => h.version > version).map(({ decisionNote: _private, ...h }) => h);
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
      // A table decided on standing at its round's end is over for every seat (no move will come).
      if (this.state.phase === 'finished' || this.decidedAt !== null) return 'finished';
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

  /** Stop the bot and the turn timer (close, shutdown). */
  stopBot() {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
    this.clearTurnTimer();
  }

  // ---- turn timer ----

  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnTimerKey = null;
  }

  /**
   * Start, keep or stop the turn timer after a change. It runs only for a living human or agent seat whose decision
   * it is. Per move every change restarts it; per turn it restarts when the player or the turn changes (each setup
   * placement and capital pick counts as a turn). The clock lives here, never in the engine.
   */
  armTurnTimer() {
    const t = timerOf(this.state.options);
    const s = this.state;
    const cur = s.currentPlayer;
    const p = cur ? s.players.find((x) => x.id === cur) : undefined;
    if (!t || this.closed || this.decidedAt !== null || !p || p.isBot || !p.alive || s.phase === 'lobby' || s.phase === 'finished') return this.clearTurnTimer();
    const key = t.mode === 'move' || s.phase === 'setup' || s.phase === 'capitals' ? `v${s.version}` : `${cur}:${s.turnNumber}`;
    if (key === this.turnTimerKey && this.turnTimer) return;
    this.clearTurnTimer();
    this.turnTimerKey = key;
    this.turnDeadline = Date.now() + t.seconds * 1000;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.expireTurn();
    }, t.seconds * 1000);
    this.turnTimer.unref?.();
  }

  /**
   * The current player ran out of time: make the moves timeoutSteps picks for them (engine rules), each one
   * committed like any other move and flagged `timeout` in the history and the game record.
   */
  expireTurn() {
    const t = timerOf(this.state.options);
    const cur = this.state.currentPlayer;
    this.clearTurnTimer();
    if (!t || !cur || this.closed) return;
    try {
      for (const step of timeoutSteps(this.state, cur, t.mode)) this.commit(step.state, step.events, cur, step.action, { timeout: true });
    } catch (err) {
      console.error(`[timer ${this.id}] skipping ${cur} failed:`, err);
    }
  }

  // ---- bots ----

  scheduleBot() {
    if (this.botTimer || this.closed || this.decidedAt !== null) return;
    const cur = this.state.currentPlayer;
    if (!cur || this.state.phase === 'finished' || this.state.phase === 'lobby') return;
    const p = this.state.players.find((x) => x.id === cur);
    if (!p?.isBot) return;
    const pace = this.botDelayMs ?? BOT_DELAY_MS;
    const delay = this.state.phase === 'setup' ? Math.min(pace, 250) : pace;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.runBotStep();
    }, delay);
  }

  /**
   * Make the current bot's move now, if a bot is to move (headless runs, e.g. scripts/nested-sim.mjs, drive the bots
   * themselves instead of waiting for the timer). Returns false when it is not a bot's turn or the table is frozen.
   */
  stepBot(): boolean {
    const cur = this.state.currentPlayer;
    if (this.closed || this.decidedAt !== null || !cur || this.state.phase === 'finished' || this.state.phase === 'lobby') return false;
    if (!this.state.players.find((x) => x.id === cur)?.isBot) return false;
    const before = this.state.version;
    this.runBotStep();
    return this.state.version !== before;
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
  /** Registered players and their keys (player-keys.json next to games.json): seats joined with a key rank as one player. */
  playerKeys: PlayerKeyStore;
  /** The quick-play queue (POST /api/queue, MCP quick_play): seats waiting entrants in fresh rooms, filled with Zergs. */
  quickPlay: QuickPlayQueue;
  /** Scheduled nested tournaments (RISK_TOURNAMENT_SCHEDULE); null = no schedule (the default). */
  schedule: TournamentScheduler | null = null;
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
    /** The clock nested tournaments run their round deadlines on (tests pass a fake one). */
    opts: { clock?: TournamentClock } = {},
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
          // The turn timer arrived later: off for games already saved.
          if (snap.state.options.turnTimer === undefined) snap.state.options.turnTimer = 'off';
          if (snap.state.options.turnTimerSeconds === undefined) snap.state.options.turnTimerSeconds = 15;
          // The stall breaker arrived later: off for games already saved.
          if (snap.state.options.stallFogLift === undefined) snap.state.options.stallFogLift = 0;
          if (snap.state.options.stallStorm === undefined) snap.state.options.stallStorm = 0;
          if (snap.state.options.stallEnd === undefined) snap.state.options.stallEnd = 0;
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
      preregPerJoiner: envInt('RISK_PREREG_PER_JOINER', DEFAULT_TOURNAMENT_LIMITS.preregPerJoiner, 0),
      preregPerDay: envInt('RISK_PREREG_PER_DAY', DEFAULT_TOURNAMENT_LIMITS.preregPerDay, 0),
    }, opts.clock);
    // A finished tournament goes on the tournament board once. On start, catch up on any that finished without being
    // recorded (a crash in between); tournaments that finished before the board existed have no table scores: skipped.
    this.quickPlay = new QuickPlayQueue(this, quickPlayConfigFromEnv(process.env));
    const keys = playerKeyConfigFromEnv(process.env);
    this.playerKeys = new PlayerKeyStore(file ? join(dirname(file), 'player-keys.json') : null, keys.limits);
    this.playerKeys.enabled = keys.enabled;
    this.tournaments.onFinished = (t) => this.tournamentBoard.record(t);
    for (const t of this.tournaments.tournaments.values()) {
      if (t.status === 'finished' && t.rounds.some((r) => r.matches.some((m) => m.order))) this.tournamentBoard.record(t, t.updatedAt);
    }
    // A restored game's clock starts again in full (deadlines are not saved).
    for (const room of this.rooms.values()) {
      room.scheduleBot();
      room.armTurnTimer();
    }
  }

  private attach(room: GameRoom) {
    this.rooms.set(room.id, room);
    this.rank(room);
    room.on('commit', (c: CommitInfo) => this.archive.onCommit(room, c));
    room.on('decided', (decision?: RecordDecision) => this.archive.finish(room, 'decided on standing at its round\'s end', decision));
    room.on('commit', (c: CommitInfo) => this.tallyZergs(room, c));
    room.on('change', () => {
      this.rank(room);
      this.scheduleSave();
    });
    room.on('chat', () => this.scheduleSave());
    room.on('coach', () => this.scheduleSave());
  }

  /**
   * Record a finished room's result on its board. A scenario starts from someone else's position, so it is not ranked.
   * A tournament table is never ranked on its own: its tournament scores it on the tournament board when it finishes.
   */
  private rank(room: GameRoom) {
    // A quick-play game is not ranked: its fill seats are Zergs, and house players never count on a leaderboard.
    if (room.scenarioOf || room.tournamentId || room.quickPlay) return;
    // A seat with a player key is one named player (`key:<id>`); a bound character still wins over it.
    const keyed = Object.fromEntries(Object.entries(room.playerKeys).map(([pid, id]) => [pid, `key:${id}`]));
    this.board(room.board).record(room.state, { ...keyed, ...room.characterIds }, room.eliminationOrder);
  }

  /** Live Zerg reports, per room with Zerg seats, from its start (a room restored mid-game is not tallied). */
  private zergTallies = new Map<string, { tally: ZergTally; recordId?: string }>();
  /** Reports of archived games, by record id (records never change); the most recent RECORD_REPORTS_KEPT. */
  private recordReports = new Map<string, ZergReport>();
  /**
   * The swarm over finished games (THE HOUSE): filled from the archive once, on first use, then each game adds its own
   * report as it ends. Never re-scanned per request. `ids` keeps a game from counting twice.
   */
  private swarmDone: { sum: SwarmSum; ids: Set<string> } | null = null;
  /** Without an archive: finished games' reports, summed in memory (a restart forgets them). */
  private swarmMemory = new SwarmSum();

  private tallyZergs(room: GameRoom, c: CommitInfo) {
    if (c.action.type === 'start') {
      if (!c.next.players.some((p) => isZergSeat(p.id))) return;
      // The archive has just begun this game's record (its listener runs first): keep the id for when the game ends.
      this.zergTallies.set(room.id, { tally: new ZergTally(c.next.players), recordId: room.recordId });
    }
    const t = this.zergTallies.get(room.id);
    if (!t) return;
    t.tally.add({ player: c.playerId, action: c.action, events: c.events });
    if (c.next.phase === 'finished') this.endTally(room.id);
  }

  /** A game with Zergs ended (won, or its room dropped): its live report joins the finished total, once. */
  private endTally(roomId: string) {
    const t = this.zergTallies.get(roomId);
    if (!t) return;
    this.zergTallies.delete(roomId);
    const report = t.tally.report();
    if (!this.archive.enabled || !t.recordId) {
      this.swarmMemory.add(report);
      return;
    }
    if (this.swarmDone && !this.swarmDone.ids.has(t.recordId)) {
      this.swarmDone.ids.add(t.recordId);
      this.swarmDone.sum.add(report);
    }
  }

  private cacheReport(id: string, report: ZergReport) {
    this.recordReports.delete(id);
    this.recordReports.set(id, report);
    while (this.recordReports.size > RECORD_REPORTS_KEPT) this.recordReports.delete(this.recordReports.keys().next().value!);
  }

  /** The Zerg report of an archived game (GET /api/history/:id/report), or null for an unknown id. */
  recordReport(id: string): ZergReport | null {
    const cached = this.recordReports.get(id);
    if (cached) {
      this.cacheReport(id, cached);
      return cached;
    }
    const record = this.archive.get(id);
    if (!record) return null;
    const report = reportOfRecord(record);
    this.cacheReport(id, report);
    return report;
  }

  /**
   * The swarm over every game with Zergs (THE HOUSE): finished games (from the archive, or in memory without one) plus
   * the games being played now. Cheap per request: the finished total is kept, not recomputed.
   */
  swarmReport(): SwarmTotal {
    const live = [...this.zergTallies.values()].map((t) => t.tally.report());
    if (!this.archive.enabled) return this.swarmMemory.plus(live);
    if (!this.swarmDone) {
      // Once: every archived game with Zergs, each record read once by its index entry.
      const done = { sum: new SwarmSum(), ids: new Set<string>() };
      for (const e of this.archive.list(Infinity)) {
        if (!e.players.some((p) => isZergSeat(p.id)) || done.ids.has(e.id)) continue;
        const record = this.archive.read(e);
        if (!record) continue;
        done.ids.add(e.id);
        done.sum.add(reportOfRecord(record));
      }
      this.swarmDone = done;
    }
    return this.swarmDone.sum.plus(live);
  }

  /** The leaderboard for a board name: "training", or the public one when absent. */
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

  create(name: string, options: Partial<GameOptions>, hostName: string, hostIsBot = false, board?: RankingBoard, agent?: string, playerKey?: string): { room: GameRoom; playerId: PlayerId; token: string } {
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
    const { playerId, token } = room.join(hostName, hostIsBot, 'bot', agent, playerKey);
    room.hostId = playerId;
    this.scheduleSave();
    return { room, playerId, token };
  }

  /**
   * A tournament table: a room nobody hosts (so no seat can close it, kick or add players), seated with
   * the given players in order and started at once. Returns each player's seat in the same order.
   */
  createTable(
    name: string,
    options: Partial<GameOptions>,
    players: { name: string; isBot: boolean; kind?: BotKind; agent?: string; playerKey?: string }[],
    /** The tournament that seats this table, or null for a quick-play room. */
    tournamentId: string | null,
    /**
     * `prepare(lobby, seats)` builds the start from the seated lobby (engine rules, e.g. startOnSpots); `botDelayMs` sets the
     * bots' pace; `quickPlay` marks a room the quick-play queue made.
     */
    extra: { prepare?: (lobby: GameState, seats: { playerId: PlayerId; token: string }[]) => ActionResult; botDelayMs?: number; quickPlay?: boolean } = {},
  ): { room: GameRoom; seats: { playerId: PlayerId; token: string }[] } {
    let id = joinCode();
    while (this.rooms.has(id)) id = joinCode();
    const room = new GameRoom({ id, name, hostId: '', state: createGame(id, options), tokens: {}, chat: [], history: [], updatedAt: Date.now(), ...(tournamentId ? { tournamentId } : {}), ...(extra.botDelayMs !== undefined ? { botDelayMs: extra.botDelayMs } : {}), ...(extra.quickPlay ? { quickPlay: true as const } : {}) });
    this.attach(room);
    // A Zerg entrant keeps its tournament name (a Zerg name, unique in the tournament, so unique at the table).
    // A Zerg with no name (a quick-play fill) gets a Zerg name nobody at the table has.
    const seats = players.map((p) => room.join(p.kind === 'zerg' && !p.name ? zergName(room.state) : p.name, p.isBot, p.kind ?? 'bot', p.agent, p.playerKey));
    room.start(extra.prepare ? (lobby) => extra.prepare!(lobby, seats) : undefined);
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
    room.armTurnTimer();
    this.scheduleSave();
    return { room, seats };
  }

  get(id: string): GameRoom | undefined {
    return this.rooms.get(id.toUpperCase());
  }

  list(): GameSummary[] {
    return [...this.rooms.values()]
      .map((r) => {
        const s = r.summary();
        const table = r.tournamentId ? this.tournaments.tableOf(r.tournamentId, r.id) : null;
        return table ? { ...s, tournament: table } : s;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Close and forget a room. Attached clients are told why. */
  delete(id: string, reason: CloseReason = 'admin') {
    const room = this.rooms.get(id.toUpperCase());
    if (!room) return false;
    room.close(reason);
    // A game closed before anyone won still keeps its record, marked unfinished.
    this.archive.finish(room, `room closed (${reason})`);
    // Its Zerg tally (a game closed before the end) joins the finished total and is dropped: no leak.
    this.endTally(room.id);
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
    this.tournaments.stopTimers();
    this.quickPlay.stop();
    this.schedule?.stop();
  }

  /**
   * The seat a player key may coach in this room (live coach channel): the key's registered player owns it, and the room
   * is quick play. Null otherwise (no key, a key that does not work, no seat, not quick play).
   */
  coachSeat(room: GameRoom, key: unknown): PlayerId | null {
    if (!room.quickPlay) return null;
    const player = this.playerKeys.verify(key);
    if (!player) return null;
    return Object.entries(room.playerKeys).find(([, id]) => id === player.id)?.[0] ?? null;
  }

  /** Quick-play rooms still being played (the queue's room cap counts these). */
  liveQuickPlayRooms(): number {
    let n = 0;
    for (const room of this.rooms.values()) if (room.quickPlay && !room.closed && room.state.phase !== 'finished') n++;
    return n;
  }

  /** Why a room would be swept right now, or null to keep it. */
  staleReason(room: GameRoom, now = Date.now()): string | null {
    const idle = now - room.lastActivity;
    const r = this.retention;
    if (idle > r.max) return `idle ${fmt(idle)} (hard limit)`;
    // A table its tournament is still waiting on stays until it is decided, even with only bots at it.
    if (this.tournaments.isManagedTable(room)) return null;
    const phase = room.state.phase;
    // A table decided on standing closes like a finished game.
    if (room.decidedAt !== null && r.finishedClose > 0 && now - room.decidedAt > r.finishedClose) return `decided ${fmt(now - room.decidedAt)} ago`;
    // Finished games close shortly after the end, even with spectators attached.
    if (phase === 'finished' && r.finishedClose > 0 && room.finishedAt !== null && now - room.finishedAt > r.finishedClose) return `finished ${fmt(now - room.finishedAt)} ago`;
    // Every seat gone (no socket, no request, no long-poll) for a while: lobbies and running games.
    // A quick-play game runs on its turn timer: a seat that is thinking or gone is skipped, and the house players finish
    // the game, so it is not closed as abandoned (the hard limit above still applies). That only holds while a house
    // player is alive: a table of people alone (a full table, no fill) whose seats are all gone is swept as usual.
    const timed = room.quickPlay && timerOf(room.state.options) !== null && room.state.players.some((p) => p.isBot && p.alive && !p.isNeutral);
    if (phase !== 'finished' && !timed && r.abandonedClose > 0 && room.hasLivingSeats() && !room.seatAttached() && now - room.lastSeatSeen > r.abandonedClose) {
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
