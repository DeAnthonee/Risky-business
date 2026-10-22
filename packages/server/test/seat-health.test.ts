import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { LocalRiskApi } from '../src/local-api.js';
import { DEFAULT_DISCONNECT, disconnectConfigFromEnv, disconnectIdleMs } from '../src/seat-health.js';

/** A knockout tournament with one table of `names`, a per-move timer of 30 s, the game started; bots held still. */
function table(names: string[]) {
  const store = new Store(null);
  const t = store.tournaments.create({ name: 'Drop Cup', groupSize: names.length, maxEntrants: names.length, fillBots: false, options: { map: 'classic', autoSetup: true, turnTimer: 'move', turnTimerSeconds: 30 } });
  const ids = names.map((n) => store.tournaments.join(t.id, n).entrantId);
  store.tournaments.start(t.id);
  const m = t.rounds[0].matches[0];
  const room = store.get(m.gameId!)!;
  room.stopBot();
  const seat = (name: string) => m.seats[ids[names.indexOf(name)]];
  const entrant = (name: string) => t.entrants.find((e) => e.id === ids[names.indexOf(name)])!;
  return { store, t, m, room, seat, entrant };
}

/** Let the clock run out on whoever is to move until it is `name`'s decision, then time `name` out once. */
function timeOut(ctx: ReturnType<typeof table>, name: string) {
  const pid = ctx.seat(name).playerId;
  // The other seats are present (they poll), so only `name` can be dropped here.
  const others = Object.values(ctx.m.seats).filter((s) => s.playerId !== pid);
  for (let i = 0; i < 50 && ctx.room.state.currentPlayer !== pid; i++) {
    for (const s of others) ctx.room.playerForToken(s.token);
    ctx.room.expireTurn();
  }
  expect(ctx.room.state.currentPlayer).toBe(pid);
  ctx.room.expireTurn();
}

afterEach(() => vi.useRealTimers());

describe('disconnect thresholds', () => {
  it('a seat is disconnected after 2 timeouts in a row and max(2 x the move timer, 180 s) of silence; env-tunable', () => {
    expect(DEFAULT_DISCONNECT).toEqual({ timeouts: 2, timerFactor: 2, idleFloorMs: 180_000 });
    expect(disconnectIdleMs(30)).toBe(180_000);
    expect(disconnectIdleMs(120)).toBe(240_000);
    expect(disconnectConfigFromEnv({ RISK_DISCONNECT_TIMEOUTS: '3', RISK_DISCONNECT_IDLE_S: '60' })).toMatchObject({ timeouts: 3, idleFloorMs: 60_000 });
  });
});

