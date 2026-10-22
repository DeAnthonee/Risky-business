import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The season-archive password (RISK_SEASON_KEY) and its brute-force guard. The owner's chosen value may be short, so
 * wrong tries are limited per IP and in total: after `perIp` wrong tries an IP is locked out for `lockMs`, and after
 * `global` wrong tries from anyone within `lockMs` every attempt is refused until the window passes. A right password
 * clears its IP's count. Failures are logged without the attempted value. With a `file` (under RISK_DATA_DIR) the counts
 * and lockouts are saved on every change and read back at start, so a restart does not reset them.
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
  /** Per IP: wrong tries, lockout end (0 = not locked) and the last wrong try (for pruning). */
  private byIp = new Map<string, { fails: number; until: number; at?: number }>();
  private globalFails: number[] = [];

  constructor(
    private key: string | null | undefined,
    private limits: SeasonKeyLimits = DEFAULT_SEASON_KEY_LIMITS,
    private now: () => number = Date.now,
    private file: string | null = null,
    /** The log label (another key guarded the same way, e.g. the seat pool's). */
    private label = 'season',
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { byIp?: Record<string, { fails: number; until: number }>; globalFails?: number[] };
        this.byIp = new Map(Object.entries(saved.byIp ?? {}));
        this.globalFails = (saved.globalFails ?? []).filter((n) => typeof n === 'number');
      } catch (err) {
        console.error(`[${this.label}] could not read the lockout file:`, (err as Error).message);
      }
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ byIp: Object.fromEntries(this.byIp), globalFails: this.globalFails }));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[${this.label}] could not save the lockout file:`, (err as Error).message);
    }
  }

  get enabled(): boolean {
    return !!this.key;
  }

  check(ip: string, password: unknown): SeasonKeyCheck {
    if (!this.key) return { ok: false, status: 403, error: 'Archiving seasons from the site is off (RISK_SEASON_KEY is not set)' };
    const t = this.now();
    this.globalFails = this.globalFails.filter((at) => t - at < this.limits.lockMs);
    this.prune(t);
    const mine = this.byIp.get(ip);
    if (mine && mine.until > t) return this.locked(mine.until - t);
    if (this.globalFails.length >= this.limits.global) return this.locked(this.limits.lockMs - (t - this.globalFails[0]));
    if (typeof password === 'string' && password.length > 0 && password.length <= 200 && sameSecret(password, this.key)) {
      if (this.byIp.delete(ip)) this.save();
      return { ok: true };
    }
    const fails = (mine && mine.until <= t && mine.fails >= this.limits.perIp ? 0 : (mine?.fails ?? 0)) + 1;
    this.byIp.set(ip, { fails, until: fails >= this.limits.perIp ? t + this.limits.lockMs : 0, at: t });
    this.globalFails.push(t);
    this.save();
    console.warn(`[${this.label}] wrong key from ${ip} (${fails}/${this.limits.perIp})`);
    if (fails >= this.limits.perIp) return this.locked(this.limits.lockMs);
    return { ok: false, status: 403, error: 'Wrong password' };
  }

  /** Forget IPs whose lockout is over and whose last wrong try is older than the window (in memory and in the file). */
  private prune(t: number) {
    let pruned = false;
    for (const [ip, e] of this.byIp) {
      const last = e.at ?? e.until;
      if (e.until <= t && t - last >= this.limits.lockMs) {
        this.byIp.delete(ip);
        pruned = true;
      }
    }
    if (pruned) this.save();
  }

  /** IPs currently tracked (tests). */
  get tracked(): number {
    return this.byIp.size;
  }

  private locked(ms: number): SeasonKeyCheck {
    const retryAfterSec = Math.max(1, Math.ceil(ms / 1000));
    return { ok: false, status: 429, error: `Too many wrong tries; try again in ${Math.ceil(retryAfterSec / 60)} min`, retryAfterSec };
  }
}
