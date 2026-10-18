import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';

const MIN = 60_000;
const ADMIN = 'cleanup-admin';

let risk: RiskServer;
let base: string;

async function call(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  return { status: res.status, body: await res.json() };
}
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

// Only Date is faked: sockets, fetch and long-poll timers stay real. Sweeps are run by hand.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  risk = createRiskServer(new Store(null), { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
  vi.useRealTimers();
});

async function lobby() {
  const created = await call('/games', post({ playerName: 'Host' }));
  const id: string = created.body.gameId;
  const host = created.body.token as string;
  const guest = (await call(`/games/${id}/join`, post({ playerName: 'Guest' }))).body.token as string;
  return { id, host, guest };
}

async function subscribe(id: string, token?: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: id, token, reqId: 'a' })));
    ws.on('message', (raw) => JSON.parse(String(raw)).reqId === 'a' && resolve());
    ws.on('error', reject);
  });
  return ws;
}

describe('room cleanup: abandoned and finished rooms', () => {
  it('closes a lobby when every seat has been gone for 2 minutes, not at 1', async () => {
    const { id } = await lobby();
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
    expect(risk.store.get(id)).toBeUndefined();
  });

  it('an authenticated request resets the 2 minute clock; a spectator request does not', async () => {
    const { id, host } = await lobby();
    advance(100_000);
    expect((await call(`/games/${id}`, {}, host)).status).toBe(200);
    advance(100_000);
    expect(risk.store.sweep()).toEqual([]);
    await call(`/games/${id}`);
    advance(30_000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
  });

  it('a seat long-polling /wait keeps the room alive for the whole poll', async () => {
    const { id, host } = await lobby();
    const version = risk.store.get(id)!.state.version;
    const poll = fetch(`${base}/api/games/${id}/wait?since=${version}&timeoutMs=4000`, { headers: { authorization: `Bearer ${host}` } });
    await new Promise((r) => setTimeout(r, 150));
    advance(10 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    // Once the poll ends the clock starts again from that moment.
    risk.store.get(id)!.releaseWaiters();
    expect((await poll).status).toBe(200);
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
  });

  it('a WebSocket-connected seat keeps the room alive until it disconnects', async () => {
    const { id, host } = await lobby();
    const ws = await subscribe(id, host);
    advance(10 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    ws.close();
    await vi.waitFor(() => expect(risk.store.get(id)!.seatAttached()).toBe(false));
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
  });

  it('a spectator socket alone does not keep the room alive', async () => {
    const { id } = await lobby();
    const ws = await subscribe(id);
    advance(2 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
    ws.close();
  });

  it('applies to running games too; closing notifies listeners and removes the room', async () => {
    const { id, host } = await lobby();
    expect((await call(`/games/${id}/start`, post(), host)).status).toBe(200);
    const room = risk.store.get(id)!;
    room.stopBot();
    let reason: string | null = null;
    room.on('closed', (r) => (reason = r));
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
    expect(reason).toBe('idle');
    expect(room.closed).toBe(true);
    expect(risk.store.list().some((g) => g.id === id)).toBe(false);
    expect((await call(`/games/${id}`)).status).toBe(404);
  });

  it('closes a finished game 2 minutes after it ended, even with seats and spectators attached', async () => {
    const { id, host, guest } = await lobby();
    await call(`/games/${id}/start`, post(), host);
    const room = risk.store.get(id)!;
    room.stopBot();
    room.connections = 1;
    room.seatSocket(room.tokens.get(host)!, 1);
    room.seatSocket(room.tokens.get(guest)!, 1);
    const cur = room.state.currentPlayer!;
    const curTok = room.tokens.get(host) === cur ? host : guest;
    // Surrender ends a 2-player game; only the finished rule can close it since both seats stay attached.
    expect((await call(`/games/${id}/actions`, post({ action: { type: 'surrender' } }), curTok)).status).toBe(200);
    expect(room.state.phase).toBe('finished');
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([id]);
  });

  it('0 disables both rules', () => {
    const store = new Store(null, { finishedClose: 0, abandonedClose: 0 });
    const { room } = store.create('keep', {}, 'Host');
    advance(50 * MIN);
    expect(store.sweep()).toEqual([]);
    expect(store.get(room.id)).toBeDefined();
    store.stopTimers();
  });

  it('leaves a bots-only game to the bots-only rule, not the 2 minute rule', () => {
    const store = new Store(null);
    const { room } = store.create('bots', {}, 'Human');
    room.join('B1', true);
    room.join('B2', true);
    room.start();
    room.stopBot();
    room.act(room.state.players.find((p) => !p.isBot)!.id, { type: 'surrender' });
    expect(room.botsOnly()).toBe(true);
    advance(5 * MIN);
    expect(store.sweep()).toEqual([]);
    advance(30 * MIN);
    expect(store.sweep().map((r) => r.id)).toEqual([room.id]);
    store.stopTimers();
  });
});

describe('room cleanup: tournament tables', () => {
  it('keeps a running table, records the result, then closes the finished table', async () => {
    const id = (await call('/admin/tournaments', post({ name: 'Cup', fillBots: false, groupSize: 2 }), ADMIN)).body.tournament.id;
    const a = (await call(`/tournaments/${id}/join`, post({ playerName: 'A' }))).body;
    await call(`/tournaments/${id}/join`, post({ playerName: 'B' }));
    await call(`/admin/tournaments/${id}/start`, post(), ADMIN);
    const you = (await call(`/tournaments/${id}`, {}, a.token)).body.tournament.you.match;
    const room = risk.store.get(you.gameId)!;
    room.stopBot();
    // Nobody is at the table, yet the tournament still needs it.
    advance(10 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    // Whoever's turn it is surrenders; the other seat wins a two-player table.
    const [loser] = [...room.tokens].find(([, pid]) => pid === room.state.currentPlayer)!;
    expect((await call(`/games/${you.gameId}/actions`, post({ action: { type: 'surrender' } }), loser)).status).toBe(200);
    const done = (await call(`/tournaments/${id}`)).body.tournament;
    expect(done.status).toBe('finished');
    expect(done.rounds[0].matches[0].status).toBe('finished');
    const champion = done.champion.entrantId;
    advance(1 * MIN);
    expect(risk.store.sweep()).toEqual([]);
    advance(1 * MIN + 1000);
    expect(risk.store.sweep().map((r) => r.id)).toEqual([you.gameId]);
    // The result outlives the table.
    const after = (await call(`/tournaments/${id}`)).body.tournament;
    expect(after.champion.entrantId).toBe(champion);
    expect(after.rounds[0].matches[0].winner).toBe(champion);
  });
});
