import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { chooseBotAction, getMap } from '@risk/engine';
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
      // `id` works as well as `tournamentId`, in any case.
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', id: id.toLowerCase(), reqId: 'f' }));
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament_tables'))).toBe(true);
      expect(s.got.find((m) => m.reqId === 'f')).toMatchObject({ type: 'ack', ok: true });
      expect(s.got.find((m) => m.type === 'tournament').tournament).toMatchObject({ id, status: 'running' });
      const feed = s.got.find((m) => m.type === 'tournament_tables');
      expect(feed).toMatchObject({ tournamentId: id, full: true, round: { n: 1, deadline: null, finished: 0, needed: 2 } });
      expect(feed.tables).toHaveLength(2);
      for (const table of feed.tables) {
        expect(t.rounds[0].matches.map((m: any) => m.gameId)).toContain(table.gameId);
        // A knockout has no nested nodes.
        expect(table).toMatchObject({ node: null, round: 1, final: false });
        expect(['waiting', 'playing']).toContain(table.status);
        expect(table.excitement.score).toBeGreaterThanOrEqual(0);
        expect(table.excitement.score).toBeLessThanOrEqual(100);
        expect(table.players).toHaveLength(2);
        expect(Object.keys(table.players[0]).sort()).toEqual(['alive', 'color', 'name']);
        expect(table.owners).toHaveLength(getMap('skirmish').territoryIds.length);
        expect(table.owners.every((o: any) => o === null || o === 0 || o === 1)).toBe(true);
        expect([0, 1]).toContain(table.leader);
        // Armies per territory beside the owners (spectators see the whole board); no battle yet.
        expect(table.armies).toHaveLength(table.owners.length);
        expect(table.armies.every((n: any) => Number.isInteger(n) && n >= 0)).toBe(true);
        expect(table.lastAttack).toBeNull();
        // Public summaries only: no seat tokens, no cards, no player-type labels.
        expect(JSON.stringify(table)).not.toMatch(/token|cards|agent/);
      }
      // One table to follow, the same for every watcher, with a caption.
      expect(feed.follow).toMatchObject({ node: null, caption: expect.stringMatching(/^Following: /) });
      expect(feed.tables.map((x: any) => x.gameId)).toContain(feed.follow.gameId);
    } finally {
      s.ws.close();
    }
  });

  it('carries the armies of each table and its latest battle', async () => {
    const { id, t } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', id }));
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament_tables'))).toBe(true);
      const gameId = t.rounds[0].matches[0].gameId;
      const room = risk.store.get(gameId)!;
      // Play until the table has fought a battle.
      for (let i = 0; i < 400 && !room.history.some((h) => h.events.some((e) => e.type === 'battle')); i++) move(room);
      const ids = getMap(room.state.options.map).territoryIds;
      const battle = room.history.flatMap((h) => h.events).filter((e) => e.type === 'battle').at(-1) as { from: string; to: string };
      const latest = () => s.got.filter((m) => m.type === 'tournament_tables').flatMap((m) => m.tables).filter((x: any) => x.gameId === gameId).at(-1);
      expect(await s.until(() => latest()?.lastAttack != null, FEED_TABLE_MS * 6)).toBe(true);
      const table = latest();
      expect(table.lastAttack).toMatchObject({ from: ids.indexOf(battle.from), to: ids.indexOf(battle.to) });
      const now = JSON.stringify(ids.map((tid) => room.view(null).territories[tid].armies));
      expect(await s.until(() => JSON.stringify(latest()?.armies) === now, FEED_TABLE_MS * 6)).toBe(true);
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
      expect(s.got.some((m) => m.type === 'tournament_tables')).toBe(false);
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
      await s.until(() => s.got.some((m) => m.type === 'tournament_tables'));
      const gameId = t.rounds[0].matches[0].gameId;
      const room = risk.store.get(gameId)!;
      // A burst of five moves on one table.
      for (let i = 0; i < 5; i++) move(room);
      const last = room.state.version;
      const tableMsgs = () => s.got.filter((m) => m.type === 'tournament_tables' && !m.full && m.tables.some((x: any) => x.gameId === gameId));
      expect(await s.until(() => tableMsgs().length >= 1, 1_000)).toBe(true);
      // Within the throttle window only the first one went out.
      await new Promise((r) => setTimeout(r, FEED_TABLE_MS / 2));
      expect(tableMsgs()).toHaveLength(1);
      expect(await s.until(() => tableMsgs().length >= 2, 2_000)).toBe(true);
      await new Promise((r) => setTimeout(r, FEED_TABLE_MS + 200));
      const msgs = tableMsgs();
      expect(msgs).toHaveLength(2);
      // Only the table that changed, and the latest of the burst.
      expect(msgs[1].tables).toHaveLength(1);
      expect(msgs[1].tables[0].version).toBe(last);
      expect(msgs[1].version).toBeGreaterThan(msgs[0].version);
    } finally {
      s.ws.close();
    }
  });

  it('follows the bracket: a new round brings its tables, the final is marked', async () => {
    const { id, t } = await knockout();
    const s = await socket();
    try {
      s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, reqId: 'f' }));
      await s.until(() => s.got.some((m) => m.type === 'tournament_tables'));
      for (const m of t.rounds[0].matches) await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: m.players[0].entrantId }), ADMIN);
      expect(await s.until(() => s.got.some((m) => m.type === 'tournament' && m.tournament.rounds.length === 2))).toBe(true);
      const final = (await call(`/tournaments/${id}`)).body.tournament.rounds[1].matches[0];
      const room = risk.store.get(final.gameId)!;
      move(room);
      const finalMsg = () => s.got.find((m) => m.type === 'tournament_tables' && !m.full && m.tables.some((x: any) => x.gameId === final.gameId));
      expect(await s.until(() => !!finalMsg())).toBe(true);
      const table = finalMsg().tables[0];
      expect(table).toMatchObject({ round: 2, final: true });
      expect(table.excitement.signals.map((x: any) => x.kind)).toContain('final');
      expect(finalMsg().round).toMatchObject({ n: 2, needed: 1 });
      // The finished round's tables are gone; the follow moved to the final.
      expect(finalMsg().follow.gameId).toBe(final.gameId);
    } finally {
      s.ws.close();
    }
  });

  it('leaving the feed (or closing the socket) releases it', async () => {
    const { id } = await knockout();
    const s = await socket();
    s.ws.send(JSON.stringify({ type: 'subscribe_tournament', tournamentId: id, reqId: 'f' }));
    await s.until(() => s.got.some((m) => m.type === 'tournament_tables'));
    s.ws.send(JSON.stringify({ type: 'unsubscribe_tournament', reqId: 'u' }));
    expect(await s.until(() => s.got.some((m) => m.reqId === 'u'))).toBe(true);
    s.ws.close();
  });
});

