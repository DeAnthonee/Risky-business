import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import type { TournamentClock } from '../src/tournaments.js';
import { CANCEL_MISSED, CANCEL_NOT_ENOUGH, TournamentScheduler, nextStart, parseAt, parseSchedule, scheduleFromEnv } from '../src/tournament-schedule.js';

const H = 60 * 60_000;
/** Thursday 2026-10-22, 12:00 UTC. */
const NOON = Date.UTC(2026, 9, 22, 12, 0);

/** A clock the test moves by hand: the schedule's timer fires only when it is advanced past it. */
class FakeClock implements TournamentClock {
  timers: { at: number; fn: () => void }[] = [];
  constructor(public t = NOON) {}
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + ms, fn };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      this.timers = this.timers.filter((x) => x !== due);
      due.fn();
    }
    this.t = end;
  }
}

/** Slow bots: the tables of a started tournament must not race the test. */
const DAILY = { at: '14:00', name: 'Daily Nest', signupMinutes: 60, roundMinutes: 20, botDelayMs: 2000 };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'risk-schedule-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('schedule times', () => {
  it('parses "HH:MM" and "Mon,Thu HH:MM" (UTC) and finds the next start', () => {
    expect(parseAt('20:00')).toEqual({ days: null, minuteOfDay: 20 * 60 });
    expect(parseAt('thu, Mon 7:05')).toEqual({ days: [1, 4], minuteOfDay: 7 * 60 + 5 });
    for (const bad of ['', '25:00', '12:60', 'Fun 10:00', 'noon', 12]) expect(() => parseAt(bad)).toThrow();
    const daily = parseAt('20:00');
    expect(nextStart(daily, NOON)).toBe(Date.UTC(2026, 9, 22, 20, 0));
    expect(nextStart(daily, Date.UTC(2026, 9, 22, 20, 0))).toBe(Date.UTC(2026, 9, 23, 20, 0));
    // Thursday 21:00 -> next Monday 20:00.
    expect(nextStart(parseAt('Mon,Thu 20:00'), Date.UTC(2026, 9, 22, 21, 0))).toBe(Date.UTC(2026, 9, 26, 20, 0));
  });

  it('checks every entry at startup: unknown keys, bad times, game settings (strict) and nested settings', () => {
    const t = new Store(null).tournaments;
    expect(parseSchedule(DAILY, t)).toHaveLength(1);
    expect(parseSchedule([DAILY, { at: 'Sat 18:30', finalMap: 'classic' }], t)[1]).toMatchObject({ days: [6], signupMinutes: 60, minEntrants: 2, spec: { format: 'nested', finalMap: 'classic' } });
    expect(() => parseSchedule([], t)).toThrow(/empty/);
    expect(() => parseSchedule({ at: '14:00', hostToken: 'x' }, t)).toThrow(/entry 1: unknown key "hostToken"/);
    expect(() => parseSchedule([DAILY, { at: '99:00' }], t)).toThrow(/entry 2/);
    expect(() => parseSchedule({ at: '14:00', options: { noSuchSetting: 1 } }, t)).toThrow();
    expect(() => parseSchedule({ at: '14:00', finalMap: 'nowhere' }, t)).toThrow(/Unknown map/);
    expect(() => parseSchedule({ at: '14:00', roundMinutes: 0 }, t)).toThrow(/roundMinutes/);
    expect(() => parseSchedule({ at: '14:00', signupMinutes: 0 }, t)).toThrow(/signupMinutes/);
    expect(() => parseSchedule({ at: '14:00', minEntrants: 1 }, t)).toThrow(/minEntrants must be a whole number from 2/);
    expect(t.tournaments.size).toBe(0);
  });

  it('reads RISK_TOURNAMENT_SCHEDULE, else RISK_TOURNAMENT_SCHEDULE_FILE, else nothing (off)', () => {
    expect(scheduleFromEnv({})).toBeNull();
    expect(scheduleFromEnv({ RISK_TOURNAMENT_SCHEDULE: JSON.stringify(DAILY) })).toEqual({ raw: DAILY, source: 'RISK_TOURNAMENT_SCHEDULE' });
  });
});

