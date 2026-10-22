import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError, createGame, getMap, type GameOptions } from '@risk/engine';
import type { GameRoom, Store } from './store.js';

/**
 * Knockout tournaments. The host creates one and gets its host token; players and agents join while it is
 * registering; the host (the host token or the admin key) starts it. Every round splits the remaining entrants into tables of about `groupSize`
 * (filled with bots in round 1 when `fillBots` is on), each table is an ordinary game room that nobody
 * hosts, and each table's winner moves on. The last one standing is the champion.
 *
 * Rules stay in the engine: a table is decided by the game's own winner. The manager only listens to
 * the rooms it created and builds the next round when the current one is done.
 */

export type TournamentStatus = 'registering' | 'running' | 'finished';

export interface Entrant {
  id: string;
  name: string;
  isBot: boolean;
  /** Secret that identifies this entrant (bots have none). */
  token?: string;
  /** Self-declared player type, passed to every table seat; spectators see it, no view of the tournament does. */
  agent?: string;
  joinedAt: number;
}

export interface TournamentMatch {
  /** The table's game room; null for a bye. */
  gameId: string | null;
  entrants: string[];
  /** Each entrant's seat in the room. */
  seats: Record<string, { playerId: string; token: string }>;
  winner: string | null;
  /** 'abandoned': the room was closed before anyone won, so nobody from this table moves on. */
  status: 'playing' | 'finished' | 'bye' | 'abandoned';
}

export interface TournamentRound {
  round: number;
  matches: TournamentMatch[];
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
  rounds: { round: number; matches: { gameId: string | null; status: TournamentMatch['status']; players: { entrantId: string; name: string }[]; winner: string | null }[] }[];
  champion: { entrantId: string; name: string } | null;
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
const MAX_ENTRANTS = 256;

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

  constructor(
    private store: Store,
    private file: string | null,
    limits: Partial<TournamentLimits> = {},
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
        if (room && !room.closed) this.watch(t, m, room);
        else m.status = 'abandoned';
      }
      this.advance(t);
    }
    this.prune();
  }

  // ---- host ----

  /** Create a tournament. The snapshot carries its `hostToken`: hand it to the creator only. */
  create(spec: CreateTournamentSpec): TournamentSnapshot {
    const { maxActive } = this.limits;
    if (maxActive > 0 && [...this.tournaments.values()].filter((x) => x.status !== 'finished').length >= maxActive)
      throw new RuleError(`Too many tournaments are open right now (${maxActive}); try again when one has finished`);
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

  start(id: string): TournamentSnapshot {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('This tournament has already started');
    if (!t.entrants.length) throw new RuleError('Nobody has joined yet');
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

  join(id: string, rawName: unknown, agent?: string): { entrantId: string; token: string } {
    const t = this.require(id);
    if (t.status !== 'registering') throw new RuleError('Registration is closed: this tournament has started');
    if (t.entrants.length >= t.maxEntrants) throw new RuleError('This tournament is full');
    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) throw new RuleError('A name is required');
    if (t.entrants.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new RuleError(`The name "${name}" is taken in this tournament`);
    const entrant: Entrant = { id: `e_${newId(6)}`, name, isBot: false, token: newId(24), joinedAt: Date.now(), ...(agent ? { agent } : {}) };
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
        map: String(t.options.map),
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
      map: String(t.options.map),
      options: t.options,
      groupSize: t.groupSize,
      maxEntrants: t.maxEntrants,
      fillBots: t.fillBots,
      entrants: t.entrants.map((e) => ({ id: e.id, name: e.name, isBot: e.isBot, status: status(e) })),
      rounds: t.rounds.map((r) => ({
        round: r.round,
        matches: r.matches.map((m) => ({ gameId: m.gameId, status: m.status, players: m.entrants.map((eid) => ({ entrantId: eid, name: name(eid) })), winner: m.winner })),
      })),
      champion: t.champion ? { entrantId: t.champion, name: name(t.champion) } : null,
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
      const { room, seats } = this.store.createTable(`${t.name} · R${round} ${label}`.slice(0, 40), { ...t.options, maxPlayers: entrants.length }, players.map((p) => ({ name: p.name, isBot: p.isBot, agent: p.agent })), t.id);
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
}
