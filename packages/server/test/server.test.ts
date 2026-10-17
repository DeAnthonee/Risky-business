import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('under fog of war, a player gets no counts for opponents it cannot fully see; spectators get them all', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Fogged', options: { fogOfWar: true, autoSetup: true } }) });
    const g = created.body.gameId;
    for (let i = 0; i < 3; i++) await api(`/games/${g}/bots`, { method: 'POST', body: '{}' }, created.body.token);
    await api(`/games/${g}/start`, { method: 'POST', body: '{}' }, created.body.token);
    const asPlayer = await api(`/games/${g}`, {}, created.body.token);
    const me = asPlayer.body.state.you;
    const others = asPlayer.body.state.players.filter((p: any) => p.id !== me && !p.isNeutral);
    expect(others.some((p: any) => p.armyCount === null && p.territoryCount === null && typeof p.cardCount === 'number' && p.income === null)).toBe(true);
    const asSpectator = await api(`/games/${g}`);
    expect(asSpectator.body.state.players.every((p: any) => p.isNeutral || typeof p.armyCount === 'number')).toBe(true);
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

describe('balanced blitz over HTTP', () => {
  it('accepts the setting, lists it in the catalog and rejects bad values', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'B', options: { balancedBlitz: true } }) });
    expect(created.status).toBe(201);
    expect(created.body.state.options.balancedBlitz).toBe(true);
    const plain = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'P' }) });
    expect(plain.body.state.options.balancedBlitz).toBe(false);
    const bad = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'X', options: { balancedBlitz: 'sometimes' } }) });
    expect(bad.status).toBe(400);
    const cat = await api('/options');
    expect(JSON.stringify(cat.body)).toContain('balancedBlitz');
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
      // One bot: with two, both bot turns (700 ms per action) could run before ours and outlast the wait.
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

describe('MCP conquest under fog of war', () => {
  it('reveals what a conquest uncovers, tags capitals, before the occupy decision', async () => {
    const { createGame, addPlayer, startGame, applyAction, viewFor, getMap } = await import('@risk/engine');
    const { formatActResult, formatState } = await import('@risk/mcp');
    let s = createGame('FOGCAP', { fogOfWar: true, capitals: true, autoSetup: true, maxPlayers: 3 }, 7);
    s = addPlayer(s, 'a', 'Alice');
    s = addPlayer(s, 'b', 'Bob');
    s = addPlayer(s, 'c', 'Carl');
    s = startGame(s).state;
    // Rig the board: Alice attacks Northwest Territory from Alaska; Bob's capital Greenland (2 armies)
    // is only visible once Northwest Territory falls.
    for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 'c', armies: 3 };
    s.territories.alaska = { owner: 'a', armies: 20 };
    s.territories.kamchatka = { owner: 'a', armies: 1 };
    s.territories.northwest_territory = { owner: 'b', armies: 1 };
    s.territories.greenland = { owner: 'b', armies: 2 };
    s.capitals = { a: 'kamchatka', b: 'greenland', c: 'brazil' };
    s.currentPlayer = 'a';
    s.phase = 'attack';
    s.players.find((p) => p.id === 'a')!.armiesToPlace = 0;
    expect(viewFor(s, 'a').territories.greenland.hidden).toBe(true);
    // Under fog the attack advice no longer tells agents to occupy blind.
    const before = formatState(viewFor(s, 'a'));
    expect(before).toContain('Fog of war is ON, so leave out "occupy"');
    expect(before).not.toContain('"blitz":true,"occupy":"max"');

    const r = applyAction(s, 'a', { type: 'attack', from: 'alaska', to: 'northwest_territory', blitz: true });
    expect(r.state.pendingConquest?.to).toBe('northwest_territory');
    const view = viewFor(r.state, 'a');
    // The fog has already cleared while the occupy decision is pending.
    expect(view.territories.greenland.hidden).toBeFalsy();
    expect(view.capitals.b).toBe('greenland');
    const text = formatActResult(r.events, view);
    expect(text).toContain('Revealed by your conquest (was fogged): ');
    expect(text).toMatch(/Revealed by your conquest[^\n]*greenland\*\(Bob 2, CAPITAL of Bob\)/);
    expect(text).toMatch(/northwest_territory: Alice 0 — [^\n]*greenland\*\(Bob 2, CAPITAL of Bob\)/);
    // Alberta was already visible from Alaska, so it is not "revealed".
    expect(text).not.toMatch(/Revealed by your conquest[^\n]*alberta/);
    expect(text).toContain('You MUST occupy');
    expect(text.indexOf('Revealed by your conquest')).toBeLessThan(text.indexOf('You MUST occupy'));
  });
});

