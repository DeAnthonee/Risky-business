import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createRiskServer, DEFAULT_AI_DIR, type RiskServer } from '../src/app.js';
import { CharacterStore } from '../src/characters.js';
import { LocalRiskApi } from '../src/local-api.js';
import { HttpRiskApi } from '@risk/mcp';

let risk: RiskServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (risk) await risk.shutdown('test');
  risk = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = 'league-key';
const ADMIN = 'admin-secret';

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'training-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'games.json'));
  risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0, adminToken: ADMIN, characters: new CharacterStore(DEFAULT_AI_DIR, null, [KEY, ADMIN]) });
  await new Promise<void>((r) => risk!.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (path: string) => fetch(`${base}/api${path}`).then((r) => r.json());
  return { dir, store, base, post, get, api: new HttpRiskApi(base, KEY) };
}

type Served = Awaited<ReturnType<typeof serve>>;

/** A two-seat game that ends when the second seat surrenders. */
async function table(s: Served, a: string, b: string, board?: 'training') {
  const g = await s.api.createGame(a, undefined, { map: 'classic', autoSetup: true, maxPlayers: 2 }, board);
  const j = await s.api.joinGame(g.gameId, b);
  await s.api.start(g.gameId, g.token);
  return { id: g.gameId, finish: () => s.api.act(g.gameId, j.token, { type: 'surrender' }) };
}

