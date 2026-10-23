import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Store } from '../../server/src/store.js';
import { createRiskServer } from '../../server/src/app.js';
import { SeatPool, type PoolEntrant } from '../src/pool.js';
import type { EntrantResult } from '../src/tournament-seat.js';

// Fake values, set only here (the real keys live only in the server's and the pool's environment).
const KEY = 'test-pool-key';
const ADMIN = 'test-admin-token';

async function serve() {
  const risk = createRiskServer(new Store(null), {
    clientDir: null,
    sweepIntervalMs: 0,
    adminToken: ADMIN,
    openTournaments: false,
    seatPoolKey: KEY,
    tourneyAccess: { adminCode: 'x-admin', limitedCode: 'x-limited', maxActive: 0, maxActiveLimited: 0, maxLiveSeats: 0, createsPerDay: 0, lagBrakeMs: 0, deloveAdmin: 40, deloveLimited: 16, deloveAtOnce: 48, deloveSearchAtOnce: 20 },
  });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const admin = { authorization: `Bearer ${ADMIN}` };
  const roster = async (model: string, count: number) => (await call('POST', '/admin/roster', { model, count }, admin)).body.created as { id: string; name: string; model: string }[];
  const create = async (spec: Record<string, unknown>) => (await call('POST', '/admin/tournaments', { name: 'Daily', ...spec }, admin)).body.tournament;
  return { risk, server, call, admin, roster, create };
}

function stubPlay() {
  const playing: PoolEntrant[] = [];
  return { playing, play: (e: PoolEntrant) => (playing.push(e), new Promise<EntrantResult>(() => {})) };
}

describe('the seat pool seats the server\'s house roster (#313)', () => {
  it('joins each roster entry by its id, playing its model bare; the seats past the roster are "Delove N"', async () => {
    const s = await serve();
    try {
      const r13 = await s.roster('delove@13', 2);
      const r12 = await s.roster('delove@12', 2);
      const ids = [r13[0].id, r12[0].id, r13[1].id, r12[1].id];
      const t = await s.create({ rosterIds: ids, delove: 5, maxEntrants: 8 });
      const st = stubPlay();
      const pool = new SeatPool({ server: s.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, canPlay: () => true });
      await pool.tick();
      const byName = new Map([...r13, ...r12].map((e) => [e.name, e.model]));
      const roster = st.playing.filter((e) => byName.has(e.name));
      expect(roster.map((e) => [e.agentId, byName.get(e.name)]).every(([a, m]) => a === m)).toBe(true);
      expect(roster.map((e) => e.agentId).sort()).toEqual(['delove@12', 'delove@12', 'delove@13', 'delove@13']);
      expect(st.playing.filter((e) => !byName.has(e.name)).map((e) => e.name)).toEqual(['Delove 1']);
      expect(st.playing.every((e) => !e.search)).toBe(true);
      // The bracket shows the roster names; the host's list shows "AI agent", never the model.
      const bracket = (await s.call('GET', `/tournaments/${t.id}`)).body.tournament;
      expect(bracket.entrants.map((e: { name: string }) => e.name).sort()).toEqual([...st.playing.map((e) => e.name)].sort());
      const list = (await s.call('GET', `/tournaments/${t.id}/entrants`, undefined, s.admin)).body.entrants as { name: string; agent?: string }[];
      expect(list.filter((e) => byName.has(e.name)).every((e) => e.agent === 'AI agent')).toBe(true);
      expect(JSON.stringify(list.filter((e) => byName.has(e.name)))).not.toMatch(/delove@1[23]/); // plain "Delove N" seats keep their label
      expect((await s.call('GET', '/seat-requests?kind=delove', undefined, { 'x-seat-pool-key': KEY })).body.requests).toEqual([]); // done
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('an entry whose model the pool cannot play is skipped and given back; the rest are seated, and it never loops', async () => {
    const s = await serve();
    try {
      const r13 = await s.roster('delove@13', 2);
      const r12 = await s.roster('delove@12', 1);
      await s.create({ rosterIds: [r12[0].id, r13[0].id, r13[1].id], delove: 3, maxEntrants: 8 });
      const st = stubPlay();
      const logs: string[] = [];
      const pool = new SeatPool({ server: s.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, canPlay: (m) => m === 'delove@13', log: (l) => logs.push(l) });
      await pool.tick();
      expect(st.playing.map((e) => e.name).sort()).toEqual(r13.map((e) => e.name).sort());
      const [req] = (await s.call('GET', '/seat-requests?kind=delove', undefined, { 'x-seat-pool-key': KEY })).body.requests;
      expect(req).toMatchObject({ n: 3, claimed: 2 }); // the @12 seat went back
      await pool.tick(); // it comes back first, is skipped again, and nothing else breaks
      expect(st.playing).toHaveLength(2);
      expect(logs.filter((l) => l.includes('roster model delove@12 cannot be played here'))).toHaveLength(1);
    } finally {
      await s.risk.shutdown('test');
    }
  });
});
