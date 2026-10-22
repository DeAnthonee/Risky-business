import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Bots move without the 700 ms pause, so the game plays out in the test. Set before the store module loads.
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');
const { HttpRiskApi } = await import('@risk/mcp');

// Labels nobody's name or anything else in a view contains, so finding the text anywhere means a leak.
const SONNET = 'claude-sonnet-5-5';
const HOST = 'human-tester';

let dir: string;
let file: string;
let store: InstanceType<typeof Store>;
let risk: ReturnType<typeof createRiskServer>;
let base: string;

async function api<T = any>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T; raw: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as T, raw };
}

/** Nothing in this response names a player type. */
function noLabels(raw: string) {
  expect(raw).not.toContain('"agent"');
  expect(raw).not.toContain(SONNET);
  expect(raw).not.toContain(HOST);
}

/** The first WebSocket state message for this subscription. */
function wsState(gameId: string, token?: string): Promise<{ raw: string; state: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId, ...(token ? { token } : {}), reqId: 's' })));
    ws.on('message', (data) => {
      const raw = String(data);
      const m = JSON.parse(raw);
      if (m.type !== 'state') return;
      ws.close();
      resolve({ raw, state: m.state });
    });
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-tags-'));
  file = join(dir, 'games.json');
  store = new Store(file);
  risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

describe('player-type labels', () => {
  let gameId: string;
  let hostToken: string;
  let sonnetToken: string;
  let sonnetId: string;

  it('seats declare labels on create and join; seated replies never carry any', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', agent: HOST, options: { autoSetup: true } }) });
    expect(created.status).toBe(201);
    noLabels(created.raw);
    ({ gameId, token: hostToken } = created.body);
    const joined = await api(`/games/${gameId}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Sonnet', agent: SONNET }) });
    expect(joined.status).toBe(201);
    noLabels(joined.raw);
    ({ token: sonnetToken, playerId: sonnetId } = joined.body);
    noLabels((await api(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind: 'zerg' }) }, hostToken)).raw);
    expect((await api(`/games/${gameId}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'X', agent: '<script>' }) })).status).toBe(400);
  });

  it('a spectator sees every label; seated players see none, over HTTP and the WebSocket', async () => {
    const watch = await api(`/games/${gameId}`);
    const byName = Object.fromEntries(watch.body.state.players.map((p: any) => [p.name, p.agent]));
    expect(byName.Host).toBe(HOST);
    expect(byName.Sonnet).toBe(SONNET);
    expect(watch.body.state.players.find((p: any) => p.isBot).agent).toBe('zerg');

    for (const t of [hostToken, sonnetToken]) {
      noLabels((await api(`/games/${gameId}`, {}, t)).raw);
      noLabels((await api(`/games/${gameId}/wait?timeoutMs=0&since=0`, {}, t)).raw);
      noLabels((await api(`/games/${gameId}/events?since=0`, {}, t)).raw);
      noLabels((await wsState(gameId, t)).raw);
    }
    const spectatorWs = await wsState(gameId);
    expect(spectatorWs.state.players.find((p: any) => p.name === 'Sonnet').agent).toBe(SONNET);
    expect((await api(`/games/${gameId}/wait?timeoutMs=0`)).body.state.players.find((p: any) => p.name === 'Host').agent).toBe(HOST);
    // The public game list never has labels.
    noLabels((await api('/games')).raw);
  });

  // The guard for the neutral yardstick protocol: a model at the table must not learn who the others are.
  it('a seated player never gets an agent field anywhere: HTTP GET/wait/events/chat, its WebSocket stream (state and chat), MCP get_state/wait_for_turn', async () => {
    // Every chat message, from a seat and from a watcher, goes through the seat's channels too.
    expect((await api(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message: 'gl hf' }) }, hostToken)).status).toBe(201);
    expect((await api(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message: 'go Sonnet', name: 'Watcher' }) })).status).toBe(201);

    const seen: string[] = [];
    seen.push((await api(`/games/${gameId}`, {}, sonnetToken)).raw);
    seen.push((await api(`/games/${gameId}/wait?timeoutMs=0&since=0`, {}, sonnetToken)).raw);
    seen.push((await api(`/games/${gameId}/events?since=0`, {}, sonnetToken)).raw);
    seen.push((await api(`/games/${gameId}/chat?since=0`, {}, sonnetToken)).raw);

    // The seat's WebSocket: everything it receives after subscribing, including chat history and a live chat line.
    const frames: string[] = await new Promise((resolve, reject) => {
      const got: string[] = [];
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      ws.on('message', (data) => got.push(String(data)));
      ws.on('error', reject);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', gameId, token: sonnetToken, reqId: 's' }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'chat', message: 'my move soon' })), 150);
        setTimeout(() => {
          ws.close();
          resolve(got);
        }, 400);
      });
    });
    expect(frames.some((f) => f.includes('"type":"state"'))).toBe(true);
    expect(frames.some((f) => f.includes('"type":"chat_history"'))).toBe(true);
    expect(frames.some((f) => f.includes('my move soon'))).toBe(true);
    seen.push(...frames);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'seat', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] };
      return r.content.map((x) => x.text).join('\n');
    };
    try {
      seen.push(await call('get_state', { gameId, token: sonnetToken, format: 'json' }));
      seen.push(await call('get_state', { gameId, token: sonnetToken }));
      seen.push(await call('wait_for_turn', { gameId, token: sonnetToken, timeoutSeconds: 1 }));
      seen.push(await call('read_chat', { gameId, token: sonnetToken }));
    } finally {
      await mcp.close();
    }
    expect(seen.join('\n')).toContain('gl hf');
    for (const out of seen) noLabels(out);
  });

  it('the MCP never shows a label, not even to a spectator', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'tags', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return r.content.map((x) => x.text).join('\n');
    };
    try {
      for (const format of ['text', 'json']) {
        for (const out of [await call('get_state', { gameId, token: sonnetToken, format }), await call('spectate_game', { gameId, format })]) {
          expect(out).toContain('Sonnet');
          noLabels(out);
        }
      }
      const waited = await call('wait_for_turn', { gameId, token: sonnetToken, timeoutSeconds: 1 });
      expect(waited).toContain('Sonnet');
      noLabels(waited);
    } finally {
      await agent.close();
    }
    // The stdio MCP talks HTTP: a tokenless read there would be a spectator's, so it drops the labels itself.
    const http = new HttpRiskApi(base);
    noLabels(JSON.stringify(await http.getGame(gameId)));
  });

  it('labels survive a restart, and the finished record carries them', async () => {
    const room = store.get(gameId)!;
    const finished = new Promise<void>((resolve) => room.on('change', () => room.state.phase === 'finished' && resolve()));
    expect((await api(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, hostToken)).status).toBe(200);
    // While the game runs, the seated players' replies still have no labels.
    noLabels((await api(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action: { type: 'surrender' } }) }, sonnetToken)).raw);
    store.save();
    const again = new Store(file);
    expect(again.get(gameId)!.agents).toEqual(room.agents);
    again.stopTimers();
    await api(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action: { type: 'surrender' } }) }, hostToken);
    await finished;

    const [entry] = store.archive.list();
    expect(entry.room).toBe(gameId);
    expect(Object.fromEntries(entry.players.map((p) => [p.name, p.agent]))).toMatchObject({ Host: HOST, Sonnet: SONNET });
    expect(store.archive.get(entry.id)!.room.agents?.[sonnetId]).toBe(SONNET);
    const history = await api('/history');
    expect(history.body.games[0].players.find((p: any) => p.name === 'Sonnet').agent).toBe(SONNET);
  }, 30_000);
});