describe('scheduled nested tournaments', () => {
  let risk: RiskServer | null = null;
  afterEach(async () => {
    await risk?.shutdown('test');
    risk = null;
  });

  async function serve(store: Store, schedule: unknown) {
    risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0, tournamentSchedule: schedule ? parseSchedule(schedule, store.tournaments) : null });
    await new Promise<void>((resolve) => risk!.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${base}/api${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { base, call };
  }
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

  it('no schedule: nothing is created and /next says so', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const { call } = await serve(store, null);
    clock.advance(48 * H);
    expect(store.tournaments.tournaments.size).toBe(0);
    expect((await call('/tournaments/next')).body).toEqual({ scheduled: false, next: null, running: null, cancelled: null });
  });

  it('schedule -> sign-up opens ahead -> people join -> starts on time -> Zergs fill the seats', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const { call } = await serve(store, DAILY);
    const start = Date.UTC(2026, 9, 22, 14, 0);

    // 12:00: not open yet; the card shows when sign-up opens.
    let next = (await call('/tournaments/next')).body;
    expect(next).toMatchObject({ scheduled: true, next: { id: null, name: 'Daily Nest', startsAt: start, opensAt: start - H, entrants: 0 }, running: null, cancelled: null });
    expect(store.tournaments.tournaments.size).toBe(0);

    // 13:00: the server creates it (no host token handed out) and sign-up is open.
    clock.advance(H);
    next = (await call('/tournaments/next')).body;
    const id = next.next.id as string;
    expect(id).toMatch(/^T/);
    const view = (await call(`/tournaments/${id}`)).body.tournament;
    expect(view).toMatchObject({ status: 'registering', format: 'nested', scheduled: { startsAt: start } });
    expect(view).not.toHaveProperty('hostToken');
    expect((await call('/tournaments')).body.tournaments[0]).toMatchObject({ id, startsAt: start });

    const joined = await call(`/tournaments/${id}/join`, post({ playerName: 'Ann' }));
    expect(joined.status).toBe(201);
    await call(`/tournaments/${id}/join`, post({ playerName: 'Bob' }));
    expect((await call('/tournaments/next')).body.next).toMatchObject({ id, entrants: 2 });

    // 13:59: still registering. 14:00: started, and the planner's Zergs fill the empty seats.
    clock.advance(H - 60_000);
    expect(store.tournaments.get(id)!.status).toBe('registering');
    clock.advance(60_000);
    const t = store.tournaments.get(id)!;
    expect(t.status).toBe('running');
    const zergs = t.entrants.filter((e) => e.isBot && e.kind === 'zerg').length;
    expect(zergs).toBe(t.nested!.plan!.zergs);
    expect(zergs).toBeGreaterThan(0);
    expect(t.rounds[0].matches.every((m) => m.gameId)).toBe(true);

    // The card: this one is being played; the next is tomorrow's, not open yet.
    next = (await call('/tournaments/next')).body;
    expect(next.running).toMatchObject({ id, name: 'Daily Nest', round: 1 });
    expect(next.next).toMatchObject({ id: null, startsAt: start + 24 * H });
  });

  it('fewer than minEntrants at the start: called off ("not enough entrants"), never on the board', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const { call } = await serve(store, DAILY);
    clock.advance(H);
    const id = (await call('/tournaments/next')).body.next.id as string;
    await call(`/tournaments/${id}/join`, post({ playerName: 'Ann' }));
    clock.advance(H);
    const t = store.tournaments.get(id)!;
    expect(t).toMatchObject({ status: 'finished', champion: null, rounds: [], scheduled: { cancelled: CANCEL_NOT_ENOUGH } });
    expect(store.tournamentBoard.rows()).toEqual([]);
    const next = (await call('/tournaments/next')).body;
    expect(next.cancelled).toMatchObject({ id, reason: CANCEL_NOT_ENOUGH });
    expect(next.next).toMatchObject({ id: null, startsAt: Date.UTC(2026, 9, 23, 14, 0) });
    expect((await call(`/tournaments/${id}/join`, post({ playerName: 'Late' }))).status).toBe(400);
  });

  it('survives a restart: no second tournament for the same slot, it starts on time; a start missed while down is called off', () => {
    const file = join(dir, 'games.json');
    const state = join(dir, 'tournament-schedule.json');
    const clock = new FakeClock(NOON + H); // 13:00: sign-up opens at once
    const store = new Store(file, {}, { clock });
    const entries = parseSchedule(DAILY, store.tournaments);
    const first = new TournamentScheduler(store.tournaments, entries, state);
    const [id] = [...store.tournaments.tournaments.keys()];
    expect(store.tournaments.join(id, 'Ann').entrantId).toBeTruthy();
    store.tournaments.join(id, 'Bob');
    first.stop();
    store.save();
    store.stopTimers();

    // Back up at 13:30: the same tournament, still open; it starts at 14:00.
    const clock2 = new FakeClock(NOON + 1.5 * H);
    const again = new Store(file, {}, { clock: clock2 });
    const second = new TournamentScheduler(again.tournaments, parseSchedule(DAILY, again.tournaments), state);
    expect([...again.tournaments.tournaments.keys()]).toEqual([id]);
    clock2.advance(0.5 * H);
    expect(again.tournaments.get(id)!.status).toBe('running');
    second.stop();
    again.stopTimers();

    // A fresh slot opened, then the server was down past its start and a round's grace: called off on boot.
    // Its own folder: tournaments.json sits next to games.json.
    const file3 = join(dir, 'third', 'games.json');
    const state3 = join(dir, 'third', 'tournament-schedule.json');
    const s3 = new Store(file3, {}, { clock: new FakeClock(NOON + H) });
    new TournamentScheduler(s3.tournaments, parseSchedule(DAILY, s3.tournaments), state3).stop();
    const [id3] = [...s3.tournaments.tournaments.keys()];
    s3.tournaments.join(id3, 'Ann');
    s3.save();
    s3.stopTimers();
    const late = new Store(file3, {}, { clock: new FakeClock(NOON + 2 * H + 21 * 60_000) });
    const third = new TournamentScheduler(late.tournaments, parseSchedule(DAILY, late.tournaments), state3);
    expect(late.tournaments.get(id3)!.scheduled).toMatchObject({ cancelled: CANCEL_MISSED });
    expect(third.next().cancelled).toMatchObject({ id: id3, reason: CANCEL_MISSED });
    third.stop();
    late.stopTimers();
  });

  it('agents find and join it over MCP: next_tournament, list_tournaments, join_tournament', async () => {
    const clock = new FakeClock(NOON + H);
    const store = new Store(null, {}, { clock });
    const { base } = await serve(store, DAILY);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'schedule', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
    const [id] = [...store.tournaments.tournaments.keys()];
    const next = await call('next_tournament');
    expect(next).toContain(`NEXT: ${id} "Daily Nest" - sign-up OPEN, starts 2026-10-22T14:00:00.000Z`);
    expect(await call('list_tournaments')).toContain('"startsAt"');
    const joined = await call('join_tournament', { tournamentId: id, playerName: 'Claude' });
    expect(joined).toContain('ENTRANT TOKEN');
    expect(joined).toContain('SCHEDULED: starts at 2026-10-22T14:00:00.000Z');
    expect(store.tournaments.get(id)!.entrants.map((e) => e.name)).toEqual(['Claude']);
    await client.close();
  });
});
