import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { RateLimiter } from '../src/rate-limit.js';

let risk: RiskServer;
let base: string;

async function api(path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  risk.store.stopTimers();
  for (const room of risk.store.rooms.values()) room.stopBot();
  await risk.shutdown('test');
});

describe('tournament preview (POST /api/tournaments/preview)', () => {
  it('plans 100 seats without creating anything: rounds, tables, finalists, the final board, round-1 seating and a time range', async () => {
    const r = await api('/tournaments/preview', { zergs: 50, delove: 10, open: 40, roundMinutes: 20 });
    expect(r.status).toBe(200);
    const p = r.body.preview;
    expect(p.counts).toEqual({ zergs: 50, delove: 10, open: 40 });
    expect(p.seats).toBe(100);
    expect(p.rounds).toBe(p.tablesPerRound.length);
    expect(p.tablesPerRound.at(-1)).toBe(1);
    expect(p.seatsPerRound[0].reduce((a: number, b: number) => a + b, 0)).toBe(100 + p.plannerZergs);
    expect(p.finalists).toBe(p.seatsPerRound.at(-1)[0]);
    expect(p.finalBoard).toMatchObject({ generated: true, map: null, territories: p.finalists * 5 });
    // #240's seating: 50 people over the round-1 tables, so none is all Zergs.
    expect(p.firstRound).toHaveLength(p.tablesPerRound[0]);
    expect(p.firstRound.every((t: any) => t.people >= 1 && t.people + t.zergs === t.seats)).toBe(true);
    expect(p.timer).toEqual({ mode: 'move', seconds: 90 });
    expect(p.minutes.high).toBe(p.rounds * 20);
    expect(p.minutes.low).toBeGreaterThanOrEqual(p.rounds);
    expect(p.minutes.low).toBeLessThanOrEqual(p.minutes.high);
    expect(p.warnings.join(' ')).toMatch(/Delove seats are stored/);
    // Nothing was created.
    expect((await api('/tournaments')).body.tournaments).toEqual([]);
    expect(risk.store.rooms.size).toBe(0);
  });

  it('a named final board, and fewer people than tables shows the all-bot tables', async () => {
    const p = (await api('/tournaments/preview', { zergs: 16, open: 2, finalMap: 'world' })).body.preview;
    expect(p.finalBoard).toMatchObject({ map: 'world', generated: false });
    expect(p.firstRound.filter((t: any) => t.people === 0).length).toBeGreaterThan(0);
    expect(p.warnings.join(' ')).toMatch(/server bots only/);
  });

  it('checks the request like create does', async () => {
    expect((await api('/tournaments/preview', { zergs: 1 })).status).toBe(400);
    expect((await api('/tournaments/preview', { open: 300 })).status).toBe(400);
    expect((await api('/tournaments/preview', { zergs: -1, open: 4 })).status).toBe(400);
    expect((await api('/tournaments/preview', { open: 8, format: 'knockout' })).status).toBe(400);
    expect((await api('/tournaments/preview', { open: 8, finalMap: 'nowhere' })).status).toBe(400);
    expect((await api('/tournaments/preview', { open: 8, roundMinutes: 999 })).status).toBe(400);
  });

  it('is rate-limited per client (429)', async () => {
    risk.store.tournaments.previewLimiter = new RateLimiter(2, 60_000);
    expect((await api('/tournaments/preview', { open: 8 })).status).toBe(200);
    expect((await api('/tournaments/preview', { open: 8 })).status).toBe(200);
    const over = await api('/tournaments/preview', { open: 8 });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/Too many previews/);
  });
});

describe('create with seat counts', () => {
  it('adds the Zergs at once, stores the Delove count, and caps entrants at the sum', async () => {
    const r = await api('/tournaments', { format: 'nested', name: 'Counts Cup', zergs: 5, delove: 2, open: 3 });
    expect(r.status).toBe(201);
    const t = r.body.tournament;
    expect(t.maxEntrants).toBe(10);
    expect(t.requested).toEqual({ zergs: 5, delove: 2, open: 3 });
    expect(t.entrants).toHaveLength(5);
    expect(t.entrants.every((e: any) => e.isBot)).toBe(true);
    expect(risk.store.tournaments.get(t.id)!.entrants.every((e) => e.kind === 'zerg')).toBe(true);
    // A cap below the counts is refused; no counts keeps the old behaviour.
    expect((await api('/tournaments', { format: 'nested', zergs: 5, open: 5, maxEntrants: 6 })).status).toBe(400);
    const plain = (await api('/tournaments', { format: 'nested' })).body.tournament;
    expect(plain.requested).toBeUndefined();
    expect(plain.entrants).toHaveLength(0);
  });
});

describe('MCP: preview_tournament and create_tournament with counts', () => {
  it('previews as text and creates with the Zergs added', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'preview', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
    try {
      const preview = await call('preview_tournament', { zergs: 30, delove: 4, open: 14 });
      expect(preview).toMatch(/Seats: 48 \(30 Zergs, 4 Delove, 14 open\)/);
      expect(preview).toMatch(/Rounds: \d+; tables per round:/);
      expect(preview).toMatch(/Time: about \d+-\d+ min/);
      expect(preview).toMatch(/Delove seats are stored/);
      expect(risk.store.tournaments.list()).toHaveLength(0);
      const created = await call('create_tournament', { format: 'nested', name: 'Mcp Counts', zergs: 6, open: 4 });
      const id = /Created tournament ([A-Z0-9]+)/.exec(created)![1];
      const t = risk.store.tournaments.get(id)!;
      expect(t.entrants.filter((e) => e.kind === 'zerg')).toHaveLength(6);
      expect(t.maxEntrants).toBe(10);
      const tools = (await mcp.listTools()).tools;
      expect(tools.find((x) => x.name === 'create_tournament')!.description).toMatch(/operator joins them/);
    } finally {
      await mcp.close();
    }
  });
});
