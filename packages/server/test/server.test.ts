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

async function startServer(file: string | null, clientDir?: string, adminToken?: string) {
  const store = new Store(file);
  const r = createRiskServer(store, { clientDir: clientDir ?? null, adminToken, sweepIntervalMs: 0 });
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

  it('lets a player rename themselves in the lobby', async () => {
    const r = await api(`/games/${gameId}/name`, { method: 'POST', body: JSON.stringify({ name: 'Dean' }) }, token);
    expect(r.status).toBe(200);
    expect(r.body.state.players.find((p: any) => p.id === playerId).name).toBe('Dean');
    const anon = await api(`/games/${gameId}/name`, { method: 'POST', body: JSON.stringify({ name: 'X' }) });
    expect(anon.status).toBe(401);
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

  it('gives spectators every hand but no legal moves; players see only their own hand', async () => {
    const r = await api(`/games/${gameId}`);
    expect(r.status).toBe(200);
    expect(r.body.playerId).toBeNull();
    for (const p of r.body.state.players) expect(Array.isArray(p.cards)).toBe(true);
    expect(r.body.state.legal).toBeNull();
    const mine = await api(`/games/${gameId}`, {}, token);
    for (const p of mine.body.state.players) expect(p.cards === null || p.id === playerId).toBe(true);
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

  it('reports spectators and online players over WebSocket', async () => {
    const open = (token?: string) =>
      new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        const messages: any[] = [];
        ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', gameId, token }));
          setTimeout(() => resolve({ ws, messages }), 150);
        });
        ws.on('error', reject);
      });
    const player = await open(token);
    const watcher = await open();
    await new Promise((r) => setTimeout(r, 150));
    const last = (ms: any[]) => [...ms].reverse().find((m) => m.type === 'presence');
    expect(last(player.messages)).toEqual({ type: 'presence', spectators: 1, online: [playerId] });
    expect(last(watcher.messages)).toEqual({ type: 'presence', spectators: 1, online: [playerId] });
    // Spectators get a redacted view and cannot act.
    const view = [...watcher.messages].reverse().find((m) => m.type === 'state');
    expect(view.you).toBeNull();
    watcher.ws.send(JSON.stringify({ type: 'action', reqId: 'x', action: { type: 'end_turn' } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(watcher.messages.find((m) => m.type === 'ack' && m.reqId === 'x')?.ok).toBe(false);
    watcher.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(last(player.messages)).toEqual({ type: 'presence', spectators: 0, online: [playerId] });
    player.ws.close();
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

  it('backfills the map option for games saved by older builds', async () => {
    const file = join(dir, 'legacy.json');
    risk.store.save();
    const saved = JSON.parse(readFileSync(join(dir, 'games.json'), 'utf8')) as any[];
    for (const g of saved) delete g.state.options.map;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(saved));
    const legacy = await startServer(file);
    try {
      const room = legacy.risk.store.get(gameId)!;
      expect(room.state.options.map).toBe('classic');
      // Option changes on a legacy lobby must not throw "Unknown map".
      const lobby = await fetch(`${legacy.base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerName: 'L' }) }).then((r) => r.json());
      const lobbyRoom = legacy.risk.store.get(lobby.gameId)!;
      delete (lobbyRoom.state.options as any).map;
      lobbyRoom.state.options.map = 'classic';
      lobbyRoom.setOptions({ setupBatch: 3 });
      expect(lobbyRoom.state.options.setupBatch).toBe(3);
    } finally {
      await legacy.risk.shutdown('test');
    }
  });

  it('creates a game with blizzards over HTTP and backfills them for older saves', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Ice', options: { blizzards: 4, setupBatch: 40 } }) });
    expect(created.status).toBe(201);
    expect(created.body.state.options.blizzards).toBe(4);
    const tooMany = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Ice', options: { blizzards: 30 } }) });
    expect(tooMany.status).toBe(400);
    const bot = await api(`/games/${created.body.gameId}/bots`, { method: 'POST', body: '{}' }, created.body.token);
    expect(bot.status).toBeLessThan(300);
    const started = await api(`/games/${created.body.gameId}/start`, { method: 'POST', body: '{}' }, created.body.token);
    expect(started.status).toBe(200);
    expect(started.body.state.blizzards).toHaveLength(4);
    for (const t of started.body.state.blizzards) expect(started.body.state.territories[t].owner).toBeNull();

    risk.store.save();
    const saved = JSON.parse(readFileSync(join(dir, 'games.json'), 'utf8')) as any[];
    for (const g of saved) {
      delete g.state.options.blizzards;
      delete g.state.blizzards;
    }
    const file = join(dir, 'pre-blizzard.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(saved));
    const legacy = await startServer(file);
    try {
      const room = legacy.risk.store.get(gameId)!;
      expect(room.state.options.blizzards).toBe(0);
      expect(room.state.blizzards).toEqual([]);
    } finally {
      await legacy.risk.shutdown('test');
    }
  });

  it('creates a 3-player game with neutral territories over HTTP and backfills older saves', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'N', options: { neutrals: 6, neutralArmies: 4 } }) });
    expect(created.status).toBe(201);
    expect(created.body.state.options.neutrals).toBe(6);
    const bad = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'N', options: { neutrals: 99 } }) });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 2; i++) await api(`/games/${created.body.gameId}/bots`, { method: 'POST', body: '{}' }, created.body.token);
    const started = await api(`/games/${created.body.gameId}/start`, { method: 'POST', body: '{}' }, created.body.token);
    expect(started.status).toBe(200);
    const terr = Object.values(started.body.state.territories) as any[];
    expect(terr.filter((t) => t.owner === 'neutral')).toHaveLength(6);
    expect(terr.filter((t) => t.owner === 'neutral').every((t) => t.armies === 4)).toBe(true);

    risk.store.save();
    const saved = JSON.parse(readFileSync(join(dir, 'games.json'), 'utf8')) as any[];
    for (const g of saved) {
      delete g.state.options.neutrals;
      delete g.state.options.neutralArmies;
    }
    const file = join(dir, 'pre-neutrals.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(saved));
    const legacy = await startServer(file);
    try {
      const room = legacy.risk.store.get(gameId)!;
      expect(room.state.options.neutrals).toBe(0);
      expect(room.state.options.neutralArmies).toBe(2);
    } finally {
      await legacy.risk.shutdown('test');
    }
  });

  it('lets spectators chat over HTTP and WebSocket, guarded and hidden from players under fog', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { setupBatch: 40 } }) });
    const g = created.body.gameId;
    const hostToken = created.body.token;

    // HTTP: no token = spectator, marked, and cannot pose as a player.
    const fan = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'go host!', name: 'Fan' }) });
    expect(fan.status).toBe(201);
    expect(fan.body.message).toMatchObject({ spectator: true, playerId: null, name: 'Fan' });
    const poser = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi', name: 'host' }) });
    expect(poser.body.message.name).toBe('host (fan)');
    const player = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'thanks' }) }, hostToken);
    expect(player.body.message.spectator).toBeUndefined();

    // Flood guard: 5 per 10 s per sender (two already sent from this IP).
    for (let i = 0; i < 3; i++) expect((await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: `m${i}`, name: 'Fan' }) })).status).toBe(201);
    expect((await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'too many', name: 'Fan' }) })).status).toBe(400);

    // Fog of war: spectators are still heard by every player (they're meant to stir things up).
    const fogGame = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'P', options: { fogOfWar: true } }) });
    const fg = fogGame.body.gameId;
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const wsMsgs: any[] = [];
    ws.on('message', (raw) => wsMsgs.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'subscribe', gameId: fg, reqId: 's' }));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(JSON.stringify({ type: 'chat', message: 'Alaska is empty!', name: 'Leaky', reqId: 'c1' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(wsMsgs.find((m) => m.type === 'ack' && m.reqId === 'c1')?.ok).toBe(true);
    expect(wsMsgs.some((m) => m.type === 'chat' && m.message.name === 'Leaky' && m.message.spectator)).toBe(true);
    ws.close();
    const asPlayer = await api(`/games/${fg}/chat`, {}, fogGame.body.token);
    expect(asPlayer.body.messages.some((m: any) => m.spectator && m.name === 'Leaky')).toBe(true);
    const asWatcher = await api(`/games/${fg}/chat`);
    expect(asWatcher.body.messages.some((m: any) => m.name === 'Leaky')).toBe(true);

    // Host can turn it off.
    const quiet = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Q', options: { spectatorChat: false } }) });
    const off = await api(`/games/${quiet.body.gameId}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hello', name: 'X' }) });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/turned off/);
  });

  it('routes whispers by id first, rejects ambiguous names, and refuses unknown tokens on read', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Ann' }) });
    const g = created.body.gameId;
    const ann = created.body.token;
    const bobJoin = (await api(`/games/${g}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Bob' }) })).body;
    const bob = bobJoin.token;
    const bobId = bobJoin.playerId;
    // Ann sits before Bob and renames herself to Bob's id to try to intercept whispers meant for Bob.
    const mal = (await api(`/games/${g}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Mal' }) })).body.token;
    expect((await api(`/games/${g}/name`, { method: 'POST', body: JSON.stringify({ name: bobId }) }, ann)).status).toBeLessThan(300);
    const w = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'for Bob only', to: bobId }) }, mal);
    expect(w.status).toBe(201);
    expect(w.body.message.to).toBe(bobId);
    const annRead = await api(`/games/${g}/chat`, {}, ann);
    expect(annRead.body.messages.some((m: any) => m.message === 'for Bob only')).toBe(false);

    // Two players with the same name: a whisper by that name is ambiguous.
    expect((await api(`/games/${g}/name`, { method: 'POST', body: JSON.stringify({ name: 'Bob' }) }, mal)).status).toBeLessThan(300);
    const amb = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'which Bob?', to: 'bob' }) }, ann);
    expect(amb.status).toBe(400);
    expect(amb.body.error).toMatch(/player id/);

    // A token that is not a seat here does not silently read the spectator view (which shows all whispers).
    const bad = await api(`/games/${g}/chat`, {}, 'not-a-real-token');
    expect(bad.status).toBe(401);
    expect((await api(`/games/${g}/chat`, {}, bob)).body.messages.some((m: any) => m.message === 'for Bob only')).toBe(true);
  });

  it('delivers whispers to the two players and spectators only', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Ann' }) });
    const g = created.body.gameId;
    const ann = created.body.token;
    const bob = (await api(`/games/${g}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Bob' }) })).body.token;
    const cat = (await api(`/games/${g}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Cat' }) })).body.token;

    // Cat (a third player) and a spectator listen over WebSocket.
    const listen = async (token?: string) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      const msgs: any[] = [];
      ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      ws.send(JSON.stringify({ type: 'subscribe', gameId: g, token }));
      await new Promise((r) => setTimeout(r, 100));
      return { ws, chats: () => msgs.filter((m) => m.type === 'chat').map((m) => m.message.message), msgs };
    };
    const catWs = await listen(cat);
    const fanWs = await listen();

    // By name (any case) over HTTP; by id over WebSocket.
    const w = await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'ally vs Cat?', to: 'bob' }) }, ann);
    expect(w.status).toBe(201);
    expect(w.body.message).toMatchObject({ to: expect.any(String), toName: 'Bob' });
    const bobId = w.body.message.to;
    const annWs = await listen(ann);
    annWs.ws.send(JSON.stringify({ type: 'chat', message: 'deal?', to: bobId, reqId: 'w2' }));
    await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hello all' }) }, bob);
    await new Promise((r) => setTimeout(r, 150));
    expect(annWs.msgs.find((m) => m.reqId === 'w2')?.ok).toBe(true);

    const read = async (token?: string) => (await api(`/games/${g}/chat`, {}, token)).body.messages.map((m: any) => m.message);
    expect(await read(ann)).toEqual(['ally vs Cat?', 'deal?', 'hello all']);
    expect(await read(bob)).toEqual(['ally vs Cat?', 'deal?', 'hello all']);
    expect(await read(cat)).toEqual(['hello all']);
    expect(await read()).toEqual(['ally vs Cat?', 'deal?', 'hello all']);
    expect(catWs.chats()).toEqual(['hello all']);
    expect(fanWs.chats()).toEqual(['ally vs Cat?', 'deal?', 'hello all']);

    // Chat history on (re)connect is filtered the same way.
    const catAgain = await listen(cat);
    const history = catAgain.msgs.find((m) => m.type === 'chat_history').messages.map((m: any) => m.message);
    expect(history).toEqual(['hello all']);

    // Spectators can't whisper; nobody whispers to themselves or to a stranger.
    expect((await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'psst', name: 'Fan', to: 'Ann' }) })).status).toBe(400);
    fanWs.ws.send(JSON.stringify({ type: 'chat', message: 'psst', name: 'Fan', to: 'Ann', reqId: 'f1' }));
    expect((await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'me', to: 'Ann' }) }, ann)).body.error).toMatch(/yourself/);
    expect((await api(`/games/${g}/chat`, { method: 'POST', body: JSON.stringify({ message: 'x', to: 'Zed' }) }, ann)).body.error).toMatch(/No player/);
    await new Promise((r) => setTimeout(r, 100));
    expect(fanWs.msgs.find((m) => m.reqId === 'f1')?.error).toMatch(/seated players/);
    for (const l of [catWs, fanWs, annWs, catAgain]) l.ws.close();

    // MCP: send_chat with "to" whispers; read_chat labels it and hides it from the third player.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'agent', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError };
    };
    try {
      const sent = await call('send_chat', { gameId: g, token: cat, message: 'Bob, Ann is plotting', to: 'Bob' });
      expect(sent).toEqual({ text: 'Whispered to Bob.', isError: false });
      expect((await call('read_chat', { gameId: g, token: bob })).text).toContain('Cat [whisper -> Bob]: Bob, Ann is plotting');
      const annView = (await call('read_chat', { gameId: g, token: ann })).text;
      expect(annView).toContain('Ann [whisper -> Bob]: ally vs Cat?');
      expect(annView).not.toContain('plotting');
    } finally {
      await agent.close();
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

describe('room cleanup', () => {
  it('sweeps idle rooms by phase and keeps watched ones', async () => {
    const { Store, DEFAULT_RETENTION } = await import('../src/store.js');
    const store = new Store(null);
    const now = Date.now();
    const lobby = store.create('lobby', {}, 'A').room;
    const watched = store.create('watched', {}, 'B').room;
    const fresh = store.create('fresh', {}, 'C').room;
    const botsOnly = store.create('bots', { setupBatch: 40 }, 'D').room;
    botsOnly.join('Bot', true);
    botsOnly.join('Bot2', true);
    botsOnly.start();
    botsOnly.stopBot();
    botsOnly.act(botsOnly.state.players.find((p) => !p.isBot)!.id, { type: 'surrender' });
    expect(botsOnly.botsOnly()).toBe(true);

    const old = now - DEFAULT_RETENTION.lobby - 60_000;
    lobby.lastActivity = old;
    watched.lastActivity = old;
    watched.connections = 1;
    botsOnly.lastActivity = now - DEFAULT_RETENTION.botsOnly - 60_000;
    const removed = store.sweep(now).map((r) => r.id).sort();
    expect(removed).toEqual([botsOnly.id, lobby.id].sort());
    expect(store.get(watched.id)).toBeDefined();
    expect(store.get(fresh.id)).toBeDefined();
    // The hard cap applies even while someone is connected.
    watched.lastActivity = now - DEFAULT_RETENTION.max - 1;
    expect(store.sweep(now).map((r) => r.id)).toEqual([watched.id]);
    store.stopTimers();
  });

  it('lets the host close a room and notifies connected clients', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host' }) });
    const id = created.body.gameId;
    const joined = await api(`/games/${id}/join`, { method: 'POST', body: JSON.stringify({ playerName: 'Guest' }) });
    const notHost = await api(`/games/${id}/close`, { method: 'POST', body: '{}' }, joined.body.token);
    expect(notHost.status).toBe(403);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const msgs: any[] = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', gameId: id }));
        setTimeout(resolve, 100);
      });
    });
    const ok = await api(`/games/${id}/close`, { method: 'POST', body: '{}' }, created.body.token);
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.find((m) => m.type === 'closed')?.reason).toBe('host');
    expect((await api(`/games/${id}`)).status).toBe(404);
    ws.close();
  });

  it('deletes a lobby when the last person leaves, even with bots in it', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Solo' }) });
    const id = created.body.gameId;
    await api(`/games/${id}/bots`, { method: 'POST', body: '{}' }, created.body.token);
    await api(`/games/${id}/leave`, { method: 'POST', body: '{}' }, created.body.token);
    expect((await api(`/games/${id}`)).status).toBe(404);
  });

  it('exposes admin cleanup only with the admin token', async () => {
    const plain = await startServer(null);
    const admin = await startServer(null, undefined, 'secret-admin');
    try {
      expect((await fetch(`${plain.base}/api/admin/games`)).status).toBe(404);
      expect((await fetch(`${admin.base}/api/admin/games`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
      const g = await fetch(`${admin.base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerName: 'X' }) }).then((r) => r.json());
      const list = await fetch(`${admin.base}/api/admin/games`, { headers: { authorization: 'Bearer secret-admin' } }).then((r) => r.json());
      expect(list.games.some((x: any) => x.id === g.gameId && x.wouldSweep === null)).toBe(true);
      const del = await fetch(`${admin.base}/api/admin/games/${g.gameId}`, { method: 'DELETE', headers: { authorization: 'Bearer secret-admin' } });
      expect(del.status).toBe(200);
      expect((await fetch(`${admin.base}/api/games/${g.gameId}`)).status).toBe(404);
      const sweep = await fetch(`${admin.base}/api/admin/sweep`, { method: 'POST', headers: { authorization: 'Bearer secret-admin' } }).then((r) => r.json());
      expect(Array.isArray(sweep.removed)).toBe(true);
    } finally {
      await plain.risk.shutdown('test');
      await admin.risk.shutdown('test');
    }
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

describe('MCP game settings', () => {
  it('creates a game with every setting, reports them, changes them, and rejects typos', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { OPTION_KEYS } = await import('@risk/engine');
    const c = new Client({ name: 'settings', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError };
    };
    try {
      // The advertised schema covers exactly the engine's settings.
      const tools = (await c.listTools()).tools;
      const createSchema = tools.find((t) => t.name === 'create_game')!.inputSchema as any;
      expect(Object.keys(createSchema.properties.options.properties).sort()).toEqual([...OPTION_KEYS].sort());
      expect(tools.some((t) => t.name === 'game_options')).toBe(true);

      const catalogue = await call('game_options');
      for (const k of OPTION_KEYS) expect(catalogue.text).toContain(`- ${k} (`);

      const options = { map: 'world', maxPlayers: 8, autoSetup: true, cardValues: 'fixed', fogOfWar: true, capitals: true, neutrals: 5, neutralArmies: 3, blizzards: 4, fortifyMode: 'adjacent' };
      const created = await call('create_game', { playerName: 'Settler', options });
      expect(created.isError).toBe(false);
      const gameId = created.text.match(/Created game (\w+)/)![1];
      expect(created.text).toContain('Fog of war: on');
      expect(created.text).toContain('Neutral territories: 5 with 3 armies');
      expect(created.text).toContain('Blizzards: 4 frozen');
      const room = risk.store.get(gameId)!;
      expect(room.state.options).toMatchObject(options);

      // set_options reports the change; switching map clamps seats.
      const changed = await call('set_options', { gameId, options: { map: 'classic', blizzards: 2 } });
      expect(changed.isError).toBe(false);
      expect(changed.text).toMatch(/map: "world" -> "classic"/);
      expect(changed.text).toMatch(/maxPlayers: 8 -> 6/);
      expect(room.state.options.blizzards).toBe(2);

      // A typo is an error, not a silent no-op.
      const typo = await call('set_options', { gameId, options: { fog_of_war: false } });
      expect(typo.isError).toBe(true);
      expect(room.state.options.fogOfWar).toBe(true);
      // Out-of-range for the map is explained by the engine.
      const tooMany = await call('set_options', { gameId, options: { maxPlayers: 9 } });
      expect(tooMany.isError).toBe(true);
      expect(tooMany.text).toMatch(/maxPlayers must be between 2 and 6/);

      const current = await call('game_options', { gameId });
      expect(current.text).toContain('You are the host');
      expect(current.text).toContain('"fogOfWar":true');

      // The settings also travel over plain HTTP.
      const http = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { fogOfWar: 'maybe' } }) });
      expect(http.status).toBe(400);
      expect(http.body.error).toMatch(/fogOfWar must be true or false/);
      const cat = await api('/options');
      expect(cat.body.limitsByMap.world.maxPlayers.max).toBe(10);
    } finally {
      await c.close();
    }
  });
});

describe('MCP seats', () => {
  it('lets one connection hold several players in a game and resolves them by name or token', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const host = new Client({ name: 'host', version: '0' });
    await host.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (c: InstanceType<typeof Client>, name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError };
    };
    try {
      const created = await call(host, 'create_game', { playerName: 'Alpha', options: { maxPlayers: 4 } });
      const gameId = created.text.match(/Created game (\w+)/)![1];
      // Two more seats from the same connection (e.g. two chats sharing one MCP session).
      const b = await call(host, 'join_game', { gameId, playerName: 'Bravo' });
      expect(b.isError).toBe(false);
      const c = await call(host, 'join_game', { gameId, playerName: 'Charlie' });
      expect(c.isError).toBe(false);
      // Joining again with the same name is a repeat, not a fourth player.
      const again = await call(host, 'join_game', { gameId, playerName: 'Bravo' });
      expect(again.text).toContain('already hold');
      const seats = await call(host, 'my_seats');
      expect(seats.text.match(/TOKEN:/g)).toHaveLength(3);
      // Ambiguous calls must say so; naming the seat works.
      const amb = await call(host, 'get_state', { gameId });
      expect(amb.isError).toBe(true);
      expect(amb.text).toMatch(/holds 3 seats/);
      const asBravo = await call(host, 'get_state', { gameId, as: 'bravo' });
      expect(asBravo.isError).toBe(false);
      expect(asBravo.text).toContain('Bravo (you)');
      expect(asBravo.text).not.toContain('Alpha (you)');
      const started = await call(host, 'start_game', { gameId, as: 'Alpha' });
      expect(started.isError).toBe(false);
      expect(started.text).toContain('phase: setup');
      // Only the host may start; Bravo cannot.
      const g2 = await call(host, 'create_game', { playerName: 'Alpha' });
      const gid2 = g2.text.match(/Created game (\w+)/)![1];
      await call(host, 'join_game', { gameId: gid2, playerName: 'Bravo' });
      const notHost = await call(host, 'start_game', { gameId: gid2, as: 'Bravo' });
      expect(notHost.isError).toBe(true);
    } finally {
      await host.close();
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
      expect(risk.health().mcpSessions).toBeGreaterThanOrEqual(1);
      // A second, independent session has no seat in that game...
      const other = new Client({ name: 'other', version: '0' });
      await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const denied = (await other.callTool({ name: 'act', arguments: { gameId, action: { type: 'end_turn' } } })) as { isError?: boolean; content: { text: string }[] };
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/Not in this game/);
      // ...but can act with the first session's token (reconnect scenario).
      const token = created.text.match(/TOKEN: (\S+)/)![1];
      const viaToken = (await other.callTool({ name: 'get_state', arguments: { gameId, token } })) as { isError?: boolean; content: { text: string }[] };
      expect(viaToken.isError).toBeFalsy();
      expect(viaToken.content[0].text).toContain('[YOU');
      await other.close();
    } finally {
      await client.close();
    }
  });
});

describe('MCP act replies', () => {
  it('returns only what the action changed plus legal moves, and the full board on request', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'compact-agent', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };
      const created = await call('create_game', { playerName: 'Lean', options: { autoSetup: true } });
      const gameId = created.text.match(/Created game (\w+)/)![1];
      await call('add_bot', { gameId });
      await call('start_game', { gameId });
      expect((await call('wait_for_turn', { gameId, timeoutSeconds: 15 })).text).toMatch(/^It is your turn/);
      const board = await call('get_state', { gameId });
      const mine = board.text.match(/YOUR LEGAL MOVES:[\s\S]*?Place up to (\d+) armies/)!;
      const room = risk.store.get(gameId)!;
      const me = room.state.players.find((p) => p.name === 'Lean')!;
      const territory = Object.entries(room.state.territories).find(([, t]) => t.owner === me.id)![0];
      const placed = await call('act', { gameId, action: { type: 'place', placements: { [territory]: Number(mine[1]) } } });
      expect(placed.isError).toBe(false);
      expect(placed.text).toContain('Changed territories');
      expect(placed.text).toContain(`${territory}:`);
      expect(placed.text).toContain('YOUR LEGAL MOVES');
      expect(placed.text).not.toContain('Territories (owner armies) with neighbours:');
      // Compare without the legal moves (both carry them in full, and their length depends on the deal):
      // the compact reply lists one touched territory, the board all of them.
      const boardPart = (t: string) => t.split('\nYOUR LEGAL MOVES:')[0];
      expect(boardPart(placed.text).length).toBeLessThan(boardPart(board.text).length / 3);
      // full:true still gives the whole board.
      const end = await call('act', { gameId, action: { type: 'end_attack' }, full: true });
      expect(end.text).toContain('Territories (owner armies) with neighbours:');
    } finally {
      await client.close();
    }
  });

  it('under fog of war the compact reply shows nothing the fogged board hides, and lists your cards', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { viewFor } = await import('@risk/engine');
    const client = new Client({ name: 'fog-agent', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };
      const created = await call('create_game', { playerName: 'Foggy', options: { autoSetup: true, fogOfWar: true } });
      const gameId = created.text.match(/Created game (\w+)/)![1];
      await call('add_bot', { gameId });
      await call('add_bot', { gameId });
      await call('start_game', { gameId });
      expect((await call('wait_for_turn', { gameId, timeoutSeconds: 15 })).text).toMatch(/^It is your turn/);
      const room = risk.store.get(gameId)!;
      const me = room.state.players.find((p) => p.name === 'Foggy')!;
      me.cards = room.state.deck.splice(0, 2);
      const board = await call('get_state', { gameId });
      const toPlace = Number(board.text.match(/YOUR LEGAL MOVES:[\s\S]*?Place up to (\d+) armies/)![1]);
      const territory = Object.entries(room.state.territories).find(([, t]) => t.owner === me.id)![0];
      const placed = await call('act', { gameId, action: { type: 'place', placements: { [territory]: toPlace } } });
      expect(placed.isError).toBe(false);
      expect(placed.text).toContain(`Your cards: #${me.cards[0].id}`);
      const hidden = Object.entries(viewFor(room.state, me.id).territories).filter(([, t]) => t.hidden).map(([id]) => id);
      expect(hidden.length).toBeGreaterThan(0);
      for (const t of hidden) expect(placed.text).not.toMatch(new RegExp(`\\b${t}\\*?\\((?!fog)`));
    } finally {
      await client.close();
    }
  });
});

describe('new boards over HTTP', () => {
  it('lists every board', async () => {
    const r = await api('/maps');
    expect(r.body.maps.map((m: any) => m.id)).toEqual(['classic', 'world', 'world_large', 'europe', 'europe_advanced', 'usa', 'asia', 'fantasy', 'earth']);
  });

  for (const [id, territories, maxPlayers] of [
    ['world_large', 104, 10],
    ['europe', 44, 8],
    ['europe_advanced', 99, 6],
    ['usa', 45, 10],
    ['asia', 49, 8],
  ] as const) {
    it(`creates, fills with bots and starts a ${maxPlayers}-player game on ${id}`, async () => {
      const map = await api(`/map?map=${id}`);
      expect(map.status).toBe(200);
      expect(map.body.territories).toHaveLength(territories);
      const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { map: id, maxPlayers, autoSetup: true } }) });
      expect(created.status).toBe(201);
      expect(created.body.state.options.map).toBe(id);
      const { gameId, token } = created.body;
      for (let i = 1; i < maxPlayers; i++) expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBe(201);
      expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).not.toBe(201);
      const s = await api(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
      expect(s.status).toBe(200);
      expect(Object.keys(s.body.state.territories)).toHaveLength(territories);
      expect(s.body.state.players.filter((p: any) => !p.isNeutral)).toHaveLength(maxPlayers);
      expect(s.body.state.phase).not.toBe('lobby');
    });
  }

  it('rejects too many seats for a board', async () => {
    const r = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { map: 'europe', maxPlayers: 9 } }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maxPlayers must be between 2 and 8/);
    const ea = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { map: 'europe_advanced', maxPlayers: 7 } }) });
    expect(ea.status).toBe(400);
    expect(ea.body.error).toMatch(/maxPlayers must be between 2 and 6/);
  });

  it('serves Europe Advanced with its regions and cross-water adjacency', async () => {
    const maps = await api('/maps');
    expect(maps.body.maps).toContainEqual(expect.objectContaining({ id: 'europe_advanced', territories: 99, maxPlayers: 6 }));
    const map = await api('/map?map=europe_advanced');
    expect(map.body.continents).toHaveLength(14);
    expect(map.body.adjacency.southern_england).toContain('ile_de_france');
    expect(map.body.adjacency.morocco).toContain('andalusia');
  });
});

