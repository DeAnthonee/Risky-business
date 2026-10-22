import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The season-archive password (RISK_SEASON_KEY) and its brute-force guard. The owner's chosen value may be short, so
 * wrong tries are limited per IP and in total: after `perIp` wrong tries an IP is locked out for `lockMs`, and after
 * `global` wrong tries from anyone within `lockMs` every attempt is refused until the window passes. A right password
 * clears its IP's count. Failures are logged without the attempted value.
 */
export interface SeasonKeyLimits {
  perIp: number;
  global: number;
  lockMs: number;
}

export const DEFAULT_SEASON_KEY_LIMITS: SeasonKeyLimits = { perIp: 5, global: 20, lockMs: 15 * 60_000 };

export type SeasonKeyCheck = { ok: true } | { ok: false; status: 403 | 429; error: string; retryAfterSec?: number };

/** Constant-time comparison of two strings of any length (both hashed first, so the length does not leak). */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export class SeasonKeyGuard {
  private byIp = new Map<string, { fails: number; until: number }>();
  private globalFails: number[] = [];

  constructor(
    private key: string | null | undefined,
    private limits: SeasonKeyLimits = DEFAULT_SEASON_KEY_LIMITS,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return !!this.key;
  }

  check(ip: string, password: unknown): SeasonKeyCheck {
    if (!this.key) return { ok: false, status: 403, error: 'Archiving seasons from the site is off (RISK_SEASON_KEY is not set)' };
    const t = this.now();
    this.globalFails = this.globalFails.filter((at) => t - at < this.limits.lockMs);
    const mine = this.byIp.get(ip);
    if (mine && mine.until > t) return this.locked(mine.until - t);
    if (this.globalFails.length >= this.limits.global) return this.locked(this.limits.lockMs - (t - this.globalFails[0]));
    if (typeof password === 'string' && password.length > 0 && password.length <= 200 && sameSecret(password, this.key)) {
      this.byIp.delete(ip);
      return { ok: true };
    }
    const fails = (mine && mine.until <= t && mine.fails >= this.limits.perIp ? 0 : (mine?.fails ?? 0)) + 1;
    this.byIp.set(ip, { fails, until: fails >= this.limits.perIp ? t + this.limits.lockMs : 0 });
    this.globalFails.push(t);
    console.warn(`[season] wrong archive password from ${ip} (${fails}/${this.limits.perIp})`);
    if (fails >= this.limits.perIp) return this.locked(this.limits.lockMs);
    return { ok: false, status: 403, error: 'Wrong password' };
  }

  private locked(ms: number): SeasonKeyCheck {
    const retryAfterSec = Math.max(1, Math.ceil(ms / 1000));
    return { ok: false, status: 429, error: `Too many wrong tries; try again in ${Math.ceil(retryAfterSec / 60)} min`, retryAfterSec };
  }
}
