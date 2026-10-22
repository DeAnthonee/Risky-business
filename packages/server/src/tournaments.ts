import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RuleError,
  createGame,
  createRng,
  genMapId,
  getMap,
  isMapId,
  nestSeed,
  nextFloat,
  planNest,
  planToNest,
  rankByStanding,
  shuffle as seededShuffle,
  startOnSpots,
  type GameOptions,
  type NestPlan,
} from '@risk/engine';
import type { GameRoom, Store } from './store.js';

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
 * when enough of its tables have finished (`finishShare`, 51% by default) or at its deadline; the tables still
 * playing are then frozen and decided on standing (the engine's rankByStanding: territories, armies, dice).
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
  joinedAt: number;
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
  /** Nested: the table's index in its round of the plan, and its board. */
  table?: number;
  map?: string;
  /** Nested, a decided table: every entrant in standing order, and the dice rolled to break ties (by entrant). */
  standing?: { order: string[]; rolls: Record<string, number[]> };
}

export interface TournamentRound {
  round: number;
  matches: TournamentMatch[];
  /** Nested: when the round ends at the latest (absolute ms), and when it did end. */
  deadline?: number;
  endedAt?: number;
}

/** A nested tournament's settings, and from its start its plan and boards. */
export interface NestedSettings {
  /** Board of the final: an existing map, or null for a generated one. */
  finalMap: string | null;
  territoriesPerSeat: number;
  roundMinutes: number;
  /** Share of a round's tables that must finish before the rest are decided on standing. */
  finishShare: number;
  /** Bots' pace at this tournament's tables, ms between moves. Absent on tournaments saved before it: the server default. */
  botDelayMs?: number;
  /** Set at start: the seed of every board and of the seating, the plan, each table's board, and each table's portals
   * (the territories its children's winners start on, in portal order). */
  seed?: number;
  plan?: NestPlan;
  boards?: string[][];
  portals?: string[][][];
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
}

/** How many tournaments the server keeps. */
export interface TournamentLimits {
  /** Most tournaments registering or running at once; creating another fails (0 = no cap). */
  maxActive: number;
  /** Finished tournaments kept (newest first); older ones are pruned from memory and tournaments.json. */
  keepFinished: number;
}

export const DEFAULT_TOURNAMENT_LIMITS: TournamentLimits = { maxActive: 20, keepFinished: 100 };

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
  /** Nested: share of a round's tables that must finish before the rest are decided (0.1-1, default 0.51). */
  finishShare?: number;
  /** Nested: bots' pace at the tables, ms between moves (0-2000, default 300). */
  botDelayMs?: number;
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
  entrants: { id: string; name: string; isBot: boolean; status: 'registered' | 'playing' | 'waiting' | 'out' | 'champion' }[];
  rounds: {
    round: number;
    /** Nested: the round's deadline and end (ms). */
    deadline?: number;
    endedAt?: number;
    matches: {
      gameId: string | null;
      status: TournamentMatch['status'];
      players: { entrantId: string; name: string }[];
      winner: string | null;
      /** Nested: the table's board. */
      map?: string;
      /** Nested, decided on standing: entrants in order, and tie-break dice. */
      standing?: TournamentMatch['standing'];
    }[];
  }[];
  champion: { entrantId: string; name: string } | null;
  format: TournamentFormat;
  /** Nested: the settings and the plan's table sizes per round (seats per table, the final last). */
  nested?: { finalMap: string | null; territoriesPerSeat: number; roundMinutes: number; finishShare: number; botDelayMs: number | null; plan: number[][] | null; zergs: number };
  createdAt: number;
  updatedAt: number;
  version: number;
  you?: {
    entrantId: string;
    name: string;
    status: TournamentView['entrants'][number]['status'];
    /** Your table in the current round while it is being played: open it with this seat token. */
    match: { gameId: string; playerId: string; token: string; round: number } | null;
  };
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
  updatedAt: number;
}

