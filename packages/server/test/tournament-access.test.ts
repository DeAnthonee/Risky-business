import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import type { TournamentClock } from '../src/tournaments.js';
import {
  CANCEL_EXPIRED,
  DEFAULT_TOURNEY_ACCESS,
  TESTING_TOURNEY_ACCESS,
  describeTourneyAccess,
  TournamentAccess,
  openModeFromEnv,
  tourneyAccessFromEnv,
  type TourneyAccessConfig,
} from '../src/tournament-access.js';

// Fake codes, set only here. Real values live only in the server's environment.
const ADMIN_CODE = 'test-admin-code';
const LIMITED_CODE = 'test-limited-code';
const CODES = { adminCode: ADMIN_CODE, limitedCode: LIMITED_CODE };

class FakeClock implements TournamentClock {
  t = Date.UTC(2026, 9, 22, 12, 0);
  now = () => this.t;
  setTimeout = (_fn: () => void, _ms: number) => ({});
  clearTimeout = (_h: unknown) => {};
}

const H = 3600_000;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'risk-access-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(config: Partial<TourneyAccessConfig> = {}, file: string | null = null, lag = () => 0) {
  const clock = new FakeClock();
  const store = new Store(null, {}, { clock });
  const access = new TournamentAccess(store.tournaments, { ...CODES, ...config }, file, lag);
  /** One create the way POST /tournaments does it. */
  const create = (code: unknown, spec: Record<string, unknown> = {}, ip = '1.1.1.1', open = false) => {
    const tier = access.hostTier(ip, code, open);
    const t = store.tournaments.create(access.checkCreate(tier, spec));
    access.recordCreate(tier, t.id);
    return t;
  };
  return { clock, store, access, create };
}

/** The status a call throws with (RiskHttpError), or 'ok'. */
function status(fn: () => unknown): number | 'ok' {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
}

