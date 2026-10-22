import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import type { TournamentClock } from '../src/tournaments.js';
import { POOL_STALE_MS } from '../src/seat-requests.js';

// Fake values, set only here. Real ones live only in the server's environment.
const POOL_KEY = 'test-pool-key';
const ADMIN = 'test-admin-token';
const ADMIN_CODE = 'test-admin-code';
const LIMITED_CODE = 'test-limited-code';

class FakeClock implements TournamentClock {
  t = Date.UTC(2026, 9, 22, 12, 0);
  now = () => this.t;
  setTimeout = (_fn: () => void, _ms: number) => ({});
  clearTimeout = (_h: unknown) => {};
}

async function serve(seatPoolKey: string | null = POOL_KEY) {
  const clock = new FakeClock();
  const store = new Store(null, {}, { clock });
  const risk = createRiskServer(store, {
    clientDir: null,
    sweepIntervalMs: 0,
    adminToken: ADMIN,
    openTournaments: false,
    seatPoolKey,
    // Only the Delove caps (the other hosting caps are tested in tournament-access.test.ts).
    tourneyAccess: { adminCode: ADMIN_CODE, limitedCode: LIMITED_CODE, maxActive: 0, maxActiveLimited: 0, maxLiveSeats: 0, createsPerDay: 0, lagBrakeMs: 0, deloveAdmin: 40, deloveLimited: 16, deloveAtOnce: 48, deloveSearchAtOnce: 20 },
  });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const asPool = { 'x-seat-pool-key': POOL_KEY };
  return { clock, store, risk, call, asPool, base };
}

