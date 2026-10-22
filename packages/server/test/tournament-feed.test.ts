import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { chooseBotAction } from '@risk/engine';
import type { GameRoom } from '../src/store.js';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { FEED_TABLE_MS } from '../src/tournament-feed.js';

const ADMIN = 'feed-admin';
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
let risk: RiskServer;
let base: string;

async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as any };
}

/** One legal move at a table (the built-in bot picks it for whoever is to move). */
function move(room: GameRoom) {
  const cur = room.state.currentPlayer!;
  room.act(cur, chooseBotAction(room.state, cur)!);
}

/** A socket that collects every message. */
async function socket() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const got: any[] = [];
  ws.on('message', (raw) => got.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const until = async (pred: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return pred();
  };
  return { ws, got, until };
}

/** A started knockout of 4 people at tables of 2. */
async function knockout() {
  const id = (await call('/admin/tournaments', post({ name: 'Feed Cup', groupSize: 2, fillBots: false }), ADMIN)).body.tournament.id;
  const tokens: Record<string, string> = {};
  for (const n of ['Ann', 'Bob', 'Cat', 'Dan']) {
    const j = (await call(`/tournaments/${id}/join`, post({ playerName: n }))).body;
    tokens[j.entrantId] = j.token;
  }
  const t = (await call(`/admin/tournaments/${id}/start`, post(), ADMIN)).body.tournament;
  return { id, t, tokens };
}

beforeEach(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
});

describe('tournament feed over WebSocket', () => {
  it('a spectator gets the bracket and every table with its excitement score', async () => {
    const { id, t } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id.toLowerCase(), reqId: 'f' }));
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament_feed'))).toBe(true);
      expect(s.got.find((m) => m.reqId === 'f')).toMatchObject({ type: 'ack', ok: true });
      const feed = s.got.find((m) => m.type === 'tournament_feed');
      expect(feed.tournament).toMatchObject({ id, status: 'running' });
      expect(feed.tables).toHaveLength(2);
      for (const table of feed.tables) {
        expect(t.rounds[0].matches.map((m: any) => m.gameId)).toContain(table.gameId);
        expect(table).toMatchObject({ round: 1, status: 'playing', final: false });
        expect(table.excitement.score).toBeGreaterThanOrEqual(0);
        expect(table.excitement.score).toBeLessThanOrEqual(100);
        expect(table.players).toHaveLength(2);
        // Public summaries only: no seat tokens, no cards, no player-type labels.
        expect(JSON.stringify(table)).not.toMatch(/token|cards|agent/);
      }
    } finally {
      s.ws.close();
    }
  });

  it('is for spectators only: an entrant token is refused', async () => {
    const { id, tokens } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, token: Object.values(tokens)[0], reqId: 'x' }));
      expect(await s.until(() => s.got.some((m) => m.reqId === 'x'))).toBe(true);
      expect(s.got.find((m) => m.reqId === 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/spectators/) });
      expect(s.got.some((m) => m.type === 'tournament_feed')).toBe(false);
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: 'TNOPE1', reqId: 'y' }));
      expect(await s.until(() => s.got.some((m) => m.reqId === 'y'))).toBe(true);
      expect(s.got.find((m) => m.reqId === 'y')).toMatchObject({ ok: false, error: 'Tournament not found' });
    } finally {
      s.ws.close();
    }
  });

  it('sends a table at most twice a second, and the last change of a burst always arrives', async () => {
    const { id, t } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, reqId: 'f' }));
      await s.until(() => s.got.some((m) => m.type === 'tournament_feed'));
      const gameId = t.rounds[0].matches[0].gameId;
      const room = risk.store.get(gameId)!;
      // A burst of five moves on one table.
      for (let i = 0; i < 5; i++) move(room);
      const last = room.state.version;
      const tableMsgs = () => s.got.filter((m) => m.type === 'tournament_table' && m.table.gameId === gameId);
      expect(await s.until(() => tableMsgs().length >= 1, 1_000)).toBe(true);
      // Within the throttle window only the first one went out.
      await new Promise((r) => setTimeout(r, FEED_TABLE_MS / 2));
      expect(tableMsgs()).toHaveLength(1);
      expect(await s.until(() => tableMsgs().length >= 2, 2_000)).toBe(true);
      await new Promise((r) => setTimeout(r, FEED_TABLE_MS + 200));
      const msgs = tableMsgs();
      expect(msgs).toHaveLength(2);
      expect(msgs[1].table.version).toBe(last);
    } finally {
      s.ws.close();
    }
  });

  it('follows the bracket: a new round brings its tables, the final is marked', async () => {
    const { id, t } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, reqId: 'f' }));
      await s.until(() => s.got.some((m) => m.type === 'tournament_feed'));
      for (const m of t.rounds[0].matches) await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: m.players[0].entrantId }), ADMIN);
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament' && m.tournament.rounds.length === 2))).toBe(true);
      const final = (await call(`/tournaments/${id}`)).body.tournament.rounds[1].matches[0];
      const room = risk.store.get(final.gameId)!;
      move(room);
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament_table' && m.table.gameId === final.gameId))).toBe(true);
      const msg = s.got.find((m) => m.type === 'tournament_table' && m.table.gameId === final.gameId);
      expect(msg.table).toMatchObject({ round: 2, final: true });
      expect(msg.table.excitement.signals.map((x: any) => x.kind)).toContain('final');
    } finally {
      s.ws.close();
    }
  });

  it('leaving the feed (or closing the socket) releases it', async () => {
    const { id } = await knockout();
    const s = await socket();
    s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, reqId: 'f' }));
    await s.until(() => s.got.some((m) => m.type === 'tournament_feed'));
    s.ws.send(JSON.stringify({ type: 'unsubscribe_tournament', reqId: 'u' }));
    expect(await s.until(() => s.got.some((m) => m.reqId === 'u'))).toBe(true);
    s.ws.close();
  });
});