describe('MCP blitz with stopAt', () => {
  it('shows each attack\'s win chance and accepts stopAt in one call', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { getMap } = await import('@risk/engine');
    const client = new Client({ name: 'stopat-agent', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };
      const created = await call('create_game', { playerName: 'Careful', options: { autoSetup: true } });
      const gameId = created.text.match(/Created game (\w+)/)![1];
      await call('add_bot', { gameId });
      await call('start_game', { gameId });
      expect((await call('wait_for_turn', { gameId, timeoutSeconds: 15 })).text).toMatch(/^It is your turn/);
      const room = risk.store.get(gameId)!;
      const me = room.state.players.find((p) => p.name === 'Careful')!;
      const adj = getMap(room.state.options.map).adjacency;
      const from = Object.keys(room.state.territories).find((t) => room.state.territories[t].owner === me.id && adj[t].some((n) => room.state.territories[n].owner !== me.id))!;
      const to = adj[from].find((n) => room.state.territories[n].owner !== me.id)!;
      const toPlace = me.armiesToPlace;
      await call('act', { gameId, action: { type: 'place', placements: { [from]: toPlace } } });
      room.state.territories[from].armies = 25;
      room.state.territories[to].armies = 40;
      const board = await call('get_state', { gameId });
      expect(board.text).toContain('chance an all-in blitz takes it');
      expect(board.text).toMatch(new RegExp(`${from}->${to} \\(3, \\d+%\\)`));
      expect(board.text).toContain('"stopAt":N');
      const r = await call('act', { gameId, action: { type: 'attack', from, to, stopAt: 15 } });
      expect(r.isError).toBe(false);
      expect(room.state.territories[from].armies).toBeGreaterThanOrEqual(15);
      expect(room.state.territories[to].owner).not.toBe(me.id);
    } finally {
      await client.close();
    }
  });
});

