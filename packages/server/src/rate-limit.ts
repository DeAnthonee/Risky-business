/** At most `limit` hits per key in any `windowMs` (a sliding window), e.g. per client IP on a public endpoint. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Count a hit for `key`. False (and not counted) when the key is at its limit. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Forget idle keys now and then, so many clients cannot grow the map without bound.
    if (this.hits.size > 1000) for (const [k, ts] of this.hits) if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

/** Raised when a client is over a rate limit (HTTP 429). */
export class RateLimitedError extends Error {}
