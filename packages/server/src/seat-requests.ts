import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RiskHttpError } from '@risk/mcp';
import type { GameOptions } from '@risk/engine';
import { nameSkeleton } from './player-keys.js';
import { SeasonKeyGuard } from './season-key.js';
import type { HostTier, TourneyAccessConfig } from './tournament-access.js';
import type { TournamentManager, TournamentSnapshot } from './tournaments.js';
import type { GameRoom } from './store.js';

/**
 * Delove seats on request (tournament-hosting P3; docs/tournaments.md "Delove seats on request"). A tournament created
 * with `delove: N` opens a seat request; training's seat-pool daemon (outside the server, hard rule 10) polls the open
 * requests with its key (RISK_SEAT_POOL_KEY), claims seats, joins them through the ordinary join route, and reports
 * back. The server keeps the pool's last free capacity for the preview. Seats still unfilled when the tournament starts
 * become Zerg entrants. The caps are the hosting ones (tournament-access.ts): Delove seats per tournament (admin code
 * or key / limited code) and at once, and search seats at once.
 */

export type SeatRequestStatus = 'open' | 'claimed' | 'done' | 'failed' | 'expired';

export interface SeatRequest {
  id: string;
  kind: 'delove';
  tournamentId: string;
  /** Seats asked for. */
  n: number;
  /** Seats the pool has claimed so far (at most `n`). */
  claimed: number;
  /** Seats the pool reported joined (done). */
  joined: number;
  /** Entrants the pool joined for this request (join with seatRequestId and the pool key): the seats that count. */
  bound?: string[];
  /**
   * A takeover (disconnected seats, seat-health.ts): one seat of a game in progress whose player was dropped; the pool
   * plays that existing seat with the token its claim returns, instead of joining the tournament. Absent = a join.
   */
  mode?: 'takeover';
  takeover?: { gameId: string; playerId: string; name: string };
  /** Names the pool gives its seats: "<labelPrefix> 1", "<labelPrefix> 2", ... */
  labelPrefix: string;
  /**
   * House roster names to seat first (roster ids, roster.ts): each claim hands the pool the next free ones with their
   * names and models, and the pool joins each with its `rosterId`. Seats beyond them are plain "Delove N" seats.
   */
  roster?: string[];
  /** Roster ids handed out by claims, and those whose seat has joined. */
  rosterClaimed?: string[];
  rosterJoined?: string[];
  /** The tournament plays with fog of war (Delove's search is fog-off only). */
  fog: boolean;
  /** Whether claims may use search seats (fog off). Each claim says how many of its seats may search. */
  searchAllowed: boolean;
  /** Seats of this request claimed as search seats. */
  search: number;
  createdAt: number;
  /** The request closes at the tournament's start (scheduled start, or whenever the host starts it). */
  expiresAt: number | null;
  status: SeatRequestStatus;
  reason?: string;
}

export interface PoolStatus {
  /** The pool reported within the last `staleMs`. */
  online: boolean;
  free: number;
  freeSearch: number;
  /** When the pool last reported (ms), or null if never. */
  at: number | null;
}

/**
 * Names kept for the pool's seats in a tournament with a seat request: "Delove", "Delove 3", ... Matched against a
 * name's skeleton (player-keys.ts nameSkeleton), so look-alikes such as "Dε1ove 1" or "Ｄｅｌｏｖｅ" count too.
 */
export const POOL_NAME = /^delove(\s|$)/;

/** The Delove caps (tournament-access.ts); every one 0 = no cap. */
export type SeatCaps = Pick<TourneyAccessConfig, 'deloveAdmin' | 'deloveLimited' | 'deloveAtOnce' | 'deloveSearchAtOnce'>;
export const NO_SEAT_CAPS: SeatCaps = { deloveAdmin: 0, deloveLimited: 0, deloveAtOnce: 0, deloveSearchAtOnce: 0 };

/** A pool's report is stale after this long: "pool offline". */
export const POOL_STALE_MS = 2 * 60_000;

interface Saved {
  requests: SeatRequest[];
  pool: { free: number; freeSearch: number; at: number } | null;
}

/**
 * What a join claim answers. `roster` (requests with house roster names): the first seats are those names, each with
 * the model it always plays; the pool joins each with `rosterId` (its name and the model stay out of the join fields).
 * The other `n - roster.length` seats are "<labelPrefix> <firstLabel>", "<labelPrefix> <firstLabel + 1>", ...
 */
