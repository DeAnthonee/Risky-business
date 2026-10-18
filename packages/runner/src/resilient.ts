import { RiskHttpError, type RiskApi } from '@risk/mcp';

export interface RetryOptions {
  /** Tries per call, the first included. Default 4. */
  attempts?: number;
  /** First wait before a retry; doubles each time. Default 1000 ms. */
  baseMs?: number;
  /** Longest single wait. Default 20 s. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
}

/**
 * Calls that are safe to repeat when the answer is lost. Moves, joins, starts and chat posts are not here: a
 * repeat could play twice or double-post, so the callers re-read the state after a failure instead.
 */
const SAFE = new Set([
  'rules',
  'map',
  'listGames',
  'getGame',
  'wait',
  'events',
  'chat',
  'leave',
  'closeGame',
  'listCharacters',
  'getCharacter',
  'characterHistory',
  'modelInfo',
  'characterMemory',
  'readDiary',
  'listTournaments',
  'getTournament',
  'waitTournament',
]);

/** Network failures and server-side trouble (5xx, 429, 408) are worth another try; a 4xx answer is final. */
export function isTransient(e: unknown): boolean {
  if (e instanceof RiskHttpError) return e.status >= 500 || e.status === 429 || e.status === 408;
  return e instanceof Error;
}

/** Wait before try `n` (0-based retry number): exponential from `base`, capped, with jitter. */
export function backoffMs(n: number, base = 1000, max = 20_000, random: () => number = Math.random): number {
  return Math.round(Math.min(max, base * 2 ** n) * (0.75 + 0.5 * random()));
}

/**
 * Wrap an API so its repeat-safe calls retry network errors and 5xx answers with exponential backoff, so a
 * shared server is never hammered. Other calls pass straight through. Messages logged never contain tokens
 * (only the call name and the error text).
 */
export function withRetry(api: RiskApi, o: RetryOptions = {}): RiskApi {
  const attempts = o.attempts ?? 4;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function' || !SAFE.has(prop)) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        for (let n = 0; ; n++) {
          try {
            return await value.apply(target, args);
          } catch (e) {
            if (n + 1 >= attempts || !isTransient(e)) throw e;
            const wait = backoffMs(n, o.baseMs, o.maxMs, o.random);
            o.log?.(`${prop} failed (${e instanceof Error ? e.message : String(e)}); retrying in ${(wait / 1000).toFixed(1)} s`);
            await sleep(wait);
          }
        }
      };
    },
  });
}
