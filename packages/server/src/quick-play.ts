import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MAP_IDS, RuleError, getMap, type GameOptions, type PlayerId } from '@risk/engine';
import type { BotKind } from './bot.js';

/**
 * Quick play: a queue that seats whoever is waiting for the same kind of game in a fresh room and fills the empty
 * seats with house players, so an agent or a person gets a game within a minute without a host or a lobby.
 *
 * Entrants wait in buckets, one per {map, seats, fog}. A bucket starts the moment it is full, or when its window
 * (`waitMs`, from the first entrant) runs out with whoever is there; the fill provider then tops the table up to
 * `seats`. The room is made by the store like a tournament table (no host, everything through commit), with auto
 * setup and the per-move turn timer on, so a slow or vanished seat is skipped instead of stalling the table.
 */

export interface QuickPlayConfig {
  /** How long a bucket waits for more entrants after its first one (ms). RISK_QUICKPLAY_WAIT_S. */
  waitMs: number;
  /** The per-move turn timer of a quick-play game (seconds, 5-600). RISK_QUICKPLAY_TIMER_S. */
  timerSeconds: number;
  /** At most this many quick-play rooms live at once (running rooms plus buckets waiting to start). RISK_QUICKPLAY_MAX_ROOMS. */
  maxRooms: number;
  /** At most this many waiting tickets per client (IP address). */
  maxTicketsPerClient: number;
  /**
   * A waiting ticket nobody has polled for this long (and that is not in a long-poll now) is dropped when its table
   * starts, so a dead client never takes a seat. Absent: twice the window, at most 30 s (live clients poll non-stop).
   */
  staleMs?: number;
}

export const DEFAULT_QUICK_PLAY: QuickPlayConfig = { waitMs: 60_000, timerSeconds: 60, maxRooms: 20, maxTicketsPerClient: 3 };