describe('dropping a disconnected seat at a tournament table', () => {
  it('a model that is thinking (any request with its token) is never dropped, however many timeouts', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = table(['Ann', 'Bob']);
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      ctx.room.playerForToken(ctx.seat('Ann').token); // get_state, wait_for_turn, chat...
      timeOut(ctx, 'Ann');
    }
    expect(ctx.entrant('Ann').dropped).toBeUndefined();
    expect(ctx.room.state.players.find((p) => p.id === ctx.seat('Ann').playerId)).toMatchObject({ name: 'Ann', isBot: false });
    ctx.store.stopTimers();
  });

  it('one timeout and silence is not enough; a second in a row drops the seat: the house bot plays it as "<name>-bot"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = table(['Ann', 'Bob']);
    const risk = createRiskServer(ctx.store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      timeOut(ctx, 'Ann');
      expect(ctx.entrant('Ann').dropped).toBeUndefined();
      // A move of Bob's in between does not reset Ann's run; only Ann's own move would.
      timeOut(ctx, 'Ann');
      const seat = ctx.room.state.players.find((p) => p.id === ctx.seat('Ann').playerId)!;
      expect(seat).toMatchObject({ name: 'Ann-bot', isBot: true });
      expect(ctx.entrant('Ann').dropped).toMatchObject({ reason: 'disconnected', standIn: 'Ann-bot' });
      expect(ctx.room.history.some((h) => h.action.type === 'system' && /dropped \(disconnected\)/.test((h.action as { note: string }).note))).toBe(true);
      // The old token says why, over HTTP (410) and MCP.
      const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/games/${ctx.room.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.seat('Ann').token}` }, body: JSON.stringify({ action: { type: 'end_turn' } }) });
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: string }).error).toMatch(/dropped from this table \(disconnected\)/);
      const mcp = new LocalRiskApi(ctx.store, risk.characters);
      await expect(mcp.act(ctx.room.id, ctx.seat('Ann').token, { type: 'end_turn' })).rejects.toMatchObject({ status: 410 });
      // The bracket shows it, and the stand-in plays on: the house bot moves the seat.
      expect(ctx.store.tournaments.view(ctx.t.id).entrants.find((e) => e.name === 'Ann')).toMatchObject({ status: 'dropped', dropped: { reason: 'disconnected', standIn: 'Ann-bot' } });
      for (let i = 0; i < 50 && ctx.room.state.currentPlayer !== seat.id; i++) ctx.room.expireTurn();
      const v = ctx.room.state.version;
      expect(ctx.room.stepBot()).toBe(true);
      expect(ctx.room.state.version).toBeGreaterThan(v);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('never at a table outside a tournament, and never for bots', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new Store(null);
    const { room, playerId: a } = store.create('Plain', { map: 'classic', maxPlayers: 2, autoSetup: true, turnTimer: 'move', turnTimerSeconds: 30 }, 'Ann');
    room.join('Bob');
    room.start();
    room.stopBot();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    for (let i = 0; i < 6; i++) room.expireTurn();
    expect(room.state.players.find((p) => p.id === a)).toMatchObject({ name: 'Ann', isBot: false });
    store.stopTimers();
  });

  it('a stand-in can win the table but never moves on: the best other seat by standing does, as decided', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = table(['Ann', 'Bob', 'Cat']);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    timeOut(ctx, 'Ann');
    timeOut(ctx, 'Ann');
    expect(ctx.entrant('Ann').dropped).toBeDefined();
    // Bob goes out first, then Cat: Ann's stand-in wins the game.
    for (const name of ['Bob', 'Cat']) ctx.room.act(ctx.seat(name).playerId, { type: 'surrender' });
    expect(ctx.room.state.winner).toBe(ctx.seat('Ann').playerId);
    expect(ctx.m.status).toBe('decided');
    expect(ctx.m.winner).toBe(ctx.entrant('Cat').id); // the last one out: the best other seat by standing
    expect(ctx.m.standing!.order[0]).toBe(ctx.entrant('Ann').id);
    expect(ctx.t.champion).toBe(ctx.entrant('Cat').id); // a one-table knockout: the table's winner is the champion
    ctx.store.stopTimers();
  });
});

describe('the Delove seat pool takes a dropped seat over (step B)', () => {
  async function withPool() {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ctx = table(['Ann', 'Bob']);
    const risk = createRiskServer(ctx.store, { clientDir: null, sweepIntervalMs: 0, seatPoolKey: 'test-pool-key' });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-seat-pool-key': 'test-pool-key' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json()) as any };
    };
    vi.setSystemTime(Date.now() + 10 * 60_000);
    timeOut(ctx, 'Ann');
    timeOut(ctx, 'Ann');
    const seat = () => ctx.room.state.players.find((p) => p.id === ctx.seat('Ann').playerId)!;
    expect(seat()).toMatchObject({ name: 'Ann-bot', isBot: true });
    return { ctx, risk, call, seat };
  }

  it('opens a takeover request (only for a pool that asks for takeovers); a claim hands it the seat as "<name>-Delove" with a token', async () => {
    const { ctx, risk, call, seat } = await withPool();
    try {
      expect((await call('GET', '/seat-requests?kind=delove')).body.requests).toEqual([]); // an older pool never sees one
      const reqs = (await call('GET', '/seat-requests?kind=delove&modes=takeover')).body.requests;
      expect(reqs).toEqual([expect.objectContaining({ mode: 'takeover', n: 1, takeover: { gameId: ctx.room.id, playerId: seat().id, name: 'Ann' } })]);
      const claim = await call('POST', `/seat-requests/${reqs[0].id}/claim`, {});
      expect(claim.status).toBe(200);
      expect(claim.body).toMatchObject({ mode: 'takeover', gameId: ctx.room.id, playerId: seat().id, n: 1, token: expect.any(String) });
      expect(seat()).toMatchObject({ name: 'Ann-Delove', isBot: false });
      expect(ctx.room.agents[seat().id]).toBe('delove');
      // The pool plays the existing seat with that token, through the ordinary game API.
      const game = await call('GET', `/games/${ctx.room.id}`, undefined, claim.body.token);
      expect(game.body.playerId).toBe(seat().id);
      expect((await call('POST', `/seat-requests/${reqs[0].id}/claim`, {})).status).toBe(409); // taken
      // The old player's token still gets the 410; the entrant stays dropped (a stand-in never moves on).
      expect((await call('POST', `/games/${ctx.room.id}/actions`, { action: { type: 'end_turn' } }, ctx.seat('Ann').token)).status).toBe(410);
      expect(ctx.entrant('Ann').dropped).toBeDefined();
    } finally {
      await risk.shutdown('test');
    }
  });

  it('a failed takeover goes back to the house bot, with no second request', async () => {
    const { ctx, risk, call, seat } = await withPool();
    try {
      const req = (await call('GET', '/seat-requests?modes=takeover')).body.requests[0];
      const claim = await call('POST', `/seat-requests/${req.id}/claim`, {});
      expect((await call('POST', `/seat-requests/${req.id}/failed`, { joined: 0, reason: 'no model loaded' })).body.request).toMatchObject({ status: 'failed' });
      expect(seat()).toMatchObject({ name: 'Ann-bot', isBot: true });
      expect((await call('POST', `/games/${ctx.room.id}/actions`, { action: { type: 'end_turn' } }, claim.body.token)).status).toBe(410); // the pool's token no longer plays
      expect((await call('GET', '/seat-requests?modes=takeover')).body.requests).toEqual([]);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('a Delove stand-in that goes silent is dropped like anyone: back to the house bot, no second request', async () => {
    const { ctx, risk, call, seat } = await withPool();
    try {
      const req = (await call('GET', '/seat-requests?modes=takeover')).body.requests[0];
      await call('POST', `/seat-requests/${req.id}/claim`, {});
      expect(seat()).toMatchObject({ name: 'Ann-Delove', isBot: false });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      timeOut(ctx, 'Ann');
      timeOut(ctx, 'Ann');
      expect(seat()).toMatchObject({ name: 'Ann-bot', isBot: true });
      expect((await call('GET', '/seat-requests?modes=takeover')).body.requests).toEqual([]);
    } finally {
      await risk.shutdown('test');
    }
  });
});
