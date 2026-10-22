import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RiskHttpError } from '@risk/mcp';
import type { GameOptions } from '@risk/engine';
import { SeasonKeyGuard } from './season-key.js';
import type { HostTier, TourneyAccessConfig } from './tournament-access.js';
import type { TournamentManager, TournamentSnapshot } from './tournaments.js';

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
  /** Names the pool gives its seats: "<labelPrefix> 1", "<labelPrefix> 2", ... */
  labelPrefix: string;
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

/** Names kept for the pool's seats in a tournament with a seat request: "Delove", "Delove 3", ... */
export const POOL_NAME = /^delove(\s|$)/i;

/** The Delove caps (tournament-access.ts); every one 0 = no cap. */
export type SeatCaps = Pick<TourneyAccessConfig, 'deloveAdmin' | 'deloveLimited' | 'deloveAtOnce' | 'deloveSearchAtOnce'>;
export const NO_SEAT_CAPS: SeatCaps = { deloveAdmin: 0, deloveLimited: 0, deloveAtOnce: 0, deloveSearchAtOnce: 0 };

/** A pool's report is stale after this long: "pool offline". */
export const POOL_STALE_MS = 2 * 60_000;

interface Saved {
  requests: SeatRequest[];
  pool: { free: number; freeSearch: number; at: number } | null;
}

export class SeatRequests {
  private saved: Saved = { requests: [], pool: null };
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

  /** After a create: a tournament with Delove seats opens its request. */
  openFor(t: TournamentSnapshot): SeatRequest | null {
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
    };
    this.saved.requests = [...this.saved.requests.filter((x) => x.id !== r.id), r];
    this.prune();
    this.save();
    return r;
  }

  /** The request of a tournament, if it has one still taking seats. */
  private requestOf(tournamentId: string): SeatRequest | undefined {
    return this.saved.requests.find((r) => r.tournamentId === tournamentId.toUpperCase() && (r.status === 'open' || r.status === 'claimed' || r.status === 'done'));
  }

  /**
   * An ordinary join (no pool key): in a tournament with a seat request, the pool's names ("Delove …") are refused, so
   * nobody can take or block a pool seat by name. Elsewhere they stay free (the operator's npm run delove-seat).
   */
  checkJoinName(tournamentId: string, name: string) {
    if (POOL_NAME.test(name.trim()) && this.requestOf(tournamentId))
      throw new RiskHttpError('Names starting with "Delove" are kept for the Delove seat pool in this tournament', 400);
  }

  /** Before a pool join (seatRequestId and the pool key): the request is this tournament's and has a claimed seat free. */
  checkBind(requestId: unknown, tournamentId: string): SeatRequest {
    const r = this.require(String(requestId ?? ''));
    if (r.tournamentId !== tournamentId.toUpperCase()) throw new RiskHttpError('That seat request is for another tournament', 400);
    if (r.status !== 'claimed' && r.status !== 'open') throw new RiskHttpError(`This request is ${r.status}`, 409);
    if ((r.bound ?? []).length >= r.claimed) throw new RiskHttpError('Every claimed seat of this request has joined: claim more first', 409);
    return r;
  }

  /** After a pool join: the entrant is this request's. */
  bind(r: SeatRequest, entrantId: string) {
    r.bound = [...(r.bound ?? []), entrantId];
    this.save();
  }

  /** Requests the pool may still claim from. */
  list(kind: string | undefined): SeatRequest[] {
    if (kind !== undefined && kind !== 'delove') throw new RiskHttpError('kind must be "delove"', 400);
    this.closeGone();
    return this.saved.requests.filter((r) => r.status === 'open' || (r.status === 'claimed' && r.claimed < r.n));
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
  claim(id: string, rawN: unknown): { requestId: string; tournamentId: string; n: number; search: number; labelPrefix: string; firstLabel: number; options: Partial<GameOptions> } {
    this.closeGone();
    const r = this.require(id);
    if (r.status !== 'open' && r.status !== 'claimed') throw new RiskHttpError(`This request is ${r.status}`, 409);
    const left = r.n - r.claimed;
    const n = rawN === undefined ? left : rawN;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new RiskHttpError('n must be a whole number of at least 1', 400);
    if (n > left) throw new RiskHttpError(`Only ${left} seats of this request are left to claim`, 409);
    const t = this.tournaments.get(r.tournamentId)!;
    const searchUsed = this.live().reduce((k, x) => k + x.search, 0);
    const search = r.searchAllowed ? Math.max(0, Math.min(n, (this.caps.deloveSearchAtOnce || Infinity) - searchUsed)) : 0;
    const firstLabel = r.claimed + 1;
    r.claimed += n;
    r.search += search;
    r.status = 'claimed';
    this.save();
    return { requestId: r.id, tournamentId: r.tournamentId, n, search, labelPrefix: r.labelPrefix, firstLabel, options: { ...t.options } };
  }

  /** The pool reports how a claim went: `done` with the seats joined, or `failed` with a reason. */
  finish(id: string, outcome: 'done' | 'failed', joined: unknown, reason: unknown) {
    const r = this.require(id);
    if (r.status !== 'claimed' && r.status !== 'done') throw new RiskHttpError(`This request is ${r.status}`, 409);
    const j = joined === undefined ? 0 : joined;
    if (typeof j !== 'number' || !Number.isInteger(j) || j < 0 || j > r.claimed) throw new RiskHttpError(`joined must be a whole number from 0 to ${r.claimed}`, 400);
    if (outcome === 'failed') {
      // The seats it could not fill go back to the request for another claim, and their search seats with them.
      r.joined = Math.min(r.claimed, r.joined + j);
      r.claimed = r.joined;
      r.search = Math.min(r.search, r.joined);
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

  /** Requests whose tournament is gone or no longer registering close (expired). */
  private closeGone() {
    let changed = false;
    for (const r of this.live()) {
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
