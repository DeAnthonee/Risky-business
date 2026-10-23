import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';

// The setup prompt a registered entrant pastes into their AI (owner's decision 1 on the daily tournament): shown once
// on the site after registering, built by GET /api/tournaments/:id/setup.
let risk: RiskServer;
let base: string;

beforeAll(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await risk.shutdown('test');
});

const call = async (path: string, init: RequestInit & { token?: string; key?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.key) headers['x-player-key'] = init.key;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as any };
};

describe('the setup prompt (GET /api/tournaments/:id/setup)', () => {
  it('walks the AI through connecting, the player key, the seat code and number, check-in and the calls', async () => {
    const startsAt = Date.UTC(2030, 0, 15, 3, 0); // 19:00 the day before in Los Angeles (winter time)
    const t = risk.store.tournaments.create({ name: 'Daily Nest', format: 'nested', scheduled: { startsAt, checkinMinutes: 10 } });
    const player = await call('/players', { method: 'POST', body: JSON.stringify({ name: 'Dee' }) });
    expect(player.status).toBe(201);
    const key = player.body.key as string;
    const joined = await call(`/tournaments/${t.id}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'ignored' }), key });
    expect(joined.status).toBe(201);
    const { token, entrantId } = joined.body;

    const r = await call(`/tournaments/${t.id}/setup?tz=America/Los_Angeles`, { token, key });
    expect(r.status).toBe(200);
    expect(r.body.filename).toBe(`risky-business-${t.id}-seat.txt`);
    const text = r.body.text as string;
    expect(text).toContain(`RISKY BUSINESS: YOUR SEAT IN "Daily Nest" (${t.id})`);
    expect(text).toContain("I'm Dee.");
    expect(text).toContain('WHEN: it starts 2030-01-15 03:00 UTC (Mon 14 Jan, 19:00 in America/Los_Angeles), by itself.');
    expect(text).toContain('CHECK-IN: from 2030-01-15 02:50 UTC (Mon 14 Jan, 18:50 in America/Los_Angeles), the last 10 minutes');
    expect(text).toContain('REMEMBER THESE AT ALL COST');
    expect(text).toContain(`- Player key: ${key}`);
    expect(text).toContain(`- Seat code: ${token}`);
    expect(text).toContain(`- Seat number: ${entrantId} (my name in this tournament: Dee)`);
    expect(text).toContain(`${base}/mcp`);
    expect(text).toContain(`use_player_key {"key": "${key}"}`);
    expect(text).toContain(`wait_for_match {"tournamentId": "${t.id}", "token": "${token}"}`);
    expect(text).toContain('Do NOT call join_tournament');
    expect(text).toContain(`reconnect_prompt {"tournamentId": "${t.id}", "token": "${token}"}`);
  });

  it('gives the key back only to its own holder; without one, no key lines', async () => {
    const t = risk.store.tournaments.create({ name: 'Open Cup', format: 'nested' });
    const { token } = (await call(`/tournaments/${t.id}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Ann' }) })).body;
    const plain = (await call(`/tournaments/${t.id}/setup`, { token })).body.text as string;
    expect(plain).not.toContain('Player key:');
    expect(plain).toContain('STEP 2: (no player key: skip.)');
    expect(plain).toContain('WHEN: the host starts it');
    // Someone else's valid key does not get echoed into Ann's seat text.
    const other = (await call('/players', { method: 'POST', body: JSON.stringify({ name: 'Other' }) })).body.key as string;
    expect(((await call(`/tournaments/${t.id}/setup`, { token, key: other })).body.text as string)).not.toContain(other);
  });

  it('needs the seat code: none is 401, a wrong one 400, an unknown tournament 404', async () => {
    const t = risk.store.tournaments.create({ name: 'Closed', format: 'nested' });
    expect((await call(`/tournaments/${t.id}/setup`)).status).toBe(401);
    expect((await call(`/tournaments/${t.id}/setup`, { token: 'nope' })).status).toBe(400);
    expect((await call('/tournaments/TNONE1/setup', { token: 'x' })).status).toBe(404);
  });
});
