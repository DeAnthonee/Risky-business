import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseBotAction, createRng, nextFloat, verifyRecord, type GameRecord } from '@risk/engine';
import { Store, type GameRoom } from '../src/store.js';
import { createRiskServer } from '../src/app.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'risk-archive-'));
  dirs.push(d);
  return d;
}

/** Two seated players (not built-in bots, so no timers run) and a game started with fog of war. */
function startedGame(store: Store) {
  const { room } = store.create('Archive test', { fogOfWar: true }, 'Alice');
  room.join('Bob');
  room.start();
  return room;
}

/** Play the current player's moves with a seeded bot, up to `max` actions or the end of the game. */
function play(room: GameRoom, max: number, seed = 5) {
  const rng = createRng(seed);
  for (let n = 0; n < max && room.state.phase !== 'finished'; n++) {
    const me = room.state.currentPlayer!;
    room.act(me, chooseBotAction(room.state, me, () => nextFloat(rng))!);
  }
}

describe('game archive', () => {
  it('records a game move by move and files it when the game is won', () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const room = startedGame(store);
    expect(existsSync(join(dir, 'archive', 'live', `${room.recordId}.jsonl`))).toBe(true);
    play(room, 10_000);
    expect(room.state.phase).toBe('finished');

    const [entry] = store.archive.list();
    expect(entry).toMatchObject({ room: room.id, name: 'Archive test', fog: true, finished: true, winner: { id: room.state.winner } });
    expect(entry.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    expect(entry.players.find((p) => p.id === room.state.winner)!.place).toBe(1);
    // The journal is gone once the record is filed.
    expect(readdirSync(join(dir, 'archive', 'live'))).toEqual([]);

    const record = store.archive.get(entry.id)!;
    expect(record.steps.length).toBe(entry.steps);
    expect(record.steps.every((s) => s.seen)).toBe(true);
    expect(verifyRecord(record)).toBeNull();
    store.stopTimers();
  });

  it('keeps recording the same game across a restart', () => {
    const dir = dataDir();
    const file = join(dir, 'games.json');
    const first = new Store(file);
    const room = startedGame(first);
    play(first.get(room.id)!, 40);
    const recordId = room.recordId;
    first.save();
    first.stopTimers();

    const second = new Store(file);
    const again = second.get(room.id)!;
    expect(again.recordId).toBe(recordId);
    play(again, 10_000, 9);
    expect(again.state.phase).toBe('finished');
    const record = second.archive.get(recordId!)!;
    expect(record.outcome.finished).toBe(true);
    expect(verifyRecord(record)).toBeNull();
    second.stopTimers();
  });

  it('files a game closed before the end as unfinished', () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const room = startedGame(store);
    play(room, 30);
    store.delete(room.id, 'host');
    const [entry] = store.archive.list();
    expect(entry).toMatchObject({ finished: false, endedBecause: 'room closed (host)', winner: null, steps: 30 });
    expect(verifyRecord(store.archive.get(entry.id)!)).toBeNull();
    store.stopTimers();
  });

  it('keeps only the newest records, deleting the oldest files and index lines', () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    expect(store.archive.keep).toBe(1000);
    store.archive.keep = 2;
    const filed: string[] = [];
    for (let n = 0; n < 4; n++) {
      const room = startedGame(store);
      play(room, 5 + n);
      filed.push(room.recordId!);
      store.delete(room.id, 'host');
    }
    const list = store.archive.list();
    expect(list.map((e) => e.id)).toEqual([filed[3], filed[2]]);
    const files = readdirSync(join(dir, 'archive', 'games'), { recursive: true }).filter((f) => String(f).endsWith('.json'));
    expect(files).toHaveLength(2);
    expect(store.archive.get(filed[0])).toBeNull();
    expect(store.archive.get(filed[3])!.steps).toHaveLength(8);

    // 0 keeps everything.
    store.archive.keep = 0;
    const room = startedGame(store);
    store.delete(room.id, 'host');
    expect(store.archive.list()).toHaveLength(3);
    store.stopTimers();
  });

  it('reads the number of records to keep from RISK_ARCHIVE_KEEP', () => {
    const dir = dataDir();
    process.env.RISK_ARCHIVE_KEEP = '25';
    try {
      expect(new Store(join(dir, 'games.json')).archive.keep).toBe(25);
      process.env.RISK_ARCHIVE_KEEP = 'lots';
      expect(new Store(join(dir, 'games.json')).archive.keep).toBe(1000);
    } finally {
      delete process.env.RISK_ARCHIVE_KEEP;
    }
  });

  it('records nothing for lobbies that never start, or without persistence', () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const { room } = store.create('Lobby', {}, 'Alice');
    store.delete(room.id, 'host');
    expect(store.archive.list()).toEqual([]);
    store.stopTimers();
    const memory = new Store(null);
    expect(memory.archive.enabled).toBe(false);
    const r = startedGame(memory);
    play(r, 20);
    expect(r.recordId).toBeUndefined();
    memory.stopTimers();
  });

  it('serves records to the admin only', async () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const room = startedGame(store);
    play(room, 10_000);
    const risk = createRiskServer(store, { clientDir: null, adminToken: 'sekret', sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api/admin/archive`;
    const get = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    try {
      expect((await get('')).status).toBe(401);
      const list = (await (await get('', 'sekret')).json()) as { enabled: boolean; games: { id: string }[] };
      expect(list.enabled).toBe(true);
      expect(list.games).toHaveLength(1);
      const id = list.games[0].id;
      const record = (await (await get(`/${id}`, 'sekret')).json()) as GameRecord;
      expect(record.id).toBe(id);
      expect((await get('/nope', 'sekret')).status).toBe(404);

      const step = record.steps.find((s) => s.phase === 'attack')!;
      const res = await get(`/${id}/steps/${step.i}?viewer=${step.player}`, 'sekret');
      const moment = (await res.json()) as { state: { territories: Record<string, unknown> }; view: { you: string; territories: Record<string, { hidden?: boolean }> } };
      expect(moment.view.you).toBe(step.player);
      record.territories.forEach((t, i) => expect(!!moment.view.territories[t].hidden).toBe(step.seen![i] === null));
      expect(Object.keys(moment.state.territories)).toHaveLength(record.territories.length);
      expect((await get(`/${id}/steps/99999`, 'sekret')).status).toBe(400);
      expect((await get(`/${id}/steps/0?viewer=stranger`, 'sekret')).status).toBe(400);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('serves finished games as public match history, newest first, without boards', async () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const first = startedGame(store);
    play(first, 10_000);
    const second = startedGame(store);
    play(second, 10_000, 9);
    const closed = startedGame(store);
    play(closed, 30);
    store.delete(closed.id, 'host');
    const risk = createRiskServer(store, { clientDir: null, adminToken: 'sekret', sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api/history`;
    try {
      const res = await fetch(base);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled: boolean; games: Record<string, unknown>[] };
      expect(body.enabled).toBe(true);
      // The closed game has no winner and is left out; the newest finished game comes first.
      expect(body.games.map((g) => g.room)).toEqual([second.id, first.id]);
      expect(body.games[0]).toMatchObject({ name: 'Archive test', fog: true, scenario: false, winner: { id: second.state.winner } });
      expect(body.games[0]).not.toHaveProperty('file');
      expect(body.games[0]).not.toHaveProperty('steps');
      const players = body.games[0].players as { name: string; place: number }[];
      expect(players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
      expect(players.map((p) => p.place).sort()).toEqual([1, 2]);
      const one = (await (await fetch(`${base}?limit=1`)).json()) as { games: unknown[] };
      expect(one.games).toHaveLength(1);
    } finally {
      await risk.shutdown('test');
    }
  });
});
