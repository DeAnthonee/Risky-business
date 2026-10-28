import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import type { TournamentClock } from '../src/tournaments.js';
import { parseSchedule, SAVED_SCHEDULE_FILE, scheduleFromSaved } from '../src/tournament-schedule.js';

/** Thursday 2026-10-22, 12:00 UTC; the schedule's timer only fires when the test moves it (it never does here). */
const NOON = Date.UTC(2026, 9, 22, 12, 0);
class FakeClock implements TournamentClock {
  constructor(public t = NOON) {}
  now = () => this.t;
  setTimeout = () => ({});
  clearTimeout = () => {};
}

const ENV = [{ at: '14:00', name: 'Daily Nest', signupMinutes: 60, roundMinutes: 20 }];
const TOKEN = 'admin-test-token';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'risk-schedule-settings-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the recurring tournaments settings page (/api/admin/schedule)', () => {
  it('shows, replaces, saves and resets the schedule; admin only; a bad entry changes nothing', async () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const file = join(dir, SAVED_SCHEDULE_FILE);
    const risk = createRiskServer(store, {
      clientDir: null,
      sweepIntervalMs: 0,
      adminToken: TOKEN,
      tournamentSchedule: parseSchedule(ENV, store.tournaments),
      scheduleRaw: ENV,
      scheduleSource: 'RISK_TOURNAMENT_SCHEDULE',
      envSchedule: { raw: ENV, source: 'RISK_TOURNAMENT_SCHEDULE' },
      scheduleFile: join(dir, 'tournament-schedule.json'),
      scheduleEntriesFile: file,
    });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
    const call = async (method: string, body?: unknown, token: string | null = TOKEN) => {
      const r = await fetch(`${base}/admin/schedule`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    try {
      expect((await call('GET', undefined, null)).status).toBe(401);
      expect((await call('GET', undefined, 'wrong')).status).toBe(401);
      const shown = await call('GET');
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({ source: 'RISK_TOURNAMENT_SCHEDULE', entries: ENV, persistent: true, envSource: 'RISK_TOURNAMENT_SCHEDULE' });
      expect(shown.body.nextStarts).toEqual([Date.UTC(2026, 9, 22, 14, 0)]);

      // A typo is refused with the entry's number, and the running schedule is untouched.
      const bad = await call('PUT', { entries: [...ENV, { at: '18:00', stlye: 'mega' }] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/schedule entry 2: unknown key "stlye"/);
      expect(store.schedule!.entries).toHaveLength(1);
      expect(existsSync(file)).toBe(false);
      expect((await call('PUT', { entries: 'nope' })).status).toBe(400);

      // A good one runs at once and is saved under RISK_DATA_DIR.
      const mega = { at: '12:00', tz: 'America/Los_Angeles', name: 'Mega tourney', style: 'mega', signupMinutes: 15, checkinMinutes: 10, roster: 100, maxEntrants: 100, options: { iceStartMinutes: 5 } };
      const saved = await call('PUT', { entries: [...ENV, mega] });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ source: 'the settings page', entries: [...ENV, mega] });
      expect(store.schedule!.entries.map((e) => e.spec.name)).toEqual(['Daily Nest', 'Mega tourney']);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([...ENV, mega]);
      expect(scheduleFromSaved(file)).toEqual({ raw: [...ENV, mega], source: 'the settings page' });

      // An empty list turns the schedule off (and is kept so); reset goes back to the server's own schedule.
      const off = await call('PUT', { entries: [] });
      expect(off.body).toMatchObject({ source: null, entries: [] });
      expect(store.schedule).toBeNull();
      const reset = await call('DELETE');
      expect(reset.body).toMatchObject({ source: 'RISK_TOURNAMENT_SCHEDULE', entries: ENV });
      expect(store.schedule!.entries).toHaveLength(1);
      expect(existsSync(file)).toBe(false);
    } finally {
      store.stopTimers();
      await new Promise<void>((resolve) => risk.server.close(() => resolve()));
    }
  });
});