describe('fantasy map over HTTP', () => {
  it('lists the board, serves its map and runs a 10-seat game on it with bots', async () => {
    const own = await startServer(null);
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${own.base}/api${path}`, { ...init, headers });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      const maps = await call('/maps');
      expect(maps.body.maps).toContainEqual(expect.objectContaining({ id: 'fantasy', territories: 87, maxPlayers: 10 }));
      const map = await call('/map?map=fantasy');
      expect(map.status).toBe(200);
      expect(map.body.territories).toHaveLength(87);
      expect(map.body.continents).toHaveLength(16);

      const created = await call('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Wanderer', options: { map: 'fantasy', maxPlayers: 10, autoSetup: true } }) });
      expect(created.status).toBe(201);
      expect(created.body.state.options.map).toBe('fantasy');
      const { gameId, token } = created.body;
      for (let i = 0; i < 9; i++) expect((await call(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBe(201);
      expect((await call(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBeGreaterThanOrEqual(400);
      const started = await call(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
      expect(started.status).toBe(200);
      const state = started.body.state;
      expect(state.players).toHaveLength(10);
      expect(Object.keys(state.territories)).toHaveLength(87);
      expect(Object.values(state.territories).every((t: any) => t.owner)).toBe(true);
      expect(state.phase).not.toBe('lobby');
    } finally {
      await own.risk.shutdown('test');
    }
  });
});
