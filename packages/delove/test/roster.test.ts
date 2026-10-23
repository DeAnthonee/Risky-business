import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../server/src/store.js';
import { createRiskServer } from '../../server/src/app.js';
import { SeatPool, type PoolEntrant } from '../src/pool.js';
import { activeModels, addNames, checkRoster, generateNames, loadRoster, newRoster, pickNames, retireOld, type Roster } from '../src/roster.js';
import type { EntrantResult } from '../src/tournament-seat.js';
import { summarizeTable, yardstick, yardstickMarkdown, type RecordLike } from '../src/roster-yardstick.js';

const small = (): Roster => ({
  v: 1,
  anchor: 'delove@12',
  names: [
    { name: 'Ada', model: 'delove@13', added: '2026-10-22' },
    { name: 'Bram', model: 'delove@13', added: '2026-10-22' },
    { name: 'Cleo', model: 'delove@13', added: '2026-10-22' },
    { name: 'Sir Pancake', model: 'delove@12', added: '2026-10-22' },
    { name: 'Lady Noodle', model: 'delove@12', added: '2026-10-22' },
    { name: 'Old Timer', model: 'delove@10', added: '2026-10-01', retired: '2026-10-20' },
  ],
});

describe('house roster (roster.ts)', () => {
  it('splits seats evenly across the active versions, skips names in use and retired names', () => {
    const r = small();
    expect(pickNames(r, 4, []).map((n) => n.name)).toEqual(['Sir Pancake', 'Ada', 'Lady Noodle', 'Bram']); // anchor first
    // Two @13 names already seated: the next seats go to @12 until it catches up.
    expect(pickNames(r, 2, ['Ada', 'bram']).map((n) => n.model)).toEqual(['delove@12', 'delove@12']);
    expect(pickNames(r, 10, []).length).toBe(5); // runs out (the retired name never comes back)
    // A fog seat: only fog-trained models.
    expect(pickNames(r, 5, [], (m) => m === 'delove@13').map((n) => n.name)).toEqual(['Ada', 'Bram', 'Cleo']);
  });

  it('retires versions two promotions behind, never the anchor; new names never clash', () => {
    const r = small();
    expect(retireOld(r, 'delove@14', '2026-11-01')).toEqual([]); // @13 is one behind; @12 is the anchor
    const added = addNames(r, 'delove@14', 4, '2026-11-01', 7);
    expect(added.every((n) => n.model === 'delove@14')).toBe(true);
    expect(retireOld(r, 'delove@15', '2026-11-08')).toEqual(['delove@13']);
    expect(activeModels(r)).toEqual(['delove@12', 'delove@14']);
    expect(r.names.find((n) => n.name === 'Ada')).toMatchObject({ model: 'delove@13', retired: '2026-11-08' }); // its model, for good
    const names = generateNames(80, r.names.map((n) => n.name), 3);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(80);
    expect(names.every((n) => n.length <= 24 && !/^(delove|zerg)/i.test(n))).toBe(true);
  });

  it('refuses names that clash, impersonate pool seats or play something that is not a delove version', () => {
    const r = small();
    expect(() => checkRoster({ ...r, names: [...r.names, { name: 'ada', model: 'delove@13', added: 'x' }] })).toThrow(/twice/);
    expect(() => checkRoster({ ...r, names: [{ name: 'Delove 3', model: 'delove@13', added: 'x' }] })).toThrow(/Delove/);
    expect(() => checkRoster({ ...r, names: [{ name: 'Zergling', model: 'delove@13', added: 'x' }] })).toThrow(/Zerg/);
    expect(() => checkRoster({ ...r, names: [{ name: 'Ann', model: 'claude', added: 'x' }] })).toThrow(/not a delove@N/);
  });

  it('the sample roster: 100 names, 50 on delove@13 and 50 on the anchor delove@12', () => {
    const r = loadRoster(join(__dirname, '..', 'configs', 'roster.sample.json'));
    expect(r.anchor).toBe('delove@12');
    expect(r.names.length).toBe(100);
    expect(r.names.filter((n) => n.model === 'delove@13').length).toBe(50);
    expect(newRoster({ 'delove@13': 2, 'delove@12': 2 }, 'delove@12', '2026-10-22', 1).names.length).toBe(4);
  });
});

