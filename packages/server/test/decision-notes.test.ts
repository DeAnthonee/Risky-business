import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { chooseBotAction, verifyRecord, type GameRecord } from '@risk/engine';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';

const ADMIN = 'notes-admin';
const SECRET = 'NOTE-7f3a-only-for-review';
let dir: string;
let risk: RiskServer;
let base: string;

async function api(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : {} };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-notes-'));
  risk = createRiskServer(new Store(join(dir, 'games.json')), { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

/** A started 2-human game; returns the seat whose turn it is first. */
async function game() {
  const host = (await api('/games', post({ playerName: 'Host', options: { autoSetup: true, maxPlayers: 2 } }))).body;
  const guest = (await api(`/games/${host.gameId}/join`, post({ playerName: 'Guest' }))).body;
  await api(`/games/${host.gameId}/start`, post({}), host.token);
  const room = risk.store.get(host.gameId)!;
  const seats = { [host.playerId]: host.token, [guest.playerId]: guest.token };
  const mover = room.state.currentPlayer!;
  const other = Object.keys(seats).find((id) => id !== mover)!;
  return { id: host.gameId as string, room, mover, moverToken: seats[mover], other, otherToken: seats[other] };
}

describe('decision notes (act with note)', () => {
  it('stores a seated note with its move, and no live output shows it to anyone', async () => {
    const g = await game();
    // A spectator WebSocket and the other seat's WebSocket, listening while the note is sent.
    const listen = (token?: string) =>
      new Promise<{ frames: string[]; close: () => void }>((resolve, reject) => {
        const frames: string[] = [];
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        ws.on('message', (d) => frames.push(String(d)));
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', gameId: g.id, ...(token ? { token } : {}), reqId: 's' }));
          setTimeout(() => resolve({ frames, close: () => ws.close() }), 150);
        });
      });
    const watcher = await listen();
    const rival = await listen(g.otherToken);
    const mine = await listen(g.moverToken);

    const action = chooseBotAction(g.room.state, g.mover)!;
    const acted = await api(`/games/${g.id}/actions`, post({ action, note: { why: SECRET, odds: 0.62 } }), g.moverToken);
    expect(acted.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    // Stored with the move.
    expect(g.room.history.at(-1)).toMatchObject({ action, decisionNote: { why: SECRET, odds: 0.62 } });

    const seen: string[] = [acted.raw, ...watcher.frames, ...rival.frames, ...mine.frames];
    for (const t of [g.moverToken, g.otherToken, undefined]) {
      seen.push((await api(`/games/${g.id}`, {}, t)).raw);
      seen.push((await api(`/games/${g.id}/wait?timeoutMs=0&since=0`, {}, t)).raw);
      seen.push((await api(`/games/${g.id}/events?since=0`, {}, t)).raw);
      seen.push((await api(`/games/${g.id}/chat?since=0`, {}, t)).raw);
    }
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'notes', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((x) => x.text).join('\n');
    try {
      for (const token of [g.moverToken, g.otherToken]) {
        seen.push(await call('get_state', { gameId: g.id, token, format: 'json' }));
        seen.push(await call('get_state', { gameId: g.id, token }));
        seen.push(await call('wait_for_turn', { gameId: g.id, token, timeoutSeconds: 1, sinceVersion: 0 }));
        seen.push(await call('recent_events', { gameId: g.id, token, sinceVersion: 0 }));
      }
      seen.push(await call('spectate_game', { gameId: g.id }));
    } finally {
      await mcp.close();
      for (const l of [watcher, rival, mine]) l.close();
    }
    expect(watcher.frames.some((f) => f.includes('"type":"state"') && f.includes(`"version":${g.room.state.version}`))).toBe(true);
    for (const out of seen) expect(out).not.toContain(SECRET);
  });

  it('takes a plain string over MCP act, and refuses a note over 2 KB (HTTP 400, MCP error)', async () => {
    const g = await game();
    const tooBig = 'x'.repeat(2100);
    const action = chooseBotAction(g.room.state, g.mover)!;
    const r = await api(`/games/${g.id}/actions`, post({ action, note: tooBig }), g.moverToken);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/note is too long/);
    // Nothing was played.
    expect(g.room.history.at(-1)!.decisionNote).toBeUndefined();
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'notes', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const res = (await mcp.callTool({ name: 'act', arguments: { gameId: g.id, token: g.moverToken, action, note: 'took the weak border first' } })) as { isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(g.room.history.at(-1)!.decisionNote).toBe('took the weak border first');
      const big = (await mcp.callTool({ name: 'act', arguments: { gameId: g.id, token: g.moverToken, action: chooseBotAction(g.room.state, g.mover), note: { pad: 'y'.repeat(2100) } } })) as { isError?: boolean };
      expect(big.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it('the finished record carries the note on its step (admin only); it and records without notes verify', async () => {
    const g = await game();
    const action = chooseBotAction(g.room.state, g.mover)!;
    await api(`/games/${g.id}/actions`, post({ action, note: { why: SECRET } }), g.moverToken);
    // The other seat surrenders: the game is over and filed.
    await api(`/games/${g.id}/actions`, post({ action: { type: 'surrender' } }), g.otherToken);
    expect(g.room.state.phase).toBe('finished');
    const entry = (await api('/admin/archive', {}, ADMIN)).body.games[0];
    expect((await api(`/admin/archive/${entry.id}`)).status).toBe(401);
    const record = (await api(`/admin/archive/${entry.id}`, {}, ADMIN)).body as GameRecord;
    const step = record.steps.find((s) => s.note !== undefined)!;
    expect(step).toMatchObject({ player: g.mover, action, note: { why: SECRET } });
    expect(verifyRecord(record)).toBeNull();
    // The public match history never shows it.
    expect((await api('/history')).raw).not.toContain(SECRET);
    // A record written before notes existed (no `note` anywhere) still loads and verifies.
    const file = join(dir, 'archive', entry.file);
    const old = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as GameRecord;
    for (const s of old.steps) delete (s as { note?: unknown }).note;
    writeFileSync(file, gzipSync(JSON.stringify(old)));
    const reloaded = risk.store.archive.get(entry.id)!;
    expect(reloaded.steps.some((s) => s.note !== undefined)).toBe(false);
    expect(verifyRecord(reloaded)).toBeNull();
  });
});
