import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';

let risk: RiskServer;
let base: string;

async function call(path: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method: opts.body === undefined ? 'GET' : 'POST', headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : {} };
}

beforeEach(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  risk.store.stopTimers();
  await risk.shutdown('test');
});

describe("the host's live entrants list (GET /api/tournaments/:id/entrants)", () => {
  it('counts Zergs, Delove, other agents, humans and open spots, newest first, for the host only, never with tokens', async () => {
    const created = (await call('/tournaments', { body: { format: 'nested', name: 'Live Cup', maxEntrants: 20 } })).body;
    const id = created.tournament.id as string;
    await call(`/tournaments/${id}/bots`, { token: created.hostToken, body: { kind: 'zerg', count: 3 } });
    const tokens: string[] = [];
    for (const [playerName, agent] of [['Ada', undefined], ['Sonnet Seat', 'claude-sonnet-5-5'], ['Boss', 'delove@12']] as const) {
      const r = (await call(`/tournaments/${id}/join`, { body: { playerName, ...(agent ? { agent } : {}) } })).body;
      tokens.push(r.token);
      await new Promise((res) => setTimeout(res, 5)); // distinct join times
    }

    expect((await call(`/tournaments/${id}/entrants`)).status).toBe(401);
    expect((await call(`/tournaments/${id}/entrants`, { token: tokens[0] })).status).toBe(403);
    const r = await call(`/tournaments/${id}/entrants`, { token: created.hostToken });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'registering', maxEntrants: 20, counts: { zergs: 3, delove: 1, agents: 1, humans: 1, bots: 0, open: 14 } });
    expect(r.body.entrants.map((e: { name: string }) => e.name).slice(0, 3)).toEqual(['Boss', 'Sonnet Seat', 'Ada']);
    expect(r.body.entrants.find((e: { name: string }) => e.name === 'Sonnet Seat')).toMatchObject({ kind: 'agent', agent: 'claude-sonnet-5-5', joinedAt: expect.any(Number) });
    expect(r.body.entrants.find((e: { name: string }) => e.name === 'Boss').kind).toBe('delove');
    // Entrant tokens never leave the server.
    for (const t of tokens) expect(r.raw).not.toContain(t);
    expect(r.raw).not.toContain('"token"');

    // A seat the Delove pool joined counts as Delove whatever its label.
    const ada = r.body.entrants.find((e: { name: string }) => e.name === 'Ada').id;
    expect(risk.store.tournaments.hostEntrants(id, new Set([ada])).counts).toMatchObject({ delove: 2, humans: 0 });
  });
});