describe('Delove seats on request', () => {
  it('the pool needs its key: off without one, 401 without the header, 403 for a wrong one, then a lockout', async () => {
    const off = await serve(null);
    try {
      expect((await off.call('GET', '/seat-requests', undefined, { 'x-seat-pool-key': 'x' })).status).toBe(404);
    } finally {
      await off.risk.shutdown('test');
    }
    const { risk, call, asPool } = await serve();
    try {
      expect((await call('GET', '/seat-requests')).status).toBe(401);
      for (let i = 0; i < 4; i++) expect((await call('GET', '/seat-requests', undefined, { 'x-seat-pool-key': 'nope' })).status).toBe(403);
      expect((await call('GET', '/seat-requests', undefined, { 'x-seat-pool-key': 'nope' })).status).toBe(429);
      expect((await call('GET', '/seat-requests', undefined, asPool)).status).toBe(429); // locked out, even the right key
    } finally {
      await risk.shutdown('test');
    }
  });

  it('a create with Delove seats opens a request; the pool claims, joins over the normal route and reports; the rest become Zergs at the start', async () => {
    const { risk, store, call, asPool } = await serve();
    try {
      const made = await call('POST', '/tournaments', { format: 'nested', name: 'Pool Cup', zergs: 4, delove: 5, open: 3, code: ADMIN_CODE, options: { fogOfWar: false } });
      expect(made.status).toBe(201);
      const id = made.body.tournament.id as string;
      // The pool polls with its free capacity.
      const polled = await call('GET', '/seat-requests?kind=delove&free=12&freeSearch=3', undefined, asPool);
      expect(polled.status).toBe(200);
      expect(polled.body.pool).toMatchObject({ online: true, free: 12, freeSearch: 3 });
      expect(polled.body.requests).toHaveLength(1);
      const req = polled.body.requests[0];
      expect(req).toMatchObject({ tournamentId: id, n: 5, claimed: 0, labelPrefix: 'Delove', fog: false, searchAllowed: true, status: 'open' });
      // Claim 3: what to join, and how many may search.
      const claim = await call('POST', `/seat-requests/${req.id}/claim`, { n: 3 }, asPool);
      expect(claim.status).toBe(200);
      expect(claim.body).toMatchObject({ tournamentId: id, n: 3, search: 3, labelPrefix: 'Delove', firstLabel: 1, options: { fogOfWar: false } });
      expect((await call('POST', `/seat-requests/${req.id}/claim`, { n: 3 }, asPool)).status).toBe(409); // only 2 left
      // The pool joins with the ordinary join route, then reports.
      for (let k = 1; k <= 3; k++) expect((await call('POST', `/tournaments/${id}/join`, { playerName: `Delove ${k}`, agent: 'delove@12' })).status).toBe(201);
      expect((await call('POST', `/seat-requests/${req.id}/done`, { joined: 3 }, asPool)).body.request).toMatchObject({ joined: 3, status: 'open' });
      // The other 2 are claimed and fail: they go back to the request.
      await call('POST', `/seat-requests/${req.id}/claim`, { n: 2 }, asPool);
      expect((await call('POST', `/seat-requests/${req.id}/failed`, { joined: 0, reason: 'out of memory' }, asPool)).body.request).toMatchObject({ claimed: 3, status: 'open', reason: 'out of memory' });
      // At the start the 2 unfilled Delove seats become Zergs: 4 + 2 Zergs, 3 Delove, nobody else.
      const t = store.tournaments.get(id)!;
      expect(t.entrants).toHaveLength(7);
      store.tournaments.start(id);
      expect(t.entrants.filter((e) => e.kind === 'zerg')).toHaveLength(6);
      expect(t.entrants.filter((e) => e.name.startsWith('Delove '))).toHaveLength(3);
      const after = (await call('GET', '/seat-requests', undefined, asPool)).body;
      expect(after.requests).toEqual([]); // closed
      store.stopTimers();
      for (const room of store.rooms.values()) room.stopBot();
    } finally {
      await risk.shutdown('test');
    }
  });

  it('enforces the Delove caps: 40 per tournament with the admin code or key, 16 with the limited code, 48 at once; search only with fog off, 20 at once', async () => {
    const { risk, call, asPool, store } = await serve();
    try {
      expect((await call('POST', '/tournaments', { format: 'nested', delove: 17, open: 2, code: LIMITED_CODE })).status).toBe(400);
      expect((await call('POST', '/tournaments', { format: 'nested', delove: 41, open: 2, code: ADMIN_CODE })).status).toBe(400);
      expect((await call('POST', '/admin/tournaments', { format: 'nested', delove: 41, open: 2 }, { authorization: `Bearer ${ADMIN}` })).status).toBe(400);
      // 30 + 16 = 46 held; 3 more would pass 48.
      expect((await call('POST', '/admin/tournaments', { format: 'nested', delove: 30, open: 2, options: { fogOfWar: false } }, { authorization: `Bearer ${ADMIN}` })).status).toBe(201);
      expect((await call('POST', '/tournaments', { format: 'nested', delove: 16, open: 2, code: LIMITED_CODE, options: { fogOfWar: true } })).status).toBe(201);
      const over = await call('POST', '/tournaments', { format: 'nested', delove: 3, open: 2, code: ADMIN_CODE });
      expect(over.status).toBe(429);
      expect(over.body.error).toMatch(/Only 2 Delove seats are free/);
      const reqs = (await call('GET', '/seat-requests?free=50&freeSearch=50', undefined, asPool)).body.requests as any[];
      const fogOff = reqs.find((r) => r.n === 30);
      const fogOn = reqs.find((r) => r.n === 16);
      expect(fogOn).toMatchObject({ fog: true, searchAllowed: false });
      // Search seats: 20 at once across claims, fog-off requests only.
      expect((await call('POST', `/seat-requests/${fogOff.id}/claim`, { n: 25 }, asPool)).body.search).toBe(20);
      expect((await call('POST', `/seat-requests/${fogOff.id}/claim`, { n: 5 }, asPool)).body.search).toBe(0);
      expect((await call('POST', `/seat-requests/${fogOn.id}/claim`, { n: 4 }, asPool)).body.search).toBe(0);
      store.stopTimers();
    } finally {
      await risk.shutdown('test');
    }
  });

  it('the preview says how many Delove seats the pool has free, or that it is offline (stale after 2 minutes)', async () => {
    const { risk, call, asPool, clock } = await serve();
    try {
      const preview = async () => (await call('POST', '/tournaments/preview', { zergs: 4, delove: 6, open: 2 })).body.preview;
      let p = await preview();
      expect(p.delovePool).toMatchObject({ online: false });
      expect(p.warnings.join(' ')).toMatch(/Delove seat pool offline/);
      await call('GET', '/seat-requests?free=4&freeSearch=0', undefined, asPool);
      p = await preview();
      expect(p.delovePool).toMatchObject({ online: true, free: 4 });
      expect(p.warnings.join(' ')).toMatch(/Delove: 4 seats available now, fewer than the 6 asked for/);
      clock.t += POOL_STALE_MS;
      p = await preview();
      expect(p.delovePool.online).toBe(false);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('an MCP create with Delove seats opens a request too', async () => {
    const { risk, call, asPool, base } = await serve();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'host', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(base.replace(/\/api$/, '/mcp'))));
    try {
      const r = (await agent.callTool({ name: 'create_tournament', arguments: { format: 'nested', name: 'M', zergs: 2, delove: 3, open: 1, code: ADMIN_CODE } })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      const id = /Created tournament (\w+)/.exec(r.content[0].text)![1];
      const reqs = (await call('GET', '/seat-requests', undefined, asPool)).body.requests;
      expect(reqs).toEqual([expect.objectContaining({ tournamentId: id, n: 3 })]);
    } finally {
      await agent.close();
      await risk.shutdown('test');
    }
  });
});