const MAX_NAME = 24;
const DEFAULT_MAX_ENTRANTS = 64;
const DEFAULT_MAX_NESTED_ENTRANTS = 128;
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

  limits: TournamentLimits;

  /** Nested tournaments' round deadline timers, by tournament id. */
  private roundTimers = new Map<string, unknown>();

  constructor(
    private store: Store,
    private file: string | null,
    limits: Partial<TournamentLimits> = {},
    private clock: TournamentClock = REAL_CLOCK,
  ) {
    super();
    this.limits = { ...DEFAULT_TOURNAMENT_LIMITS, ...limits };
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
      // Nested: the round clock starts again from its saved deadline (a deadline passed while down ends the round now).
      if (t.format === 'nested' && t.status === 'running') {
        const round = this.currentRound(t);
        if (round && !round.endedAt && round.deadline !== undefined && this.clock.now() >= round.deadline) this.endRound(t);
        else this.armRound(t);
      }
    }
    this.prune();
  }

  // ---- host ----

  /** Create a tournament. The snapshot carries its `hostToken`: hand it to the creator only. */
  create(spec: CreateTournamentSpec): TournamentSnapshot {
    const { maxActive } = this.limits;
    if (maxActive > 0 && [...this.tournaments.values()].filter((x) => x.status !== 'finished').length >= maxActive)
      throw new RuleError(`Too many tournaments are open right now (${maxActive}); try again when one has finished`);
    if (spec.format === 'nested') return this.createNested(spec);
    if (spec.format !== undefined && spec.format !== 'knockout') throw new RuleError('format must be "knockout" or "nested"');
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

  /** A nested tournament: the boards come from the plan at start, so the settings are checked on every table size. */
  private createNested(spec: CreateTournamentSpec): TournamentSnapshot {
    const options: Partial<GameOptions> = { ...(spec.options ?? {}) };
    delete options.maxPlayers; // set per table
    delete options.map; // every table plays its own board
    const tps = spec.territoriesPerSeat ?? 5;
    if (!Number.isInteger(tps) || tps < 4 || tps > 6) throw new RuleError('territoriesPerSeat must be a whole number from 4 to 6');
    const roundMinutes = spec.roundMinutes ?? 30;
    if (!Number.isInteger(roundMinutes) || roundMinutes < 1 || roundMinutes > 240) throw new RuleError('roundMinutes must be a whole number from 1 to 240');
    const finishShare = spec.finishShare ?? 0.51;
    if (typeof finishShare !== 'number' || !(finishShare >= 0.1 && finishShare <= 1)) throw new RuleError('finishShare must be a number from 0.1 to 1');
    const botDelayMs = spec.botDelayMs ?? 300;
    if (!Number.isInteger(botDelayMs) || botDelayMs < 0 || botDelayMs > 2000) throw new RuleError('botDelayMs must be a whole number from 0 to 2000');
    // Tables run on a per-move turn timer unless the host says otherwise, so a stalled seat cannot hold a round.
    if (options.turnTimer === undefined) {
      options.turnTimer = 'move';
      if (options.turnTimerSeconds === undefined) options.turnTimerSeconds = 30;
    }
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
      nested: { finalMap, territoriesPerSeat: tps, roundMinutes, finishShare, botDelayMs },
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
    if (!t.entrants.length) throw new RuleError('Nobody has joined yet');
    if (t.format === 'nested') return this.startNested(t);
    if (t.fillBots) {
      const target = Math.max(2, Math.ceil(t.entrants.length / t.groupSize) * t.groupSize);
      for (let i = 1; t.entrants.length < target; i++) t.entrants.push({ id: `e_${newId(6)}`, name: `Bot ${i}`, isBot: true, joinedAt: Date.now() });
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

  /** Delete a tournament and close the tables still being played. */
  delete(id: string): boolean {
    const t = this.tournaments.get(id.toUpperCase());
    if (!t) return false;
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

  join(id: string, rawName: unknown): { entrantId: string; token: string } {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('Registration is closed: this tournament has started');
    if (t.entrants.length >= t.maxEntrants) throw new RuleError('This tournament is full');
    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) throw new RuleError('A name is required');
    if (t.entrants.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new RuleError(`The name "${name}" is taken in this tournament`);
    const entrant: Entrant = { id: `e_${newId(6)}`, name, isBot: false, token: newId(24), joinedAt: Date.now() };
    t.entrants.push(entrant);
    this.changed(t);
    return { entrantId: entrant.id, token: entrant.token! };
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
      entrants: t.entrants.map((e) => ({ id: e.id, name: e.name, isBot: e.isBot, status: status(e) })),
      rounds: t.rounds.map((r) => ({
        round: r.round,
        ...(r.deadline !== undefined ? { deadline: r.deadline } : {}),
        ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        matches: r.matches.map((m) => ({
          gameId: m.gameId,
          status: m.status,
          players: m.entrants.map((eid) => ({ entrantId: eid, name: name(eid) })),
          winner: m.winner,
          ...(m.map ? { map: m.map } : {}),
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
              plan: t.nested.plan ? t.nested.plan.rounds.map((r) => r.map((x) => x.seats)) : null,
              zergs: t.nested.plan?.zergs ?? 0,
            },
          }
        : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      version: t.version,
    };
    const me = token ? t.entrants.find((e) => e.token === token) : undefined;
    if (token && !me) throw new RuleError('Unknown entrant token for this tournament');
    if (me) {
      const round = this.currentRound(t);
      const m = round?.matches.find((x) => x.status === 'playing' && x.entrants.includes(me.id));
      view.you = {
        entrantId: me.id,
        name: me.name,
        status: status(me),
        match: m?.gameId ? { gameId: m.gameId, ...m.seats[me.id], round: round!.round } : null,
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

  private entrantStatus(t: TournamentSnapshot, id: string): TournamentView['entrants'][number]['status'] {
    if (t.status === 'registering') return 'registered';
    if (t.champion === id) return 'champion';
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
      const { room, seats } = this.store.createTable(`${t.name} · R${round} ${label}`.slice(0, 40), { ...t.options, maxPlayers: entrants.length }, players.map((p) => ({ name: p.name, isBot: p.isBot })), t.id);
      const match: TournamentMatch = { gameId: room.id, entrants, seats: Object.fromEntries(entrants.map((eid, k) => [eid, seats[k]])), winner: null, status: 'playing' };
      matches.push(match);
      this.watch(t, match, room);
    }
    t.rounds.push({ round, matches });
  }

  private watch(t: TournamentSnapshot, m: TournamentMatch, room: GameRoom) {
    const settle = () => {
      if (m.status !== 'playing') return;
      if (room.state.phase === 'finished') {
        const winner = Object.entries(m.seats).find(([, s]) => s.playerId === room.state.winner)?.[0] ?? null;
        m.winner = winner;
        m.status = winner ? 'finished' : 'abandoned';
      } else if (room.closed) {
        m.status = 'abandoned';
      } else return;
      room.off('change', settle);
      room.off('closed', settle);
      if (this.tournaments.get(t.id) !== t) return; // tournament deleted
      this.advance(t);
      this.changed(t);
    };
    room.on('change', settle);
    room.on('closed', settle);
    settle();
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
      return;
    }
    this.buildRound(t, winners);
  }

  // ---- nested format ----

  /** Plan the rounds, add the bots the plan needs, draw the boards and seat round 1 (every table at once). */
  private startNested(t: TournamentSnapshot): TournamentSnapshot {
    const n = t.nested!;
    const plan = planNest(t.entrants.length, { maxFinal: n.finalMap ? this.maxFinal(n.finalMap) : NESTED_FINAL.max });
    for (let i = 1; i <= plan.zergs; i++) t.entrants.push({ id: `e_${newId(6)}`, name: `Bot ${i}`, isBot: true, joinedAt: Date.now() });
    n.seed = randomBytes(4).readUInt32LE(0);
    n.plan = plan;
    const { boards } = planToNest(plan, { seed: n.seed, final: n.finalMap ? { map: n.finalMap } : undefined, boards: { territoriesPerSeat: n.territoriesPerSeat } });
    n.boards = boards.map((round) => round.map((node) => node.map));
    n.portals = boards.map((round) => round.map((node) => node.portals));
    // Seating, from the tournament seed: people and agents first, spread over the tables, then bots fill the rest,
    // so a table is all bots only when there are more tables than people.
    const rng = createRng(nestSeed(n.seed, 'seats'));
    const people = seededShuffle(rng, t.entrants.filter((e) => !e.isBot).map((e) => e.id));
    const bots = seededShuffle(rng, t.entrants.filter((e) => e.isBot).map((e) => e.id));
    const tables = plan.rounds[0].map(() => [] as string[]);
    for (const eid of [...people, ...bots]) {
      let best = -1;
      for (let j = 0; j < tables.length; j++) {
        const free = plan.rounds[0][j].seats - tables[j].length;
        if (free > 0 && (best < 0 || free > plan.rounds[0][best].seats - tables[best].length)) best = j;
      }
      tables[best].push(eid);
    }
    t.status = 'running';
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
      if (entrants.length === 0) return { gameId: null, entrants, seats: {}, winner: null, status: 'abandoned', table: j, map };
      if (entrants.length === 1) return { gameId: null, entrants, seats: {}, winner: entrants[0], status: 'bye', table: j, map };
      const players = entrants.map((eid) => this.entrant(t, eid)!);
      const label = last ? 'Final' : `Table ${j + 1}`;
      const portals = n.portals?.[r]?.[j] ?? [];
      const onPortals = group.every((g) => g.portal !== null && portals[g.portal] !== undefined);
      const rng = createRng(nestSeed(n.seed!, `start:${r + 1}:${j}`));
      const { room, seats } = this.store.createTable(
        `${t.name} · R${r + 1} ${label}`.slice(0, 40),
        { ...t.options, map: map as GameOptions['map'], maxPlayers: entrants.length },
        players.map((p) => ({ name: p.name, isBot: p.isBot })),
        t.id,
        {
          ...(n.botDelayMs !== undefined ? { botDelayMs: n.botDelayMs } : {}),
          // Engine rules: every winner starts on the portal territory it came up through.
          ...(onPortals ? { prepare: (lobby, seated) => startOnSpots(lobby, Object.fromEntries(seated.map((s, k) => [s.playerId, portals[group[k].portal!]])), () => nextFloat(rng)) } : {}),
        },
      );
      return { gameId: room.id, entrants, seats: Object.fromEntries(entrants.map((eid, k) => [eid, seats[k]])), winner: null, status: 'playing', table: j, map };
    });
    t.rounds.push({ round: r + 1, matches, deadline: this.clock.now() + n.roundMinutes * 60_000 });
    for (const m of matches) if (m.status === 'playing') this.watch(t, m, this.store.get(m.gameId!)!);
    if (this.currentRound(t)!.matches.length === matches.length && !this.currentRound(t)!.endedAt) {
      this.armRound(t);
      this.checkRound(t);
    }
  }

  /** End the current round once enough tables have finished (or none is left playing). */
  private checkRound(t: TournamentSnapshot) {
    const round = this.currentRound(t);
    if (t.status !== 'running' || !round || round.endedAt) return;
    const playing = round.matches.filter((m) => m.status === 'playing').length;
    const finished = round.matches.filter((m) => m.status === 'finished' || m.status === 'bye').length;
    if (playing === 0 || finished >= Math.ceil(t.nested!.finishShare * round.matches.length)) this.endRound(t);
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
      const rng = createRng(nestSeed(n.seed!, `${round.round}:${m.gameId}`));
      const standing = rankByStanding(room.state, () => nextFloat(rng), room.eliminationOrder);
      const byPlayer = new Map(Object.entries(m.seats).map(([eid, s]) => [s.playerId, eid]));
      const order = standing.order.map((pid) => byPlayer.get(pid)).filter((eid): eid is string => !!eid);
      m.standing = { order, rolls: Object.fromEntries(Object.entries(standing.rolls).filter(([pid]) => byPlayer.has(pid)).map(([pid, r]) => [byPlayer.get(pid)!, r])) };
      m.winner = order[0] ?? null;
      m.status = m.winner ? 'decided' : 'abandoned';
      const names = order.map((eid, i) => `${i + 1}. ${this.entrant(t, eid)?.name ?? '?'}`).join(', ');
      room.decide(`Round ${round.round} is over: this table was decided on standing (territories, then armies, then dice): ${names}.`, now);
    }
    round.endedAt = now;
    const plan = n.plan!;
    const r = round.round - 1;
    if (r === plan.rounds.length - 1) {
      t.champion = round.matches[0]?.winner ?? null;
      t.status = 'finished';
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

  /** (Re)arm the current round's deadline timer. */
  private armRound(t: TournamentSnapshot) {
    this.clearRoundTimer(t.id);
    const round = this.currentRound(t);
    if (t.status !== 'running' || !round || round.endedAt || round.deadline === undefined) return;
    const handle = this.clock.setTimeout(() => {
      this.roundTimers.delete(t.id);
      if (this.tournaments.get(t.id) !== t || this.currentRound(t) !== round) return;
      this.endRound(t);
      this.changed(t);
    }, Math.max(0, round.deadline - this.clock.now()));
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