describe('training leaderboard', () => {
  it('creates training games only with the characters key and ranks them apart from the public board', async () => {
    const s = await serve();
    const body = { playerName: 'delove@6', options: { map: 'classic', autoSetup: true, maxPlayers: 2 }, board: 'training' };
    expect((await s.post('/games', body)).status).toBe(403);
    expect((await s.post('/games', body, { 'x-characters-key': 'wrong' })).status).toBe(403);
    expect((await s.post('/games', { ...body, board: 'secret' }, { 'x-characters-key': KEY })).status).toBe(400);
    // The admin token is a characters key too (index.ts passes both).
    expect((await s.post('/games', body, { 'x-characters-key': ADMIN })).status).toBe(201);

    const t = await table(s, 'delove@6', 'Claude Haiku 1', 'training');
    expect((await s.get('/games')).games.find((g: { id: string }) => g.id === t.id)).toMatchObject({ board: 'training' });
    await t.finish();
    const pub = await table(s, 'Shen', 'Ahri');
    await pub.finish();

    expect((await s.api.rankings()).rankings.map((r) => r.key)).toEqual(['player:shen', 'player:ahri']);
    const training = await s.api.rankings(undefined, 'training');
    expect(training).toMatchObject({ board: 'training', current: true });
    expect(training.rankings.map((r) => r.key)).toEqual(['player:delove@6', 'player:claude haiku 1']);
    expect(await s.get('/rankings?board=public')).toMatchObject({ rankings: [{ key: 'player:shen' }, { key: 'player:ahri' }] });
    expect((await fetch(`${s.base}/api/rankings?board=nope`)).status).toBe(400);
    expect((await s.api.rankedProfile('player:delove@6', 'training')).stats).toMatchObject({ wins: 1, games: 1 });
    expect((await s.api.rankedProfile('player:delove@6')).stats).toMatchObject({ games: 0 });
    expect(await s.get('/rankings/profile?key=player:shen&board=training')).toMatchObject({ board: 'training', stats: { games: 0 } });

    // Never written into the public file.
    const publicIds = JSON.parse(readFileSync(join(s.dir, 'rankings.json'), 'utf8')).map((g: { gameId: string }) => g.gameId);
    expect(publicIds).toEqual([pub.id]);
    expect(JSON.parse(readFileSync(join(s.dir, 'rankings-training.json'), 'utf8')).map((g: { gameId: string }) => g.gameId)).toEqual([t.id]);

    // Match history and the game record carry the board.
    const history = (await s.get('/history')).games;
    expect(history.find((g: { room: string }) => g.room === t.id)).toMatchObject({ board: 'training' });
    expect(history.find((g: { room: string }) => g.room === pub.id).board).toBeUndefined();
    expect((await s.get('/history?board=training')).games.map((g: { room: string }) => g.room)).toEqual([t.id]);
    expect((await s.get('/history?board=public')).games.map((g: { room: string }) => g.room)).toEqual([pub.id]);
    const entry = s.store.archive.list().find((e) => e.room === t.id)!;
    expect(s.store.archive.get(entry.id)!.room).toMatchObject({ id: t.id, board: 'training' });

    // The flag survives a restart; a snapshot from before it existed loads as public.
    s.store.save();
    await risk!.shutdown('reload');
    risk = undefined;
    const file = join(s.dir, 'games.json');
    const snaps = JSON.parse(readFileSync(file, 'utf8'));
    expect(snaps.find((r: { id: string }) => r.id === t.id)?.board).toBe('training');
    writeFileSync(file, JSON.stringify(snaps.map(({ board: _b, ...r }: { board?: string }) => r)));
    const restored = new Store(file);
    expect(restored.list().every((g) => g.board === undefined)).toBe(true);
    expect(restored.training.rows().map((r) => r.key)).toEqual(['player:delove@6', 'player:claude haiku 1']);
    restored.stopTimers();
  });

  it('moves a game played on the public board to the training board (admin)', async () => {
    const s = await serve();
    const done = await table(s, 'delove@6', 'Claude Haiku 1');
    await done.finish();
    const running = await table(s, 'delove@6', 'Claude Haiku 2');
    const keep = await table(s, 'Shen', 'Ahri');
    await keep.finish();
    expect((await s.api.rankings()).rankings).toHaveLength(4);

    const move = (id: string, body: unknown = { board: 'training' }, token = ADMIN) => s.post(`/admin/games/${id}/board`, body, { authorization: `Bearer ${token}` });
    expect((await move(done.id, { board: 'training' }, 'wrong')).status).toBe(401);
    expect((await move(done.id, { board: 'public' })).status).toBe(400);
    expect((await move('ZZZZZZ')).status).toBe(404);

    // A finished game, its room already gone: the result and the record move.
    s.store.delete(done.id, 'admin');
    const res = await move(done.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, board: 'training', gameId: done.id, room: false, result: 'moved', records: 1 });
    expect((await s.api.rankings()).rankings.map((r) => r.key)).toEqual(['player:shen', 'player:ahri']);
    expect((await s.api.rankings(undefined, 'training')).rankings.map((r) => r.key)).toEqual(['player:delove@6', 'player:claude haiku 1']);
    expect(JSON.parse(readFileSync(join(s.dir, 'rankings.json'), 'utf8')).map((g: { gameId: string }) => g.gameId)).toEqual([keep.id]);
    const rec = s.store.archive.list().find((e) => e.room === done.id)!;
    expect(rec.board).toBe('training');
    expect(s.store.archive.get(rec.id)!.room.board).toBe('training');
    // Moving it again changes nothing.
    expect(await (await move(done.id)).json()).toMatchObject({ result: 'already', records: 0 });

    // A game still being played: its room is flagged and its result goes to the training board when it ends.
    expect(await (await move(running.id.toLowerCase())).json()).toMatchObject({ gameId: running.id, room: true, result: 'none', records: 0 });
    expect((await s.get('/games')).games.find((g: { id: string }) => g.id === running.id)).toMatchObject({ board: 'training' });
    await running.finish();
    expect((await s.api.rankings()).rankings.map((r) => r.key)).toEqual(['player:shen', 'player:ahri']);
    expect((await s.api.rankings(undefined, 'training')).rankings.find((r) => r.key === 'player:delove@6')).toMatchObject({ games: 2, wins: 2 });
    expect(s.store.archive.list().find((e) => e.room === running.id)?.board).toBe('training');
    // A public game played meanwhile was never touched.
    expect(existsSync(join(s.dir, 'rankings.json'))).toBe(true);
    expect(s.store.archive.list().find((e) => e.room === keep.id)?.board).toBeUndefined();
  });

  it('lets MCP agents create training games and read the training board', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'training-'));
    dirs.push(dir);
    const store = new Store(join(dir, 'games.json'));
    const api = new LocalRiskApi(store, new CharacterStore(DEFAULT_AI_DIR, null, [KEY]));
    await expect(api.createGame('delove@6', undefined, { maxPlayers: 2, autoSetup: true }, 'training')).rejects.toMatchObject({ status: 403 });
    const g = await api.createGame('delove@6', undefined, { maxPlayers: 2, autoSetup: true }, 'training', KEY);
    const j = await api.joinGame(g.gameId, 'Claude Sonnet 1');
    expect(store.get(g.gameId)?.board).toBe('training');
    await api.start(g.gameId, g.token);
    await api.act(g.gameId, j.token, { type: 'surrender' });
    expect((await api.rankings()).rankings).toEqual([]);
    expect(await api.rankings(undefined, 'training')).toMatchObject({ board: 'training', rankings: [{ key: 'player:delove@6' }, { key: 'player:claude sonnet 1' }] });
    expect((await api.rankedProfile('player:delove@6', 'training')).stats).toMatchObject({ wins: 1 });
    store.stopTimers();
  });
});