describe('a backed-up socket', () => {
  it('skips deltas while backed up, then gets the whole feed again so no table is lost', async () => {
    const { TournamentFeeds } = await import('../src/tournament-feed.js');
    const store = new Store(null);
    const t = store.tournaments.create({ name: 'Slow Cup', groupSize: 2, fillBots: false });
    for (const n of ['A', 'B', 'C', 'D']) store.tournaments.join(t.id, n);
    store.tournaments.start(t.id);
    const feeds = new TournamentFeeds(store);
    const got: any[] = [];
    let backedUp = false;
    const sock = { send: (json: string) => (backedUp ? false : (got.push(JSON.parse(json)), true)) };
    const first = feeds.subscribe(t.id, sock);
    expect(first.ok).toBe(true);
    const [g1, g2] = t.rounds[0].matches.map((m) => store.get(m.gameId!)!);
    backedUp = true;
    move(g1); // a delta for table 1 is skipped
    expect(got).toHaveLength(0);
    backedUp = false;
    move(g2); // the next message: the whole feed instead of table 2's delta
    expect(got.map((m) => m.type)).toEqual(['tournament', 'tournament_tables']);
    expect(got[1].full).toBe(true);
    expect(got[1].tables.map((x: any) => x.gameId).sort()).toEqual([g1.id, g2.id].sort());
    expect(got[1].tables.find((x: any) => x.gameId === g1.id).version).toBe(g1.state.version);
    // Back to deltas after that.
    await new Promise((r) => setTimeout(r, FEED_TABLE_MS + 50));
    move(g1);
    expect(got.at(-1)).toMatchObject({ type: 'tournament_tables', full: false });
    feeds.unsubscribe(t.id, sock);
    expect(feeds.size).toBe(0);
    for (const r of [g1, g2]) r.close('admin');
  });
});

describe('nested node numbering', () => {
  it('matches the engine planToNest: each table points at its board in resolveNest order', async () => {
    const { planNest, planToNest, resolveNest } = await import('@risk/engine');
    const { nodeIndex } = await import('../src/tournament-feed.js');
    const plan = planNest(18);
    const { spec, boards } = planToNest(plan, { seed: 7 });
    const nodes = resolveNest(spec);
    const index = nodeIndex({ nested: { finalMap: null, territoriesPerSeat: 6, roundMinutes: 30, finishShare: 0.51, plan } });
    for (const [r, round] of plan.rounds.entries()) for (const table of round) expect(nodes[index.get(`${r}:${table.index}`)!]).toEqual(boards[r][table.index]);
    expect(index.get(`${plan.rounds.length - 1}:0`)).toBe(0); // the final is the outermost node
  });
});
