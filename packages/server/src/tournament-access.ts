import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sameSecret } from './season-key.js';
import { RiskHttpError } from '@risk/mcp';
import type { CreateTournamentSpec, TournamentManager } from './tournaments.js';

/**
 * Who may host a tournament, and how much the site lets them run (docs/tournaments.md "Hosting codes and caps"). The
 * owner sets two codes as env vars: an admin code (unlimited creates) and a limited code (a few creates per UTC day).
 * Their values are never logged or written anywhere. When either is set, creating needs a code (or the admin key), and
 * starting needs the host token, a code or the admin key. Wrong codes are limited per IP and site-wide, then locked out.
 *
 * Caps guard the one server loop (resources' RS2, owner-approved): tournaments at once, seats per tournament and in
 * total, creates per day, and a brake that refuses creates while the event loop lags. They apply to every create but
 * the admin key's (the server owner) and the server's own schedule. The Delove numbers are kept here for P3, which
 * enforces them. Tournaments left registering expire.
 */

/** How a create was allowed: the admin code, the limited code, or open mode (RISK_TOURNAMENTS_OPEN, no code). */
export type HostTier = 'admin' | 'limited' | 'open';

export interface TourneyAccessConfig {
  adminCode: string | null;
  limitedCode: string | null;
  // Every cap below: 0 = no cap.
  /** Creates per UTC day with the limited code. */
  limitedPerDay: number;
  /** Creates per UTC day, site-wide, by code or open mode. */
  createsPerDay: number;
  /** Tournaments registering or running at once, site-wide (every kind counts toward it; 0 = no cap). */
  maxActive: number;
  /** Of those, at most this many created with the limited code (or in open mode) at once. */
  maxActiveLimited: number;
  /** Most entrants per tournament: admin code, and limited code or open mode. */
  seatsAdmin: number;
  seatsLimited: number;
  /** Entrant seats reserved (maxEntrants) by every tournament registering or running, at most. */
  maxLiveSeats: number;
  /** Delove seats per tournament (admin, limited) and at once, site-wide. Stored for P3; not enforced yet. */
  deloveAdmin: number;
  deloveLimited: number;
  deloveAtOnce: number;
  /** Refuse creates while the event loop's p99 lag (the /healthz figure) is above this many ms (0 = off). */
  lagBrakeMs: number;
  /** A tournament never started is called off this long after it was created, ms. */
  expireMs: number;
  /** A scheduled tournament still registering this long after its start is called off, ms. */
  scheduledExpireMs: number;
  /** Wrong-code limits: per IP within `windowMs`, then locked out for `lockMs`; site-wide within `globalWindowMs`. */
  attempts: { perIp: number; windowMs: number; lockMs: number; global: number; globalWindowMs: number };
}

const H = 3600_000;

export const DEFAULT_TOURNEY_ACCESS: TourneyAccessConfig = {
  adminCode: null,
  limitedCode: null,
  limitedPerDay: 5,
  createsPerDay: 20,
  maxActive: 2,
  maxActiveLimited: 1,
  seatsAdmin: 128,
  seatsLimited: 64,
  maxLiveSeats: 200,
  deloveAdmin: 40,
  deloveLimited: 16,
  deloveAtOnce: 48,
  lagBrakeMs: 100,
  expireMs: 24 * H,
  scheduledExpireMs: 2 * H,
  attempts: { perIp: 5, windowMs: 15 * 60_000, lockMs: H, global: 50, globalWindowMs: H },
};

/**
 * No caps, no brake, no expiry: what `createRiskServer` uses when it is given no config (tests and embedding). The server
 * binary (index.ts) always passes `tourneyAccessFromEnv`, whose defaults are the caps above.
 */
export const NO_TOURNEY_CAPS: Partial<TourneyAccessConfig> = {
  createsPerDay: 0,
  limitedPerDay: 0,
  maxActive: 0,
  maxActiveLimited: 0,
  seatsAdmin: 0,
  seatsLimited: 0,
  maxLiveSeats: 0,
  lagBrakeMs: 0,
  expireMs: 0,
  scheduledExpireMs: 0,
};

