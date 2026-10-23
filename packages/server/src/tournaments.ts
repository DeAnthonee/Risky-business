import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RuleError,
  createGame,
  createRng,
  finalPlacements,
  genMapId,
  getMap,
  maxBlizzards,
  isMapId,
  nestSeed,
  nextFloat,
  planNest,
  planToNest,
  rankByStanding,
  shuffle as seededShuffle,
  startGame,
  startOnSpots,
  stallOf,
  type GameOptions,
  type NestNode,
  type NestPlan,
  type Rng,
} from '@risk/engine';
import type { GameRoom, Store } from './store.js';
import type { CommitInfo } from './archive.js';
import { freeZergName, type BotKind } from './bot.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';
import { ROSTER_AGENT } from './roster.js';

/**
 * Knockout tournaments. The host creates one and gets its host token; players and agents join while it is
 * registering; the host (the host token or the admin key) starts it. Every round splits the remaining entrants into tables of about `groupSize`
 * (filled with bots in round 1 when `fillBots` is on), each table is an ordinary game room that nobody
 * hosts, and each table's winner moves on. The last one standing is the champion.
 *
 * Rules stay in the engine: a table is decided by the game's own winner. The manager only listens to
 * the rooms it created and builds the next round when the current one is done.
 *
 * The `nested` format (docs/tournaments.md) plans its rounds with the engine's planNest (tables of 3-6, a final of
 * 6-10, bots only when the count fits no plan) and plays every table on its own board from planToNest. A round ends
 * when every table has finished, or after its deadline (15 minutes by default): the tables still playing then get a
 * last lap, to the end of the current go-around of the turn order so every player there has taken the same number of
 * turns, and are then decided on standing (the engine's rankByStanding: territories, armies, dice).
 */

/** Wall clock for round deadlines; tests pass a fake one. */
export interface TournamentClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: TournamentClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type TournamentFormat = 'knockout' | 'nested';

export type TournamentStatus = 'registering' | 'running' | 'finished';

export interface Entrant {
  id: string;
  name: string;
  isBot: boolean;
  /** Secret that identifies this entrant (bots have none). */
  token?: string;
  /** A server bot's kind: "zerg" plays as a Zerg at its tables (docs/zergs.md); absent = the built-in bot. */
  kind?: BotKind;
  /**
   * Self-declared player type, passed to every table seat; spectators see it. The public tournament view never shows it;
   * the host's live entrants list does (GET /api/tournaments/:id/entrants: hardening #2; for anyone in open mode: #15).
   */
  agent?: string;
  /** The registered player (player key) this entrant plays as: its seats and the tournament board rank as `key:<id>`. */
  playerKey?: string;
  /**
   * A house roster name (roster.ts), joined by the seat pool: its seats and the tournament board rank as `roster:<id>`,
   * and its agent label is "AI agent" (never its model). Absent = not a roster seat.
   */
  rosterId?: string;
  joinedAt: number;
  /** Scheduled tournaments: when this entrant checked in (polled the bracket inside the check-in window). */
  checkedInAt?: number;
  /** A no-show swapped for a Zerg at a scheduled start: the person's name and old token (so their client hears why). */
  missed?: { name: string; token: string };
  /**
   * Dropped from the tournament (seat-health.ts: disconnected): a stand-in ("<name>-bot") plays its seat to the end of
   * that table only. It may win the table, but never moves on: the best other seat by standing does.
   */
  dropped?: { reason: string; at: number; standIn: string };
}

export interface TournamentMatch {
  /** The table's game room; null for a bye. */
  gameId: string | null;
  entrants: string[];
  /** Each entrant's seat in the room. */
  seats: Record<string, { playerId: string; token: string }>;
  winner: string | null;
  /**
   * 'abandoned': the room was closed before anyone won, so nobody from this table moves on.
   * 'decided' (nested): the round ended first, and the table was decided on standing.
   */
  status: 'playing' | 'finished' | 'bye' | 'abandoned' | 'decided';
  /** Nested: the table's index in its round of the plan, its board, and that board's index in `nested.nodes`. */
  table?: number;
  map?: string;
  node?: number;
  /** Nested, a decided table: every entrant in standing order, and the dice rolled to break ties (by entrant). */
  standing?: { order: string[]; rolls: Record<string, number[]> };
  /** Set when the table settles: its entrants best first (the game's final placings, or the standing), for the tournament board. */
  order?: string[];
  /** Set when the table settles: players each entrant eliminated there (surrenders credit nobody). */
  kills?: Record<string, number>;
  /** Fun numbers per entrant, gathered while the table is played (for the house-bot panel; nothing is ranked on them). */
  stats?: Record<string, TableStats>;
  /**
   * Nested, set at the round's deadline on a table still playing: the game's round then (GameState.round). The table is
   * decided once that round is over (the turn passed the last seat in turn order), so everyone there has had as many turns.
   */
  lapRound?: number;
}

/**
 * One entrant's numbers at one table. Collected from the table's moves as they happen, so a table already being
 * played when the server restarts counts only from the restart on.
 */
export interface TableStats {
  /** Armies this entrant lost in battles, attacking or defending. */
  lost: number;
  /** Enemy armies this entrant destroyed in battles. */
  destroyed: number;
  /** Territories this entrant conquered. */
  conquests: number;
  /** Most armies this entrant held on the board at once. */
  peak: number;
  /** The turn this entrant was knocked out on, or the table's last turn if it was still in. */
  turns: number;
}

export interface TournamentRound {
  round: number;
  matches: TournamentMatch[];
  /** Nested: the round's deadline (absolute ms), when its last lap began (the deadline passed), and when it ended. */
  deadline?: number;
  lastLapAt?: number;
  endedAt?: number;
}

/** A nested tournament's settings, and from its start its plan and boards. */
export interface NestedSettings {
  /** Board of the final: an existing map, or null for a generated one. */
  finalMap: string | null;
  territoriesPerSeat: number;
  roundMinutes: number;
  /** Unused since 2026-10-22 (a round no longer closes early); kept so saved tournaments and old clients still load. */
  finishShare: number;
  /** Bots' pace at this tournament's tables, ms between moves. Absent on tournaments saved before it: the server default. */
  botDelayMs?: number;
  /**
   * Blizzards as a share of each table's territories (NESTED_BLIZZARD_SHARE), set when the host gave no blizzard
   * count. Absent (an explicit count, or saved before it): every table uses `options.blizzards` as given.
   */
  blizzardShare?: number;
  /** A seed the host fixed at create (else one is drawn at start). */
  fixedSeed?: number;
  /** Set at start: the seed of every board and of the seating, the plan, each table's board, and each table's portals
   * (the territories its children's winners start on, in portal order). */
  seed?: number;
  plan?: NestPlan;
  boards?: string[][];
  portals?: string[][][];
  /** The board tree (resolveNest's list): every table's board, seats, portals and parent, known from the start. */
  nodes?: NestNode[];
  /** Index in `nodes` of each table's board ([round][table]). */
  nodeOf?: number[][];
}

export interface TournamentSnapshot {
  id: string;
  name: string;
  status: TournamentStatus;
  /** Game settings every table uses (seats are set per table). */
  options: Partial<GameOptions>;
  groupSize: number;
  maxEntrants: number;
  fillBots: boolean;
  entrants: Entrant[];
  rounds: TournamentRound[];
  champion: string | null;
  /**
   * Secret returned once by create: it (or the admin key) starts, forfeits for and deletes this tournament.
   * Tournaments saved before host tokens existed have none and are admin-only.
   */
  hostToken?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  /** Absent on tournaments saved before formats existed: a knockout. */
  format?: TournamentFormat;
  nested?: NestedSettings;
  /** Made by the server's schedule (RISK_TOURNAMENT_SCHEDULE): when it starts, and why it was called off, if it was. */
  scheduled?: TournamentScheduleInfo;
  /** The seat counts the host created it with (absent when created without counts). */
  requested?: TournamentCounts;
  /** Set when it was aborted (stopped by its host or the admin, or deleted while running): finished, no champion. */
  aborted?: { at: number };
}

/** A scheduled tournament's start (ms) and, if it never ran, why ("not enough entrants"). */
export interface TournamentScheduleInfo {
  startsAt: number;
  cancelled?: string;
  /** The check-in window: entrants check in during the last this-many minutes before the start (default 10). */
  checkinMinutes?: number;
  /** At the start: how many people missed check-in and were swapped for Zergs. */
  noShows?: number;
}

/** Default check-in window, minutes before a scheduled start. */
export const DEFAULT_CHECKIN_MINUTES = 10;

/** How many tournaments the server keeps. */
export interface TournamentLimits {
  /** Most tournaments registering or running at once; creating another fails (0 = no cap). */
  maxActive: number;
  /** Finished tournaments kept (newest first); older ones are pruned from memory and tournaments.json. */
  keepFinished: number;
  /** Scheduled tournaments: one joiner (an IP, or an MCP session) holds at most this many open registrations. */
  preregPerJoiner: number;
  /** Scheduled tournaments: at most this many registrations site-wide in any 24 h (new MCP sessions are free); 0 = no cap. */
  preregPerDay: number;
}

export const DEFAULT_TOURNAMENT_LIMITS: TournamentLimits = { maxActive: 20, keepFinished: 100, preregPerJoiner: 4, preregPerDay: 500 };

