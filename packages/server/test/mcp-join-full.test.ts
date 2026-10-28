import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { parseSchedule } from '../src/tournament-schedule.js';
import type { TournamentClock } from '../src/tournaments.js';

const NOON = Date.UTC(2026, 9, 22, 12, 0);
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
}

describe('MCP join into a full scheduled tournament', () => {
  it('a 1v1 full of roster Deloves: join_tournament over /mcp takes a roster seat', async () => {
    const store = new Store(null, {}, { clock: new FakeClock(NOON + 55 * 60_000) });
    const [roster1, roster2, roster3] = store.roster.create('delove@13', 3);
    const risk = createRiskServer(store, {
      clientDir: null,
      sweepIntervalMs: 0,
      seatPoolKey: 'pool-key',
      tournamentSchedule: parseSchedule({ at: '13:00', name: '1v1s', style: '1v1', signupMinutes: 6, checkinMinutes: 6, roster: 3, maxEntrants: 3 }, store.tournaments),
    });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-seat-pool-key': 'pool-key' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'joiner', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const [id] = [...store.tournaments.tournaments.keys()];
      const r = (await call('/seat-requests')).body.requests[0];
      const claim = (await call(`/seat-requests/${r.id}/claim`, { n: 3 })).body;
      expect(claim.roster.map((x: any) => x.rosterId).sort()).toEqual([roster1.id, roster2.id, roster3.id].sort());
      for (const x of claim.roster) expect((await call(`/tournaments/${id}/join`, { seatRequestId: r.id, rosterId: x.rosterId })).status).toBe(201);
      await call(`/seat-requests/${r.id}/done`, { joined: 3 });
      expect(store.tournaments.get(id)!.entrants).toHaveLength(3);
      const res = (await agent.callTool({ name: 'join_tournament', arguments: { tournamentId: id, playerName: 'Visitor' } })) as { content: { text: string }[]; isError?: boolean };
      const text = res.content.map((c) => c.text).join('\n');
      expect(text).not.toMatch(/full|error/i);
      expect(store.tournaments.get(id)!.entrants.map((e) => e.name)).toContain('Visitor');
      expect(store.tournaments.get(id)!.entrants).toHaveLength(3);
    } finally {
      await agent.close();
      await risk.shutdown('test');
    }
  });
});
