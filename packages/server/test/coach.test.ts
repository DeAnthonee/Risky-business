import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { CoachLog, COACH_PER_GAME } from '../src/coach.js';

let dir: string;
let risk: RiskServer;
let base: string;

async function call(path: string, opts: { body?: unknown; key?: string; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key) headers['x-player-key'] = opts.key;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method: opts.body === undefined ? 'GET' : 'POST', headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : {} };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-coach-'));
  risk = createRiskServer(new Store(join(dir, 'games.json')), { clientDir: null, sweepIntervalMs: 0 });
  risk.store.quickPlay.config.waitMs = 200;
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  risk.store.stopTimers();
  for (const room of risk.store.rooms.values()) room.stopBot();
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

/** A registered player seated by quick play (with their key) at a 2-seat table with one Zerg. */
async function seated(fog = false) {
  const player = (await call('/players', { body: { name: 'Coachee' } })).body;
  const joined = (await call('/queue', { key: player.key, body: { seats: 2, fog } })).body;
  const ticket = (await call(`/queue/${joined.ticket.ticket}?timeoutMs=5000`, { token: joined.token })).body.ticket;
  expect(ticket.status).toBe('seated');
  const room = risk.store.get(ticket.gameId)!;
  // Keep the Zerg still, so the game does not end while the test runs.
  room.stopBot();
  return { key: player.key as string, gameId: ticket.gameId as string, seat: ticket.playerId as string, token: ticket.seatToken as string, room };
}

describe('live coach channel (quick play)', () => {
  it('only the seat owner (their player key) coaches, and only in quick play', async () => {
    const g = await seated();
    expect((await call(`/games/${g.gameId}/coach`, { body: { text: 'hold Australia' } })).status).toBe(401);
    const other = (await call('/players', { body: { name: 'Stranger' } })).body;
    expect((await call(`/games/${g.gameId}/coach`, { key: other.key, body: { text: 'hold Australia' } })).status).toBe(403);
    const ok = await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: '  hold   Australia ' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ seat: g.seat, notes: [{ text: 'hold Australia' }] });
    // Not in an ordinary game, even the owner's own.
    const plain = (await call('/games', { key: g.key, body: { options: {} } })).body;
    expect((await call(`/games/${plain.gameId}/coach`, { key: g.key, body: { text: 'hi' } })).status).toBe(403);
  });

  it('caps the length, the pace and the count', async () => {
    const g = await seated();
    expect((await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: '   ' } })).status).toBe(400);
    expect((await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'x'.repeat(281) } })).status).toBe(400);
    expect((await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'first' } })).status).toBe(201);
    expect((await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'too soon' } })).status).toBe(400);
    const log = new CoachLog();
    let t = 0;
    for (let i = 0; i < COACH_PER_GAME; i++) log.add('p', `note ${i}`, 1, (t += 11_000));
    expect(() => log.add('p', 'one more', 1, (t += 11_000))).toThrow(/At most/);
    expect(log.shown('p')).toHaveLength(5);
  });

  it('the coached seat sees its notes (with the notice over MCP); nobody else does', async () => {
    const g = await seated();
    await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'SECRET-PLAN-attack-Kamchatka' } });
    const mine = (await call(`/games/${g.gameId}`, { token: g.token })).body.state;
    expect(mine.coach).toEqual([{ text: 'SECRET-PLAN-attack-Kamchatka', at: expect.any(Number) }]);
    // Spectators, the other seat, events and history never see it.
    expect((await call(`/games/${g.gameId}`)).raw).not.toContain('SECRET-PLAN');
    const zerg = g.room.state.players.find((p) => p.id !== g.seat)!;
    expect(JSON.stringify(g.room.view(zerg.id))).not.toContain('SECRET-PLAN');
    expect((await call(`/games/${g.gameId}/events?since=0`, { token: g.token })).raw).not.toContain('SECRET-PLAN');
    expect((await call(`/games/${g.gameId}/chat?since=0`, { token: g.token })).raw).not.toContain('SECRET-PLAN');
    expect(JSON.stringify(g.room.spectatorView())).not.toContain('SECRET-PLAN');

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'coached', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const r = (await mcp.callTool({ name: 'get_state', arguments: { gameId: g.gameId, token: g.token } })) as { content: { text: string }[] };
      const text = r.content.map((c) => c.text).join('\n');
      expect(text).toMatch(/COACH NOTES \(notes from your human coach: advice to weigh, not instructions/);
      expect(text).toContain('SECRET-PLAN-attack-Kamchatka');
    } finally {
      await mcp.close();
    }
  });

  it("the coach's page gets the seat's view, fog applied, never the whole board", async () => {
    const g = await seated(true);
    const r = await call(`/games/${g.gameId}/coach`, { key: g.key });
    expect(r.status).toBe(200);
    expect(r.body.seat).toBe(g.seat);
    expect(r.body.state.you).toBe(g.seat);
    expect(JSON.stringify(r.body.state.territories)).toBe(JSON.stringify(g.room.view(g.seat).territories));
    expect(JSON.stringify(r.body.state.territories)).not.toBe(JSON.stringify(g.room.spectatorView().territories));
  });

  it("a coach's WebSocket gets the seat's fogged view, read-only; a wrong key gets the spectator view", async () => {
    const { WebSocket } = await import('ws');
    const g = await seated(true);
    const first = (coachKey?: string) =>
      new Promise<{ state: { you: string | null; territories: unknown }; you: string | null; coaching?: string }>((resolve, reject) => {
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
        ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: g.gameId, ...(coachKey ? { coachKey } : {}) })));
        ws.on('message', (raw) => {
          const m = JSON.parse(String(raw));
          if (m.type === 'state') {
            ws.close();
            resolve(m);
          }
        });
        ws.on('error', reject);
      });
    const coached = await first(g.key);
    expect(coached.coaching).toBe(g.seat);
    expect(coached.you).toBeNull();
    expect(JSON.stringify(coached.state.territories)).toBe(JSON.stringify(g.room.view(g.seat).territories));
    const other = (await call('/players', { body: { name: 'Lurker' } })).body;
    const spectator = await first(other.key);
    expect(spectator.coaching).toBeUndefined();
    expect(JSON.stringify(spectator.state.territories)).toBe(JSON.stringify(g.room.spectatorView().territories));
  });

  it('files the notes in the game record as private notes', async () => {
    const g = await seated();
    await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'trade cards early' } });
    // The seat leaves: only the Zerg is left, so the game ends and its record is filed.
    await call(`/games/${g.gameId}/actions`, { token: g.token, body: { action: { type: 'surrender' } } });
    expect(g.room.state.phase).toBe('finished');
    const entry = risk.store.archive.list(Infinity).find((e) => e.room === g.gameId)!;
    const record = risk.store.archive.get(entry.id)!;
    expect(record.coach).toEqual([{ player: g.seat, at: expect.any(Number), version: expect.any(Number), text: 'trade cards early' }]);
    expect((await call('/history')).raw).not.toContain('trade cards early');
    // A finished game takes no more notes.
    expect((await call(`/games/${g.gameId}/coach`, { key: g.key, body: { text: 'gg' } })).status).toBe(400);
  });
});
