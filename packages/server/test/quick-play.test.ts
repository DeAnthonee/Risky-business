import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { DEFAULT_QUICK_PLAY, quickPlayConfigFromEnv } from '../src/quick-play.js';

let dir: string;
let risk: RiskServer;
let base: string;

async function api(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : {} };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const join_ = (body: Record<string, unknown>) => api('/queue', post(body));
const wait = (ticket: string, token: string, timeoutMs = 5000) => api(`/queue/${ticket}?timeoutMs=${timeoutMs}`, {}, token);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-quick-'));
  risk = createRiskServer(new Store(join(dir, 'games.json')), { clientDir: null, sweepIntervalMs: 0 });
  // A short window, so a lone entrant is seated within the test.
  risk.store.quickPlay.config.waitMs = 300;
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

describe('quick play (POST /api/queue)', () => {
  it('a lone agent is seated within the window, the empty seats filled with Zergs, the turn timer on', async () => {
    const joined = await join_({ playerName: 'Ada', agent: 'claude-test', seats: 4 });
    expect(joined.status).toBe(201);
    expect(joined.body.ticket).toMatchObject({ status: 'waiting', name: 'Ada', map: 'classic', seats: 4, fog: false, waiting: 1 });
    expect(joined.body.ticket.startsAt).toBeGreaterThan(Date.now() - 1000);
    expect(joined.body.ticket.seatToken).toBeUndefined();

    const started = Date.now();
    const seated = (await wait(joined.body.ticket.ticket, joined.body.token)).body.ticket;
    expect(seated.status).toBe('seated');
    expect(Date.now() - started).toBeLessThan(3000);

    const room = risk.store.get(seated.gameId)!;
    expect(room.quickPlay).toBe(true);
    expect(room.hostId).toBe('');
    expect(room.state.phase).not.toBe('lobby');
    expect(room.state.options).toMatchObject({ map: 'classic', maxPlayers: 4, fogOfWar: false, autoSetup: true, turnTimer: 'move', turnTimerSeconds: DEFAULT_QUICK_PLAY.timerSeconds });
    const players = room.state.players.filter((p) => !p.isNeutral);
    expect(players).toHaveLength(4);
    expect(players.filter((p) => p.id.startsWith('zerg_'))).toHaveLength(3);
    expect(new Set(players.map((p) => p.name)).size).toBe(4);
    expect(room.agents[seated.playerId]).toBe('claude-test');
    expect(room.summary().quickPlay).toBe(true);

    // The seat token plays the seat, like a joined game's token.
    const g = (await api(`/games/${seated.gameId}`, {}, seated.seatToken)).body;
    expect(g.playerId).toBe(seated.playerId);
    // The ticket token is not a seat token.
    expect((await api(`/games/${seated.gameId}`, {}, joined.body.token)).body.playerId ?? null).toBeNull();
  });

  it('two agents waiting for the same game share one room; a different game waits apart', async () => {
    risk.store.quickPlay.config.waitMs = 1500;
    const a = (await join_({ playerName: 'Ada', seats: 4 })).body;
    const b = (await join_({ playerName: 'Ada', seats: 4 })).body;
    const c = (await join_({ playerName: 'Cy', seats: 4, fog: true })).body;
    expect(b.ticket.waiting).toBe(2);
    expect(b.ticket.name).toBe('Ada 2');
    expect(c.ticket.waiting).toBe(1);
    expect((await api('/queue')).body.waiting).toHaveLength(2);

    const [sa, sb, sc] = (await Promise.all([wait(a.ticket.ticket, a.token), wait(b.ticket.ticket, b.token), wait(c.ticket.ticket, c.token)])).map((r) => r.body.ticket);
    expect(sa.status).toBe('seated');
    expect(sb.gameId).toBe(sa.gameId);
    expect(sb.playerId).not.toBe(sa.playerId);
    expect(sc.gameId).not.toBe(sa.gameId);
    const room = risk.store.get(sa.gameId)!;
    expect(room.state.players.filter((p) => !p.isBot)).toHaveLength(2);
    expect(room.state.players.filter((p) => p.id.startsWith('zerg_'))).toHaveLength(2);
    expect(risk.store.get(sc.gameId)!.state.options.fogOfWar).toBe(true);
    expect((await api('/queue')).body.waiting).toHaveLength(0);
  });

  it('a full table starts at once, without waiting for the window', async () => {
    risk.store.quickPlay.config.waitMs = 60_000;
    const a = (await join_({ playerName: 'Ada', seats: 2 })).body;
    const b = (await join_({ playerName: 'Bo', seats: 2 })).body;
    expect(b.ticket.status).toBe('seated');
    const sa = (await wait(a.ticket.ticket, a.token, 0)).body.ticket;
    expect(sa.status).toBe('seated');
    expect(sa.gameId).toBe(b.ticket.gameId);
    expect(risk.store.get(sa.gameId)!.state.players.filter((p) => p.isBot)).toHaveLength(0);
  });

  it('checks the request, the ticket token, and lets a waiting entrant leave', async () => {
    expect((await join_({ seats: 1 })).status).toBe(400);
    expect((await join_({ seats: 99 })).status).toBe(400);
    expect((await join_({ map: 'nowhere' })).status).toBe(400);
    expect((await join_({ fog: 'yes' })).status).toBe(400);

    risk.store.quickPlay.config.waitMs = 60_000;
    const a = (await join_({ playerName: 'Ada' })).body;
    expect((await wait(a.ticket.ticket, 'not-the-token', 0)).status).toBe(404);
    expect((await api(`/queue/${a.ticket.ticket}`, { method: 'DELETE' }, 'not-the-token')).status).toBe(404);
    expect((await api(`/queue/${a.ticket.ticket}`, { method: 'DELETE' }, a.token)).body).toEqual({ ok: true });
    expect((await wait(a.ticket.ticket, a.token, 0)).status).toBe(404);
    expect((await api('/queue')).body.waiting).toHaveLength(0);
  });

  it('caps the live quick-play rooms (503 when full)', async () => {
    risk.store.quickPlay.config.waitMs = 60_000;
    risk.store.quickPlay.config.maxRooms = 1;
    const a = (await join_({ playerName: 'Ada', seats: 2 })).body;
    // Joining the waiting table is fine; a second table is not.
    expect((await join_({ playerName: 'Cy', seats: 3 })).status).toBe(503);
    const b = (await join_({ playerName: 'Bo', seats: 2 })).body;
    expect(b.ticket.status).toBe('seated');
    expect((await wait(a.ticket.ticket, a.token, 0)).body.ticket.status).toBe('seated');
    // The running room counts until it ends.
    expect((await join_({ playerName: 'Cy', seats: 3 })).status).toBe(503);
    risk.store.delete(b.ticket.gameId, 'admin');
    expect((await join_({ playerName: 'Cy', seats: 3 })).status).toBe(201);
  });

  it('drops a ticket nobody polls: a dead client never takes a seat', async () => {
    risk.store.quickPlay.config.waitMs = 400;
    risk.store.quickPlay.config.staleMs = 50;
    const live = (await join_({ playerName: 'Live', seats: 4 })).body;
    const dead = (await join_({ playerName: 'Dead', seats: 4 })).body;
    const seated = (await wait(live.ticket.ticket, live.token)).body.ticket;
    expect(seated.status).toBe('seated');
    const room = risk.store.get(seated.gameId)!;
    expect(room.state.players.filter((p) => !p.isBot).map((p) => p.name)).toEqual(['Live']);
    expect(room.state.players.filter((p) => p.id.startsWith('zerg_'))).toHaveLength(3);
    expect((await wait(dead.ticket.ticket, dead.token, 0)).status).toBe(404);
  });

  it('caps the waiting tickets per client (429)', async () => {
    risk.store.quickPlay.config.waitMs = 60_000;
    for (const seats of [2, 3, 4]) expect((await join_({ playerName: 'Ada', seats })).status).toBe(201);
    const over = await join_({ playerName: 'Ada', seats: 5 });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/per client/);
  });

  it('a finished quick-play game is not ranked (house players never count on a leaderboard)', async () => {
    const a = (await join_({ playerName: 'Ada', seats: 3 })).body;
    const seated = (await wait(a.ticket.ticket, a.token)).body.ticket;
    // Ada leaves the game: only Zergs are left, so it ends at once by standing.
    await api(`/games/${seated.gameId}/actions`, post({ action: { type: 'surrender' } }), seated.seatToken);
    const room = risk.store.get(seated.gameId)!;
    expect(room.state.phase).toBe('finished');
    expect(room.state.winner).toMatch(/^zerg_/);
    expect((await api('/rankings')).body.rankings).toEqual([]);
  });

  it('the sweep leaves a running quick-play room whose seats are away: its turn timer moves for them', async () => {
    const a = (await join_({ playerName: 'Ada', seats: 3 })).body;
    const seated = (await wait(a.ticket.ticket, a.token)).body.ticket;
    const room = risk.store.get(seated.gameId)!;
    const later = Date.now() + 10 * 60_000;
    expect(risk.store.staleReason(room, later)).toBeNull();
    // Without the timer it would be an abandoned room like any other.
    room.quickPlay = false;
    expect(risk.store.staleReason(room, later)).toMatch(/every seat gone/);
  });

  it('reads its settings from RISK_QUICKPLAY_* (bad values keep the defaults)', () => {
    expect(quickPlayConfigFromEnv({})).toEqual(DEFAULT_QUICK_PLAY);
    expect(quickPlayConfigFromEnv({ RISK_QUICKPLAY_WAIT_S: '30', RISK_QUICKPLAY_TIMER_S: '45', RISK_QUICKPLAY_MAX_ROOMS: '5' })).toEqual({ ...DEFAULT_QUICK_PLAY, waitMs: 30_000, timerSeconds: 45, maxRooms: 5 });
    expect(quickPlayConfigFromEnv({ RISK_QUICKPLAY_WAIT_S: 'soon', RISK_QUICKPLAY_TIMER_S: '1', RISK_QUICKPLAY_MAX_ROOMS: '-1' })).toEqual(DEFAULT_QUICK_PLAY);
  });
});

describe('quick play over MCP (quick_play)', () => {
  it('seats the agent and remembers the seat on the connection', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'quick', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((x) => x.text).join('\n');
    try {
      const out = await call('quick_play', { playerName: 'Mcp Ada', seats: 3, timeoutSeconds: 10 });
      expect(out).toMatch(/Seated by quick play in game [A-Z0-9]{6}/);
      const gameId = out.match(/in game ([A-Z0-9]{6})/)![1];
      const room = risk.store.get(gameId)!;
      expect(room.quickPlay).toBe(true);
      expect(room.state.players.filter((p) => p.id.startsWith('zerg_'))).toHaveLength(2);
      // The token it printed is the seat's.
      const me = room.state.players.find((p) => p.name === 'Mcp Ada')!;
      expect(out).toContain(me.id);
      expect(await call('my_seats', {})).toContain(gameId);
      expect(await call('quick_play', { leave: true })).toMatch(/not waiting/);
    } finally {
      await mcp.close();
    }
  });
});