/** Why an expired tournament was called off (its `scheduled.cancelled`). */
export const CANCEL_EXPIRED = 'expired: never started';

/** The config from the environment (docs/hosting.md lists every name). Bad numbers fall back to the default. */
export function tourneyAccessFromEnv(env: NodeJS.ProcessEnv): TourneyAccessConfig {
  const d = DEFAULT_TOURNEY_ACCESS;
  const int = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 ? v : fallback;
  };
  return {
    ...d,
    adminCode: env.RISK_TOURNEY_ADMIN_CODE || null,
    limitedCode: env.RISK_TOURNEY_LIMITED_CODE || null,
    limitedPerDay: int('RISK_TOURNEY_LIMITED_PER_DAY', d.limitedPerDay),
    createsPerDay: int('RISK_TOURNEY_CREATES_PER_DAY', d.createsPerDay),
    maxActive: int('RISK_TOURNEY_MAX_ACTIVE', d.maxActive),
    maxActiveLimited: int('RISK_TOURNEY_MAX_ACTIVE_LIMITED', d.maxActiveLimited),
    seatsAdmin: int('RISK_TOURNEY_SEATS_ADMIN', d.seatsAdmin),
    seatsLimited: int('RISK_TOURNEY_SEATS_LIMITED', d.seatsLimited),
    maxLiveSeats: int('RISK_TOURNEY_MAX_LIVE_SEATS', d.maxLiveSeats),
    deloveAdmin: int('RISK_TOURNEY_DELOVE_ADMIN', d.deloveAdmin),
    deloveLimited: int('RISK_TOURNEY_DELOVE_LIMITED', d.deloveLimited),
    deloveAtOnce: int('RISK_TOURNEY_DELOVE_AT_ONCE', d.deloveAtOnce),
    lagBrakeMs: int('RISK_TOURNEY_LAG_BRAKE_MS', d.lagBrakeMs),
    expireMs: int('RISK_TOURNEY_EXPIRE_HOURS', d.expireMs / H) * H,
    scheduledExpireMs: int('RISK_TOURNEY_SCHEDULED_EXPIRE_HOURS', d.scheduledExpireMs / H) * H,
  };
}

/** Open mode (RISK_TOURNAMENTS_OPEN): "0" off, anything else on; unset, on only while no hosting code is set. */
export function openModeFromEnv(env: NodeJS.ProcessEnv, config: Pick<TourneyAccessConfig, 'adminCode' | 'limitedCode'>): boolean {
  const raw = env.RISK_TOURNAMENTS_OPEN;
  if (raw === undefined || raw === '') return !(config.adminCode || config.limitedCode);
  return raw !== '0';
}

/** What is saved under RISK_DATA_DIR: the day's counts, wrong tries and each code-made tournament's tier. */
interface Saved {
  day: string;
  creates: number;
  limited: number;
  tiers: Record<string, HostTier>;
  byIp: Record<string, { fails: number[]; until: number }>;
  globalFails: number[];
}