/** RISK_QUICKPLAY_* env vars over the defaults (a missing or bad value keeps the default). */
export function quickPlayConfigFromEnv(env: NodeJS.ProcessEnv): QuickPlayConfig {
  const num = (key: string, min: number, max: number) => {
    const n = Number(env[key]);
    return env[key] !== undefined && env[key] !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const wait = num('RISK_QUICKPLAY_WAIT_S', 1, 600);
  const timer = num('RISK_QUICKPLAY_TIMER_S', 5, 600);
  const rooms = num('RISK_QUICKPLAY_MAX_ROOMS', 0, 1000);
  return {
    waitMs: wait !== null ? Math.round(wait * 1000) : DEFAULT_QUICK_PLAY.waitMs,
    timerSeconds: timer !== null ? Math.round(timer) : DEFAULT_QUICK_PLAY.timerSeconds,
    maxRooms: rooms !== null ? Math.floor(rooms) : DEFAULT_QUICK_PLAY.maxRooms,
    maxTicketsPerClient: DEFAULT_QUICK_PLAY.maxTicketsPerClient,
  };
}

/** What kind of game an entrant asked for: entrants with the same key share a table. */
export interface QuickPlayKey {
  map: string;
  /** Seats at the table, entrants and fill together. */
  seats: number;
  fog: boolean;
}

/** One seat a fill provider adds: a house player the server runs. An empty name lets the store pick one (Zergs). */
export interface FillSeat {
  name: string;
  isBot: true;
  kind: BotKind;
}

/**
 * Who sits in the seats no entrant took. Zergs for now (free: the server plays them). Step 2 adds a provider for
 * external players (Delove seats from a runner pool) behind the same call.
 */
export interface FillProvider {
  readonly name: string;
  fill(count: number, key: QuickPlayKey): FillSeat[];
}

export const ZERG_FILL: FillProvider = {
  name: 'zerg',
  fill: (count) => Array.from({ length: count }, () => ({ name: '', isBot: true as const, kind: 'zerg' as const })),
};

/** What the queue needs from the store: a room made from a list of seats, and how many quick-play rooms are live. */
export interface QuickPlayHost {
  createTable(
    name: string,
    options: Partial<GameOptions>,
    players: { name: string; isBot: boolean; kind?: BotKind; agent?: string }[],
    tournamentId: string | null,
    extra: { quickPlay?: boolean },
  ): { room: { id: string }; seats: { playerId: PlayerId; token: string }[] };
  liveQuickPlayRooms(): number;
}

export type QuickPlayStatus = 'waiting' | 'seated';

/** A ticket as its holder sees it. */
export interface QuickPlayTicketView {
  ticket: string;
  status: QuickPlayStatus;
  name: string;
  map: string;
  seats: number;
  fog: boolean;
  /** Entrants waiting in this ticket's bucket, this one included (while waiting). */
  waiting: number;
  /** When the bucket starts at the latest (epoch ms, while waiting). */
  startsAt: number | null;
  /** Once seated: the game, your player id and your seat token (pass it on every move, like a joined game). */
  gameId?: string;
  playerId?: PlayerId;
  seatToken?: string;
}

/** A waiting bucket as anyone sees it (GET /api/queue). */
export interface QuickPlayBucketView {
  map: string;
  seats: number;
  fog: boolean;
  waiting: number;
  startsAt: number;
}

interface Ticket {
  id: string;
  token: string;
  name: string;
  agent?: string;
  /** Who opened it (the client's IP address), for the per-client cap. */
  client: string | null;
  key: QuickPlayKey;
  status: QuickPlayStatus;
  /** Last time the holder looked at the ticket (join, view, wait), and how many long-polls are open on it now. */
  lastSeen: number;
  polling: number;
  seat?: { gameId: string; playerId: PlayerId; token: string };
  /** When a seated ticket is forgotten (ms). */
  expiresAt?: number;
}

interface Bucket {
  id: string;
  key: QuickPlayKey;
  tickets: Ticket[];
  startsAt: number;
  timer: NodeJS.Timeout | null;
}

/** A seated ticket is kept this long so a late wait still gets its seat. */
const SEATED_KEPT_MS = 10 * 60_000;

/** Constant-time token check (lengths differ: not equal). */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const keyId = (k: QuickPlayKey) => `${k.map}|${k.seats}|${k.fog ? 1 : 0}`;
const newId = (bytes: number) => randomBytes(bytes).toString('base64url');

export class QuickPlayQueue {
  config: QuickPlayConfig;
  /** Fills the seats no entrant took. Zergs only for now. */
  fill: FillProvider = ZERG_FILL;
  private tickets = new Map<string, Ticket>();
  private buckets = new Map<string, Bucket>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(
    private host: QuickPlayHost,
    config: Partial<QuickPlayConfig> = {},
  ) {
    this.config = { ...DEFAULT_QUICK_PLAY, ...config };
  }

  /** The key an entrant's request asks for, checked: a listed map, 2 to the map's most seats, fog on or off. */
  parseKey(input: { map?: unknown; seats?: unknown; fog?: unknown }): QuickPlayKey {
    const map = input.map === undefined || input.map === null || input.map === '' ? 'classic' : String(input.map);
    if (!(MAP_IDS as readonly string[]).includes(map)) throw new RuleError(`Unknown map "${map}": one of ${MAP_IDS.join(', ')}`);
    const most = getMap(map).maxPlayers;
    const seats = input.seats === undefined || input.seats === null ? Math.min(4, most) : Number(input.seats);
    if (!Number.isInteger(seats) || seats < 2 || seats > most) throw new RuleError(`seats must be a whole number from 2 to ${most} on this map`);
    if (input.fog !== undefined && input.fog !== null && typeof input.fog !== 'boolean') throw new RuleError('fog must be true or false');
    return { map, seats, fog: input.fog === true };
  }

  /** Enter the queue. Starts the bucket at once when this entrant fills it. */
  join(input: { playerName?: unknown; agent?: string; map?: unknown; seats?: unknown; fog?: unknown }, client: string | null = null): { token: string; ticket: QuickPlayTicketView } {
    const key = this.parseKey(input);
    if (client !== null) {
      let open = 0;
      for (const t of this.tickets.values()) if (t.status === 'waiting' && t.client === client) open++;
      if (open >= this.config.maxTicketsPerClient) {
        throw new QuickPlayBusyError(`At most ${this.config.maxTicketsPerClient} waiting quick-play tickets per client: leave one or wait to be seated`, 429);
      }
    }
    const raw = typeof input.playerName === 'string' ? input.playerName.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
    let bucket = this.buckets.get(keyId(key));
    if (!bucket) {
      if (this.config.maxRooms <= 0) throw new QuickPlayBusyError('Quick play is switched off on this server');
      if (this.host.liveQuickPlayRooms() + this.buckets.size >= this.config.maxRooms) {
        throw new QuickPlayBusyError(`Quick play is full (${this.config.maxRooms} games running): try again in a minute`);
      }
      bucket = { id: keyId(key), key, tickets: [], startsAt: Date.now() + this.config.waitMs, timer: null };
      const b = bucket;
      b.timer = setTimeout(() => this.start(b), this.config.waitMs);
      b.timer.unref?.();
      this.buckets.set(b.id, b);
    }
    const taken = new Set(bucket.tickets.map((t) => t.name.toLowerCase()));
    let name = raw || 'Player';
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${(raw || 'Player').slice(0, 21)} ${n}`;
    const ticket: Ticket = { id: newId(9), token: newId(24), name, ...(input.agent ? { agent: input.agent } : {}), client, key, status: 'waiting', lastSeen: Date.now(), polling: 0 };
    this.tickets.set(ticket.id, ticket);
    bucket.tickets.push(ticket);
    if (bucket.tickets.length >= key.seats) this.start(bucket);
    else this.wake(bucket);
    return { token: ticket.token, ticket: this.viewOf(ticket) };
  }

  /** The ticket, for its holder only (null when unknown or the token is wrong). */
  view(id: string, token: string | undefined): QuickPlayTicketView | null {
    const t = this.owned(id, token);
    return t ? this.viewOf(t) : null;
  }

  /** Long-poll: resolves once the ticket is seated (or its bucket changes), or after timeoutMs. */
  async wait(id: string, token: string | undefined, timeoutMs: number): Promise<QuickPlayTicketView | null> {
    const t = this.owned(id, token);
    if (!t) return null;
    if (t.status === 'seated' || timeoutMs <= 0) return this.viewOf(t);
    const bucket = this.buckets.get(keyId(t.key));
    t.polling++;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        set?.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      let set: Set<() => void> | undefined;
      if (bucket) {
        set = this.waiters.get(bucket.id) ?? new Set();
        this.waiters.set(bucket.id, set);
        set.add(done);
      }
    });
    t.polling--;
    t.lastSeen = Date.now();
    // A table that failed to start (or dropped this ticket as stale) no longer has it.
    return this.tickets.get(t.id) === t ? this.viewOf(t) : null;
  }

  /** Leave the queue before being seated. A seated ticket has a game: leave that game instead. */
  leave(id: string, token: string | undefined): boolean {
    const t = this.owned(id, token);
    if (!t) return false;
    if (t.status === 'seated') throw new RuleError('This ticket is already seated: leave the game instead');
    this.tickets.delete(t.id);
    const bucket = this.buckets.get(keyId(t.key));
    if (bucket) {
      bucket.tickets = bucket.tickets.filter((x) => x !== t);
      if (!bucket.tickets.length) this.drop(bucket);
      else this.wake(bucket);
    }
    return true;
  }

  /** Buckets waiting to start, for anyone (how many are waiting for which game). */
  list(): QuickPlayBucketView[] {
    return [...this.buckets.values()].map((b) => ({ ...b.key, waiting: b.tickets.length, startsAt: b.startsAt }));
  }

  /** Server shutdown: no bucket starts after this (waiting tickets are lost, like long-polls). */
  stop() {
    for (const b of this.buckets.values()) if (b.timer) clearTimeout(b.timer);
    this.buckets.clear();
    for (const set of this.waiters.values()) for (const done of [...set]) done();
    this.waiters.clear();
  }

  private start(bucket: Bucket) {
    if (this.buckets.get(bucket.id) !== bucket) return;
    this.drop(bucket);
    const { key } = bucket;
    // Tickets nobody is polling any more are dropped: a dead client never takes a seat.
    const now = Date.now();
    const staleMs = this.config.staleMs ?? Math.min(2 * this.config.waitMs, 30_000);
    const tickets = bucket.tickets.filter((t) => t.polling > 0 || now - t.lastSeen <= staleMs);
    for (const t of bucket.tickets) if (!tickets.includes(t)) this.tickets.delete(t.id);
    if (!tickets.length) {
      this.wakeId(bucket.id);
      return;
    }
    const fill = this.fill.fill(Math.max(0, key.seats - tickets.length), key);
    const options: Partial<GameOptions> = {
      map: key.map as GameOptions['map'],
      maxPlayers: key.seats,
      fogOfWar: key.fog,
      autoSetup: true,
      turnTimer: 'move',
      turnTimerSeconds: this.config.timerSeconds,
    };
    const players = [...tickets.map((t) => ({ name: t.name, isBot: false, ...(t.agent ? { agent: t.agent } : {}) })), ...fill];
    try {
      const { room, seats } = this.host.createTable(`Quick play · ${getMap(key.map).name}`, options, players, null, { quickPlay: true });
      tickets.forEach((t, i) => {
        t.status = 'seated';
        t.seat = { gameId: room.id, playerId: seats[i].playerId, token: seats[i].token };
        t.expiresAt = now + SEATED_KEPT_MS;
      });
    } catch (err) {
      // Nothing was seated: the entrants are dropped and their next wait says the ticket is gone.
      console.error(`[quick-play] could not start a ${keyId(key)} table:`, err);
      for (const t of tickets) this.tickets.delete(t.id);
    }
    this.wakeId(bucket.id);
    this.prune();
  }

  private drop(bucket: Bucket) {
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = null;
    if (this.buckets.get(bucket.id) === bucket) this.buckets.delete(bucket.id);
  }

  private wake(bucket: Bucket) {
    this.wakeId(bucket.id);
  }

  private wakeId(id: string) {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const done of [...set]) done();
  }

  /** Forget seated tickets past their keep time. */
  private prune(now = Date.now()) {
    for (const [id, t] of this.tickets) if (t.expiresAt !== undefined && t.expiresAt < now) this.tickets.delete(id);
  }

  private owned(id: string, token: string | undefined): Ticket | null {
    this.prune();
    const t = this.tickets.get(id);
    if (!t || !token || !sameToken(t.token, token)) return null;
    t.lastSeen = Date.now();
    return t;
  }

  private viewOf(t: Ticket): QuickPlayTicketView {
    const bucket = t.status === 'waiting' ? this.buckets.get(keyId(t.key)) : undefined;
    return {
      ticket: t.id,
      status: t.status,
      name: t.name,
      ...t.key,
      waiting: bucket ? bucket.tickets.length : 0,
      startsAt: bucket ? bucket.startsAt : null,
      ...(t.seat ? { gameId: t.seat.gameId, playerId: t.seat.playerId, seatToken: t.seat.token } : {}),
    };
  }
}

/** The queue cannot take this entrant right now: 503 when the room cap is reached, 429 past the per-client cap. */
export class QuickPlayBusyError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 503 = 503,
  ) {
    super(message);
  }
}
