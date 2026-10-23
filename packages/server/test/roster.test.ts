import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { ROSTER_AGENT, ROSTER_NAMES } from '../src/roster.js';
import { builtInReservedName, nameSkeleton } from '../src/player-keys.js';

// Fake values, set only here. Real ones live only in the server's environment.
const ADMIN = 'test-roster-admin';
const RECORDS = 'test-roster-records';
const POOL_KEY = 'test-roster-pool';
const asPool = { 'x-seat-pool-key': POOL_KEY };
const asAdmin = { authorization: `Bearer ${ADMIN}` };

let dir: string;
let risk: RiskServer;
let base: string;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? (JSON.parse(raw) as any) : {} };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-roster-'));
  risk = createRiskServer(new Store(join(dir, 'games.json')), { clientDir: null, adminToken: ADMIN, recordsKey: RECORDS, seatPoolKey: POOL_KEY, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  risk.store.stopTimers();
  for (const room of risk.store.rooms.values()) room.stopBot();
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

/** A two-seat game: a host and the roster name `rosterId`; the host surrenders, so the roster seat wins. */
async function rosterWin(rosterId: string, name: string) {
  const host = (await call('POST', '/games', { playerName: 'Host', options: { autoSetup: true, maxPlayers: 2 } })).body;
  const room = risk.store.get(host.gameId)!;
  const seat = room.join(name, false, 'bot', 'delove@13', undefined, rosterId);
  await call('POST', `/games/${host.gameId}/start`, {}, { authorization: `Bearer ${host.token}` });
  await call('POST', `/games/${host.gameId}/actions`, { action: { type: 'surrender' } }, { authorization: `Bearer ${host.token}` });
  expect(room.state.phase).toBe('finished');
  return { gameId: host.gameId as string, playerId: seat.playerId };
}

describe('the house roster', () => {
  it('has 100 house names: distinct look-alike skeletons, valid player names, none built-in reserved and none starting with "Delove"', () => {
    expect(ROSTER_NAMES).toHaveLength(100);
    expect(new Set(ROSTER_NAMES.map(nameSkeleton)).size).toBe(100);
    for (const n of ROSTER_NAMES) {
      expect(n.length).toBeGreaterThanOrEqual(2);
      expect(n.length).toBeLessThanOrEqual(24);
      expect(n).toMatch(/^[\p{L}\p{N} ._'-]+$/u);
      expect(builtInReservedName(n)).toBeNull();
      expect(nameSkeleton(n)).not.toMatch(/^delove/);
    }
  });

  it('admin routes create in bulk, list (the answer key) and retire; nobody else reaches them', async () => {
    expect((await call('GET', '/admin/roster')).status).toBe(401);
    expect((await call('POST', '/admin/roster', { model: 'delove@13', count: 2 }, { authorization: 'Bearer nope' })).status).toBe(401);
    // A registered player's name is skipped: the next free house name is taken instead.
    expect((await call('POST', '/players', { name: 'Tom' })).status).toBe(201);
    const made = await call('POST', '/admin/roster', { model: 'delove@13', count: 2 }, asAdmin);
    expect(made.status).toBe(201);
    expect(made.body.created.map((e: { name: string }) => e.name)).toEqual(['Mabel', 'Gus']);
    expect(made.body.created[0]).toMatchObject({ id: expect.stringMatching(/^r_[0-9a-f]{8}$/), model: 'delove@13', status: 'active' });
    const own = await call('POST', '/admin/roster', { model: 'delove@12', names: ['Sir Loin', 'Snake Eyes'] }, asAdmin);
    expect(own.status).toBe(201);
    // Bad names, all or none.
    for (const names of [['Delove Junior'], ['Mabel'], ['Ivy', 'IVY'], ['tom'], ['Zergling Pal'], ['Bot 3'], ['x']])
      expect((await call('POST', '/admin/roster', { model: 'delove@12', names }, asAdmin)).status).toBe(400);
    expect((await call('POST', '/admin/roster', { model: 'not a model', count: 1 }, asAdmin)).status).toBe(400);
    const list = (await call('GET', '/admin/roster', undefined, asAdmin)).body;
    expect(list.roster).toHaveLength(4);
    expect(list.byModel).toEqual({ 'delove@13': { active: 2, retired: 0 }, 'delove@12': { active: 2, retired: 0 } });
    // Retire one by id, then the oldest of a model by count.
    const gus = made.body.created[1].id as string;
    expect((await call('POST', `/admin/roster/${gus}/retire`, {}, asAdmin)).body.retired[0]).toMatchObject({ id: gus, status: 'retired', retiredAt: expect.any(Number) });
    const byModel = await call('POST', '/admin/roster/retire', { model: 'delove@12', count: 1 }, asAdmin);
    expect(byModel.body.retired.map((e: { name: string }) => e.name)).toEqual(['Sir Loin']);
    expect(byModel.body.byModel).toEqual({ 'delove@13': { active: 1, retired: 1 }, 'delove@12': { active: 1, retired: 1 } });
    expect((await call('POST', '/admin/roster/retire', { model: 'delove@12', count: 5 }, asAdmin)).status).toBe(400);
    // The roster survives a restart (saved under the data dir).
    expect(new Store(join(dir, 'games.json')).roster.list()).toHaveLength(4);
  });

  it('the pool reads the roster with its key; pick(n) spreads seats over the models and rotates the names', async () => {
    const a = (await call('POST', '/admin/roster', { model: 'delove@13', count: 3 }, asAdmin)).body.created;
    const b = (await call('POST', '/admin/roster', { model: 'delove@12', count: 2 }, asAdmin)).body.created;
    await call('POST', `/admin/roster/${b[1].id}/retire`, {}, asAdmin);
    expect((await call('GET', '/roster')).status).toBe(401);
    expect((await call('GET', '/roster', undefined, { 'x-seat-pool-key': 'nope' })).status).toBe(403);
    const active = (await call('GET', '/roster?status=active', undefined, asPool)).body.roster;
    expect(active).toEqual([...a, b[0]].map((e: { id: string; name: string; model: string }) => ({ id: e.id, name: e.name, model: e.model, status: 'active' })));
    expect((await call('GET', '/roster', undefined, asPool)).body.roster).toHaveLength(5);
    // One per model in turn (delove@12 sorts first), then the rest; the next pick starts after the names just used.
    const r = risk.store.roster;
    expect(r.pick(3)).toEqual([b[0].id, a[0].id, a[1].id]);
    expect(r.pick(2)).toEqual([b[0].id, a[2].id]);
    expect(r.pick(10)).toHaveLength(4);
  });

  it('roster names are reserved, look-alikes too, retired ones included: no registration, seat, tournament entry or rename', async () => {
    const made = (await call('POST', '/admin/roster', { model: 'delove@13', names: ['Paper Tiger', 'Hank'] }, asAdmin)).body.created;
    await call('POST', `/admin/roster/${made[1].id}/retire`, {}, asAdmin);
    for (const name of ['Paper Tiger', 'paper  tiger', 'Pαper Tiger', 'Hank', 'HANK'])
      expect((await call('POST', '/players', { name })).status, name).toBe(400);
    expect((await call('POST', '/games', { playerName: 'Paper Tiger' })).status).toBe(400);
    const host = (await call('POST', '/games', { playerName: 'Host' })).body;
    expect((await call('POST', `/games/${host.gameId}/join`, { playerName: 'hank' })).body.error).toMatch(/house roster/);
    expect((await call('POST', `/games/${host.gameId}/name`, { name: 'Paper Tiger' }, { authorization: `Bearer ${host.token}` })).status).toBe(400);
    const t = (await call('POST', '/tournaments', { name: 'Open Cup' })).body.tournament;
    expect((await call('POST', `/tournaments/${t.id}/join`, { playerName: 'Paper Tiger' })).status).toBe(400);
    // Only the pool seats a roster name, and only through a claim of the admin's seat request.
    expect((await call('POST', `/tournaments/${t.id}/join`, { rosterId: made[0].id })).status).toBe(400);
    expect((await call('POST', '/tournaments', { name: 'Sneaky', rosterIds: [made[0].id] })).status).toBe(403);
  });

  it('a roster seat ranks as roster:<id> across games; retiring freezes its row; the record (records key) names the model, nothing public does', async () => {
    const [tom] = (await call('POST', '/admin/roster', { model: 'delove@13', names: ['Tom'] }, asAdmin)).body.created;
    const first = await rosterWin(tom.id, 'Tom');
    const room = risk.store.get(first.gameId)!;
    expect(room.agents[first.playerId]).toBe(ROSTER_AGENT); // whatever the join declared
    expect(room.rosterIds[first.playerId]).toBe(tom.id);
    await rosterWin(tom.id, 'Tom');
    const row = () => ((async () => (await call('GET', '/rankings')).body.rankings.find((r: { key: string }) => r.key === `roster:${tom.id}`))());
    expect(await row()).toMatchObject({ name: 'Tom', games: 2, wins: 2 });
    expect((await call('GET', '/rankings')).body.rankings.some((r: { key: string }) => r.key === 'player:tom')).toBe(false);
    expect((await call('GET', `/games/${first.gameId}/players/${first.playerId}/profile`)).raw).toContain(`roster:${tom.id}`);
    await call('POST', `/admin/roster/${tom.id}/retire`, {}, asAdmin);
    expect(await row()).toMatchObject({ name: 'Tom', games: 2, wins: 2 });
    // The filed record has the answer key; the public match history shows "AI agent".
    const history = await call('GET', '/history');
    expect(history.body.games[0].players.find((p: { name: string }) => p.name === 'Tom')).toMatchObject({ agent: ROSTER_AGENT });
    expect(history.raw).not.toContain('delove@');
    const rec = await call('GET', `/records/${history.body.games[0].id}`, undefined, { 'x-records-key': RECORDS });
    expect(rec.status).toBe(200);
    expect(Object.values(rec.body.room.roster)).toEqual([{ id: tom.id, model: 'delove@13' }]);
    expect((await call('GET', `/records/${history.body.games[0].id}`)).status).toBe(403);
  });

  it('a tournament seats roster names through the pool; no public route carries a model', async () => {
    const thirteen = (await call('POST', '/admin/roster', { model: 'delove@13', count: 2 }, asAdmin)).body.created;
    const twelve = (await call('POST', '/admin/roster', { model: 'delove@12', count: 1 }, asAdmin)).body.created;
    const ids = [...thirteen, ...twelve].map((e: { id: string }) => e.id);
    // Unknown or retired ids are refused at the create.
    expect((await call('POST', '/admin/tournaments', { name: 'Bad', rosterIds: ['r_00000000'] }, asAdmin)).status).toBe(400);
    const made = await call('POST', '/admin/tournaments', { name: 'Roster Cup', format: 'nested', rosterIds: ids, delove: 4, zergs: 2, open: 0, options: { fogOfWar: false } }, asAdmin);
    expect(made.status).toBe(201);
    const id = made.body.tournament.id as string;
    const req = (await call('GET', '/seat-requests', undefined, asPool)).body.requests[0];
    expect(req).toMatchObject({ n: 4, roster: ids });
    // The claim hands the pool the roster names with their models first, then plain Delove seats.
    const claim = (await call('POST', `/seat-requests/${req.id}/claim`, { n: 4 }, asPool)).body;
    expect(claim.roster).toEqual([...thirteen, ...twelve].map((e: { id: string; name: string; model: string }) => ({ rosterId: e.id, name: e.name, model: e.model })));
    expect(claim.firstLabel).toBe(1);
    // A roster join: the id only; the body's name and agent are ignored.
    for (const e of claim.roster) {
      const j = await call('POST', `/tournaments/${id}/join`, { seatRequestId: req.id, rosterId: e.rosterId, playerName: 'Ignored', agent: e.model }, asPool);
      expect(j.status).toBe(201);
    }
    expect((await call('POST', `/tournaments/${id}/join`, { seatRequestId: req.id, rosterId: ids[0] }, asPool)).status).toBe(409); // joined already
    expect((await call('POST', `/tournaments/${id}/join`, { seatRequestId: req.id, playerName: 'Delove 1', agent: 'delove@11' }, asPool)).status).toBe(201);
    const t = risk.store.tournaments.get(id)!;
    expect(t.entrants.filter((e) => e.rosterId).map((e) => [e.name, e.agent])).toEqual([...thirteen, ...twelve].map((e: { name: string }) => [e.name, ROSTER_AGENT]));
    risk.store.tournaments.start(id);
    const tables = [...risk.store.rooms.values()].filter((r) => r.tournamentId === id);
    const seated = tables.flatMap((r) => Object.entries(r.rosterIds));
    expect(seated.map(([, rid]) => rid).sort()).toEqual([...ids].sort());
    for (const r of tables) for (const pid of Object.keys(r.rosterIds)) expect(r.agents[pid]).toBe(ROSTER_AGENT);

    // The sweep: every public route a spectator, a player or a crawler can read.
    const publicPaths = ['/games', '/tournaments', `/tournaments/${id}`, '/tournaments/next', '/rankings', '/rankings?board=tournament', '/history', '/house-bots', ...tables.map((r) => `/games/${r.id}`)];
    for (const path of publicPaths) {
      const r = await call('GET', path);
      expect(r.status, path).toBe(200);
      for (const model of ['delove@13', 'delove@12']) expect(r.raw, `${path} leaks ${model}`).not.toContain(model);
    }
    // The host's entrants list (public in open mode) shows roster names as plain agents.
    const host = await call('GET', `/tournaments/${id}/entrants`, undefined, { authorization: `Bearer ${made.body.hostToken}` });
    expect(host.status).toBe(200);
    for (const model of ['delove@13', 'delove@12']) expect(host.raw).not.toContain(model);
    for (const e of [...thirteen, ...twelve]) expect(host.body.entrants.find((x: { name: string }) => x.name === e.name)).toMatchObject({ kind: 'agent', agent: ROSTER_AGENT });
    // The answer key is still there for the admin.
    expect((await call('GET', '/admin/roster', undefined, asAdmin)).raw).toContain('delove@12');
  });
});