export interface CreateTournamentSpec {
  name?: string;
  options?: Partial<GameOptions>;
  groupSize?: number;
  maxEntrants?: number;
  fillBots?: boolean;
  /** 'nested': planned rounds on boards inside boards (the settings below); default 'knockout'. */
  format?: TournamentFormat;
  /** Nested: the final's board (an existing map seating 6+, with a region per seat); default a generated board. */
  finalMap?: string;
  /** Nested: generated boards' size, territories per seat (4-6, default 5). */
  territoriesPerSeat?: number;
  /** Nested: a round's deadline in minutes (1-240, default 30). */
  roundMinutes?: number;
  /** Nested: accepted (0.1-1) for old callers and ignored: a round no longer closes early. */
  finishShare?: number;
  /** Nested: bots' pace at the tables, ms between moves (0-2000, default 300). */
  botDelayMs?: number;
  /** Nested: fix the seed of the boards, seating and tie-break dice (replays and simulations); default random. */
  seed?: number;
  /** Set by the server's schedule only (never parsed from a request): the planned start. */
  scheduled?: { startsAt: number; checkinMinutes?: number };
  /**
   * The host's seat counts (create form, MCP create_tournament): `zergs` Zerg entrants added at once, `delove` Delove
   * seats asked for (stored only, until the Delove seat pool joins on request), `open` spots for people and agents.
   * With any count, maxEntrants defaults to their sum.
   */
  zergs?: number;
  delove?: number;
  open?: number;
}

/** A host's seat counts: Zergs added at create, Delove seats asked for (stored), open spots. */
export interface TournamentCounts {
  zergs: number;
  delove: number;
  open: number;
}

/** Public view; `you` is filled in when the caller passed their entrant token. */
export interface TournamentView {
  id: string;
  name: string;
  status: TournamentStatus;
  map: string;
  options: Partial<GameOptions>;
  groupSize: number;
  maxEntrants: number;
  fillBots: boolean;
  entrants: { id: string; name: string; isBot: boolean; status: 'registered' | 'playing' | 'waiting' | 'out' | 'champion' | 'dropped'; dropped?: { reason: string; standIn: string } }[];
  rounds: {
    round: number;
    /** Nested: the round's deadline, the start of its last lap and its end (ms). */
    deadline?: number;
    lastLapAt?: number;
    endedAt?: number;
    matches: {
      gameId: string | null;
      status: TournamentMatch['status'];
      players: { entrantId: string; name: string }[];
      winner: string | null;
      /** Nested: the table's board, and its index in `nested.nodes`. */
      map?: string;
      node?: number;
      /** Nested, decided on standing: entrants in order, and tie-break dice. */
      standing?: TournamentMatch['standing'];
    }[];
  }[];
  champion: { entrantId: string; name: string } | null;
  format: TournamentFormat;
  /** Nested: the settings and the plan's table sizes per round (seats per table, the final last). */
  nested?: {
    finalMap: string | null;
    territoriesPerSeat: number;
    roundMinutes: number;
    finishShare: number;
    botDelayMs: number | null;
    /** Blizzards as a share of each table's territories, or null when every table uses options.blizzards. */
    blizzardShare: number | null;
    plan: number[][] | null;
    zergs: number;
    /** The board tree from the start (null before): each table's board, seats, portals, parent board and portal. */
    nodes: NestNode[] | null;
  };
  /** Made by the server's schedule: its start, check-in window and, once open, how many checked in; if it never ran, why. */
  scheduled?: TournamentScheduleInfo & { checkedIn?: number };
  /** Aborted: when. The bracket stays as it was; the tables then being played have records with the standing so far. */
  aborted?: { at: number };
  createdAt: number;
  updatedAt: number;
  version: number;
  you?: {
    entrantId: string;
    name: string;
    status: TournamentView['entrants'][number]['status'];
    /** Your table in the current round while it is being played: open it with this seat token. */
    match: { gameId: string; playerId: string; token: string; round: number } | null;
    /** Scheduled tournaments: whether you have checked in (poll the bracket inside the check-in window). */
    checkedIn?: boolean;
  };
}

/**
 * Which tournament table a game is: the tournament, its round, the table's place in that round (1-based, as on the
 * bracket page) and whether it is the final. The games list, the game socket and link previews carry it, so a
 * tournament table is marked everywhere ("🏆 Cup · Round 2, table 3").
 */
export interface TournamentTableRef {
  id: string;
  name: string;
  round: number;
  table: number;
  tables: number;
  final: boolean;
}

/** "Round 2, table 3", or "the final". */
export function tableLabel(ref: Pick<TournamentTableRef, 'round' | 'table' | 'tables' | 'final'>): string {
  if (ref.final) return 'the final';
  return ref.tables > 1 ? `Round ${ref.round}, table ${ref.table}` : `Round ${ref.round}`;
}

export interface TournamentSummary {
  id: string;
  name: string;
  status: TournamentStatus;
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

const MAX_NAME = 24;
const DEFAULT_MAX_ENTRANTS = 64;
const DEFAULT_MAX_NESTED_ENTRANTS = 128;
/** Nested (and so scheduled) tournaments' table settings when the host leaves them out (owner, 2026-10-22). */
/** A nested table's per-move turn timer when the host sets none (the owner's default). */
export const NESTED_TURN_TIMER_SECONDS = 90;
/** A nested (and so scheduled) round's deadline when the host sets none, in minutes (owner, 2026-10-22). */
export const NESTED_ROUND_MINUTES = 15;
/**
 * The stall breakers (owner, 2026-10-22): the fog lifts after 3 stalled rounds, a storm wears down idle stacks from 5,
 * and 5 stalled rounds after that (10 with no capture) the table ends on standing.
 */
export const NESTED_DEFAULT_OPTIONS: Partial<GameOptions> = { autoSetup: true, capitals: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5 };
/** Unless the host sets a blizzard count, each nested table freezes this share of its own board's territories. */
export const NESTED_BLIZZARD_SHARE = 0.1;

/** A table's blizzards for a share of its board: at least 1, at most the map's limit. */
export function blizzardsFor(mapId: string, share: number): number {
  const map = getMap(mapId as GameOptions['map']);
  return Math.min(maxBlizzards(map), Math.max(1, Math.round(share * map.territoryIds.length)));
}
const MAX_ENTRANTS = 256;
const NESTED_TABLE = { min: 3, max: 6 };
const NESTED_FINAL = { min: 6, max: 10 };

function newId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function code(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'T';
  for (let i = 0; i < 5; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function shuffle<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The first "Bot <n>" none of `names` uses (any case). */
function nextBotName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`bot ${n}`)) return `Bot ${n}`;
}

/** Split `n` entrants into the fewest tables of at most `size`, as even as possible (sizes differ by at most 1). */
export function tableSizes(n: number, size: number): number[] {
  if (n <= 0) return [];
  const tables = Math.ceil(n / size);
  const base = Math.floor(n / tables);
  const extra = n % tables;
  return Array.from({ length: tables }, (_, i) => base + (i < extra ? 1 : 0));
}

export class TournamentManager extends EventEmitter {
  tournaments = new Map<string, TournamentSnapshot>();
  /** Called once when a tournament finishes (the store records it on the tournament leaderboard). */
  onFinished: ((t: TournamentSnapshot) => void) | null = null;
  /** Called first thing when a tournament starts, still registering (seat-requests.ts: unfilled Delove seats become Zergs). */
  beforeStart: ((t: TournamentSnapshot) => void) | null = null;
  /** A seat was dropped as disconnected (its entrant is now dropped): the app asks the Delove seat pool to take it over. */
  onSeatDropped: ((d: { tournamentId: string; gameId: string; playerId: string; name: string; fog: boolean }) => void) | null = null;
  /** The Delove seat pool's free capacity, for the preview (seat-requests.ts); null = no pool configured. */
  delovePool: (() => { online: boolean; free: number; freeSearch: number }) | null = null;

  limits: TournamentLimits;

  /** Nested tournaments' round deadline timers, by tournament id. */
  private roundTimers = new Map<string, unknown>();
  /** Who joined each entrant of a scheduled tournament (an IP or an MCP session), for the pre-registration cap. */
  private joiners = new Map<string, string>();
  /** Site-wide pre-registrations in the last 24 h (in memory); null = no cap. Set up in the constructor. */
  private preregDaily: RateLimiter | null = null;