export class TournamentAccess {
  readonly config: TourneyAccessConfig;
  private saved: Saved;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private tournaments: TournamentManager,
    config: Partial<TourneyAccessConfig> = {},
    private file: string | null = null,
    /** The event loop's p99 lag in ms (the /healthz figure). */
    private lagMs: () => number = () => 0,
  ) {
    this.config = { ...DEFAULT_TOURNEY_ACCESS, ...config, attempts: { ...DEFAULT_TOURNEY_ACCESS.attempts, ...(config.attempts ?? {}) } };
    this.saved = { day: this.today(), creates: 0, limited: 0, tiers: {}, byIp: {}, globalFails: [] };
    if (file && existsSync(file)) {
      try {
        this.saved = { ...this.saved, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>) };
      } catch (err) {
        console.error('[tourney] could not read the access file:', (err as Error).message);
      }
    }
  }

  /** True when either code is set: creating then needs a code. */
  get codesSet(): boolean {
    return !!(this.config.adminCode || this.config.limitedCode);
  }

  private now() {
    return this.tournaments.clock.now();
  }

  private today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[tourney] could not save the access file:', (err as Error).message);
    }
  }

  /** A new UTC day resets the create counts. */
  private rollDay() {
    const day = this.today();
    if (this.saved.day !== day) this.saved = { ...this.saved, day, creates: 0, limited: 0 };
  }

  /**
   * Which code `code` is, or throws: 429 while this IP (or the whole site) is locked out, 403 for a wrong code. The
   * message never says which code was close. A right code clears its IP's wrong tries.
   */
  checkCode(ip: string, code: unknown): 'admin' | 'limited' {
    const { attempts } = this.config;
    const t = this.now();
    this.saved.globalFails = this.saved.globalFails.filter((at) => t - at < attempts.globalWindowMs);
    for (const [k, e] of Object.entries(this.saved.byIp)) {
      e.fails = e.fails.filter((at) => t - at < attempts.windowMs);
      if (e.until <= t && e.fails.length === 0) delete this.saved.byIp[k];
    }
    const mine = this.saved.byIp[ip];
    if (mine && mine.until > t) throw this.locked(mine.until - t);
    if (this.saved.globalFails.length >= attempts.global) throw this.locked(attempts.globalWindowMs - (t - this.saved.globalFails[0]));
    const given = typeof code === 'string' && code.length > 0 && code.length <= 200 ? code : null;
    // Both codes are always compared, so the time taken does not say which one matched.
    const admin = given !== null && !!this.config.adminCode && sameSecret(given, this.config.adminCode);
    const limited = given !== null && !!this.config.limitedCode && sameSecret(given, this.config.limitedCode);
    if (admin || limited) {
      if (this.saved.byIp[ip]) {
        delete this.saved.byIp[ip];
        this.save();
      }
      return admin ? 'admin' : 'limited';
    }
    const e = (this.saved.byIp[ip] ??= { fails: [], until: 0 });
    e.fails.push(t);
    this.saved.globalFails.push(t);
    if (e.fails.length >= attempts.perIp) {
      e.until = t + attempts.lockMs;
      e.fails = [];
    }
    this.save();
    console.warn(`[tourney] wrong tournament code from ${ip}`);
    if (e.until > t) throw this.locked(e.until - t);
    return this.wrong();
  }

  private wrong(): never {
    throw new RiskHttpError('Wrong tournament code', 403);
  }

  private locked(ms: number): RiskHttpError {
    const min = Math.max(1, Math.ceil(ms / 60_000));
    return new RiskHttpError(`Too many wrong tournament codes; try again in ${min} min`, 429);
  }

  /**
   * Who may create, before any cap: a code (checked, limited per IP), else open mode, else nobody. `open` is
   * RISK_TOURNAMENTS_OPEN (off by default once a code is set).
   */
  hostTier(ip: string, code: unknown, open: boolean): HostTier {
    if (code !== undefined && code !== null && code !== '') return this.checkCode(ip, code);
    if (open) return 'open';
    if (this.codesSet) throw new RiskHttpError('Creating a tournament needs a tournament code', 401);
    throw new RiskHttpError('Only the host can create tournaments: it needs the admin key', 403);
  }

  /** The caps for a create at `tier`; fills in `maxEntrants` up to the tier's seats. Throws when a cap is reached. */
  checkCreate(tier: HostTier, spec: CreateTournamentSpec): CreateTournamentSpec {
    const c = this.config;
    if (c.lagBrakeMs > 0 && this.lagMs() > c.lagBrakeMs)
      throw new RiskHttpError('The server is busy right now; new tournaments are paused until it catches up. Try again in a few minutes', 503);
    this.expire();
    this.rollDay();
    if (c.createsPerDay > 0 && this.saved.creates >= c.createsPerDay) throw new RiskHttpError(`The site has made its ${c.createsPerDay} tournaments for today (UTC); try again tomorrow`, 429);
    if (tier === 'limited' && c.limitedPerDay > 0 && this.saved.limited >= c.limitedPerDay) throw new RiskHttpError(`This code has made its ${c.limitedPerDay} tournaments for today (UTC); try again tomorrow`, 429);
    const active = [...this.tournaments.tournaments.values()].filter((t) => t.status !== 'finished');
    if (c.maxActive > 0 && active.length >= c.maxActive) throw new RiskHttpError(`${c.maxActive} tournaments are already registering or running; try again when one has finished`, 429);
    if (tier !== 'admin' && c.maxActiveLimited > 0 && active.filter((t) => this.saved.tiers[t.id] && this.saved.tiers[t.id] !== 'admin').length >= c.maxActiveLimited)
      throw new RiskHttpError(`A tournament made with this code is already registering or running (at most ${c.maxActiveLimited} at once)`, 429);
    const seats = (tier === 'admin' ? c.seatsAdmin : c.seatsLimited) || Infinity;
    // With seat counts the cap defaults to their sum (TournamentManager.create), which must fit too; without, the
    // format's default is cut down to the code's seats.
    const counted = (spec.zergs ?? 0) + (spec.delove ?? 0) + (spec.open ?? 0);
    const fallback = spec.format === 'nested' ? 128 : 64;
    const maxEntrants = spec.maxEntrants ?? (counted > 0 ? counted : Math.min(seats, fallback));
    if ((spec.maxEntrants !== undefined || counted > 0) && maxEntrants > seats) throw new RiskHttpError(`maxEntrants can be at most ${seats} with this code`, 400);
    const reserved = active.reduce((n, t) => n + t.maxEntrants, 0);
    if (c.maxLiveSeats > 0 && reserved + maxEntrants > c.maxLiveSeats)
      throw new RiskHttpError(`Only ${Math.max(0, c.maxLiveSeats - reserved)} tournament seats are free right now (of ${c.maxLiveSeats}); lower maxEntrants or try later`, 429);
    return { ...spec, maxEntrants };
  }

  /** Count a create made at `tier`. */
  recordCreate(tier: HostTier, tournamentId: string) {
    this.rollDay();
    this.saved.creates++;
    if (tier === 'limited') this.saved.limited++;
    this.saved.tiers[tournamentId] = tier;
    for (const id of Object.keys(this.saved.tiers)) if (!this.tournaments.get(id)) delete this.saved.tiers[id];
    this.save();
  }

  /** Whether `code` may start tournament `id`: the admin code starts any, the limited code those made with it. */
  canStart(ip: string, code: unknown, id: string): boolean {
    const tier = this.checkCode(ip, code);
    return tier === 'admin' || this.saved.tiers[id.toUpperCase()] === 'limited';
  }

  /** Call off tournaments left registering: never started `expireMs` after creation, or `scheduledExpireMs` past their start. */
  expire(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const x of this.tournaments.tournaments.values()) {
      if (x.status !== 'registering') continue;
      const late = x.scheduled
        ? this.config.scheduledExpireMs > 0 && t > x.scheduled.startsAt + this.config.scheduledExpireMs
        : this.config.expireMs > 0 && t > x.createdAt + this.config.expireMs;
      if (!late) continue;
      this.tournaments.cancel(x.id, CANCEL_EXPIRED);
      console.log(`[tourney] ${x.id} called off (${CANCEL_EXPIRED})`);
      out.push(x.id);
    }
    return out;
  }

  /** Check for expired tournaments every few minutes. */
  startSweeper(everyMs = 5 * 60_000) {
    this.stopSweeper();
    this.expire();
    this.sweepTimer = setInterval(() => this.expire(), everyMs);
    this.sweepTimer.unref();
  }

  stopSweeper() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
