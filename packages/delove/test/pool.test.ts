import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../../server/src/store.js';
import { createRiskServer } from '../../server/src/app.js';
import { ChildPool, SeatPool, type ChildLike, type PoolEntrant, type ToChild } from '../src/pool.js';
import type { EntrantResult } from '../src/tournament-seat.js';

// Fake values, set only here (the real key lives only in the server's and the pool's environment).
const KEY = 'test-pool-key';
const ADMIN = 'test-admin-token';
const dir = mkdtempSync(join(tmpdir(), 'delove-pool-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function serve(seatPoolKey: string | null = KEY) {
  const risk = createRiskServer(new Store(null), {
    clientDir: null,
    sweepIntervalMs: 0,
    adminToken: ADMIN,
    openTournaments: false,
    seatPoolKey,
    tourneyAccess: { adminCode: 'x-admin', limitedCode: 'x-limited', maxActive: 0, maxActiveLimited: 0, maxLiveSeats: 0, createsPerDay: 0, lagBrakeMs: 0, deloveAdmin: 40, deloveLimited: 16, deloveAtOnce: 48, deloveSearchAtOnce: 20 },
  });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const create = async (spec: Record<string, unknown>) => (await call('POST', '/admin/tournaments', { name: 'Pool cup', ...spec }, { authorization: `Bearer ${ADMIN}` })).body.tournament;
  const requests = async () => (await call('GET', '/seat-requests', undefined, { 'x-seat-pool-key': KEY })).body;
  return { risk, server, call, create, requests };
}

/** A play() that never ends by itself: each seat's game is "in play" until `end` is called for it. */
function stubPlay() {
  const playing: PoolEntrant[] = [];
  const ends = new Map<string, (r: EntrantResult) => void>();
  const play = (e: PoolEntrant) => {
    playing.push(e);
    return new Promise<EntrantResult>((resolve) => ends.set(e.name, resolve));
  };
  const end = (name: string) => ends.get(name)?.({ name, status: 'out', tables: 1 });
  return { playing, play, end };
}

describe('the Delove seat pool (pool.ts) against the seat-request routes', () => {
  it('polls with its capacity, claims, joins the seats with the request and its labels, reports done', async () => {
    const s = await serve();
    try {
      const t = await s.create({ delove: 3, maxEntrants: 8 });
      const st = stubPlay();
      const logs: string[] = [];
      const pool = new SeatPool({ server: s.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 2, play: st.play, log: (l) => logs.push(l) });
      await pool.tick();
      expect(pool.lastError).toBeNull();
      expect(st.playing.map((e) => e.name)).toEqual(['Delove 1', 'Delove 2', 'Delove 3']);
      expect(st.playing.map((e) => e.agentId)).toEqual(['delove@12+search', 'delove@12+search', 'delove@12']); // fog off: 2 search seats (maxSearch)
      const bracket = (await s.call('GET', `/tournaments/${t.id}`)).body.tournament;
      expect(bracket.entrants.map((e: { name: string }) => e.name)).toEqual(['Delove 1', 'Delove 2', 'Delove 3']);
      expect((await s.requests()).requests).toEqual([]); // done: no longer open
      expect(pool.free).toEqual({ free: 7, freeSearch: 0 });
      await pool.tick(); // the next poll reports what is left
      expect((await s.requests()).pool).toMatchObject({ online: true, free: 7, freeSearch: 0 });
      st.end('Delove 3');
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.free).toEqual({ free: 8, freeSearch: 0 }); // a seat whose tournament ended frees its place
      expect(logs.some((l) => l.includes('3/3 seats joined, 2 with search'))).toBe(true);
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('a claim it cannot fill is reported failed, and the seats it did not join go back to the request', async () => {
    const s = await serve();
    try {
      const t = await s.create({ delove: 3, maxEntrants: 4 });
      for (const n of ['Alice', 'Bob']) expect((await s.call('POST', `/tournaments/${t.id}/join`, { playerName: n })).status).toBe(201);
      const st = stubPlay();
      const pool = new SeatPool({ server: s.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play });
      await pool.tick();
      expect(st.playing.map((e) => e.name)).toEqual(['Delove 1', 'Delove 2']); // the table was full after two
      const [r] = (await s.requests()).requests;
      expect(r).toMatchObject({ tournamentId: t.id, n: 3, claimed: 2, status: 'open' });
      expect(r.reason).toMatch(/Delove 3/);
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('fog: only a fog-trained network takes fog seats, always bare; a fog-blind pool leaves them', async () => {
    const s = await serve();
    try {
      const t = await s.create({ delove: 2, maxEntrants: 8, options: { fogOfWar: true } });
      const blind = stubPlay();
      const logs: string[] = [];
      await new SeatPool({ server: s.server, key: KEY, model: 'delove@11', modelFog: false, maxSeats: 10, maxSearch: 10, play: blind.play, log: (l) => logs.push(l) }).tick();
      expect(blind.playing).toEqual([]);
      expect((await s.requests()).requests[0]).toMatchObject({ tournamentId: t.id, claimed: 0 });
      expect(logs.some((l) => l.includes('not fog-trained'))).toBe(true);
      const fog = stubPlay();
      await new SeatPool({ server: s.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 10, play: fog.play }).tick();
      expect(fog.playing.map((e) => [e.agentId, e.search])).toEqual([['delove@12', false], ['delove@12', false]]); // no search under fog
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('without the key on the server the routes are off (404); a wrong key is refused (403); neither throws', async () => {
    const off = await serve(null);
    try {
      const pool = new SeatPool({ server: off.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 0, play: stubPlay().play });
      await pool.tick();
      expect((pool.lastError as { status?: number }).status).toBe(404);
    } finally {
      await off.risk.shutdown('test');
    }
    const s = await serve();
    try {
      const logs: string[] = [];
      const pool = new SeatPool({ server: s.server, key: 'wrong', model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 0, play: stubPlay().play, log: (l) => logs.push(l) });
      await pool.tick();
      expect((pool.lastError as { status?: number }).status).toBe(403);
      expect(logs.join('\n')).not.toContain('wrong'); // the key is never logged
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('keeps its seats in a state file and plays them on after a restart', async () => {
    const s = await serve();
    try {
      await s.create({ delove: 2, maxEntrants: 8 });
      const stateFile = join(dir, 'state.json');
      const first = stubPlay();
      const a = new SeatPool({ server: s.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 0, play: first.play, stateFile });
      await a.tick();
      a.stop(); // SIGTERM: the seats stay in the file
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')).entrants as PoolEntrant[];
      expect(saved.map((e) => e.name)).toEqual(['Delove 1', 'Delove 2']);
      expect(JSON.stringify(saved)).not.toContain(KEY);
      const again = stubPlay();
      const b = new SeatPool({ server: s.server, key: KEY, model: 'delove@12', modelFog: true, maxSeats: 10, maxSearch: 0, play: again.play, stateFile });
      expect(b.resume()).toBe(2);
      expect(again.playing.map((e) => e.token)).toEqual(saved.map((e) => e.token));
      expect(b.free.free).toBe(8);
    } finally {
      await s.risk.shutdown('test');
    }
  });
});

describe('ChildPool: seats over child processes', () => {
  class FakeChild extends EventEmitter implements ChildLike {
    static n = 0;
    pid = ++FakeChild.n;
    got: ToChild[] = [];
    send(m: unknown) {
      this.got.push(m as ToChild);
      return true;
    }
    kill() {
      return true;
    }
  }
  const seat = (name: string, search = false): PoolEntrant => ({ tournamentId: 'T1', requestId: 'r', name, token: `tok-${name}`, agentId: 'delove@12', search });

  it('spreads the seats (search seats weigh more), and hands a dead child seats to a new one', async () => {
    const made: FakeChild[] = [];
    const pool = new ChildPool(2, () => {
      const c = new FakeChild();
      made.push(c);
      return c;
    }, 'http://x', 0);
    const results = [pool.play(seat('A', true)), pool.play(seat('B')), pool.play(seat('C')), pool.play(seat('D'))];
    expect(made.length).toBe(2);
    expect(made[0].got.map((m) => m.entrant.name)).toEqual(['A']); // the search seat counts 4: its child gets no more
    expect(made[1].got.map((m) => m.entrant.name)).toEqual(['B', 'C', 'D']);
    made[1].emit('exit', 1); // child 2 crashes
    expect(made.length).toBe(3); // replaced
    expect(made[2].got.map((m) => m.entrant.name).sort()).toEqual(['B', 'C', 'D']); // with its seats, tokens and all
    expect(made[2].got[0].entrant.token).toBe('tok-B');
    made[2].emit('message', { type: 'end', key: 'T1/B', result: { name: 'B', status: 'out', tables: 2 } });
    await expect(results[1]).resolves.toMatchObject({ name: 'B', status: 'out' });
    made[0].emit('message', { type: 'error', key: 'T1/A', message: 'boom' });
    await expect(results[0]).rejects.toThrow('boom');
  });
});