  constructor(
    private store: Store,
    private file: string | null,
    limits: Partial<TournamentLimits> = {},
    readonly clock: TournamentClock = REAL_CLOCK,
  ) {
    super();
    this.limits = { ...DEFAULT_TOURNAMENT_LIMITS, ...limits };
    if (this.limits.preregPerDay > 0) this.preregDaily = new RateLimiter(this.limits.preregPerDay, 24 * 60 * 60_000, () => this.clock.now());
    this.setMaxListeners(500);
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as TournamentSnapshot[];
        for (const t of data) this.tournaments.set(t.id, t);
        console.log(`Loaded ${this.tournaments.size} tournament(s) from ${file}`);
      } catch (err) {
        console.error('Failed to load saved tournaments:', err);
      }
    }
    // Re-attach to the tables that were being played; a table whose room is gone was abandoned.
    for (const t of this.tournaments.values()) {
      if (t.status !== 'running') continue;
      for (const m of this.currentRound(t)?.matches ?? []) {
        if (m.status !== 'playing' || !m.gameId) continue;
        const room = this.store.get(m.gameId);
        if (room && !room.closed && room.decidedAt === null) this.watch(t, m, room);
        else m.status = 'abandoned';
      }
      this.advance(t);
      // Nested: the round clock starts again from its saved deadline (a deadline passed while down starts the last lap now).
      if (t.format === 'nested' && t.status === 'running') {
        const round = this.currentRound(t);
        if (round && !round.endedAt && round.deadline !== undefined && this.clock.now() >= round.deadline) {
          this.lastLap(t);
          this.changed(t);
        } else this.armRound(t);
      }
    }
    this.prune();
  }

  // ---- host ----

  /**
   * Create a tournament; the snapshot carries its `hostToken`: hand it to the creator only. With seat counts (`zergs`, `delove`, `open`), maxEntrants defaults to their sum, the Zergs
   * are added at once, and the counts are kept (`requested`); the Delove seats are only stored for now.
   */
  create(spec: CreateTournamentSpec): TournamentSnapshot {
    const counts = tournamentCounts(spec);
    if (!counts) return this.createUnfilled(spec);
    const total = counts.zergs + counts.delove + counts.open;
    if (spec.maxEntrants !== undefined && spec.maxEntrants < total) throw new RuleError(`maxEntrants (${spec.maxEntrants}) is less than the seats asked for (${total})`);
    const t = this.createUnfilled({ ...spec, maxEntrants: spec.maxEntrants ?? total });
    t.requested = counts;
    if (counts.zergs) this.addBots(t.id, 'zerg', counts.zergs);
    else this.changed(t);
    return t;
  }

  private createUnfilled(spec: CreateTournamentSpec): TournamentSnapshot {
    const { maxActive } = this.limits;
    if (maxActive > 0 && [...this.tournaments.values()].filter((x) => x.status !== 'finished').length >= maxActive)
      throw new RuleError(`Too many tournaments are open right now (${maxActive}); try again when one has finished`);
    if (spec.format === 'nested') return this.createNested(spec);
    if (spec.format !== undefined && spec.format !== 'knockout') throw new RuleError('format must be "knockout" or "nested"');
    if (spec.seed !== undefined) throw new RuleError('seed applies to nested tournaments only');
    const options: Partial<GameOptions> = { map: 'skirmish', ...(spec.options ?? {}) };
    delete options.maxPlayers; // set per table
    const map = getMap(options.map);
    const groupSize = spec.groupSize ?? Math.min(4, map.maxPlayers);
    if (!Number.isInteger(groupSize) || groupSize < 2 || groupSize > map.maxPlayers)
      throw new RuleError(`groupSize must be a whole number from 2 to ${map.maxPlayers} on this map`);
    const maxEntrants = spec.maxEntrants ?? DEFAULT_MAX_ENTRANTS;
    if (!Number.isInteger(maxEntrants) || maxEntrants < 2 || maxEntrants > MAX_ENTRANTS) throw new RuleError(`maxEntrants must be a whole number from 2 to ${MAX_ENTRANTS}`);
    // Later rounds can seat smaller tables: the settings must work at every size, so check them now, not mid-bracket.
    for (let seats = 2; seats <= groupSize; seats++) createGame('CHECK', { ...options, maxPlayers: seats });
    let id = code();
    while (this.tournaments.has(id)) id = code();
    const now = Date.now();
    const t: TournamentSnapshot = {
      id,
      name: String(spec.name ?? '').trim().slice(0, 60) || 'Tournament',
      status: 'registering',
      options,
      groupSize,
      maxEntrants,
      fillBots: spec.fillBots ?? true,
      entrants: [],
      rounds: [],
      champion: null,
      hostToken: newId(24),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tournaments.set(id, t);
    this.changed(t);
    return t;
  }

  /** Previews per client (IP address) per minute: the preview is public and plans on every call. */
  previewLimiter = new RateLimiter(PREVIEW_PER_MINUTE, 60_000);

  /**
   * What a nested tournament with these counts and settings would look like, creating nothing: the plan (tables per
   * round, finalists, Zergs the planner adds), the final's board, how round 1 would seat people and server bots
   * (#240's seating, every open spot taken), and the time as a range (a formula, no simulation: the endpoint is
   * public). Throws on bad settings, like create. `client`: the caller's address, for the per-client limit (null =
   * not limited, e.g. tests and the schedule).
   */
  preview(spec: CreateTournamentSpec, client: string | null = null): TournamentPreview {
    if (client !== null && !this.previewLimiter.take(client)) throw new RateLimitedError(`Too many previews: at most ${PREVIEW_PER_MINUTE} a minute`);
    if (spec.format !== undefined && spec.format !== 'nested') throw new RuleError('The preview is for nested tournaments (format "nested")');
    const counts = tournamentCounts(spec);
    if (!counts) throw new RuleError('A tournament needs at least 2 seats: count Zergs, Delove seats and open spots');
    const total = counts.zergs + counts.delove + counts.open;
    this.createNested({ ...spec, format: 'nested', maxEntrants: spec.maxEntrants ?? Math.max(2, total) }, true);
    const tps = spec.territoriesPerSeat ?? 5;
    const roundMinutes = spec.roundMinutes ?? NESTED_ROUND_MINUTES;
    const botDelayMs = spec.botDelayMs ?? 300;
    const finalMax = spec.finalMap ? this.maxFinal(spec.finalMap) : NESTED_FINAL.max;
    const plan = planNest(total, { maxFinal: finalMax });
    // Round 1 as it would be seated: open spots are guests, Delove seats house AI (seated after the guests), then Zergs.
    const entrants = [
      ...Array.from({ length: counts.open }, (_, i) => ({ id: `p${i}`, isBot: false })),
      ...Array.from({ length: counts.delove }, (_, i) => ({ id: `d${i}`, isBot: false })),
      ...Array.from({ length: counts.zergs + plan.zergs }, (_, i) => ({ id: `z${i}`, isBot: true, kind: 'zerg' as const })),
    ];
    const seated = seatNestedRound(plan.rounds[0], entrants, createRng(1), new Set(entrants.filter((e) => e.id.startsWith('d')).map((e) => e.id)));
    const firstRound = seated.map((ids, j) => ({ seats: plan.rounds[0][j].seats, people: ids.filter((id) => id.startsWith('p') || id.startsWith('d')).length, zergs: ids.filter((id) => id.startsWith('z')).length }));
    // Time: low = every table at bot pace (moves grow with seats), high = every round to its deadline.
    const roundsLow = plan.rounds.map((r) => {
      const biggest = Math.max(...r.map((x) => x.seats));
      return Math.min(roundMinutes, Math.max(1, Math.ceil((biggest * PREVIEW_BOT_MOVES_PER_SEAT * botDelayMs) / 60_000)));
    });
    const options = { ...NESTED_DEFAULT_OPTIONS, ...(spec.options ?? {}) };
    const timer = options.turnTimer === undefined ? { mode: 'move', seconds: NESTED_TURN_TIMER_SECONDS } : options.turnTimer === 'off' ? null : { mode: options.turnTimer, seconds: options.turnTimerSeconds ?? 15 };
    const warnings: string[] = [];
    const pool = this.delovePool?.() ?? null;
    if (counts.delove) {
      if (!pool) warnings.push(`The ${counts.delove} Delove seats are stored with the tournament; no Delove seat pool is set up here, so an operator joins them (npm run delove-seat) or Zergs take them at the start.`);
      else if (!pool.online) warnings.push(`Delove seat pool offline: the ${counts.delove} Delove seats go to Zergs at the start unless it comes back before then.`);
      else warnings.push(`Delove: ${pool.free} seats available now${pool.free < counts.delove ? `, fewer than the ${counts.delove} asked for (the rest go to Zergs at the start)` : ''}.`);
    }
    if (plan.zergs) warnings.push(`The plan adds ${plan.zergs} Zergs so the numbers fit a bracket.`);
    const allBots = firstRound.filter((t) => t.people === 0).length;
    if (allBots) warnings.push(`${allBots} round-1 tables would be server bots only (fewer people than tables).`);
    if (counts.open) warnings.push('The breakdown assumes every open spot is taken; the plan is made again from the real entrants at the start.');
    return {
      counts,
      seats: total,
      plannerZergs: plan.zergs,
      rounds: plan.rounds.length,
      tablesPerRound: plan.rounds.map((r) => r.length),
      seatsPerRound: plan.rounds.map((r) => r.map((x) => x.seats)),
      finalists: plan.finalSeats,
      finalBoard: spec.finalMap
        ? { map: spec.finalMap, name: getMap(spec.finalMap).name, generated: false, territories: getMap(spec.finalMap).territoryIds.length }
        : { map: null, name: 'a generated board', generated: true, territories: plan.finalSeats * tps },
      firstRound,
      timer,
      minutes: { low: roundsLow.reduce((a, b) => a + b, 0), high: plan.rounds.length * roundMinutes, perRound: roundMinutes },
      delovePool: pool,
      warnings,
    };
  }

  /** Check a nested tournament's settings without creating it (the schedule, at startup). Throws on bad settings. */
  checkNested(spec: CreateTournamentSpec): void {
    this.createNested(spec, true);
  }

  /** A nested tournament: the boards come from the plan at start, so the settings are checked on every table size. */
  private createNested(spec: CreateTournamentSpec, dryRun: true): null;
  private createNested(spec: CreateTournamentSpec, dryRun?: false): TournamentSnapshot;
  private createNested(spec: CreateTournamentSpec, dryRun = false): TournamentSnapshot | null {
    // The owner's tournament mode (a random deal and placement, capitals, blizzards) unless the host says otherwise.
    const options: Partial<GameOptions> = { ...NESTED_DEFAULT_OPTIONS, ...(spec.options ?? {}) };
    delete options.maxPlayers; // set per table
    delete options.map; // every table plays its own board
    const tps = spec.territoriesPerSeat ?? 5;
    if (!Number.isInteger(tps) || tps < 4 || tps > 6) throw new RuleError('territoriesPerSeat must be a whole number from 4 to 6');
    const roundMinutes = spec.roundMinutes ?? NESTED_ROUND_MINUTES;
    if (!Number.isInteger(roundMinutes) || roundMinutes < 1 || roundMinutes > 240) throw new RuleError('roundMinutes must be a whole number from 1 to 240');
    const finishShare = spec.finishShare ?? 0.51;
    if (typeof finishShare !== 'number' || !(finishShare >= 0.1 && finishShare <= 1)) throw new RuleError('finishShare must be a number from 0.1 to 1');
    const botDelayMs = spec.botDelayMs ?? 300;
    if (!Number.isInteger(botDelayMs) || botDelayMs < 0 || botDelayMs > 2000) throw new RuleError('botDelayMs must be a whole number from 0 to 2000');
    // Tables run on a per-move turn timer unless the host says otherwise, so a stalled seat cannot hold a round.
    if (options.turnTimer === undefined) {
      options.turnTimer = 'move';
      if (options.turnTimerSeconds === undefined) options.turnTimerSeconds = NESTED_TURN_TIMER_SECONDS;
    }
    if (spec.seed !== undefined && (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff)) throw new RuleError('seed must be a whole number from 0 to 4294967295');
    const maxEntrants = spec.maxEntrants ?? DEFAULT_MAX_NESTED_ENTRANTS;
    if (!Number.isInteger(maxEntrants) || maxEntrants < 2 || maxEntrants > MAX_ENTRANTS) throw new RuleError(`maxEntrants must be a whole number from 2 to ${MAX_ENTRANTS}`);
    let finalMap: string | null = null;
    if (spec.finalMap !== undefined) {
      if (!isMapId(spec.finalMap)) throw new RuleError(`Unknown map "${spec.finalMap}"`);
      finalMap = spec.finalMap;
      if (this.maxFinal(finalMap) < NESTED_FINAL.min) throw new RuleError(`The final needs a board seating ${NESTED_FINAL.min}+ players with a region per seat`);
    }
    // The settings must work at every table size the plan can make, on generated boards and on the final's board.
    for (let seats = 2; seats <= NESTED_FINAL.max; seats++) createGame('CHECK', { ...options, map: genMapId({ seed: 1, seats, territoriesPerSeat: tps }), maxPlayers: seats });
    if (finalMap) for (let seats = NESTED_FINAL.min; seats <= this.maxFinal(finalMap); seats++) createGame('CHECK', { ...options, map: finalMap as GameOptions['map'], maxPlayers: seats });
    // No blizzard count from the host: each table gets its share of its own board (buildNestedRound).
    const blizzardShare = options.blizzards === undefined ? NESTED_BLIZZARD_SHARE : undefined;
    if (dryRun) return null;
    let id = code();
    while (this.tournaments.has(id)) id = code();
    const now = Date.now();
    const t: TournamentSnapshot = {
      id,
      name: String(spec.name ?? '').trim().slice(0, 60) || 'Tournament',
      status: 'registering',
      options,
      groupSize: NESTED_TABLE.max,
      maxEntrants,
      fillBots: true,
      entrants: [],
      rounds: [],
      champion: null,
      hostToken: newId(24),
      createdAt: now,
      updatedAt: now,
      version: 1,
      format: 'nested',
      nested: { finalMap, territoriesPerSeat: tps, roundMinutes, finishShare, botDelayMs, ...(blizzardShare !== undefined ? { blizzardShare } : {}), ...(spec.seed !== undefined ? { fixedSeed: spec.seed } : {}) },
      ...(spec.scheduled ? { scheduled: { startsAt: spec.scheduled.startsAt, ...(spec.scheduled.checkinMinutes !== undefined ? { checkinMinutes: spec.scheduled.checkinMinutes } : {}) } } : {}),
    };
    this.tournaments.set(id, t);
    this.changed(t);
    return t;
  }

  /** The biggest final a board can seat: its seats, one region per seat, at most 10. */
  private maxFinal(map: string): number {
    const m = getMap(map);
    return Math.min(NESTED_FINAL.max, m.maxPlayers, m.continents.length);
  }

  start(id: string): TournamentSnapshot {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('This tournament has already started');
    this.beforeStart?.(t);
    if (!t.entrants.length) throw new RuleError('Nobody has joined yet');
    if (t.format === 'nested') return this.startNested(t);
    if (t.fillBots) {
      const target = Math.max(2, Math.ceil(t.entrants.length / t.groupSize) * t.groupSize);
      while (t.entrants.length < target) t.entrants.push({ id: `e_${newId(6)}`, name: nextBotName(t.entrants.map((e) => e.name)), isBot: true, joinedAt: Date.now() });
    }
    if (t.entrants.length < 2) throw new RuleError('A tournament needs at least 2 entrants (or turn fillBots on)');
    t.status = 'running';
    this.buildRound(t, t.entrants.map((e) => e.id));
    this.changed(t);
    return t;
  }

  /** Concede for an entrant who will not play (a no-show): they surrender at their table. */
  forfeit(id: string, entrantId: string): TournamentSnapshot {
    const t = this.require(id);
    const m = this.currentRound(t)?.matches.find((x) => x.status === 'playing' && x.entrants.includes(entrantId));
    if (!m?.gameId) throw new RuleError('That entrant is not playing a table right now');
    const room = this.store.get(m.gameId);
    if (!room) throw new RuleError('That table no longer exists');
    room.act(m.seats[entrantId].playerId, { type: 'surrender' });
    return t;
  }

  /**
   * Call off a tournament that is still registering (a scheduled one nobody came to): it is finished with no rounds
   * and no champion, so it never reaches the tournament board, and `scheduled.cancelled` says why.
   */
  cancel(id: string, reason: string): TournamentSnapshot {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('This tournament has already started');
    t.status = 'finished';
    t.scheduled = { startsAt: t.scheduled?.startsAt ?? this.clock.now(), cancelled: reason };
    this.changed(t);
    return t;
  }

  /**
   * Abort a tournament (owner, 2026-10-22): stop it and keep its bracket, finished with no champion (`aborted`). Every
   * table still being played is ranked on standing so far (the engine's rankByStanding, its dice from the game's own
   * seed) and its game record filed with reason "aborted" and that standing, before the room closes. A registering
   * tournament is just stopped. Nothing goes on the tournament board. Aborting a finished tournament changes nothing.
   */
  abort(id: string): TournamentSnapshot {
    const t = this.require(id);
    if (t.status === 'finished') return t;
    const now = this.clock.now();
    // Finished first, so tables closing below never seat a next round.
    t.status = 'finished';
    t.champion = null;
    t.aborted = { at: now };
    this.clearRoundTimer(t.id);
    const round = this.currentRound(t);
    for (const m of round?.matches ?? []) {
      if (m.status !== 'playing') continue;
      m.status = 'abandoned';
      const room = m.gameId ? this.store.get(m.gameId) : undefined;
      if (!room || room.closed) continue;
      const rng = createRng(room.state.rngState);
      const standing = rankByStanding(room.state, () => nextFloat(rng), room.eliminationOrder);
      const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
      const order = standing.order.map((pid) => byPlayer.get(pid)).filter((eid): eid is string => !!eid);
      m.standing = { order, rolls: Object.fromEntries(Object.entries(standing.rolls).filter(([pid]) => byPlayer.has(pid)).map(([pid, r]) => [byPlayer.get(pid)!, r])) };
      this.scoreTable(m, room);
      m.order = order;
      this.store.delete(room.id, 'admin', { standing: standing.order, rolls: standing.rolls });
    }
    if (round && round.endedAt === undefined) round.endedAt = now;
    this.changed(t);
    return t;
  }

  /**
   * Take an entrant out while registering (a house-roster seat making room for a person: SeatRequests.makeRoom). Its
   * token stops working; nothing else changes.
   */
  removeEntrant(id: string, entrantId: string): void {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('Registration is closed: this tournament has started');
    const before = t.entrants.length;
    t.entrants = t.entrants.filter((e) => e.id !== entrantId);
    if (t.entrants.length === before) return;
    this.joiners.delete(entrantId);
    this.changed(t);
  }

  /** Delete a tournament: a running one is aborted first (its live tables filed as "aborted"), then it is removed. */
  delete(id: string): boolean {
    const t = this.tournaments.get(id.toUpperCase());
    if (!t) return false;
    if (t.status !== 'finished') this.abort(t.id);
    this.tournaments.delete(t.id);
    this.clearRoundTimer(t.id);
    for (const m of this.currentRound(t)?.matches ?? []) if (m.status === 'playing' && m.gameId) this.store.delete(m.gameId, 'admin');
    this.emit('change', t.id);
    this.store.requestSave();
    return true;
  }

  /** True when `token` is this tournament's host token (constant time). Tournaments without one have no host but the admin. */
  isHost(id: string, token: string | undefined): boolean {
    const t = this.get(String(id));
    if (!t?.hostToken || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(t.hostToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- players ----

  /**
   * The host adds server bots while registering: built-in bots ("Bot 3") or Zergs, named from the Zerg list (puns like
   * "Mark Zergburg"; unique in the tournament: "Elon Zerg", then "Elon Zerg 2" once every name is used). They are
   * entrants like anyone else.
   */
  addBots(id: string, kind: BotKind, count: number): { entrantId: string; name: string }[] {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('Registration is closed: this tournament has started');
    if (!Number.isInteger(count) || count < 1) throw new RuleError('count must be a whole number of at least 1');
    if (t.entrants.length + count > t.maxEntrants) throw new RuleError(`That would pass the tournament's ${t.maxEntrants} entrants`);
    const added: { entrantId: string; name: string }[] = [];
    for (let i = 0; i < count; i++) {
      const names = t.entrants.map((e) => e.name);
      const name = kind === 'zerg' ? freeZergName(names) : nextBotName(names);
      const entrant: Entrant = { id: `e_${newId(6)}`, name, isBot: true, joinedAt: Date.now(), ...(kind === 'zerg' ? { kind } : {}) };
      t.entrants.push(entrant);
      added.push({ entrantId: entrant.id, name });
    }
    this.changed(t);
    return added;
  }

  /**
   * Join while registering. `player`: the registered player (from its key) joining: they enter under the registered
   * name, once per tournament. `joiner` (an IP, or an MCP session) is counted for scheduled tournaments: pre-registration
   * needs no code, so one joiner holds at most `preregPerJoiner` open registrations across them (kept in memory).
   */
  join(id: string, rawName: unknown, agent?: string, player?: { id: string; name: string }, joiner?: string | null, rosterId?: string): { entrantId: string; token: string } {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('Registration is closed: this tournament has started');
    // Full: a person or agent (an outside joiner, never the pool) may still take a house-roster seat's place. The seat
    // is freed only after every check below has passed, just before the push, so a refused join evicts nobody.
    const full = t.entrants.length >= t.maxEntrants;
    const freeSeat = full && joiner ? (this.roomFor?.(t) ?? null) : null;
    if (full && !freeSeat) throw new RuleError('This tournament is full');
    const cap = this.limits.preregPerJoiner;
    if (t.scheduled && joiner && cap > 0 && this.openRegistrations(joiner) >= cap)
      throw new RuleError(`You already hold ${cap} open registrations for scheduled tournaments; join more once one has started`);
    const name = (player ? player.name : String(rawName ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) throw new RuleError('A name is required');
    if (player && t.entrants.some((e) => e.playerKey === player.id)) throw new RuleError('This player has already joined this tournament');
    if (rosterId && t.entrants.some((e) => e.rosterId === rosterId)) throw new RuleError('This roster name has already joined this tournament');
    if (t.entrants.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new RuleError(`The name "${name}" is taken in this tournament`);
    // The site-wide daily cap on pre-registrations, counted last so a refused join costs nothing (429).
    if (t.scheduled && joiner && this.preregDaily && !this.preregDaily.take('site'))
      throw new RateLimitedError(`Too many tournament registrations on this site today (at most ${this.limits.preregPerDay} in 24 h); try again later`);
    const entrant: Entrant = { id: `e_${newId(6)}`, name, isBot: false, token: newId(24), joinedAt: Date.now(), ...(rosterId ? { agent: ROSTER_AGENT, rosterId } : agent ? { agent } : {}), ...(player ? { playerKey: player.id } : {}) };
    freeSeat?.();
    // Joining inside the check-in window is checking in.
    if (this.checkinOpen(t)) entrant.checkedInAt = this.clock.now();
    t.entrants.push(entrant);
    if (t.scheduled && joiner) this.joiners.set(entrant.id, joiner);
    this.changed(t);
    return { entrantId: entrant.id, token: entrant.token! };
  }

  /** How many entrants `joiner` holds in scheduled tournaments still registering. */
  private openRegistrations(joiner: string): number {
    let n = 0;
    for (const t of this.tournaments.values()) {
      if (t.status !== 'registering' || !t.scheduled) continue;
      for (const e of t.entrants) if (this.joiners.get(e.id) === joiner) n++;
    }
    return n;
  }

  /** A scheduled tournament still registering whose check-in window is open. */
  checkinOpen(t: TournamentSnapshot): boolean {
    const s = t.scheduled;
    if (!s || s.cancelled || t.status !== 'registering') return false;
    return this.clock.now() >= s.startsAt - (s.checkinMinutes ?? DEFAULT_CHECKIN_MINUTES) * 60_000;
  }

  /**
   * An entrant polling the bracket with its token (wait_for_match, tournament_status, the page's long-poll) checks in,
   * once the window is open. Anything else (no window, no token, an unknown token) does nothing.
   */
  checkIn(id: string, token: string | undefined): void {
    const t = this.get(String(id));
    if (!t || !token || !this.checkinOpen(t)) return;
    const me = t.entrants.find((e) => e.token === token);
    if (!me || me.checkedInAt) return;
    me.checkedInAt = this.clock.now();
    this.changed(t);
  }

  /**
   * Start a scheduled tournament: people who did not check in are no-shows, swapped for Zerg entrants in place (same
   * count, so the plan holds), then it starts as usual. A no-show's token then answers "you missed check-in".
   */
  startScheduled(id: string): TournamentSnapshot {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('This tournament has already started');
    let noShows = 0;
    for (const e of t.entrants) {
      if (e.isBot || e.checkedInAt) continue;
      const missed = { name: e.name, token: e.token ?? '' };
      e.name = freeZergName(t.entrants.map((x) => x.name));
      e.isBot = true;
      e.kind = 'zerg';
      e.missed = missed;
      delete e.token;
      delete e.agent;
      // The seat is a Zerg now: no player key's (or roster name's) record gets its results.
      delete e.playerKey;
      delete e.rosterId;
      noShows++;
    }
    if (t.scheduled) t.scheduled.noShows = noShows;
    return this.start(t.id);
  }

  /** The table a game is in `tournamentId`, or null (not one of its tables, or the tournament is gone). */
  tableOf(tournamentId: string, gameId: string): TournamentTableRef | null {
    const t = this.get(tournamentId);
    if (!t) return null;
    for (const r of t.rounds) {
      const i = r.matches.findIndex((m) => m.gameId === gameId);
      if (i < 0) continue;
      // Knockout: a later round with one table left is the final. Nested: the plan's last round.
      const planned = t.nested?.plan?.rounds.length;
      const final = planned ? r.round === planned : r.matches.length === 1 && r.round > 1;
      return { id: t.id, name: t.name, round: r.round, table: i + 1, tables: r.matches.length, final };
    }
    return null;
  }

  /** The entrants the Delove seat pool joined for a tournament (app.ts wires SeatRequests.boundEntrants); null: none. */
  houseAiEntrants: ((tournamentId: string) => ReadonlySet<string>) | null = null;
  /**
   * A full scheduled tournament: the way to free one house-roster seat for an outside joiner, or null when there is
   * none to free (app.ts wires SeatRequests.roomFor). join() calls the returned function only once the join is certain.
   */
  roomFor: ((t: TournamentSnapshot) => (() => void) | null) | null = null;

  /** The tournament's house AI entrants (isHouseAi): seat-pool joined, or labelled delove@ / jacob-sensei@. */
  private houseAiIds(t: TournamentSnapshot): Set<string> {
    const bound = this.houseAiEntrants?.(t.id) ?? new Set<string>();
    return new Set(t.entrants.filter((e) => isHouseAi(e, bound)).map((e) => e.id));
  }

  /**
   * The host's live list of entrants (host token or admin key only): each entrant's kind, self-declared agent label and
   * join time, newest first, with counts by kind and the open spots left. Never an entrant token. `deloveIds`: the
   * entrants the Delove seat pool joined (seat requests).
   */
  hostEntrants(id: string, deloveIds: ReadonlySet<string> = new Set()): HostEntrants {
    const t = this.require(id);
    const kindOf = (e: Entrant): HostEntrantKind => {
      if (e.isBot) return e.kind === 'zerg' ? 'zerg' : 'bot';
      // A house roster name is an "AI agent" here too: this list is public in open mode, and the roster stays blind.
      if (e.rosterId) return 'agent';
      if (deloveIds.has(e.id) || /^delove(@|$)/i.test(e.agent ?? '')) return 'delove';
      return e.agent ? 'agent' : 'human';
    };
    const entrants = t.entrants
      .map((e) => ({ id: e.id, name: e.name, kind: kindOf(e), ...(e.agent ? { agent: e.agent } : {}), joinedAt: e.joinedAt }))
      .sort((a, b) => b.joinedAt - a.joinedAt);
    const count = (k: HostEntrantKind) => entrants.filter((e) => e.kind === k).length;
    return {
      status: t.status,
      maxEntrants: t.maxEntrants,
      version: t.version,
      counts: { zergs: count('zerg'), delove: count('delove'), agents: count('agent'), humans: count('human'), bots: count('bot'), open: Math.max(0, t.maxEntrants - t.entrants.length) },
      entrants,
    };
  }

  get(id: string): TournamentSnapshot | undefined {
    return this.tournaments.get(id.toUpperCase());
  }

  list(): TournamentSummary[] {
    return [...this.tournaments.values()]
      .map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        map: t.format === 'nested' ? 'nested' : String(t.options.map),
        entrants: t.entrants.length,
        maxEntrants: t.maxEntrants,
        round: t.rounds.length,
        champion: t.champion ? (this.entrant(t, t.champion)?.name ?? null) : null,
        ...(t.scheduled ? { startsAt: t.scheduled.startsAt, ...(t.scheduled.cancelled ? { cancelled: t.scheduled.cancelled } : {}) } : {}),
        updatedAt: t.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  view(id: string, token?: string): TournamentView {
    const t = this.require(id);
    const status = (e: Entrant) => this.entrantStatus(t, e.id);
    const name = (eid: string) => this.entrant(t, eid)?.name ?? '?';
    const view: TournamentView = {
      id: t.id,
      name: t.name,
      status: t.status,
      map: t.format === 'nested' ? 'nested' : String(t.options.map),
      options: t.options,
      groupSize: t.groupSize,
      maxEntrants: t.maxEntrants,
      fillBots: t.fillBots,
      entrants: t.entrants.map((e) => ({ id: e.id, name: e.name, isBot: e.isBot, status: status(e), ...(e.dropped ? { dropped: { reason: e.dropped.reason, standIn: e.dropped.standIn } } : {}) })),
      rounds: t.rounds.map((r) => ({
        round: r.round,
        ...(r.deadline !== undefined ? { deadline: r.deadline } : {}),
        ...(r.lastLapAt !== undefined ? { lastLapAt: r.lastLapAt } : {}),
        ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        matches: r.matches.map((m) => ({
          gameId: m.gameId,
          status: m.status,
          players: m.entrants.map((eid) => ({ entrantId: eid, name: name(eid) })),
          winner: m.winner,
          ...(m.map ? { map: m.map } : {}),
          ...(m.node !== undefined ? { node: m.node } : {}),
          ...(m.standing ? { standing: m.standing } : {}),
        })),
      })),
      champion: t.champion ? { entrantId: t.champion, name: name(t.champion) } : null,
      format: t.format ?? 'knockout',
      ...(t.nested
        ? {
            nested: {
              finalMap: t.nested.finalMap,
              territoriesPerSeat: t.nested.territoriesPerSeat,
              roundMinutes: t.nested.roundMinutes,
              finishShare: t.nested.finishShare,
              botDelayMs: t.nested.botDelayMs ?? null,
              blizzardShare: t.nested.blizzardShare ?? null,
              plan: t.nested.plan ? t.nested.plan.rounds.map((r) => r.map((x) => x.seats)) : null,
              zergs: t.nested.plan?.zergs ?? 0,
              nodes: t.nested.nodes ?? null,
            },
          }
        : {}),
      ...(t.scheduled
        ? {
            scheduled: {
              ...t.scheduled,
              checkinMinutes: t.scheduled.checkinMinutes ?? DEFAULT_CHECKIN_MINUTES,
              // Once the window is open: how many people have checked in.
              ...(this.checkinOpen(t) ? { checkedIn: t.entrants.filter((e) => !e.isBot && e.checkedInAt).length } : {}),
            },
          }
        : {}),
      ...(t.requested ? { requested: { ...t.requested } } : {}),
      ...(t.aborted ? { aborted: { ...t.aborted } } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      version: t.version,
    };
    const me = token ? t.entrants.find((e) => e.token === token) : undefined;
    if (token && !me) {
      const missed = t.entrants.find((e) => e.missed?.token === token);
      if (missed) throw new RuleError(`${missed.missed!.name} missed check-in for this tournament: the seat went to a Zerg (${missed.name})`);
      throw new RuleError('Unknown entrant token for this tournament');
    }
    if (me) {
      const round = this.currentRound(t);
      const m = round?.matches.find((x) => x.status === 'playing' && x.entrants.includes(me.id));
      view.you = {
        entrantId: me.id,
        name: me.name,
        status: status(me),
        match: m?.gameId ? { gameId: m.gameId, ...m.seats[me.id], round: round!.round } : null,
        ...(t.scheduled ? { checkedIn: !!me.checkedInAt } : {}),
      };
    }
    return view;
  }

  /** Resolve when the tournament's version passes `since` (or right away without `since`), or after `timeoutMs`. */
  waitFor(id: string, since: number | undefined, timeoutMs: number): Promise<'change' | 'timeout'> {
    const t = this.require(id);
    if (since === undefined || t.version > since) return Promise.resolve('change');
    return new Promise((resolve) => {
      const onChange = (changed: string) => {
        if (changed !== t.id) return;
        cleanup();
        resolve('change');
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
        this.off('release', release);
      };
      this.on('change', onChange);
      this.on('release', release);
    });
  }

  /** Resolve every pending long-poll (shutdown). */
  releaseWaiters() {
    this.emit('release');
  }

  /** Tournament tables are kept until their tournament no longer needs them. */
  isManagedTable(room: GameRoom): boolean {
    if (!room.tournamentId) return false;
    const t = this.tournaments.get(room.tournamentId);
    return !!t && (this.currentRound(t)?.matches.some((m) => m.gameId === room.id && m.status === 'playing') ?? false);
  }

  // ---- persistence ----

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.tournaments.values()]));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save tournaments:', err);
    }
  }

  // ---- internals ----

  private require(id: string): TournamentSnapshot {
    const t = this.get(String(id));
    if (!t) throw new RuleError('Tournament not found');
    return t;
  }

  private entrant(t: TournamentSnapshot, id: string) {
    return t.entrants.find((e) => e.id === id);
  }

  private currentRound(t: TournamentSnapshot): TournamentRound | undefined {
    return t.rounds.at(-1);
  }

  /** The first entrant in `order` that was not dropped (a stand-in never moves on), or null. */
  private firstNotDropped(t: TournamentSnapshot, order: readonly string[]): string | null {
    return order.find((eid) => !this.entrant(t, eid)?.dropped) ?? null;
  }

  private entrantStatus(t: TournamentSnapshot, id: string): TournamentView['entrants'][number]['status'] {
    if (t.status === 'registering') return 'registered';
    if (t.champion === id) return 'champion';
    if (this.entrant(t, id)?.dropped) return 'dropped';
    const m = this.currentRound(t)?.matches.find((x) => x.entrants.includes(id));
    if (!m) return 'out';
    if (m.status === 'playing') return 'playing';
    return m.winner === id ? (t.status === 'finished' ? 'champion' : 'waiting') : 'out';
  }

  private changed(t: TournamentSnapshot) {
    t.version++;
    t.updatedAt = Date.now();
    this.emit('change', t.id);
    if (t.status === 'finished') this.prune();
    this.store.requestSave();
  }

  /** Keep only the newest `keepFinished` finished tournaments (their tables are already decided). */
  private prune() {
    // Newest first; ties (same millisecond) go to the one created later.
    const finished = [...this.tournaments.values()].reverse().filter((t) => t.status === 'finished').sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of finished.slice(Math.max(1, this.limits.keepFinished))) {
      this.tournaments.delete(t.id);
      this.emit('change', t.id);
    }
  }

  private buildRound(t: TournamentSnapshot, ids: string[]) {
    const round = t.rounds.length + 1;
    const order = shuffle(ids);
    const matches: TournamentMatch[] = [];
    let at = 0;
    for (const [i, size] of tableSizes(order.length, t.groupSize).entries()) {
      const entrants = order.slice(at, at + size);
      at += size;
      if (entrants.length === 1) {
        matches.push({ gameId: null, entrants, seats: {}, winner: entrants[0], status: 'bye' });
        continue;
      }
      const players = entrants.map((eid) => this.entrant(t, eid)!);
      const tables = tableSizes(order.length, t.groupSize).length;
      const label = tables === 1 ? (round === 1 ? 'Table 1' : 'Final') : `Table ${i + 1}`;
      const { room, seats } = this.store.createTable(`${t.name} · R${round} ${label}`.slice(0, 40), { ...t.options, maxPlayers: entrants.length }, players.map((p) => ({ name: p.name, isBot: p.isBot, ...(p.kind ? { kind: p.kind } : {}), agent: p.agent, ...(p.playerKey ? { playerKey: p.playerKey } : {}), ...(p.rosterId ? { rosterId: p.rosterId } : {}) })), t.id);
      const match: TournamentMatch = { gameId: room.id, entrants, seats: Object.fromEntries(entrants.map((eid, k) => [eid, seats[k]])), winner: null, status: 'playing' };
      matches.push(match);
    }
    // The round is in place before its tables are watched: a table can already be over when it starts (only Zergs
    // seated: the game ends right after the deal), and settling it must see this round, not build it again.
    t.rounds.push({ round, matches });
    for (const m of matches) if (m.status === 'playing') this.watch(t, m, this.store.get(m.gameId!)!);
  }

  private watch(t: TournamentSnapshot, m: TournamentMatch, room: GameRoom) {
    let roundsSeen = room.state.round;
    // A seat dropped as disconnected (GameRoom.dropSeat): its entrant is out of the tournament; the stand-in plays on.
    const onDrop = ({ playerId, reason, standIn }: { playerId: string; reason: string; standIn: string }) => {
      const e = this.entrant(t, Object.entries(m.seats).find(([, s]) => s.playerId === playerId)?.[0] ?? '');
      if (!e || e.dropped) return;
      e.dropped = { reason, at: this.clock.now(), standIn };
      if (this.tournaments.get(t.id) !== t) return;
      this.changed(t);
      this.onSeatDropped?.({ tournamentId: t.id, gameId: room.id, playerId, name: e.name, fog: !!room.state.options.fogOfWar });
    };
    room.on('seat_dropped', onDrop);
    const settle = () => {
      if (m.status !== 'playing') return;
      if (t.format === 'nested' && room.state.phase !== 'finished' && !room.closed) {
        // A round in its last lap (checkRound) may be able to end once this table has finished its go-around.
        if (room.state.round === roundsSeen) return;
        roundsSeen = room.state.round;
        if (this.tournaments.get(t.id) === t && this.checkRound(t)) this.changed(t);
        return;
      }
      if (room.state.phase === 'finished') {
        const winner = Object.entries(m.seats).find(([, s]) => s.playerId === room.state.winner)?.[0] ?? null;
        m.winner = winner;
        m.status = winner ? 'finished' : 'abandoned';
        // A stand-in won (a dropped entrant's seat): it never moves on. The best other seat by standing does, as a
        // table decided on standing (+1); with none left, nobody moves on from this table.
        if (winner && this.entrant(t, winner)?.dropped) {
          const rng = createRng(nestSeed(t.nested?.seed ?? 0, `drop:${t.rounds.length}:${m.table ?? 0}`));
          const standing = rankByStanding(room.state, () => nextFloat(rng), room.eliminationOrder);
          const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
          const order = standing.order.map((pid) => byPlayer.get(pid)).filter((eid): eid is string => !!eid);
          m.standing = { order, rolls: Object.fromEntries(Object.entries(standing.rolls).filter(([pid]) => byPlayer.has(pid)).map(([pid, r]) => [byPlayer.get(pid)!, r])) };
          m.winner = this.firstNotDropped(t, order);
          m.status = m.winner ? 'decided' : 'abandoned';
        }
        // A stalemate (the engine's stallEnd) is a decision on standing, not a win: 'decided' (+1 table point, owner's
        // rule), with its standing on the bracket; the winner still moves on.
        const stalemate = stallOf(room.state)?.stalemate;
        if (winner && stalemate) {
          const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
          const order = stalemate.standing.map((pid) => byPlayer.get(pid)).filter((eid): eid is string => !!eid);
          m.status = 'decided';
          m.standing = { order, rolls: Object.fromEntries(Object.entries(stalemate.rolls).filter(([pid]) => byPlayer.has(pid)).map(([pid, r]) => [byPlayer.get(pid)!, r])) };
          m.winner = this.firstNotDropped(t, order);
          if (!m.winner) m.status = 'abandoned';
        }
      } else if (room.closed) {
        m.status = 'abandoned';
      } else return;
      this.scoreTable(m, room);
      // A stalemate's table order is its standing, as for a table decided at a round's end.
      if (m.status === 'decided' && m.standing) m.order = m.standing.order;
      room.off('change', settle);
      room.off('closed', settle);
      room.off('seat_dropped', onDrop);
      if (this.tournaments.get(t.id) !== t) return; // tournament deleted
      this.advance(t);
      this.changed(t);
    };
    room.on('change', settle);
    room.on('closed', settle);
    this.collectStats(m, room);
    settle();
  }

  /** Stop listeners per table (stats collection), removed when the table is scored. */
  private collectors = new WeakMap<TournamentMatch, () => void>();

  /** Gather each entrant's fun numbers (TableStats) from the table's moves while it is played. */
  private collectStats(m: TournamentMatch, room: GameRoom) {
    if (this.collectors.has(m)) return;
    const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
    const stats = (m.stats ??= {});
    const of = (eid: string) => (stats[eid] ??= { lost: 0, destroyed: 0, conquests: 0, peak: 0, turns: 0 });
    for (const eid of byPlayer.values()) of(eid);
    const collect = ({ next, events }: CommitInfo) => {
      for (const e of events) {
        if (e.type === 'battle') {
          const a = byPlayer.get(e.attacker);
          const d = byPlayer.get(e.defender);
          if (a) (of(a).lost += e.attackerLosses), (of(a).destroyed += e.defenderLosses);
          if (d) (of(d).lost += e.defenderLosses), (of(d).destroyed += e.attackerLosses);
        } else if (e.type === 'conquered') {
          const p = byPlayer.get(e.player);
          if (p) of(p).conquests++;
        } else if (e.type === 'eliminated') {
          const p = byPlayer.get(e.player);
          if (p) of(p).turns = next.turnNumber;
        }
      }
      const armies = new Map<string, number>();
      for (const t of Object.values(next.territories)) if (t.owner) armies.set(t.owner, (armies.get(t.owner) ?? 0) + t.armies);
      for (const [pid, eid] of byPlayer) of(eid).peak = Math.max(of(eid).peak, armies.get(pid) ?? 0);
    };
    room.on('commit', collect);
    this.collectors.set(m, () => room.off('commit', collect));
  }

  /** The table's final placings and kills, by entrant, for the tournament leaderboard. */
  private scoreTable(m: TournamentMatch, room: GameRoom) {
    this.collectors.get(m)?.();
    this.collectors.delete(m);
    // Still in at the end: they survived every turn the table lasted.
    const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
    for (const p of room.state.players) {
      const eid = byPlayer.get(p.id);
      const st = eid ? m.stats?.[eid] : undefined;
      if (st && p.alive) st.turns = room.state.turnNumber;
    }
    const entrantOf = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
    const placings = finalPlacements(room.state, room.eliminationOrder).filter((p) => entrantOf.has(p.id));
    m.order = placings.map((p) => entrantOf.get(p.id)!);
    m.kills = Object.fromEntries(placings.map((p) => [entrantOf.get(p.id)!, p.killed.filter((v) => entrantOf.has(v)).length]));
  }

  /** When every table of the current round is decided: crown the champion or seat the next round. */
  private advance(t: TournamentSnapshot) {
    if (t.status !== 'running') return;
    if (t.format === 'nested') return this.checkRound(t);
    const round = this.currentRound(t);
    if (!round || round.matches.some((m) => m.status === 'playing')) return;
    const winners = round.matches.map((m) => m.winner).filter((w): w is string => !!w);
    if (winners.length <= 1) {
      t.champion = winners[0] ?? null;
      t.status = 'finished';
      this.onFinished?.(t);
      return;
    }
    this.buildRound(t, winners);
  }

  // ---- nested format ----

  /** Plan the rounds, add the bots the plan needs, draw the boards and seat round 1 (every table at once). */
  private startNested(t: TournamentSnapshot): TournamentSnapshot {
    const n = t.nested!;
    const plan = planNest(t.entrants.length, { maxFinal: n.finalMap ? this.maxFinal(n.finalMap) : NESTED_FINAL.max });
    // The bots the plan needs are Zerg entrants (docs/zergs.md), with reptile names unique in the tournament.
    for (let i = 1; i <= plan.zergs; i++) {
      const entrant: Entrant = { id: `e_${newId(6)}`, name: freeZergName(t.entrants.map((e) => e.name)), isBot: true, kind: 'zerg', joinedAt: Date.now() };
      t.entrants.push(entrant);
    }
    n.seed = n.fixedSeed ?? randomBytes(4).readUInt32LE(0);
    n.plan = plan;
    const { boards, nodes, index } = planToNest(plan, { seed: n.seed, final: n.finalMap ? { map: n.finalMap } : undefined, boards: { territoriesPerSeat: n.territoriesPerSeat } });
    n.boards = boards.map((round) => round.map((node) => node.map));
    n.portals = boards.map((round) => round.map((node) => node.portals));
    n.nodes = nodes;
    n.nodeOf = index;
    t.status = 'running';
    const tables = seatNestedRound(plan.rounds[0], t.entrants, createRng(nestSeed(n.seed, 'seats')), this.houseAiIds(t));
    this.buildNestedRound(t, 0, tables.map((g) => g.map((entrant) => ({ entrant, portal: null }))));
    this.changed(t);
    return t;
  }

  /**
   * Seat plan round `r` (0-based) with `groups[j]` at table j, start its clock. From round 2 each entrant comes with
   * the portal (child table index) it won: the table starts with every player on that portal territory (startOnSpots).
   */
  private buildNestedRound(t: TournamentSnapshot, r: number, groups: { entrant: string; portal: number | null }[][]) {
    const n = t.nested!;
    const last = r === n.plan!.rounds.length - 1;
    const matches: TournamentMatch[] = groups.map((group, j) => {
      const entrants = group.map((g) => g.entrant);
      const map = n.boards![r][j];
      const node = n.nodeOf?.[r]?.[j];
      if (entrants.length === 0) return { gameId: null, entrants, seats: {}, winner: null, status: 'abandoned', table: j, map, node };
      if (entrants.length === 1) return { gameId: null, entrants, seats: {}, winner: entrants[0], status: 'bye', table: j, map, node };
      const players = entrants.map((eid) => this.entrant(t, eid)!);
      const label = last ? 'Final' : `Table ${j + 1}`;
      const portals = n.portals?.[r]?.[j] ?? [];
      const onPortals = group.every((g) => g.portal !== null && portals[g.portal] !== undefined);
      const rng = createRng(nestSeed(n.seed!, `start:${r + 1}:${j}`));
      const { room, seats } = this.store.createTable(
        `${t.name} · R${r + 1} ${label}`.slice(0, 40),
        { ...t.options, ...(n.blizzardShare !== undefined ? { blizzards: blizzardsFor(map, n.blizzardShare) } : {}), map: map as GameOptions['map'], maxPlayers: entrants.length },
        players.map((p) => ({ name: p.name, isBot: p.isBot, ...(p.kind ? { kind: p.kind } : {}), agent: p.agent, ...(p.playerKey ? { playerKey: p.playerKey } : {}), ...(p.rosterId ? { rosterId: p.rosterId } : {}) })),
        t.id,
        {
          ...(n.botDelayMs !== undefined ? { botDelayMs: n.botDelayMs } : {}),
          // Engine rules: every winner starts on the portal territory it came up through. If that start cannot be
          // built, the table starts as usual rather than leave the tournament stuck between rounds.
          ...(onPortals
            ? {
                prepare: (lobby, seated) => {
                  try {
                    return startOnSpots(lobby, Object.fromEntries(seated.map((s, k) => [s.playerId, portals[group[k].portal!]])), () => nextFloat(rng));
                  } catch (err) {
                    console.error(`[tournament ${t.id}] start on portals failed, starting normally:`, err);
                    return startGame(lobby);
                  }
                },
              }
            : {}),
        },
      );
      return { gameId: room.id, entrants, seats: Object.fromEntries(entrants.map((eid, k) => [eid, seats[k]])), winner: null, status: 'playing', table: j, map, node };
    });
    const round: TournamentRound = { round: r + 1, matches, deadline: this.clock.now() + n.roundMinutes * 60_000 };
    t.rounds.push(round);
    for (const m of matches) if (m.status === 'playing') this.watch(t, m, this.store.get(m.gameId!)!);
    // A table already over (a bye-only round, or a game that ended while being watched) may have ended this round.
    if (this.currentRound(t) === round && !round.endedAt) {
      this.armRound(t);
      this.checkRound(t);
    }
  }

  /**
   * End the current round once no table is playing, or, in its last lap (after the deadline), once every table still
   * playing has finished the go-around it was on at the deadline (GameState.round moved past its lapRound): every
   * surviving player there has then taken the same number of turns. No early close on a share of tables (owner,
   * 2026-10-22). Returns true when it ended the round.
   */
  private checkRound(t: TournamentSnapshot): boolean {
    const round = this.currentRound(t);
    if (t.status !== 'running' || !round || round.endedAt) return false;
    const playing = round.matches.filter((m) => m.status === 'playing');
    // Every table counts (a guest's, house AI's or bots'): a fast Delove or Zerg table can never hurry a round past the
    // guests', since the round waits for every table or its deadline.
    const lapDone = (m: TournamentMatch) => {
      const room = m.gameId ? this.store.get(m.gameId) : undefined;
      return !room || room.closed || m.lapRound === undefined || room.state.round > m.lapRound;
    };
    if (playing.length > 0 && (round.lastLapAt === undefined || !playing.every(lapDone))) return false;
    this.endRound(t);
    return true;
  }

  /**
   * The round's deadline passed: every table still playing plays on to the end of its current go-around of the turn
   * order (its move timer bounds each turn), then the round ends (checkRound). Server-side only, from the engine's state.
   * A backstop ends the last lap anyway one more round's time after the deadline (lapEnd), so a table with no move timer,
   * or a seat that keeps moving, cannot hold the tournament forever.
   */
  private lastLap(t: TournamentSnapshot) {
    const round = this.currentRound(t);
    if (t.status !== 'running' || !round || round.endedAt) return;
    this.clearRoundTimer(t.id);
    if (round.lastLapAt === undefined) {
      round.lastLapAt = this.clock.now();
      for (const m of round.matches) {
        if (m.status !== 'playing' || m.lapRound !== undefined) continue;
        const room = m.gameId ? this.store.get(m.gameId) : undefined;
        if (room && !room.closed) m.lapRound = room.state.round;
      }
    }
    if (this.clock.now() >= lapEnd(t, round)) this.endRound(t);
    else if (!this.checkRound(t)) this.armRound(t);
  }

  /** Decide every table still playing on standing, then seat the next round or crown the champion. */
  private endRound(t: TournamentSnapshot) {
    const round = this.currentRound(t);
    const n = t.nested!;
    if (t.status !== 'running' || !round || round.endedAt) return;
    this.clearRoundTimer(t.id);
    const now = this.clock.now();
    for (const m of round.matches) {
      if (m.status !== 'playing') continue;
      const room = m.gameId ? this.store.get(m.gameId) : undefined;
      if (!room || room.closed) {
        m.status = 'abandoned';
        continue;
      }
      // Engine rules (rankByStanding), with dice seeded from the tournament, the round and the table: replayable.
      const rng = createRng(nestSeed(n.seed!, `${round.round}:${m.table}`));
      const standing = rankByStanding(room.state, () => nextFloat(rng), room.eliminationOrder);
      const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
      const order = standing.order.map((pid) => byPlayer.get(pid)).filter((eid): eid is string => !!eid);
      m.standing = { order, rolls: Object.fromEntries(Object.entries(standing.rolls).filter(([pid]) => byPlayer.has(pid)).map(([pid, r]) => [byPlayer.get(pid)!, r])) };
      // A stand-in (a dropped entrant's seat) never moves on: the best other seat does.
      m.winner = this.firstNotDropped(t, order);
      m.status = m.winner ? 'decided' : 'abandoned';
      // The tournament board: kills from the game so far, and the standing as the table's order.
      this.scoreTable(m, room);
      m.order = order;
      const names = order.map((eid, i) => `${i + 1}. ${this.entrant(t, eid)?.name ?? '?'}`).join(', ');
      room.decide(`Round ${round.round} is over: this table was decided on standing (territories, then armies, then dice): ${names}.`, now, { standing: standing.order, rolls: standing.rolls });
    }
    round.endedAt = now;
    const plan = n.plan!;
    const r = round.round - 1;
    if (r === plan.rounds.length - 1) {
      t.champion = round.matches[0]?.winner ?? null;
      t.status = 'finished';
      this.onFinished?.(t);
      return;
    }
    // Every table's winner takes its seat at the parent table, on the portal its table sits in.
    const groups = plan.rounds[r + 1].map((parent) =>
      round.matches
        .filter((m) => plan.rounds[r][m.table!].parent === parent.index && m.winner)
        .sort((a, b) => plan.rounds[r][a.table!].portal! - plan.rounds[r][b.table!].portal!)
        .map((m) => ({ entrant: m.winner!, portal: plan.rounds[r][m.table!].portal })),
    );
    this.buildNestedRound(t, r + 1, groups);
  }

  /** (Re)arm the current round's timer: its deadline (starts the last lap), or in the last lap its backstop (lapEnd). */
  private armRound(t: TournamentSnapshot) {
    this.clearRoundTimer(t.id);
    const round = this.currentRound(t);
    if (t.status !== 'running' || !round || round.endedAt || round.deadline === undefined) return;
    const lap = round.lastLapAt !== undefined;
    const handle = this.clock.setTimeout(() => {
      this.roundTimers.delete(t.id);
      if (this.tournaments.get(t.id) !== t || this.currentRound(t) !== round) return;
      if (lap) this.endRound(t);
      else this.lastLap(t);
      this.changed(t);
    }, Math.max(0, (lap ? lapEnd(t, round) : round.deadline) - this.clock.now()));
    this.roundTimers.set(t.id, handle);
  }

  private clearRoundTimer(id: string) {
    const h = this.roundTimers.get(id);
    if (h !== undefined) this.clock.clearTimeout(h);
    this.roundTimers.delete(id);
  }

  /** Stop every round timer (shutdown). */
  stopTimers() {
    for (const id of [...this.roundTimers.keys()]) this.clearRoundTimer(id);
  }
}

/** When a nested round's last lap ends at the latest: one more round's time after its deadline (the backstop). */
function lapEnd(t: TournamentSnapshot, round: TournamentRound): number {
  return round.deadline! + t.nested!.roundMinutes * 60_000;
}

/**
 * Seat nested round 1 (owner, 2026-10-22: "Zergs spread out between all rooms approximately evenly; no Zerg-only
 * lobbies"). People and agents first, one per table in turn (the table with the fewest people, then the parent group
 * with the fewest, so they spread over the whole bracket), then the server bots: Zergs first, each to the table with
 * the fewest server bots (then the most free seats), then the built-in bots the same way. A table is all server bots
 * only when there are fewer people than tables. Seeded: the same tournament seats the same way.
 */
export function seatNestedRound(
  tables: readonly { seats: number; parent?: number | null }[],
  entrants: readonly { id: string; isBot: boolean; kind?: BotKind }[],
  rng: Rng,
  /** House AI entrants (isHouseAi): seated after the guests, evenly, before the server bots. */
  house: ReadonlySet<string> = new Set(),
): string[][] {
  const seated = tables.map(() => [] as string[]);
  const people = new Array(tables.length).fill(0);
  const housed = new Array(tables.length).fill(0);
  const bots = new Array(tables.length).fill(0);
  const groupPeople = new Map<number | null | undefined, number>();
  const free = (j: number) => tables[j].seats - seated[j].length;
  const place = (eid: string, better: (a: number, b: number) => boolean) => {
    let best = -1;
    for (let j = 0; j < tables.length; j++) if (free(j) > 0 && (best < 0 || better(j, best))) best = j;
    if (best < 0) throw new RuleError('More entrants than seats in the plan');
    seated[best].push(eid);
    return best;
  };
  // Guests (people and outside agents) first, one per table in turn, so house AI never crowds them out of a table.
  for (const eid of seededShuffle(rng, entrants.filter((e) => !e.isBot && !house.has(e.id)).map((e) => e.id))) {
    const j = place(eid, (a, b) => {
      if (people[a] !== people[b]) return people[a] < people[b];
      const ga = groupPeople.get(tables[a].parent) ?? 0;
      const gb = groupPeople.get(tables[b].parent) ?? 0;
      if (ga !== gb) return ga < gb;
      return free(a) > free(b);
    });
    people[j]++;
    groupPeople.set(tables[j].parent, (groupPeople.get(tables[j].parent) ?? 0) + 1);
  }
  // Then the house AI (Delove, Jacob Sensei), evenly over the tables.
  const fewestHouse = (a: number, b: number) => (housed[a] !== housed[b] ? housed[a] < housed[b] : free(a) > free(b));
  for (const eid of seededShuffle(rng, entrants.filter((e) => !e.isBot && house.has(e.id)).map((e) => e.id))) housed[place(eid, fewestHouse)]++;
  const fewestBots = (a: number, b: number) => (bots[a] !== bots[b] ? bots[a] < bots[b] : free(a) > free(b));
  for (const zerg of [true, false]) {
    for (const eid of seededShuffle(rng, entrants.filter((e) => e.isBot && (e.kind === 'zerg') === zerg).map((e) => e.id))) bots[place(eid, fewestBots)]++;
  }
  return seated;
}

/** A preview's bots-only time estimate: moves a table takes per seat at bot pace (nested:sim: ~45-90 at 4-10 seats). */
const PREVIEW_BOT_MOVES_PER_SEAT = 75;
/** Tournament previews per client per minute. */
export const PREVIEW_PER_MINUTE = 30;

/** What `preview` returns (POST /api/tournaments/preview, MCP preview_tournament). */
export interface TournamentPreview {
  counts: TournamentCounts;
  /** Seats asked for (zergs + delove + open); the plan adds plannerZergs to fit a bracket. */
  seats: number;
  plannerZergs: number;
  rounds: number;
  tablesPerRound: number[];
  seatsPerRound: number[][];
  finalists: number;
  finalBoard: { map: string | null; name: string; generated: boolean; territories: number };
  /** Round 1 as it would be seated: seats, people (open + Delove) and Zergs per table. */
  firstRound: { seats: number; people: number; zergs: number }[];
  timer: { mode: string; seconds: number } | null;
  /** About how long, in minutes: low at bot pace, high with every round running to its deadline. */
  minutes: { low: number; high: number; perRound: number };
  /** The Delove seat pool now (seat-requests.ts): null when none is set up, else online (reported in the last 2 min) and its free seats. */
  delovePool: { online: boolean; free: number; freeSearch: number } | null;
  warnings: string[];
}

/** The seat counts in a create or preview request (null when none is given). Each is a whole number 0-256. */
export function tournamentCounts(spec: Pick<CreateTournamentSpec, 'zergs' | 'delove' | 'open'>): TournamentCounts | null {
  if (spec.zergs === undefined && spec.delove === undefined && spec.open === undefined) return null;
  const n = (v: number | undefined, key: string) => {
    if (v === undefined) return 0;
    if (!Number.isInteger(v) || v < 0 || v > MAX_ENTRANTS) throw new RuleError(`${key} must be a whole number from 0 to ${MAX_ENTRANTS}`);
    return v;
  };
  const counts = { zergs: n(spec.zergs, 'zergs'), delove: n(spec.delove, 'delove'), open: n(spec.open, 'open') };
  const total = counts.zergs + counts.delove + counts.open;
  if (total < 2) throw new RuleError('A tournament needs at least 2 seats: count Zergs, Delove seats and open spots');
  if (total > MAX_ENTRANTS) throw new RuleError(`At most ${MAX_ENTRANTS} seats in a tournament`);
  return counts;
}

/** An entrant as the host's live list shows it: Zerg, built-in bot, Delove (pool or delove@ label), other agent, human. */
export type HostEntrantKind = 'zerg' | 'bot' | 'delove' | 'agent' | 'human';

/** GET /api/tournaments/:id/entrants (the host only). */
export interface HostEntrants {
  status: TournamentStatus;
  maxEntrants: number;
  version: number;
  counts: { zergs: number; delove: number; agents: number; humans: number; bots: number; open: number };
  entrants: { id: string; name: string; kind: HostEntrantKind; agent?: string; joinedAt: number }[];
}

/** Agent labels of the house AI: our own models, which join over HTTP like guests but are seated as their own tier. */
export const HOUSE_AI_AGENT = /^(delove|jacob-sensei)@/i;

/**
 * Is this entrant house AI (nested seating)? Joined by the Delove seat pool (`bound`), or labelled
 * `delove@…` / `jacob-sensei@…`. Server bots never are (they have their own tier).
 */
export function isHouseAi(e: { id: string; isBot: boolean; agent?: string }, bound: ReadonlySet<string> = new Set()): boolean {
  return !e.isBot && (bound.has(e.id) || HOUSE_AI_AGENT.test(e.agent ?? ''));
}