export interface JoinClaim {
  requestId: string;
  tournamentId: string;
  n: number;
  search: number;
  labelPrefix: string;
  firstLabel: number;
  roster?: { rosterId: string; name: string; model: string }[];
  options: Partial<GameOptions>;
}

/** What a takeover claim answers: the seat to play, with its fresh token (the game API, as resume_game). */
export interface TakeoverClaim {
  requestId: string;
  mode: 'takeover';
  tournamentId: string;
  gameId: string;
  playerId: string;
  token: string;
  n: 1;
  search: number;
  options: Partial<GameOptions>;
}

export class SeatRequests {
  private saved: Saved = { requests: [], pool: null };
  /** The game rooms, for takeovers (the app sets it: store.get). */
  rooms: ((gameId: string) => GameRoom | undefined) | null = null;
  private guard: SeasonKeyGuard;

  constructor(
    private tournaments: TournamentManager,
    private caps: SeatCaps,
    private key: string | null = null,
    private file: string | null = null,
    guardFile: string | null = null,
  ) {
    // Wrong pool keys: 5 per IP, 50 from anyone, then an hour's lockout (as the hosting codes).
    this.guard = new SeasonKeyGuard(key, { perIp: 5, global: 50, lockMs: 3600_000 }, () => this.now(), guardFile, 'seat-pool');
    if (file && existsSync(file)) {
      try {
        this.saved = { ...this.saved, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>) };
      } catch (err) {
        console.error('[seat-pool] could not read the requests file:', (err as Error).message);
      }
    }
  }

  get enabled(): boolean {
    return !!this.key;
  }

  private now() {
    return this.tournaments.clock.now();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[seat-pool] could not save the requests file:', (err as Error).message);
    }
  }

  /** The pool's key from a request header; throws 404 while the pool is off, 401/403/429 as the key guard says. */
  authorize(ip: string, key: unknown) {
    if (!this.key) throw new RiskHttpError('Delove seats on request are off (RISK_SEAT_POOL_KEY is not set)', 404);
    if (key === undefined || key === null || key === '') throw new RiskHttpError('The seat pool key is required (x-seat-pool-key)', 401);
    const check = this.guard.check(ip, key);
    if (!check.ok) throw new RiskHttpError(check.status === 403 ? 'Wrong seat pool key' : check.error, check.status);
  }

  private live(): SeatRequest[] {
    return this.saved.requests.filter((r) => r.status === 'open' || r.status === 'claimed');
  }

  /** Delove seats the live requests hold (asked for and not yet failed or expired). */
  private seatsAtOnce(): number {
    return this.live().reduce((n, r) => n + r.n, 0);
  }

  /** Before a create: the Delove count fits the caps (per tournament for the tier, and at once). */
  checkCreate(tier: HostTier | 'key', delove: number | undefined) {
    if (!delove) return;
    const per = tier === 'admin' || tier === 'key' ? this.caps.deloveAdmin : this.caps.deloveLimited;
    if (per > 0 && delove > per) throw new RiskHttpError(`At most ${per} Delove seats per tournament with this code`, 400);
    const used = this.seatsAtOnce();
    if (this.caps.deloveAtOnce > 0 && used + delove > this.caps.deloveAtOnce)
      throw new RiskHttpError(`Only ${Math.max(0, this.caps.deloveAtOnce - used)} Delove seats are free right now (of ${this.caps.deloveAtOnce}); ask for fewer or try later`, 429);
  }

  /** After a create: a tournament with Delove seats opens its request; `roster`: roster ids to seat first (admin). */
  openFor(t: TournamentSnapshot, roster?: readonly string[]): SeatRequest | null {
    const n = t.requested?.delove ?? 0;
    if (!n) return null;
    const fog = !!t.options.fogOfWar;
    const r: SeatRequest = {
      id: `SR${t.id}`,
      kind: 'delove',
      tournamentId: t.id,
      n,
      claimed: 0,
      joined: 0,
      labelPrefix: 'Delove',
      fog,
      searchAllowed: !fog,
      search: 0,
      createdAt: this.now(),
      expiresAt: t.scheduled?.startsAt ?? null,
      status: 'open',
      ...(roster?.length ? { roster: [...roster], rosterClaimed: [], rosterJoined: [] } : {}),
    };
    this.saved.requests = [...this.saved.requests.filter((x) => x.id !== r.id), r];
    this.prune();
    this.save();
    return r;
  }

  /** The join request of a tournament, if it has one still taking seats (takeovers are never this). */
  private requestOf(tournamentId: string): SeatRequest | undefined {
    return this.saved.requests.find((r) => !r.mode && r.tournamentId === tournamentId.toUpperCase() && (r.status === 'open' || r.status === 'claimed' || r.status === 'done'));
  }

  /**
   * A seat was dropped as disconnected (the house bot already plays it): ask the pool to take it over. Nothing with no
   * pool configured, or with no Delove seat free under the at-once cap (the house bot just plays on).
   */
  openTakeover(tournamentId: string, gameId: string, playerId: string, name: string, fog: boolean): SeatRequest | null {
    if (!this.key) return null;
    if (this.caps.deloveAtOnce > 0 && this.seatsAtOnce() + 1 > this.caps.deloveAtOnce) return null;
    const r: SeatRequest = {
      id: `TK${gameId}${this.now().toString(36)}`.toUpperCase(),
      kind: 'delove',
      mode: 'takeover',
      takeover: { gameId, playerId, name },
      tournamentId,
      n: 1,
      claimed: 0,
      joined: 0,
      labelPrefix: 'Delove',
      fog,
      searchAllowed: !fog,
      search: 0,
      createdAt: this.now(),
      expiresAt: null,
      status: 'open',
    };
    this.saved.requests = [...this.saved.requests, r];
    this.prune();
    this.save();
    return r;
  }

  /**
   * An ordinary join (no pool key): in a tournament with a seat request, the pool's names ("Delove …") are refused, so
   * nobody can take or block a pool seat by name. Elsewhere they stay free (the operator's npm run delove-seat).
   */
  checkJoinName(tournamentId: string, name: string) {
    if (POOL_NAME.test(nameSkeleton(name)) && this.requestOf(tournamentId))
      throw new RiskHttpError('Names starting with "Delove" are kept for the Delove seat pool in this tournament', 400);
  }

  /**
   * Before a pool join (seatRequestId and the pool key): the request is this tournament's and has a claimed seat free.
   * With `rosterId`, that roster name must be one a claim of this request handed out and not yet joined.
   */
  checkBind(requestId: unknown, tournamentId: string, rosterId?: string): SeatRequest {
    const r = this.require(String(requestId ?? ''));
    if (r.tournamentId !== tournamentId.toUpperCase()) throw new RiskHttpError('That seat request is for another tournament', 400);
    if (r.status !== 'claimed' && r.status !== 'open') throw new RiskHttpError(`This request is ${r.status}`, 409);
    if ((r.bound ?? []).length >= r.claimed) throw new RiskHttpError('Every claimed seat of this request has joined: claim more first', 409);
    if (rosterId !== undefined) {
      if (!(r.rosterClaimed ?? []).includes(rosterId)) throw new RiskHttpError('That roster name was not handed out by a claim of this request', 409);
      if ((r.rosterJoined ?? []).includes(rosterId)) throw new RiskHttpError('That roster name has already joined', 409);
    }
    return r;
  }

  /** The roster entry for an id (the app sets it from the roster store): name and model, for the pool's claims. */
  rosterEntry: ((id: string) => { id: string; name: string; model: string } | undefined) | null = null;

  /** The entrants the Delove seat pool joined for this tournament's requests (any status). */
  boundEntrants(tournamentId: string): Set<string> {
    const id = tournamentId.toUpperCase();
    return new Set(this.saved.requests.filter((r) => r.tournamentId === id).flatMap((r) => r.bound ?? []));
  }

  /** After a pool join: the entrant is this request's (and its roster name has joined). */
  bind(r: SeatRequest, entrantId: string, rosterId?: string) {
    r.bound = [...(r.bound ?? []), entrantId];
    if (rosterId !== undefined) r.rosterJoined = [...(r.rosterJoined ?? []), rosterId];
    this.save();
  }

  /**
   * Requests the pool may still claim from. Takeovers only with `modes` including "takeover", so a pool that does not
   * know them never sees one.
   */
  list(kind: string | undefined, modes?: string): SeatRequest[] {
    if (kind !== undefined && kind !== 'delove') throw new RiskHttpError('kind must be "delove"', 400);
    const takeovers = (modes ?? '').split(',').map((m) => m.trim()).includes('takeover');
    this.closeGone();
    return this.saved.requests.filter((r) => (r.mode === 'takeover' ? takeovers : true) && (r.status === 'open' || (r.status === 'claimed' && r.claimed < r.n)));
  }

  /** The pool's free capacity, sent on each poll. */
  report(free: unknown, freeSearch: unknown) {
    const n = (v: unknown, k: string) => {
      if (v === undefined) return 0;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000) throw new RiskHttpError(`${k} must be a whole number from 0 to 10000`, 400);
      return v;
    };
    this.saved.pool = { free: n(free, 'free'), freeSearch: n(freeSearch, 'freeSearch'), at: this.now() };
    this.save();
  }

  pool(): PoolStatus {
    const p = this.saved.pool;
    if (!p) return { online: false, free: 0, freeSearch: 0, at: null };
    return { online: this.now() - p.at < POOL_STALE_MS, free: p.free, freeSearch: p.freeSearch, at: p.at };
  }

  private require(id: string): SeatRequest {
    const r = this.saved.requests.find((x) => x.id === id.toUpperCase());
    if (!r) throw new RiskHttpError('Seat request not found', 404);
    return r;
  }

  /**
   * The pool takes `n` seats of a request: what it needs to join them. `search` says how many of them may run search
   * (fog off, within the search seats at once).
   */
  claim(id: string, rawN: unknown): JoinClaim | TakeoverClaim {
    this.closeGone();
    const r = this.require(id);
    if (r.status !== 'open' && r.status !== 'claimed') throw new RiskHttpError(`This request is ${r.status}`, 409);
    if (r.mode === 'takeover') return this.claimTakeover(r);
    const left = r.n - r.claimed;
    const n = rawN === undefined ? left : rawN;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new RiskHttpError('n must be a whole number of at least 1', 400);
    if (n > left) throw new RiskHttpError(`Only ${left} seats of this request are left to claim`, 409);
    const t = this.tournaments.get(r.tournamentId)!;
    const searchUsed = this.live().reduce((k, x) => k + x.search, 0);
    const search = r.searchAllowed ? Math.max(0, Math.min(n, (this.caps.deloveSearchAtOnce || Infinity) - searchUsed)) : 0;
    // House roster names first (the next ones not handed out yet), then plain "Delove N" seats numbered on from before.
    const handed = r.rosterClaimed ?? [];
    const rosterIds = (r.roster ?? []).filter((x) => !handed.includes(x)).slice(0, n);
    const firstLabel = r.claimed - handed.length + 1;
    if (r.roster) r.rosterClaimed = [...handed, ...rosterIds];
    r.claimed += n;
    r.search += search;
    r.status = 'claimed';
    this.save();
    const roster = rosterIds.map((x) => {
      const e = this.rosterEntry?.(x);
      return { rosterId: x, name: e?.name ?? x, model: e?.model ?? 'unknown' };
    });
    return { requestId: r.id, tournamentId: r.tournamentId, n, search, labelPrefix: r.labelPrefix, firstLabel, ...(r.roster ? { roster } : {}), options: { ...t.options } };
  }

  /** A takeover claim: the seat is the pool's now ("<name>-Delove"), with a fresh token to play it. */
  private claimTakeover(r: SeatRequest): TakeoverClaim {
    const room = this.rooms?.(r.takeover!.gameId);
    if (r.status !== 'open' || !room) throw new RiskHttpError('That seat is no longer waiting for a takeover', 409);
    let token: string;
    try {
      token = room.grantStandIn(r.takeover!.playerId, 'delove');
    } catch (err) {
      r.status = 'expired';
      r.reason = (err as Error).message;
      this.save();
      throw new RiskHttpError('That seat is no longer in play', 409);
    }
    const searchUsed = this.live().reduce((k, x) => k + x.search, 0);
    const search = r.searchAllowed && searchUsed < (this.caps.deloveSearchAtOnce || Infinity) ? 1 : 0;
    r.claimed = 1;
    r.search = search;
    r.status = 'claimed';
    this.save();
    return { requestId: r.id, mode: 'takeover', tournamentId: r.tournamentId, gameId: r.takeover!.gameId, playerId: r.takeover!.playerId, token, n: 1, search, options: { ...room.state.options } };
  }

  /** The pool reports how a claim went: `done` with the seats joined, or `failed` with a reason. */
  finish(id: string, outcome: 'done' | 'failed', joined: unknown, reason: unknown) {
    const r = this.require(id);
    if (r.mode === 'takeover') {
      if (r.status !== 'claimed' && r.status !== 'done') throw new RiskHttpError(`This request is ${r.status}`, 409);
      if (outcome === 'failed') {
        // The pool could not play it: back to the house bot for the rest of the table (no second request).
        r.status = 'failed';
        r.reason = String(reason ?? '').slice(0, 200) || 'the Delove takeover failed';
        this.rooms?.(r.takeover!.gameId)?.handBackToBot(r.takeover!.playerId, r.reason);
      } else {
        r.joined = 1;
        r.status = 'done';
      }
      this.save();
      return r;
    }
    if (r.status !== 'claimed' && r.status !== 'done') throw new RiskHttpError(`This request is ${r.status}`, 409);
    const j = joined === undefined ? 0 : joined;
    if (typeof j !== 'number' || !Number.isInteger(j) || j < 0 || j > r.claimed) throw new RiskHttpError(`joined must be a whole number from 0 to ${r.claimed}`, 400);
    if (outcome === 'failed') {
      // The seats it could not fill go back to the request for another claim, and their search seats with them.
      r.joined = Math.min(r.claimed, r.joined + j);
      r.claimed = r.joined;
      r.search = Math.min(r.search, r.joined);
      // Roster names that did not join go back too: the next claim hands them out again.
      if (r.roster) r.rosterClaimed = [...(r.rosterJoined ?? [])];
      r.status = r.joined >= r.n ? 'done' : 'open';
      r.reason = String(reason ?? '').slice(0, 200) || undefined;
    } else {
      r.joined = Math.min(r.claimed, r.joined + j);
      r.status = r.joined >= r.n ? 'done' : r.claimed >= r.n ? 'claimed' : 'open';
    }
    this.save();
    return r;
  }

  /**
   * At the tournament's start (TournamentManager.beforeStart): the request closes, and the Delove seats nobody filled
   * become Zerg entrants, so the bracket holds. Filled seats are the entrants bound to the request (pool joins only).
   */
  onStart(t: TournamentSnapshot) {
    const r = this.requestOf(t.id);
    if (!r) return;
    const filled = (r.bound ?? []).filter((id) => t.entrants.some((e) => e.id === id)).length;
    const missing = Math.max(0, Math.min(r.n - filled, t.maxEntrants - t.entrants.length));
    if (missing > 0) this.tournaments.addBots(t.id, 'zerg', missing);
    r.joined = Math.max(r.joined, Math.min(filled, r.n));
    r.status = r.joined >= r.n ? 'done' : 'expired';
    if (missing > 0) r.reason = `${missing} Delove seat${missing === 1 ? '' : 's'} not filled by the start: Zergs took them`;
    this.save();
  }

  /** Requests whose tournament is gone or no longer registering close (expired); a takeover when its table ends. */
  private closeGone() {
    let changed = false;
    for (const r of this.live()) {
      if (r.mode === 'takeover') {
        const room = this.rooms?.(r.takeover!.gameId);
        if (!room || room.closed || room.decidedAt !== null || room.state.phase === 'finished') {
          // The table ended: an unclaimed takeover lapses; a claimed one is over (it no longer holds a Delove seat).
          r.status = r.status === 'claimed' ? 'done' : 'expired';
          if (r.status === 'expired') r.reason ??= 'the table ended';
          changed = true;
        }
        continue;
      }
      const t = this.tournaments.get(r.tournamentId);
      if (!t || t.status !== 'registering') {
        r.status = 'expired';
        r.reason ??= 'the tournament is no longer registering';
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Keep the newest 200 closed requests. */
  private prune() {
    const closed = this.saved.requests.filter((r) => r.status !== 'open' && r.status !== 'claimed');
    if (closed.length <= 200) return;
    const drop = new Set(closed.sort((a, b) => a.createdAt - b.createdAt).slice(0, closed.length - 200).map((r) => r.id));
    this.saved.requests = this.saved.requests.filter((r) => !drop.has(r.id));
  }

  /** One request by id (tests, the view). */
  get(id: string): SeatRequest | undefined {
    return this.saved.requests.find((x) => x.id === id.toUpperCase());
  }
}
