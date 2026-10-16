import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';

// Every test server binds 127.0.0.1 on a random high port (port 0).
let dir: string;
let risk: RiskServer;
let base: string;

async function startServer(file: string | null, clientDir?: string) {
  const store = new Store(file);
  const r = createRiskServer(store, { clientDir: clientDir ?? null });
  await new Promise<void>((resolve) => r.server.listen(0, '127.0.0.1', resolve));
  const { port } = r.server.address() as AddressInfo;
  return { risk: r, base: `http://127.0.0.1:${port}` };
}

async function api<T = any>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-test-'));
  ({ risk, base } = await startServer(join(dir, 'games.json')));
});

afterAll(async () => {
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

describe('healthz', () => {
  it('reports ok, version, build and counts', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const h = await res.json();
    expect(h.ok).toBe(true);
    expect(typeof h.version).toBe('string');
    expect(typeof h.build).toBe('string');
    expect(h.build.length).toBeGreaterThan(5);
    expect(h.playing).toBe(0);
    expect(h.games).toBe(0);
    expect(typeof h.connections).toBe('number');
  });
});

describe('game lifecycle over HTTP', () => {
  let gameId: string;
  let token: string;
  let playerId: string;

  it('creates a game', async () => {
    const r = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Alice', gameName: 'test', options: { setupBatch: 40 } }) });
    expect(r.status).toBe(201);
    gameId = r.body.gameId;
    token = r.body.token;
    playerId = r.body.playerId;
    expect(gameId).toMatch(/^[A-Z0-9]{6}$/);
    expect(r.body.state.phase).toBe('lobby');
    const res = await fetch(`${base}/api/games`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects host-only actions without the host token', async () => {
    const r = await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });

  it('adds bots, starts, and counts as playing', async () => {
    expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBe(201);
    expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBe(201);
    const s = await api(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
    expect(s.status).toBe(200);
    expect(s.body.state.phase).toBe('setup');
    expect(risk.health().playing).toBe(1);
  });

  it('long-polls until it is my turn and accepts actions', async () => {
    const w = await api(`/games/${gameId}/wait?timeoutMs=10000`, {}, token);
    expect(['turn', 'finished']).toContain(w.body.reason);
    if (w.body.reason === 'turn') {
      const lm = w.body.state.legal;
      const t = lm.canPlaceOn[0];
      const a = await api(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action: { type: 'place', placements: { [t]: lm.placeLimit } } }) }, token);
      expect(a.status).toBe(200);
      expect(a.body.events.some((e: any) => e.type === 'placed')).toBe(true);
    }
    const bad = await api(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action: { type: 'end_turn' } }) }, token);
    expect(bad.status).toBe(400);
    expect(typeof bad.body.error).toBe('string');
  });

  it('hides other players cards from spectators', async () => {
    const r = await api(`/games/${gameId}`);
    expect(r.status).toBe(200);
    expect(r.body.playerId).toBeNull();
    for (const p of r.body.state.players) expect(p.cards).toBeNull();
    expect(r.body.state.legal).toBeNull();
  });

  it('serves state over WebSocket and acks actions', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId, token, reqId: 'a' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        messages.push(m);
        if (m.type === 'state' && m.reqId === 'a') resolve();
      });
      ws.on('error', reject);
    });
    const first = messages.find((m) => m.type === 'state');
    expect(first.you).toBe(playerId);
    expect(typeof first.commit).toBe('string');
    expect(risk.connections()).toBe(1);
    const ack = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'ack' && m.reqId === 'b') resolve(m);
      });
      ws.send(JSON.stringify({ type: 'action', reqId: 'b', action: { type: 'surrender' } }));
    });
    expect(ack.ok).toBe(true);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('persists games to disk and restores them after a restart', async () => {
    risk.store.save();
    const file = join(dir, 'games.json');
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.some((g: any) => g.id === gameId)).toBe(true);

    // Boot a second instance from the same file: the game (and our token) must come back.
    const second = await startServer(file);
    try {
      const r = await fetch(`${second.base}/api/games/${gameId}?token=${token}`);
      const body = await r.json();
      expect(body.playerId).toBe(playerId);
      expect(body.state.id).toBe(gameId);
    } finally {
      await second.risk.shutdown('test');
    }
  });

  it('shuts down gracefully and releases long-poll waiters', async () => {
    const third = await startServer(null);
    const created = await fetch(`${third.base}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: 'Bob' }),
    }).then((r) => r.json());
    const waiter = fetch(`${third.base}/api/games/${created.gameId}/wait?timeoutMs=30000&token=${created.token}`);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await third.risk.shutdown('test');
    expect(Date.now() - t0).toBeLessThan(5000);
    const res = await waiter.then((r) => r.json()).catch(() => ({ reason: 'disconnected' }));
    expect(['timeout', 'disconnected']).toContain(res.reason);
  });
});

describe('static client caching', () => {
  it('serves index.html with no-cache and hashed assets as immutable when a build exists', async () => {
    const clientDir = join(process.cwd(), '../client/dist');
    if (!existsSync(join(clientDir, 'index.html'))) return; // client not built in this environment
    const s = await startServer(null, clientDir);
    try {
      const index = await fetch(`${s.base}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('cache-control')).toBe('no-cache');
      const deep = await fetch(`${s.base}/?game=ABCDEF`);
      expect(deep.headers.get('cache-control')).toBe('no-cache');
      const html = await index.text();
      const asset = html.match(/assets\/[^"']+\.js/)?.[0];
      expect(asset).toBeTruthy();
      const js = await fetch(`${s.base}/${asset}`);
      expect(js.status).toBe(200);
      expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    } finally {
      await s.risk.shutdown('test');
    }
  });
});

describe('MCP over HTTP (/mcp)', () => {
  it('serves the Risk tools to a Streamable HTTP MCP client and keeps a seat per session', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'test-agent', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['rules', 'create_game', 'join_game', 'wait_for_turn', 'act', 'resume_game']));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };
      const created = await call('create_game', { playerName: 'Remote', options: { setupBatch: 40 } });
      expect(created.isError).toBe(false);
      const gameId = created.text.match(/Created game (\w+)/)![1];
      expect((await call('add_bot', { gameId })).isError).toBe(false);
      const started = await call('start_game', { gameId });
      expect(started.isError).toBe(false);
      expect(started.text).toContain('phase: setup');
      // Turn order is random; wait until it is our turn before expecting legal moves.
      const waited = await call('wait_for_turn', { gameId, timeoutSeconds: 15 });
      expect(waited.text).toMatch(/^It is your turn/);
      const state = await call('get_state', { gameId });
      expect(state.text).toContain('YOUR LEGAL MOVES');
      expect(state.text).toContain('map: Classic World (42)');
      expect(risk.health().mcpSessions).toBe(1);
      // A second, independent session has no seat in that game.
      const other = new Client({ name: 'other', version: '0' });
      await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const denied = (await other.callTool({ name: 'act', arguments: { gameId, action: { type: 'end_turn' } } })) as { isError?: boolean; content: { text: string }[] };
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/Not in this game/);
      await other.close();
    } finally {
      await client.close();
    }
  });
});