describe('hosting codes', () => {
  it('reads every setting from the environment, and open mode defaults off once a code is set', () => {
    // Unset RISK_TOURNEY_STRICT: testing mode (owner, 2026-10-22). STRICT=1: the launch levers.
    expect(tourneyAccessFromEnv({})).toEqual(TESTING_TOURNEY_ACCESS);
    expect(tourneyAccessFromEnv({ RISK_TOURNEY_STRICT: '1' })).toEqual(DEFAULT_TOURNEY_ACCESS);
    const c = tourneyAccessFromEnv({ RISK_TOURNEY_STRICT: '1', RISK_TOURNEY_ADMIN_CODE: ADMIN_CODE, RISK_TOURNEY_LIMITED_PER_DAY: '3', RISK_TOURNEY_MAX_LIVE_SEATS: '90', RISK_TOURNEY_EXPIRE_HOURS: '6', RISK_TOURNEY_MAX_ACTIVE: 'lots' });
    expect(c).toMatchObject({ adminCode: ADMIN_CODE, limitedCode: null, limitedPerDay: 3, maxLiveSeats: 90, expireMs: 6 * H, maxActive: 2 });
    expect(DEFAULT_TOURNEY_ACCESS).toMatchObject({ limitedPerDay: 5, createsPerDay: 20, maxActive: 2, maxActiveLimited: 1, seatsAdmin: 128, seatsLimited: 64, maxLiveSeats: 200, deloveAdmin: 40, deloveLimited: 16, deloveAtOnce: 48, lagBrakeMs: 100 });
    expect(openModeFromEnv({}, { adminCode: null, limitedCode: null })).toBe(true);
    expect(openModeFromEnv({}, { adminCode: null, limitedCode: LIMITED_CODE })).toBe(false);
    expect(openModeFromEnv({ RISK_TOURNAMENTS_OPEN: '1' }, CODES)).toBe(true);
    expect(openModeFromEnv({ RISK_TOURNAMENTS_OPEN: '0' }, { adminCode: null, limitedCode: null })).toBe(false);
  });

  it('needs a code once one is set; a wrong one is refused without saying which code was close', () => {
    const { access, create } = setup();
    expect(status(() => create(undefined))).toBe(401);
    expect(status(() => create('test-admin-cod'))).toBe(403);
    let msg = '';
    try {
      create('test-limited-codf');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('Wrong tournament code');
    expect(access.checkCode('2.2.2.2', ADMIN_CODE)).toBe('admin');
    expect(access.checkCode('2.2.2.2', LIMITED_CODE)).toBe('limited');
    // Open mode lets anyone create without a code, but a code given is still checked.
    expect(access.hostTier('3.3.3.3', undefined, true)).toBe('open');
    expect(status(() => access.hostTier('3.3.3.3', 'nope', true))).toBe(403);
  });

  it('locks an IP out for an hour after 5 wrong codes in 15 minutes, and the whole site after 50 wrong tries in an hour', () => {
    const { clock, access } = setup();
    for (let i = 0; i < 4; i++) expect(status(() => access.checkCode('9.9.9.9', 'bad'))).toBe(403);
    // Spread over more than 15 minutes, the old tries no longer count.
    clock.t += 16 * 60_000;
    expect(status(() => access.checkCode('9.9.9.9', 'bad'))).toBe(403);
    for (let i = 0; i < 3; i++) expect(status(() => access.checkCode('9.9.9.9', 'bad'))).toBe(403);
    expect(status(() => access.checkCode('9.9.9.9', 'bad'))).toBe(429); // the 5th within 15 min
    expect(status(() => access.checkCode('9.9.9.9', ADMIN_CODE))).toBe(429); // even the right code, while locked
    expect(access.checkCode('8.8.8.8', ADMIN_CODE)).toBe('admin'); // other IPs are not locked
    clock.t += H;
    expect(access.checkCode('9.9.9.9', ADMIN_CODE)).toBe('admin');

    const site = setup();
    for (let i = 0; i < 50; i++) expect(status(() => site.access.checkCode(`10.0.${i >> 2}.${i}`, 'bad'))).toBe(403);
    expect(status(() => site.access.checkCode('10.9.9.9', ADMIN_CODE))).toBe(429);
    site.clock.t += H;
    expect(site.access.checkCode('10.9.9.9', ADMIN_CODE)).toBe('admin');
  });

  it('keeps wrong tries and the day\'s counts across a restart, never the codes', () => {
    const file = join(dir, 'access.json');
    const a = setup({}, file);
    for (let i = 0; i < 5; i++) status(() => a.access.checkCode('7.7.7.7', 'bad'));
    a.create(LIMITED_CODE);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(ADMIN_CODE);
    expect(saved).not.toContain(LIMITED_CODE);
    expect(saved).not.toContain('bad');
    const b = new TournamentAccess(a.store.tournaments, CODES, file);
    expect(status(() => b.checkCode('7.7.7.7', ADMIN_CODE))).toBe(429);
    expect(JSON.parse(saved)).toMatchObject({ creates: 1, limited: 1 });
  });
});

describe('testing mode (RISK_TOURNEY_STRICT off)', () => {
  it('loosens the caps and turns the lockout off; each lever still has its own variable', () => {
    const t = tourneyAccessFromEnv({});
    expect(t).toMatchObject({ strict: false, maxActive: 10, maxActiveLimited: 5, createsPerDay: 200, limitedPerDay: 50, maxLiveSeats: 1000, lagBrakeMs: 100, seatsAdmin: 256, seatsLimited: 256, deloveAdmin: 256, deloveLimited: 256, deloveAtOnce: 1000, deloveSearchAtOnce: 20, attempts: { perIp: 0, global: 0 } });
    expect(tourneyAccessFromEnv({ RISK_TOURNEY_STRICT: '1' })).toMatchObject({ seatsAdmin: 128, seatsLimited: 64, maxLiveSeats: 200, deloveLimited: 16, deloveAtOnce: 48 });
    expect(tourneyAccessFromEnv({ RISK_TOURNEY_MAX_ACTIVE: '3', RISK_TOURNEY_ATTEMPTS_PER_IP: '5' })).toMatchObject({ strict: false, maxActive: 3, attempts: { perIp: 5, global: 0 } });
    expect(tourneyAccessFromEnv({ RISK_TOURNEY_STRICT: '1' }).attempts).toMatchObject({ perIp: 5, global: 50 });
    // The startup line names what is set, never a value.
    const line = describeTourneyAccess({ ...t, adminCode: ADMIN_CODE });
    expect(line).toBe('[tourney] codes: admin set, limited unset, strict off');
    expect(line).not.toContain(ADMIN_CODE);
  });

  it("fits the owner's 30 Zergs + 50 Delove + 10 open (90 seats) in open mode", async () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const access = new TournamentAccess(store.tournaments, { ...TESTING_TOURNEY_ACCESS });
    const { SeatRequests } = await import('../src/seat-requests.js');
    const seats = new SeatRequests(store.tournaments, TESTING_TOURNEY_ACCESS, 'test-pool-key');
    const tier = access.hostTier('1.1.1.1', undefined, true);
    const spec = access.checkCreate(tier, { format: 'nested', name: 'Owner test', zergs: 30, delove: 50, open: 10 });
    seats.checkCreate(tier, spec.delove);
    const t = store.tournaments.create(spec);
    expect(t.maxEntrants).toBe(90);
    expect(seats.openFor(t)).toMatchObject({ n: 50 });
    expect(t.entrants.filter((e) => e.kind === 'zerg')).toHaveLength(30);
    store.stopTimers();
  });

  it('never locks anyone out, and drops lockouts saved by a strict run', () => {
    const file = join(dir, 'testing.json');
    const strict = setup({}, file);
    for (let i = 0; i < 5; i++) status(() => strict.access.checkCode('6.6.6.6', 'bad'));
    expect(status(() => strict.access.checkCode('6.6.6.6', ADMIN_CODE))).toBe(429);
    // Back in testing mode: the saved lockout is gone, and 60 wrong codes lock nobody out.
    const testing = new TournamentAccess(strict.store.tournaments, { ...TESTING_TOURNEY_ACCESS, ...CODES }, file);
    expect(testing.checkCode('6.6.6.6', ADMIN_CODE)).toBe('admin');
    for (let i = 0; i < 60; i++) expect(status(() => testing.checkCode('6.6.6.6', 'bad'))).toBe(403);
    expect(testing.checkCode('6.6.6.6', LIMITED_CODE)).toBe('limited');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ byIp: {}, globalFails: [] });
  });

  it('with no codes set on the server, a typed code is ignored: never checked, never counted (owner: no code blocks testing)', () => {
    const { access } = setup({ adminCode: null, limitedCode: null, attempts: { ...DEFAULT_TOURNEY_ACCESS.attempts } });
    // Create: open mode as if no code were given; with open mode off, the usual "host only".
    for (let i = 0; i < 10; i++) expect(access.hostTier('5.5.5.5', 'anything', true)).toBe('open');
    expect(status(() => access.hostTier('5.5.5.5', 'anything', false))).toBe(403);
    expect(access.usable('anything')).toBe(false);
    // Start: open mode lets anyone start while no codes are set; once a code is set, it does not.
    expect(access.openStart(true)).toBe(true);
    expect(access.openStart(false)).toBe(false);
    expect(setup().access.openStart(true)).toBe(false);
  });

  it('with no codes set and open mode on, a typed code is ignored and the create is open', () => {
    const { access } = setup({ adminCode: null, limitedCode: null });
    expect(access.hostTier('5.5.5.5', 'whatever the form sent', true)).toBe('open');
    expect(access.hostTier('5.5.5.5', undefined, true)).toBe('open');
  });

  it('the limited code starts its own tournaments, open-mode ones and ones made before the codes; not the admin code\'s', () => {
    const { store, access, create } = setup({ maxActive: 0, maxActiveLimited: 0 });
    const own = create(LIMITED_CODE, { maxEntrants: 4 });
    const open = create(undefined, { maxEntrants: 4 }, '1.1.1.1', true);
    const before = store.tournaments.create({ name: 'Before codes', maxEntrants: 4 }); // no record: made before the codes
    const admins = create(ADMIN_CODE, { maxEntrants: 4 });
    for (const t of [own, open, before]) expect(access.canStart('4.4.4.4', LIMITED_CODE, t.id), t.name).toBe(true);
    expect(access.canStart('4.4.4.4', LIMITED_CODE, admins.id)).toBe(false);
    expect(access.canStart('4.4.4.4', ADMIN_CODE, admins.id)).toBe(true);
  });
});