describe('the seat pool seats roster names', () => {
  const KEY = 'test-pool-key';
  async function serve() {
    const risk = createRiskServer(new Store(null), {
      clientDir: null,
      sweepIntervalMs: 0,
      adminToken: 'test-admin-token',
      openTournaments: false,
      seatPoolKey: KEY,
      tourneyAccess: { adminCode: 'x-admin', limitedCode: 'x-limited', maxActive: 0, maxActiveLimited: 0, maxLiveSeats: 0, createsPerDay: 0, lagBrakeMs: 0, deloveAdmin: 40, deloveLimited: 16, deloveAtOnce: 48, deloveSearchAtOnce: 20 },
    });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const server = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const create = async (spec: Record<string, unknown>) =>
      ((await (await fetch(`${server}/api/admin/tournaments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-token' }, body: JSON.stringify({ name: 'Daily', ...spec }) })).json()) as any).tournament;
    const entrants = async (id: string) => ((await (await fetch(`${server}/api/tournaments/${id}`)).json()) as any).tournament.entrants as { name: string }[];
    return { risk, server, create, entrants };
  }
  const stub = () => {
    const playing: PoolEntrant[] = [];
    return { playing, play: (e: PoolEntrant) => (playing.push(e), new Promise<EntrantResult>(() => {})) };
  };

  it('joins with free roster names split by version, each playing its model, labelled only "delove"', async () => {
    const s = await serve();
    try {
      const t = await s.create({ delove: 4, maxEntrants: 8 });
      const st = stub();
      const pool = new SeatPool({ server: s.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, roster: small, fogCapable: () => true });
      await pool.tick();
      expect(st.playing.map((e) => [e.name, e.agentId])).toEqual([
        ['Sir Pancake', 'delove@12'],
        ['Ada', 'delove@13'],
        ['Lady Noodle', 'delove@12'],
        ['Bram', 'delove@13'],
      ]);
      expect((await s.entrants(t.id)).map((e) => e.name)).toEqual(['Sir Pancake', 'Ada', 'Lady Noodle', 'Bram']);
      // The host's list shows the generic label, never the model.
      const list = (await (await fetch(`${s.server}/api/tournaments/${t.id}/entrants`, { headers: { authorization: 'Bearer test-admin-token' } })).json()) as any;
      expect(list.entrants.map((e: { agent?: string }) => e.agent)).toEqual(['delove', 'delove', 'delove', 'delove']);
    } finally {
      await s.risk.shutdown('test');
    }
  });

  it('a fog tournament seats only names whose model is fog-trained; more seats than free names: the rest go back', async () => {
    const s = await serve();
    try {
      const t = await s.create({ delove: 5, maxEntrants: 8, options: { fogOfWar: true } });
      const st = stub();
      await new SeatPool({ server: s.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, roster: small, fogCapable: (m) => m === 'delove@13' }).tick();
      expect(st.playing.map((e) => e.agentId)).toEqual(['delove@13', 'delove@13', 'delove@13']);
      const reqs = (await (await fetch(`${s.server}/api/seat-requests?modes=takeover`, { headers: { 'x-seat-pool-key': KEY } })).json()) as any;
      expect(reqs.requests[0]).toMatchObject({ tournamentId: t.id, n: 5, claimed: 3 });
    } finally {
      await s.risk.shutdown('test');
    }
  });
});

describe('the roster yardstick (roster-yardstick.ts)', () => {
  const rec = (id: string, order: string[], elims: [string, string | null][]): RecordLike => ({
    id,
    map: 'gen1-s1-p3-t15',
    fog: true,
    players: order.map((name, i) => ({ id: `p${i}`, name })),
    outcome: { placings: order.map((_, i) => `p${i}`), eliminations: elims.map(([p, by]) => ({ player: `p${order.indexOf(p)}`, by: by === null ? null : `p${order.indexOf(by)}` })) },
  });

  it('sums tables per name and per version: wins, placement, points, kills, rounds, who eliminated it; rates the versions', () => {
    const r = small();
    const t1 = summarizeTable(rec('g1', ['Ada', 'Sir Pancake', 'Zergy'], [['Zergy', 'Ada'], ['Sir Pancake', 'Ada']]), 'T1', 1, { Zergy: 'zerg' }, 1);
    const t2 = summarizeTable(rec('g2', ['Zergy', 'Ada', 'Lady Noodle'], [['Lady Noodle', 'Zergy'], ['Ada', 'Zergy']]), 'T1', 2, { Zergy: 'zerg' }, 2);
    expect(t1.seats[0]).toMatchObject({ name: 'Ada', place: 1, kills: 2 });
    expect(t2.seats[1]).toMatchObject({ name: 'Ada', place: 2, eliminatedBy: 'Zergy' });
    const y = yardstick([t1, t2], r, 'a', 'b');
    expect(y.perVersion['delove@13']).toMatchObject({ tables: 2, wins: 1, kills: 2, roundsReached: 2, tournaments: 1, eliminatedBy: { zerg: 1 } });
    expect(y.perVersion['delove@13'].relPlace).toBe(0.25); // first (0) then second of three (0.5)
    expect(y.perVersion['delove@13'].points).toBe(1.5); // (+1 place + 2 kills) and (0 place + 0 kills), per table
    expect(y.perVersion['delove@12']).toMatchObject({ tables: 2, wins: 0, eliminatedBy: { 'delove@13': 1, zerg: 1 } });
    expect(y.perName['Ada']).toMatchObject({ model: 'delove@13', tables: 2 });
    expect(y.perVersion['zerg']).toBeUndefined(); // only roster versions get lines
    expect(y.ratings['delove@12']).toBe(0);
    expect(y.ratings['delove@13']).toBeGreaterThan(0);
    expect(yardstickMarkdown(y)).toContain('| delove@13 | 2 | 50% | 0.25 |');
  });
});