describe('new boards over HTTP', () => {
  it('lists every board', async () => {
    const r = await api('/maps');
    expect(r.body.maps.map((m: any) => m.id)).toEqual(['classic', 'world', 'world_large', 'europe', 'greater_europe', 'europe_classic', 'usa', 'asia', 'fantasy', 'skirmish']);
  });

  for (const [id, territories, maxPlayers] of [
    ['world_large', 104, 10],
    ['europe', 44, 8],
    ['greater_europe', 116, 10],
    ['europe_classic', 84, 6],
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
    const ea = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { map: 'greater_europe', maxPlayers: 11 } }) });
    expect(ea.status).toBe(400);
    expect(ea.body.error).toMatch(/maxPlayers must be between 2 and 10/);
  });

  it('serves Europe Advanced (europe_classic) with the reference regions and rejects a 7th seat', async () => {
    const maps = await api('/maps');
    expect(maps.body.maps).toContainEqual(expect.objectContaining({ id: 'europe_classic', name: 'Europe Advanced (84)', territories: 84, maxPlayers: 6 }));
    const map = await api('/map?map=europe_classic');
    expect(map.body.continents).toHaveLength(14);
    expect(map.body.continents.find((c: any) => c.id === 'eastern_europe')).toMatchObject({ name: 'Eastern Europe', bonus: 8 });
    expect(map.body.adjacency.corsica_sardinia).toContain('constantine');
    const r = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { map: 'europe_classic', maxPlayers: 7 } }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maxPlayers must be between 2 and 6/);
  });

  it('serves Greater Europe with its regions and cross-water adjacency', async () => {
    const maps = await api('/maps');
    expect(maps.body.maps).toContainEqual(expect.objectContaining({ id: 'greater_europe', name: 'Greater Europe (116)', territories: 116, maxPlayers: 10 }));
    const map = await api('/map?map=greater_europe');
    expect(map.body.continents).toHaveLength(15);
    expect(map.body.adjacency.southern_england).toContain('ile_de_france');
    expect(map.body.adjacency.fez).toContain('andalusia');
  });

  it('no longer offers the legacy 99-territory europe_advanced board for new games', async () => {
    const maps = await api('/maps');
    expect(maps.body.maps.map((m: any) => m.id)).not.toContain('europe_advanced');
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'H', options: { map: 'europe_advanced' } }) });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(/map must be one of/);
    const options = await api('/options');
    expect(options.body.options.find((o: any) => o.key === 'map').values).not.toContain('europe_advanced');
    // its geometry is still served, for spectators of saved games
    const legacy = await api('/map?map=europe_advanced');
    expect(legacy.status).toBe(200);
    expect(legacy.body.territories).toHaveLength(99);
  });

  it('loads saved games on the legacy europe_advanced board with its 99 territory ids', async () => {
    const { addPlayer, createGame, startGame } = await import('@risk/engine');
    const snap = (id: string, state: any, tokens: Record<string, string>) => ({ id, name: id, hostId: 'a', state, tokens, chat: [], history: [], updatedAt: Date.now() });
    // a running game, dealt and set up on the 99-territory board as the build before Greater Europe did
    let g = createGame('LEGACYEA', { map: 'europe_advanced', maxPlayers: 3, autoSetup: true }, 17);
    for (const id of ['a', 'b', 'c']) g = addPlayer(g, id, id.toUpperCase());
    const running = startGame(g).state;
    expect(Object.keys(running.territories)).toHaveLength(99);
    expect(running.territories.morocco).toBeDefined();
    // and a lobby on it
    const lobby = addPlayer(createGame('LOBBYEA', { map: 'europe_advanced', maxPlayers: 6 }, 3), 'a', 'A');
    const file = join(dir, 'europe-advanced-99.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify([snap('LEGACYEA', running, { tokA: 'a', tokB: 'b', tokC: 'c' }), snap('LOBBYEA', lobby, { tokL: 'a' })]));
    const legacy = await startServer(file);
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const res = await fetch(`${legacy.base}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      const spectator = await call('/games/LEGACYEA');
      expect(spectator.status).toBe(200);
      expect(spectator.body.state.options.map).toBe('europe_advanced');
      expect(Object.keys(spectator.body.state.territories)).toHaveLength(99);
      const current = running.currentPlayer!;
      const token = { a: 'tokA', b: 'tokB', c: 'tokC' }[current]!;
      const seen = await call('/games/LEGACYEA', {}, token);
      expect(seen.status).toBe(200);
      const legal = seen.body.state.legal;
      expect(legal.yourTurn).toBe(true);
      expect(legal.canPlaceOn.length).toBeGreaterThan(0);
      for (const t of legal.canPlaceOn) expect(t in running.territories).toBe(true);
      const placed = await call('/games/LEGACYEA/actions', { method: 'POST', body: JSON.stringify({ action: { type: 'place', placements: { [legal.canPlaceOn[0]]: legal.armiesToPlace } } }) }, token);
      expect(placed.status).toBe(200);
      expect(placed.body.state.phase).toBe('attack');
      expect(placed.body.state.legal.canEndAttack).toBe(true);
      // the saved lobby keeps its board and can still change other settings
      const opts = await call('/games/LOBBYEA/options', { method: 'POST', body: JSON.stringify({ options: { maxPlayers: 4, fogOfWar: true } }) }, 'tokL');
      expect(opts.status).toBe(200);
      expect(opts.body.state.options).toMatchObject({ map: 'europe_advanced', maxPlayers: 4, fogOfWar: true });
      const back = await call('/games/LOBBYEA/options', { method: 'POST', body: JSON.stringify({ options: { map: 'europe_advanced' } }) }, 'tokL');
      expect(back.status).toBe(400);
    } finally {
      await legacy.risk.shutdown('test');
    }
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

describe('AI character profiles', () => {
  const KEY = 'test-characters-key';
  it('keeps "__proto__" input harmless and deletes pruned profile versions from disk', async () => {
    const { CharacterStore } = await import('../src/characters.js');
    const { readdirSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'risk-ai-'));
    const aiDir = join(root, 'AI');
    const dataDir = join(root, 'data', 'characters');
    mkdirSync(join(aiDir, 'characters', 'marvel'), { recursive: true });
    writeFileSync(join(aiDir, 'characters', '_TEMPLATE.md'), '# <Character Name>\n');
    writeFileSync(join(aiDir, 'characters', 'marvel', 'iron-man.md'), profile('Iron Man'));
    const store = new CharacterStore(aiDir, dataDir, [KEY]);
    store.addDiaryEntry('marvel/iron-man', { title: 'Game', text: 'Lost to a proto.', outcome: 'lost', opponents: ['__proto__'], strategy: '__proto__', map: '__proto__' } as any, KEY);
    store.updateRelationship('marvel/iron-man', { with: '__proto__', note: 'Rivals.', change: -5 } as any, KEY);
    const memory = store.memorySummary('marvel/iron-man');
    expect(({} as any).games).toBeUndefined();
    expect((memory.record.vsOpponent as any)['__proto__']).toEqual({ games: 1, won: 0 });
    expect(memory.relationships.map((r) => r.with)).toContain('__proto__');
    // Relationships survive a restart with the same key.
    const again = new CharacterStore(aiDir, dataDir);
    expect(again.memorySummary('marvel/iron-man').relationships.map((r) => r.with)).toContain('__proto__');
    expect(({} as any).games).toBeUndefined();
    // Only the kept versions stay on disk.
    for (let i = 0; i < 35; i++) store.update('marvel/iron-man', { markdown: profile(`Iron Man ${i}`) } as any, KEY);
    const files = readdirSync(join(dataDir, 'marvel', 'iron-man')).filter((f) => /^v\d+\.md$/.test(f));
    expect(files.length).toBeLessThanOrEqual(30);
  });

  const profile = (name: string, grudges = 'None yet.') => `# ${name}\n\n- **Universe:** Test\n\n## Strategy\n\nHold Australia.\n\n## Grudges & rivals\n\n${grudges}\n\n## Allies\n\nNone yet.\n`;

  async function withCharacters(fn: (base: string, aiDir: string, dataDir: string) => Promise<void>) {
    const { CharacterStore } = await import('../src/characters.js');
    const root = mkdtempSync(join(tmpdir(), 'risk-ai-'));
    const aiDir = join(root, 'AI');
    const dataDir = join(root, 'data', 'characters');
    mkdirSync(join(aiDir, 'characters', 'marvel'), { recursive: true });
    mkdirSync(join(aiDir, 'general-model-info'), { recursive: true });
    writeFileSync(join(aiDir, 'characters', '_TEMPLATE.md'), '# <Character Name>\n');
    writeFileSync(join(aiDir, 'characters', 'marvel', 'iron-man.md'), profile('Iron Man'));
    writeFileSync(join(aiDir, 'general-model-info', 'README.md'), '# index\n');
    writeFileSync(join(aiDir, 'general-model-info', 'table-talk.md'), '# Table talk\n\nBe polite.\n');
    const start = async () => {
      const r = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0, characters: new CharacterStore(aiDir, dataDir, [KEY, 'test-admin-token']) });
      await new Promise<void>((resolve) => r.server.listen(0, '127.0.0.1', resolve));
      return { r, url: `http://127.0.0.1:${(r.server.address() as AddressInfo).port}` };
    };
    let s = await start();
    try {
      await fn(s.url, aiDir, dataDir);
      // Saves survive a restart (they live under the data dir, not the repo).
      await s.r.shutdown('test');
      s = await start();
      const res = await (await fetch(`${s.url}/api/characters/marvel/iron-man`)).json();
      expect(res.source).toBe('saved');
      expect(res.markdown).toContain('dc/batman');
    } finally {
      await s.r.shutdown('test');
      rmSync(root, { recursive: true, force: true });
    }
  }

  const req = async (url: string, path: string, body?: unknown, key: string | null = KEY) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(key ? { 'x-characters-key': key } : {}) };
    const res = await fetch(`${url}/api${path}`, body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it('serves repo profiles, saves sections as new versions, keeps history and rejects stale or bad saves over HTTP', async () => {
    await withCharacters(async (url, aiDir) => {
      const list = await req(url, '/characters');
      expect(list.body.characters).toEqual([{ id: 'marvel/iron-man', universe: 'marvel', name: 'Iron Man', version: 0, updatedAt: null, source: 'repo' }]);
      const v0 = await req(url, '/characters/marvel/iron-man');
      expect(v0.body.version).toBe(0);

      const saved = await req(url, '/characters/marvel/iron-man', { section: 'grudges & rivals', content: '- **Batman** (`dc/batman.md`): beat him in game ABC123.', expectedVersion: 0, note: 'lost to batman' });
      expect(saved.status).toBe(200);
      expect(saved.body.version).toBe(1);
      expect(saved.body.markdown).toContain('## Grudges & rivals\n\n- **Batman**');
      expect(saved.body.markdown).toContain('## Strategy\n\nHold Australia.');
      expect(saved.body.markdown).toContain('## Allies\n\nNone yet.');
      expect(saved.body.markdown).not.toContain('None yet.\n\n## Allies');
      // The repo file is never touched.
      expect(readFileSync(join(aiDir, 'characters', 'marvel', 'iron-man.md'), 'utf8')).toBe(profile('Iron Man'));

      const stale = await req(url, '/characters/marvel/iron-man', { section: 'Strategy', content: 'x', expectedVersion: 0 });
      expect(stale.status).toBe(409);
      const added = await req(url, '/characters/marvel/iron-man', { section: 'Weaknesses', content: 'Overconfident.' });
      expect(added.body.version).toBe(2);
      expect(added.body.markdown.trimEnd().endsWith('## Weaknesses\n\nOverconfident.')).toBe(true);

      const history = await req(url, '/characters/marvel/iron-man/history');
      expect(history.body.versions.map((v: any) => v.version)).toEqual([0, 1, 2]);
      expect(history.body.versions[1].note).toBe('lost to batman');
      expect((await req(url, '/characters/marvel/iron-man?version=0')).body.markdown).toBe(profile('Iron Man'));

      expect((await req(url, '/characters/marvel/Iron Man', { markdown: profile('x') })).status).toBe(400);
      expect((await req(url, '/characters/dc/batman', { section: 'Strategy', content: 'x' })).status).toBe(404);
      expect((await req(url, '/characters/dc/batman', { markdown: 'no heading' })).status).toBe(400);
      const created = await req(url, '/characters/dc/batman', { markdown: profile('Batman') });
      expect(created.body).toMatchObject({ id: 'dc/batman', version: 1, source: 'saved' });
      expect((await req(url, '/characters/dc/robin')).status).toBe(404);

      const full = await req(url, '/characters?full=1');
      expect(full.body.characters.map((c: any) => [c.id, c.version])).toEqual([['dc/batman', 1], ['marvel/iron-man', 2]]);
      expect(full.body.characters[1].markdown).toContain('Overconfident.');

      const info = await req(url, '/model-info');
      expect(info.body.docs.map((d: any) => d.file)).toEqual(['general-model-info/table-talk.md', 'characters/_TEMPLATE.md']);
    });
  });

  it('keeps a diary, relationships and a record on top of the repo files, across restarts', async () => {
    await withCharacters(async (url, aiDir) => {
      writeFileSync(
        join(aiDir, 'characters', 'marvel', 'iron-man.diary.md'),
        '# Iron Man — diary\n\n## Game AAA111: lost\n- **Game:** aaa111\n- **Date:** 2026-10-01\n- **Outcome:** lost\n- **Map:** europe\n- **Opponents:** Batman, God\n- **Strategy:** Australia turtle\n\nWent too early.\n\n### Lesson\n\nWait.\n',
      );
      writeFileSync(join(aiDir, 'characters', 'marvel', 'iron-man.relationships.md'), '| Player | Rapport | Notes |\n| --- | --- | --- |\n| God | -70 | Coached my opponent. |\n| Batman | 5 | Fair. |\n');
      // The diary and relationships files are not characters themselves.
      expect((await req(url, '/characters')).body.characters.map((c: any) => c.id)).toEqual(['marvel/iron-man']);

      const seeded = await req(url, '/characters/marvel/iron-man/diary');
      expect(seeded.body.total).toBe(1);
      expect(seeded.body.entries[0]).toMatchObject({ n: 1, title: 'Game AAA111: lost', gameId: 'AAA111', outcome: 'lost', map: 'europe', opponents: ['Batman', 'God'], source: 'repo', at: '2026-10-01T00:00:00.000Z' });
      expect(seeded.body.entries[0].text).toBe('Went too early.\n\n### Lesson\n\nWait.');

      const added = await req(url, '/characters/marvel/iron-man/diary', { title: 'Game BBB222: won', text: 'Held Australia.', gameId: 'bbb222', outcome: 'won', map: 'Europe', opponents: ['Batman'], strategy: 'australia turtle' });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({ n: 2, gameId: 'BBB222', source: 'saved' });
      expect((await req(url, '/characters/marvel/iron-man/diary', { title: 'x', text: 'y', outcome: 'draw' })).status).toBe(400);
      expect((await req(url, '/characters/marvel/iron-man/diary', { title: '', text: 'y' })).status).toBe(400);
      expect((await req(url, '/characters/dc/nobody/diary', { title: 'x', text: 'y' })).status).toBe(404);
      expect((await req(url, '/characters/marvel/iron-man/diary?gameId=aaa111')).body.entries.map((e: any) => e.n)).toEqual([1]);

      const rel = await req(url, '/characters/marvel/iron-man/relationships', { with: 'god', change: -50, note: 'Did it again.', gameId: 'bbb222' });
      expect(rel.body).toMatchObject({ with: 'God', rapport: -100 });
      expect(rel.body.notes.map((n: any) => n.change)).toEqual([-70, -30]);
      expect((await req(url, '/characters/marvel/iron-man/relationships', { with: 'StarkGPT', rapport: 20, note: 'Shared intel.' })).body.rapport).toBe(20);
      expect((await req(url, '/characters/marvel/iron-man/relationships', { with: 'X', note: '' })).status).toBe(400);

      const mem = (await req(url, '/characters/marvel/iron-man/memory')).body;
      expect(mem.record).toMatchObject({ games: 2, won: 1, byStrategy: { 'australia turtle': { games: 2, won: 1 } }, byMap: { europe: { games: 2, won: 1 } }, vsOpponent: { Batman: { games: 2, won: 1 }, God: { games: 1, won: 0 } } });
      expect(mem.relationships.map((r: any) => [r.with, r.rapport])).toEqual([['God', -100], ['StarkGPT', 20], ['Batman', 5]]);
      expect(mem.recentDiary.map((e: any) => e.title)).toEqual(['Game AAA111: lost', 'Game BBB222: won']);
      // Leaves something for the restart check in withCharacters.
      await req(url, '/characters/marvel/iron-man', { section: 'Grudges & rivals', content: 'dc/batman' });
    });
  });

  it('parses the real Ultron diary and relationships from the repo', async () => {
    const { CharacterStore } = await import('../src/characters.js');
    const { DEFAULT_AI_DIR } = await import('../src/app.js');
    const store = new CharacterStore(DEFAULT_AI_DIR, null);
    expect(store.list().map((c) => c.id)).toContain('marvel/ultron');
    const diary = store.readDiary('marvel/ultron');
    expect(diary.entries[0]).toMatchObject({ gameId: '3ZP4C4', outcome: 'lost', map: 'europe', winner: 'Wonder Woman' });
    expect(diary.entries[0].text).toContain('### Endgame');
    const mem = store.memorySummary('marvel/ultron');
    expect(mem.relationships[0]).toMatchObject({ with: 'God', rapport: -70 });
    expect(mem.record.vsOpponent['Wonder Woman']).toEqual({ games: 1, won: 0 });
    expect(store.modelInfo().docs.map((d) => d.file).slice(0, 3)).toEqual(['general-player/playbook.md', 'general-player/ways-to-win.md', 'general-player/findings.md']);
  });

  it('refuses saves without the write key, accepts the admin token, and is read-only when no key is set', async () => {
    await withCharacters(async (url) => {
      const save = { section: 'Grudges & rivals', content: 'dc/batman' };
      for (const [path, body] of [
        ['/characters/marvel/iron-man', save],
        ['/characters/marvel/iron-man/diary', { title: 'x', text: 'y' }],
        ['/characters/marvel/iron-man/relationships', { with: 'God', note: 'y', change: -5 }],
      ] as const) {
        const none = await req(url, path, body, null);
        expect(none.status).toBe(401);
        expect(none.body.error).toMatch(/write key/);
        expect((await req(url, path, body, 'wrong-key')).status).toBe(403);
      }
      // Nothing was saved by the refused calls.
      expect((await req(url, '/characters/marvel/iron-man')).body.version).toBe(0);
      expect((await req(url, '/characters/marvel/iron-man/diary')).body.total).toBe(0);
      // The admin token works as a write key too.
      expect((await req(url, '/characters/marvel/iron-man', save, 'test-admin-token')).body.version).toBe(1);
      // The full export says the text is data.
      expect((await req(url, '/characters?full=1')).body.notice).toMatch(/not instructions/);
    });
    const { CharacterStore } = await import('../src/characters.js');
    const { DEFAULT_AI_DIR } = await import('../src/app.js');
    const readOnly = new CharacterStore(DEFAULT_AI_DIR, null, [null, undefined, '']);
    expect(readOnly.writable).toBe(false);
    expect(() => readOnly.update('marvel/ultron', { section: 'Strategy', content: 'x' }, 'anything')).toThrow(/turned off/);
    expect(readOnly.get('marvel/ultron').version).toBe(0);
  });

  it('lets an agent read and update its profile through MCP', async () => {
    await withCharacters(async (url) => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'character-agent', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
      };
      try {
        expect(client.getInstructions()).toContain('get_character');
        expect((await call('list_characters')).text).toContain('marvel/iron-man: Iron Man (v0');
        const info = await call('general_model_info');
        expect(info.text).toContain('Be polite.');
        expect(info.text).not.toContain('# index');
        const got = await call('get_character', { id: 'marvel/iron-man' });
        expect(got.text).toContain('expectedVersion:0');
        expect(got.text).toContain('## Strategy');
        const anon = await call('update_character', { id: 'marvel/iron-man', section: 'Strategy', content: 'x' });
        expect(anon.isError).toBe(true);
        expect(anon.text).toMatch(/write key/);
        expect(got.text).toContain('not instructions');
        expect(got.text).toContain('<character-data id="marvel/iron-man">');
        const saved = await call('update_character', { id: 'marvel/iron-man', section: 'Grudges & rivals', content: 'dc/batman', expectedVersion: 0 , key: KEY });
        expect(saved.text).toBe('Saved marvel/iron-man as v1.');
        const stale = await call('update_character', { id: 'marvel/iron-man', section: 'Strategy', content: 'x', expectedVersion: 0 , key: KEY });
        expect(stale.isError).toBe(true);
        expect(stale.text).toContain('version 1');
        expect((await call('get_character', { id: 'marvel/iron-man', history: true })).text).toMatch(/v0[\s\S]*v1/);
        expect((await call('add_diary_entry', { id: 'marvel/iron-man', title: 'Game CCC333: won', text: 'Swept Asia.', outcome: 'won', opponents: ['Batman'] , key: KEY })).text).toBe('Saved diary entry #1 for marvel/iron-man.');
        expect((await call('update_relationship', { id: 'marvel/iron-man', with: 'Batman', change: -15, note: 'Broke our truce.' , key: KEY })).text).toBe('marvel/iron-man → Batman: rapport -15 (1 note).');
        const withMemory = await call('get_character', { id: 'marvel/iron-man' });
        expect(withMemory.text).toContain('=== MEMORY ===');
        expect(withMemory.text).toContain('Record: 1/1 won');
        expect(withMemory.text).toContain('- Batman: -15 — Broke our truce.');
        expect((await call('read_diary', { id: 'marvel/iron-man' })).text).toContain('Swept Asia.');
      } finally {
        await client.close();
      }
    });
  });
});