describe('caps', () => {
  it('2 tournaments at once, 1 per limited code; the admin key and the schedule still count toward them', () => {
    const { store, create } = setup();
    const first = create(LIMITED_CODE, { maxEntrants: 16 });
    expect(status(() => create(LIMITED_CODE, { maxEntrants: 16 }))).toBe(429); // one limited at once
    // Made with the admin key (or by the schedule): no gate, but it fills the second slot.
    store.tournaments.create({ name: 'Key', maxEntrants: 16 });
    expect(status(() => create(ADMIN_CODE, { maxEntrants: 16 }))).toBe(429); // two at once
    store.tournaments.cancel(first.id, 'test');
    create(LIMITED_CODE, { maxEntrants: 16 }); // a slot is free again
  });

  it('seats: 128 with the admin code, 64 with the limited one, 200 reserved in total', () => {
    const { store, create } = setup({ maxActive: 10, maxActiveLimited: 10 });
    expect(status(() => create(LIMITED_CODE, { maxEntrants: 65 }))).toBe(400);
    // Seat counts (the create form) set the cap to their sum, which must fit the code's seats too.
    expect(status(() => create(LIMITED_CODE, { format: 'nested', zergs: 10, open: 60 }))).toBe(400);
    const counted = create(LIMITED_CODE, { format: 'nested', zergs: 4, open: 4 });
    expect(counted.maxEntrants).toBe(8);
    store.tournaments.delete(counted.id);
    expect(create(LIMITED_CODE, { format: 'nested' }).maxEntrants).toBe(64); // the nested default (128) is capped
    expect(status(() => create(ADMIN_CODE, { maxEntrants: 129 }))).toBe(400);
    const big = create(ADMIN_CODE, { format: 'nested' });
    expect(big.maxEntrants).toBe(128);
    // 64 + 128 reserved: 8 seats are left of 200.
    let msg = '';
    try {
      create(ADMIN_CODE, { maxEntrants: 16 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Only 8 tournament seats are free/);
    create(ADMIN_CODE, { maxEntrants: 8 });
    store.tournaments.delete(big.id);
    create(ADMIN_CODE, { maxEntrants: 100 });
  });

  it('5 creates a UTC day per limited code and 20 site-wide; a new day starts over', () => {
    const { clock, store, create } = setup();
    // Each is called off at once, so only the daily counts can refuse.
    const made = (code: string) => store.tournaments.cancel(create(code, { maxEntrants: 4 }).id, 'test');
    for (let i = 0; i < 5; i++) made(LIMITED_CODE);
    expect(status(() => made(LIMITED_CODE))).toBe(429);
    for (let i = 0; i < 15; i++) made(ADMIN_CODE);
    expect(status(() => made(ADMIN_CODE))).toBe(429); // 20 today, site-wide
    clock.t = Date.UTC(2026, 9, 23, 0, 1);
    made(LIMITED_CODE);
    expect(store.tournaments.tournaments.size).toBe(21);
  });

  it('refuses creates with a clear 503 while the event loop lags past 100 ms', () => {
    let lag = 150;
    const { create } = setup({}, null, () => lag);
    let err: { status?: number; message?: string } = {};
    try {
      create(ADMIN_CODE, { maxEntrants: 8 });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/busy/);
    lag = 40;
    create(ADMIN_CODE, { maxEntrants: 8 });
  });
});

describe('expiry', () => {
  it('calls off a tournament never started 24 h after it was made, and a scheduled one 2 h past its start', () => {
    const { clock, store, access } = setup();
    const plain = store.tournaments.create({ name: 'Plain', maxEntrants: 8 });
    const sched = store.tournaments.create({ name: 'Sched', format: 'nested', scheduled: { startsAt: clock.t + H } });
    clock.t += 3 * H - 1;
    expect(access.expire()).toEqual([]);
    clock.t += 2;
    expect(access.expire()).toEqual([sched.id]);
    expect(sched).toMatchObject({ status: 'finished', scheduled: { cancelled: CANCEL_EXPIRED } });
    clock.t = plain.createdAt + 24 * H + 1;
    expect(access.expire()).toEqual([plain.id]);
    expect(plain.scheduled?.cancelled).toBe(CANCEL_EXPIRED);
    // A started tournament never expires.
    const started = store.tournaments.create({ name: 'Run', maxEntrants: 4 });
    store.tournaments.join(started.id, 'A');
    store.tournaments.join(started.id, 'B');
    store.tournaments.start(started.id);
    clock.t += 48 * H;
    expect(access.expire()).toEqual([]);
    store.stopTimers();
  });
});

describe('over HTTP and MCP', () => {
  it('with no codes set and open mode on: a typed code is ignored, create works, and anyone can start (HTTP and MCP)', async () => {
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, openTournaments: true, tourneyAccess: TESTING_TOURNEY_ACCESS, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'tester', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const made = await call('/tournaments', { name: 'Typed code', maxEntrants: 4, code: 'whatever-the-owner-typed' });
      expect(made.status).toBe(201);
      const id = made.body.tournament.id;
      for (const n of ['A', 'B']) await call(`/tournaments/${id}/join`, { playerName: n });
      expect((await call(`/tournaments/${id}/start`, { code: 'whatever' })).status).toBe(200); // no host token needed
      const second = (await call('/tournaments', { name: 'Second', maxEntrants: 4 })).body.tournament.id;
      for (const n of ['C', 'D']) await call(`/tournaments/${second}/join`, { playerName: n });
      const r = (await agent.callTool({ name: 'start_tournament', arguments: { tournamentId: second, code: 'whatever' } })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toMatch(/Tournament started/);
    } finally {
      await agent.close();
      await risk.shutdown('test');
    }
  });

  it('creates and starts with a code; the limited code starts only its own tournaments', async () => {
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, openTournaments: false, tourneyAccess: { ...CODES, maxActive: 5, maxActiveLimited: 5 }, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const call = async (path: string, body: unknown, token?: string) => {
      const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'host', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    try {
      expect((await call('/tournaments', { name: 'No code' })).status).toBe(401);
      expect((await call('/tournaments', { name: 'Bad', code: 'nope' })).status).toBe(403);
      const lim = await call('/tournaments', { name: 'Lim', maxEntrants: 4, code: LIMITED_CODE });
      expect(lim.status).toBe(201);
      expect(lim.body.tournament.maxEntrants).toBe(4);
      const adm = await call('/tournaments', { name: 'Adm', maxEntrants: 4, code: ADMIN_CODE });
      for (const t of [lim, adm]) for (const n of ['A', 'B']) await call(`/tournaments/${t.body.tournament.id}/join`, { playerName: n });
      // The limited code starts its own tournament, not the admin code's; the admin code starts any.
      expect((await call(`/tournaments/${adm.body.tournament.id}/start`, { code: LIMITED_CODE })).status).toBe(403);
      expect((await call(`/tournaments/${lim.body.tournament.id}/start`, { code: LIMITED_CODE })).status).toBe(200);
      expect((await call(`/tournaments/${adm.body.tournament.id}/start`, { code: ADMIN_CODE })).status).toBe(200);

      // MCP: the same gate.
      expect((await tool('create_tournament', { name: 'M' })).text).toMatch(/needs a tournament code/);
      const made = await tool('create_tournament', { name: 'M', maxEntrants: 4, code: LIMITED_CODE });
      expect(made.isError).toBe(false);
      const id = made.text.match(/Created tournament (\w+)/)![1];
      await tool('join_tournament', { tournamentId: id, playerName: 'C' });
      await tool('join_tournament', { tournamentId: id, playerName: 'D' });
      // Another connection has no host token: a code starts it.
      const other = new Client({ name: 'other', version: '0' });
      await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const start = (await other.callTool({ name: 'start_tournament', arguments: { tournamentId: id, code: ADMIN_CODE } })) as { content: { text: string }[]; isError?: boolean };
      expect(start.isError).toBeFalsy();
      expect(start.content[0].text).toMatch(/Tournament started/);
      await other.close();
    } finally {
      await agent.close();
      await risk.shutdown('test');
    }
  });
});
