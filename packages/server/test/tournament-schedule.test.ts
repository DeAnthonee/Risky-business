import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import type { TournamentClock } from '../src/tournaments.js';
import { CANCEL_CHANGED, CANCEL_MISSED, CANCEL_NOT_ENOUGH, TournamentScheduler, nextStart, parseAt, parseSchedule, scheduleFromEnv } from '../src/tournament-schedule.js';

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
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const res = await fetch(`${base}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
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
    // The owner's tournament mode, as every nested tournament: auto setup, capitals, blizzards scaled per table.
    expect(view.options).toMatchObject({ autoSetup: true, capitals: true });
    expect(view.options.blizzards).toBeUndefined();
    expect(view).not.toHaveProperty('hostToken');
    expect((await call('/tournaments')).body.tournaments[0]).toMatchObject({ id, startsAt: start });

    const joined = await call(`/tournaments/${id}/join`, post({ playerName: 'Ann' }));
    expect(joined.status).toBe(201);
    const ann = joined.body.token as string;
    const bob = (await call(`/tournaments/${id}/join`, post({ playerName: 'Bob' }))).body.token as string;
    const cat = (await call(`/tournaments/${id}/join`, post({ playerName: 'Cat' }))).body.token as string;
    next = (await call('/tournaments/next')).body;
    expect(next.next).toMatchObject({ id, entrants: 3, checkinOpensAt: start - 10 * 60_000 });
    expect(next.next).not.toHaveProperty('checkedIn');

    // 13:49: polling does not check in yet; the window opens at 13:50.
    clock.advance(49 * 60_000);
    expect((await call(`/tournaments/${id}/wait?timeoutMs=0`, {}, ann)).body.tournament.you).toMatchObject({ checkedIn: false });
    // 13:55: Ann's wait_for_match and Bob's bracket view check them in; Cat never comes back.
    clock.advance(6 * 60_000);
    expect((await call(`/tournaments/${id}/wait?timeoutMs=0`, {}, ann)).body.tournament.you).toMatchObject({ checkedIn: true });
    expect((await call(`/tournaments/${id}`, {}, bob)).body.tournament.scheduled).toMatchObject({ checkinMinutes: 10, checkedIn: 2 });
    expect((await call('/tournaments/next')).body.next).toMatchObject({ entrants: 3, checkedIn: 2 });

    // 13:59: still registering. 14:00: started; Cat, a no-show, became a Zerg, and the planner's Zergs fill the rest.
    clock.advance(4 * 60_000);
    expect(store.tournaments.get(id)!.status).toBe('registering');
    clock.advance(60_000);
    const t = store.tournaments.get(id)!;
    expect(t.status).toBe('running');
    expect(t.scheduled).toMatchObject({ noShows: 1 });
    expect(t.entrants.filter((e) => e.missed).map((e) => e.missed!.name)).toEqual(['Cat']);
    expect(t.entrants.filter((e) => !e.isBot).map((e) => e.name).sort()).toEqual(['Ann', 'Bob']);
    const zergs = t.entrants.filter((e) => e.isBot && e.kind === 'zerg').length;
    expect(zergs).toBe(t.nested!.plan!.zergs + 1);
    expect(zergs).toBeGreaterThan(1);
    const missed = await call(`/tournaments/${id}`, {}, cat);
    expect(missed.status).toBe(400);
    expect(missed.body.error).toMatch(/^Cat missed check-in for this tournament: the seat went to a Zerg/);
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
    const ann = store.tournaments.join(id, 'Ann').token;
    const bob = store.tournaments.join(id, 'Bob').token;
    first.stop();
    store.save();
    store.stopTimers();

    // Back up at 13:30: the same tournament, still open; it starts at 14:00.
    const clock2 = new FakeClock(NOON + 1.5 * H);
    const again = new Store(file, {}, { clock: clock2 });
    const second = new TournamentScheduler(again.tournaments, parseSchedule(DAILY, again.tournaments), state);
    expect([...again.tournaments.tournaments.keys()]).toEqual([id]);
    // Both check in at 13:55 (the saved entrants keep their tokens); it starts at 14:00.
    clock2.advance(25 * 60_000);
    again.tournaments.checkIn(id, ann);
    again.tournaments.checkIn(id, bob);
    clock2.advance(5 * 60_000);
    expect(again.tournaments.get(id)!.status).toBe('running');
    expect(again.tournaments.get(id)!.scheduled).toMatchObject({ noShows: 0 });
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

  it('an entry changed while its tournament is registering: that tournament is called off on load, not left open', () => {
    const file = join(dir, 'changed', 'games.json');
    const state = join(dir, 'changed', 'tournament-schedule.json');
    const store = new Store(file, {}, { clock: new FakeClock(NOON + H) });
    new TournamentScheduler(store.tournaments, parseSchedule(DAILY, store.tournaments), state).stop();
    const [old] = [...store.tournaments.tournaments.keys()];
    store.tournaments.join(old, 'Ann');
    // An admin-added bot does not count as an entrant on the card.
    store.tournaments.addBots(old, 'zerg', 1);
    store.save();
    store.stopTimers();

    const again = new Store(file, {}, { clock: new FakeClock(NOON + 1.5 * H) });
    const sched = new TournamentScheduler(again.tournaments, parseSchedule({ ...DAILY, at: '15:00' }, again.tournaments), state);
    expect(again.tournaments.get(old)!.scheduled).toMatchObject({ cancelled: CANCEL_CHANGED });
    // The changed entry opened its own slot (15:00, sign-up from 14:00) once its time came.
    expect(sched.next().next).toMatchObject({ id: null, startsAt: Date.UTC(2026, 9, 22, 15, 0) });
    sched.stop();
    again.stopTimers();

    // The card counts people and agents only.
    const s2 = new Store(null, {}, { clock: new FakeClock(NOON + H) });
    const sc2 = new TournamentScheduler(s2.tournaments, parseSchedule(DAILY, s2.tournaments), null);
    const [id] = [...s2.tournaments.tournaments.keys()];
    s2.tournaments.join(id, 'Ann');
    s2.tournaments.addBots(id, 'zerg', 2);
    expect(sc2.next().next).toMatchObject({ id, entrants: 1 });
    sc2.stop();
    s2.stopTimers();
  });

  it('pre-registration days ahead: no code, but one joiner holds at most 4 open registrations; checks of the window', async () => {
    const t = new Store(null).tournaments;
    expect(parseSchedule({ at: '14:00', signupMinutes: 7 * 24 * 60 }, t)[0]).toMatchObject({ signupMinutes: 10080, checkinMinutes: 10 });
    expect(() => parseSchedule({ at: '14:00', signupMinutes: 10081 }, t)).toThrow(/signupMinutes must be a whole number from 1 to 10080/);
    expect(() => parseSchedule({ at: '14:00', signupMinutes: 5, checkinMinutes: 6 }, t)).toThrow(/checkinMinutes must be a whole number from 1 to 5/);
    expect(parseSchedule({ at: '14:00', signupMinutes: 5 }, t)[0].checkinMinutes).toBe(5);
    // The key keeps its #234 shape, so a deploy does not call off a slot opened before check-in existed.
    expect(parseSchedule(DAILY, t)[0].key).toBe(JSON.stringify({ at: '14:00', signupMinutes: 60, minEntrants: 2, name: 'Daily Nest', roundMinutes: 20, botDelayMs: 2000 }));

    // Sign-up three days ahead: open at once.
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const { call } = await serve(store, { ...DAILY, signupMinutes: 3 * 24 * 60 });
    const id = (await call('/tournaments/next')).body.next.id as string;
    expect(id).toMatch(/^T/);
    for (const n of ['A1', 'A2', 'A3', 'A4']) expect((await call(`/tournaments/${id}/join`, post({ playerName: n }))).status).toBe(201);
    const fifth = await call(`/tournaments/${id}/join`, post({ playerName: 'A5' }));
    expect(fifth.status).toBe(400);
    expect(fifth.body.error).toMatch(/You already hold 4 open registrations/);
    // Another joiner (another IP or MCP session) is not counted; a host-made tournament is never capped.
    expect(store.tournaments.join(id, 'B1', undefined, undefined, 'ip:10.0.0.2').token).toBeTruthy();
    const open = store.tournaments.create({ name: 'Host made', format: 'nested' });
    for (let i = 1; i <= 6; i++) store.tournaments.join(open.id, `H${i}`, undefined, undefined, 'ip:127.0.0.1');
  });

  it('a site-wide cap on pre-registrations a day (fresh MCP sessions are free): 429 past it, back after 24 h', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const { TournamentManager } = await import('../src/tournaments.js');
    const capped = new TournamentManager(store, null, { preregPerDay: 3 }, clock);
    const t = capped.create({ name: 'Daily', format: 'nested', scheduled: { startsAt: NOON + 3 * 24 * H } });
    for (let i = 1; i <= 3; i++) capped.join(t.id, `P${i}`, undefined, undefined, `mcp:session-${i}`);
    expect(() => capped.join(t.id, 'P4', undefined, undefined, 'mcp:session-4')).toThrow(/Too many tournament registrations on this site today \(at most 3 in 24 h\)/);
    // A host-made tournament is not counted; after 24 h there is room again.
    const host = capped.create({ name: 'Host made', format: 'nested' });
    capped.join(host.id, 'H1', undefined, undefined, 'mcp:session-5');
    clock.advance(24 * H);
    expect(capped.join(t.id, 'P4', undefined, undefined, 'mcp:session-4').token).toBeTruthy();
    capped.stopTimers();
    store.stopTimers();
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

    // The reconnect plan: start and check-in in UTC and the user's zone, the code remembered on this connection, the calls.
    const token = store.tournaments.get(id)!.entrants[0].token!;
    const plan = await call('reconnect_prompt', { tournamentId: id, tz: 'America/New_York' });
    expect(plan).toContain(`RECONNECT PLAN for tournament ${id} "Daily Nest"`);
    expect(plan).toContain('Starts: 2026-10-22 14:00 UTC (Thu 22 Oct, 10:00 in America/New_York), by itself.');
    expect(plan).toContain('Check-in: from 2026-10-22 13:50 UTC (Thu 22 Oct, 09:50 in America/New_York), the last 10 minutes.');
    expect(plan).toContain(`Your entrant code (it IS your seat: keep it private, pass it as "token"): ${token}`);
    expect(plan).toContain(`2. wait_for_match {"tournamentId": "${id}", "token": "${token}"}`);
    expect(plan).toContain('ASK YOUR USER: if your client can run scheduled tasks');
    // Text only: asking for the plan at 13:00 checks nobody in; a bad zone is named, not an error.
    expect(store.tournaments.get(id)!.entrants[0].checkedInAt).toBeUndefined();
    expect(await call('reconnect_prompt', { tournamentId: id, tz: 'Mars/Olympus' })).toContain('unknown time zone "Mars/Olympus"');
    // Without a code (a new connection): it says to join first.
    expect(await (async () => {
      const other = new Client({ name: 'other', version: '0' });
      await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const r = ((await other.callTool({ name: 'reconnect_prompt', arguments: { tournamentId: id } })) as { content: { text: string }[] }).content[0].text;
      await other.close();
      return r;
    })()).toContain('join_tournament first');
    await client.close();
  });
});

describe('a slot whose tournament is gone', () => {
  it('moves on when its tournament was called off or deleted before the start (expiry, the admin)', () => {
    for (const end of ['cancel', 'delete'] as const) {
      const clock = new FakeClock(NOON + H); // 13:00: sign-up opens at once
      const store = new Store(null, {}, { clock });
      const sched = new TournamentScheduler(store.tournaments, parseSchedule(DAILY, store.tournaments), null);
      const [id] = [...store.tournaments.tournaments.keys()];
      if (end === 'cancel') store.tournaments.cancel(id, 'expired: never started');
      else store.tournaments.delete(id);
      expect(() => clock.advance(H)).not.toThrow(); // 14:00, the start
      expect(sched.next().next).toMatchObject({ startsAt: Date.UTC(2026, 9, 23, 14, 0) });
      sched.stop();
      store.stopTimers();
    }
  });
});