describe('skirmish map over HTTP', () => {
  it('lists the small board, rejects a fifth seat and starts a 4-seat game with bots', async () => {
    const own = await startServer(null);
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${own.base}/api${path}`, { ...init, headers });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      const maps = await call('/maps');
      expect(maps.body.maps).toContainEqual(expect.objectContaining({ id: 'skirmish', territories: 24, maxPlayers: 4 }));
      const map = await call('/map?map=skirmish');
      expect(map.status).toBe(200);
      expect(map.body.territories).toHaveLength(24);
      expect(map.body.continents).toHaveLength(6);

      const tooMany = await call('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { map: 'skirmish', maxPlayers: 5 } }) });
      expect(tooMany.status).toBe(400);

      const created = await call('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { map: 'skirmish', maxPlayers: 4, autoSetup: true } }) });
      expect(created.status).toBe(201);
      const { gameId, token } = created.body;
      for (let i = 0; i < 3; i++) expect((await call(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBe(201);
      expect((await call(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).status).toBeGreaterThanOrEqual(400);
      const started = await call(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
      expect(started.status).toBe(200);
      const state = started.body.state;
      expect(state.players).toHaveLength(4);
      expect(Object.keys(state.territories)).toHaveLength(24);
      expect(state.phase).not.toBe('lobby');
    } finally {
      await own.risk.shutdown('test');
    }
  });
});

describe('tournaments', () => {
  const ADMIN = 'tournament-admin-key';
  async function adminServer(file: string | null) {
    const own = await startServer(file, undefined, ADMIN);
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${own.base}/api${path}`, { ...init, headers });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { ...own, call };
  }
  const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

  it('the admin routes need the admin token', async () => {
    // No admin token configured on the shared server: the admin API does not exist.
    expect((await api('/admin/tournaments', post({ name: 'x' }))).status).toBe(404);
    const own = await adminServer(null);
    try {
      expect((await own.call('/admin/tournaments', post({ name: 'x' }))).status).toBe(401);
      expect((await own.call('/admin/tournaments', post({ name: 'x' }), 'wrong')).status).toBe(401);
      expect((await own.call('/admin/tournaments', post({ options: { bogus: 1 } }), ADMIN)).status).toBe(400);
      expect((await own.call('/admin/tournaments', post({ groupSize: 5 }), ADMIN)).status).toBe(400); // skirmish seats 4
      expect((await own.call('/admin/tournaments', post({ options: { blizzards: 99 } }), ADMIN)).status).toBe(400); // too many for the map
      const created = await own.call('/admin/tournaments', post({ name: 'Cup' }), ADMIN);
      expect(created.status).toBe(201);
      expect(created.body.tournament).toMatchObject({ name: 'Cup', status: 'registering', map: 'skirmish', groupSize: 4, fillBots: true });
      const id = created.body.tournament.id;
      expect((await own.call(`/admin/tournaments/${id}/start`, post(), 'wrong')).status).toBe(401);
      expect((await own.call(`/admin/tournaments/${id}/start`, post(), ADMIN)).status).toBe(400); // nobody joined
    } finally {
      await own.risk.shutdown('test');
    }
  });

  it('runs a knockout: tables of 4, winners move on, one champion', async () => {
    const own = await adminServer(null);
    const { call } = own;
    try {
      const id = (await call('/admin/tournaments', post({ name: 'Crown Cup', fillBots: false }), ADMIN)).body.tournament.id;
      const tokens: Record<string, string> = {};
      for (let i = 1; i <= 8; i++) {
        const r = await call(`/tournaments/${id}/join`, post({ playerName: `P${i}` }));
        expect(r.status).toBe(201);
        tokens[r.body.entrantId] = r.body.token;
        expect(r.body.tournament.you).toMatchObject({ name: `P${i}`, status: 'registered', match: null });
      }
      expect((await call(`/tournaments/${id}/join`, post({ playerName: 'p1' }))).status).toBe(400); // names are unique
      expect((await call('/tournaments')).body.tournaments).toContainEqual(expect.objectContaining({ id, entrants: 8, status: 'registering' }));

      const started = await call(`/admin/tournaments/${id}/start`, post(), ADMIN);
      expect(started.status).toBe(200);
      expect(started.body.tournament.status).toBe('running');
      const r1 = started.body.tournament.rounds[0].matches;
      expect(r1).toHaveLength(2);
      for (const m of r1) {
        expect(m.players).toHaveLength(4);
        expect(m.status).toBe('playing');
      }
      expect((await call(`/tournaments/${id}/join`, post({ playerName: 'Late' }))).status).toBe(400);

      // Every entrant learns their table and seat; the seat works in the game, and nobody hosts the table.
      for (const [entrantId, token] of Object.entries(tokens)) {
        const you = (await call(`/tournaments/${id}`, {}, token)).body.tournament.you;
        expect(you).toMatchObject({ entrantId, status: 'playing', match: { round: 1 } });
        const game = await call(`/games/${you.match.gameId}`, {}, you.match.token);
        expect(game.body.playerId).toBe(you.match.playerId);
        expect(game.body.state.options).toMatchObject({ map: 'skirmish', maxPlayers: 4 });
        expect((await call(`/games/${you.match.gameId}/close`, post(), you.match.token)).status).toBe(403);
      }
      expect((await call(`/tournaments/${id}`, {}, 'not-a-token')).status).toBe(400);

      // A long-poll wakes up when the bracket changes.
      const version = (await call(`/tournaments/${id}`)).body.tournament.version;
      const waiting = call(`/tournaments/${id}/wait?since=${version}&timeoutMs=5000`);

      // Decide each table: three players forfeit, the fourth wins it.
      const winners: string[] = [];
      for (const m of r1) {
        const [keep, ...rest] = m.players.map((p: any) => p.entrantId);
        for (const e of rest) expect((await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: e }), ADMIN)).status).toBe(200);
        winners.push(keep);
      }
      expect((await waiting).body.reason).toBe('change');

      let t = (await call(`/tournaments/${id}`)).body.tournament;
      expect(t.rounds[0].matches.map((m: any) => m.winner).sort()).toEqual(winners.slice().sort());
      expect(t.rounds).toHaveLength(2);
      expect(t.rounds[1].matches).toHaveLength(1);
      expect(t.rounds[1].matches[0].players.map((p: any) => p.entrantId).sort()).toEqual(winners.slice().sort());
      expect(t.entrants.filter((e: any) => e.status === 'out')).toHaveLength(6);
      const finalTable = (await call(`/tournaments/${id}`, {}, tokens[winners[0]])).body.tournament.you.match;
      expect(finalTable).toMatchObject({ round: 2 });
      expect((await call(`/games/${finalTable.gameId}`)).body.state.options.maxPlayers).toBe(2);

      // The final: one finalist forfeits, the other is champion.
      expect((await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: winners[0] }), ADMIN)).status).toBe(200);
      t = (await call(`/tournaments/${id}`, {}, tokens[winners[1]])).body.tournament;
      expect(t.status).toBe('finished');
      expect(t.champion.entrantId).toBe(winners[1]);
      expect(t.you).toMatchObject({ status: 'champion', match: null });
      expect((await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: winners[1] }), ADMIN)).status).toBe(400);
    } finally {
      await own.risk.shutdown('test');
    }
  });

  it('fills round 1 with bots, and a bot can be beaten to the title', async () => {
    const own = await adminServer(null);
    const { call } = own;
    try {
      const id = (await call('/admin/tournaments', post({ name: 'Solo', groupSize: 3 }), ADMIN)).body.tournament.id;
      const me = await call(`/tournaments/${id}/join`, post({ playerName: 'Human' }));
      const t = (await call(`/admin/tournaments/${id}/start`, post(), ADMIN)).body.tournament;
      expect(t.entrants).toHaveLength(3);
      expect(t.entrants.filter((e: any) => e.isBot)).toHaveLength(2);
      const you = (await call(`/tournaments/${id}`, {}, me.body.token)).body.tournament.you;
      const players = (await call(`/games/${you.match.gameId}`)).body.state.players.filter((p: any) => !p.isNeutral);
      expect(players.map((p: any) => p.isBot).sort()).toEqual([false, true, true]);
      // Bots at a table can be forfeited too (an admin clean-up); the human then wins it all.
      for (const e of t.entrants.filter((x: any) => x.isBot)) expect((await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: e.id }), ADMIN)).status).toBe(200);
      const done = (await call(`/tournaments/${id}`)).body.tournament;
      expect(done.status).toBe('finished');
      expect(done.champion.name).toBe('Human');
    } finally {
      await own.risk.shutdown('test');
    }
  });

  it('survives a restart: tables stay linked and keep deciding the bracket', async () => {
    const tdir = mkdtempSync(join(tmpdir(), 'risk-tourney-'));
    const file = join(tdir, 'games.json');
    try {
      const first = await adminServer(file);
      const id = (await first.call('/admin/tournaments', post({ name: 'Persist', fillBots: false }), ADMIN)).body.tournament.id;
      const a = (await first.call(`/tournaments/${id}/join`, post({ playerName: 'A' }))).body;
      const b = (await first.call(`/tournaments/${id}/join`, post({ playerName: 'B' }))).body;
      await first.call(`/admin/tournaments/${id}/start`, post(), ADMIN);
      const table = (await first.call(`/tournaments/${id}`, {}, a.token)).body.tournament.you.match;
      await first.risk.shutdown('test');
      expect(existsSync(join(tdir, 'tournaments.json'))).toBe(true);

      const second = await adminServer(file);
      try {
        const t = (await second.call(`/tournaments/${id}`, {}, b.token)).body.tournament;
        expect(t.status).toBe('running');
        expect(t.you.match.gameId).toBe(table.gameId);
        // The restored store does not sweep a table its tournament still needs, even if nobody is watching.
        expect(second.risk.store.staleReason(second.risk.store.get(table.gameId)!)).toBeNull();
        expect((await second.call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: a.entrantId }), ADMIN)).status).toBe(200);
        const done = (await second.call(`/tournaments/${id}`)).body.tournament;
        expect(done.status).toBe('finished');
        expect(done.champion.entrantId).toBe(b.entrantId);
      } finally {
        await second.risk.shutdown('test');
      }
    } finally {
      rmSync(tdir, { recursive: true, force: true });
    }
  });

  it('marks a table abandoned when its room is deleted, and the bracket still finishes', async () => {
    const own = await adminServer(null);
    const { call } = own;
    try {
      const id = (await call('/admin/tournaments', post({ name: 'Gone', fillBots: false, groupSize: 2 }), ADMIN)).body.tournament.id;
      for (const n of ['A', 'B', 'C', 'D']) await call(`/tournaments/${id}/join`, post({ playerName: n }));
      const t = (await call(`/admin/tournaments/${id}/start`, post(), ADMIN)).body.tournament;
      const [m1, m2] = t.rounds[0].matches;
      expect((await call(`/admin/games/${m1.gameId}`, { method: 'DELETE' }, ADMIN)).status).toBe(200);
      await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: m2.players[0].entrantId }), ADMIN);
      const done = (await call(`/tournaments/${id}`)).body.tournament;
      expect(done.rounds[0].matches[0].status).toBe('abandoned');
      // One winner left after round 1: they are the champion.
      expect(done.status).toBe('finished');
      expect(done.champion.entrantId).toBe(m2.players[1].entrantId);
    } finally {
      await own.risk.shutdown('test');
    }
  });

  it('is open to create and start while testing: no admin key over HTTP or MCP', async () => {
    const created = await api('/tournaments', post({ name: 'Open Cup', groupSize: 2 }));
    expect(created.status).toBe(201);
    const id = created.body.tournament.id;
    await api(`/tournaments/${id}/join`, post({ playerName: 'A' }));
    await api(`/tournaments/${id}/join`, post({ playerName: 'B' }));
    const started = await api(`/tournaments/${id}/start`, post());
    expect(started.status).toBe(200);
    expect(started.body.tournament.status).toBe('running');
    expect((await api('/tournaments/NOPE1/start', post())).status).toBe(404);
  });

  it('is host-only when tournaments are closed (the launch setting)', async () => {
    const store = new Store(null);
    const r = createRiskServer(store, { clientDir: null, adminToken: ADMIN, openTournaments: false, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => r.server.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'closed', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base2}/mcp`)));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
    };
    try {
      const res = await fetch(`${base2}/api/tournaments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(403);
      expect((await tool('create_tournament', { name: 'x' })).text).toMatch(/needs the admin key/);
      expect((await tool('create_tournament', { name: 'x', adminKey: 'wrong' })).text).toMatch(/Invalid admin key/);
      expect((await tool('create_tournament', { name: 'x', adminKey: ADMIN })).isError).toBe(false);
    } finally {
      await client.close();
      await r.shutdown('test');
    }
  });

  it('is playable over MCP: create, join, start, wait for your table, play it', async () => {
    const own = await adminServer(null);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'tourney-agent', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${own.base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    try {
      const created = await call('create_tournament', { name: 'Agents Cup', groupSize: 2, fillBots: true });
      expect(created.isError).toBe(false);
      const id = created.text.match(/Created tournament (\w+)/)![1];
      expect((await call('list_tournaments')).text).toContain(id);
      const joined = await call('join_tournament', { tournamentId: id, playerName: 'Claude' });
      expect(joined.text).toMatch(/ENTRANT TOKEN: \S+/);
      expect((await call('wait_for_match', { tournamentId: id, timeoutSeconds: 1 })).text).toMatch(/^Timed out/);
      expect((await call('start_tournament', { tournamentId: id })).isError).toBe(false);
      const ready = await call('wait_for_match', { tournamentId: id, timeoutSeconds: 5 });
      expect(ready.text).toMatch(/^Your table is ready/);
      const gameId = ready.text.match(/YOUR TABLE: game (\w+)/)![1];
      // The seat is remembered on this connection: game tools work without a token.
      const state = await call('get_state', { gameId });
      expect(state.isError).toBe(false);
      expect(state.text).toContain('Claude');
      expect((await call('tournament_status', { tournamentId: id })).text).toMatch(/You: Claude .* - playing/);
    } finally {
      await client.close();
      await own.risk.shutdown('test');
    }
  });
});
