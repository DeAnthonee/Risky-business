import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { SeasonKeyGuard, sameSecret } from '../src/season-key.js';

// Test values only (never a real key).
const KEY = 'test-season-key';
const ADMIN = 'test-admin-token';
const dirs: string[] = [];

async function serve(opts: { seasonKey?: string | null; guard?: SeasonKeyGuard }) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-season-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'games.json'));
  const risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0, seasonKey: opts.seasonKey, seasonGuard: opts.guard });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
  const archive = async (body: unknown, token?: string) => {
    const res = await fetch(`${base}/rankings/new-season`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get('retry-after') };
  };
  const season = async () => (await (await fetch(`${base}/rankings/seasons`)).json()) as { current: number; archiving: boolean };
  return { risk, archive, season };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('archive the season from the site (RISK_SEASON_KEY)', () => {
  it('is off without the key: 403, and the site hides the button', async () => {
    const { risk, archive, season } = await serve({ seasonKey: null });
    try {
      const before = await season();
      expect(before.archiving).toBe(false);
      const r = await archive({ password: 'anything' });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/off/);
      expect((await season()).current).toBe(before.current);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('refuses a wrong password (no archive) and archives with the right one', async () => {
    const { risk, archive, season } = await serve({ seasonKey: KEY });
    try {
      const before = await season();
      expect(before.archiving).toBe(true);
      expect((await archive({ password: 'wrong' })).status).toBe(403);
      expect((await archive({})).status).toBe(403);
      expect((await season()).current).toBe(before.current);
      const ok = await archive({ password: KEY });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ archived: before.current, season: before.current + 1 });
      expect((await season()).current).toBe(before.current + 1);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('locks an IP out after 5 wrong tries (429, even with the right password) until the lockout passes', async () => {
    let now = 1_000_000;
    const guard = new SeasonKeyGuard(KEY, { perIp: 5, global: 20, lockMs: 15 * 60_000 }, () => now);
    const { risk, archive, season } = await serve({ seasonKey: KEY, guard });
    try {
      const start = (await season()).current;
      for (let i = 0; i < 4; i++) expect((await archive({ password: `nope${i}` })).status).toBe(403);
      const fifth = await archive({ password: 'nope4' });
      expect(fifth.status).toBe(429);
      expect(Number(fifth.retryAfter)).toBeGreaterThan(0);
      expect((await archive({ password: KEY })).status).toBe(429);
      expect((await season()).current).toBe(start);
      now += 15 * 60_000 + 1;
      expect((await archive({ password: KEY })).status).toBe(200);
      expect((await season()).current).toBe(start + 1);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('keeps the lockout across a restart (saved under the data dir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-season-lock-'));
    dirs.push(dir);
    const file = join(dir, 'season-key-lockout.json');
    let now = 5_000;
    const first = new SeasonKeyGuard(KEY, { perIp: 3, global: 20, lockMs: 60_000 }, () => now, file);
    for (let i = 0; i < 3; i++) first.check('10.1.1.1', 'nope');
    expect(first.check('10.1.1.1', KEY)).toMatchObject({ ok: false, status: 429 });
    // A new guard (a restarted server) reads the same file: still locked, even with the right password.
    const second = new SeasonKeyGuard(KEY, { perIp: 3, global: 20, lockMs: 60_000 }, () => now, file);
    expect(second.check('10.1.1.1', KEY)).toMatchObject({ ok: false, status: 429 });
    now += 60_001;
    expect(second.check('10.1.1.1', KEY)).toEqual({ ok: true });
    // The file never holds the password or a guess.
    expect(readFileSync(file, 'utf8')).not.toMatch(/nope|test-season-key/);
  });

  it('forgets IPs once their window has passed (memory and file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-season-prune-'));
    dirs.push(dir);
    const file = join(dir, 'season-key-lockout.json');
    let now = 0;
    const guard = new SeasonKeyGuard(KEY, { perIp: 3, global: 100, lockMs: 60_000 }, () => now, file);
    guard.check('10.2.0.1', 'nope');
    for (let i = 0; i < 3; i++) guard.check('10.2.0.2', 'nope');
    expect(guard.tracked).toBe(2);
    now += 60_001;
    guard.check('10.2.0.3', 'nope');
    expect(guard.tracked).toBe(1);
    expect(readFileSync(file, 'utf8')).not.toMatch(/10\.2\.0\.1|10\.2\.0\.2/);
    expect(new SeasonKeyGuard(KEY, undefined, () => now, file).tracked).toBe(1);
  });

  it('locks everyone out after too many wrong tries in total', () => {
    let now = 0;
    const guard = new SeasonKeyGuard(KEY, { perIp: 5, global: 6, lockMs: 60_000 }, () => now);
    for (let i = 0; i < 6; i++) guard.check(`10.0.0.${i}`, 'nope');
    expect(guard.check('10.0.0.99', KEY)).toMatchObject({ ok: false, status: 429 });
    now += 60_001;
    expect(guard.check('10.0.0.99', KEY)).toEqual({ ok: true });
  });

  it('takes the admin token too, without the key', async () => {
    const { risk, archive, season } = await serve({ seasonKey: null });
    try {
      const before = (await season()).current;
      const r = await archive({}, ADMIN);
      expect(r.status).toBe(200);
      expect((await season()).current).toBe(before + 1);
      expect((await archive({}, 'not-the-admin')).status).toBe(403);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('compares in constant time over any length', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', 'abc')).toBe(false);
  });
});
