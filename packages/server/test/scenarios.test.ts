import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { boardOf, chooseBotAction, createRng, nextFloat, verifyRecord, type GameRecord } from '@risk/engine';
import { Store, type GameRoom } from '../src/store.js';
import { createRiskServer } from '../src/app.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir() {
  const d = mkdtempSync(join(tmpdir(), 'risk-scenario-'));
  dirs.push(d);
  return d;
}

/** Play the current player's moves with a seeded bot, up to `max` actions or the end of the game. */
function play(room: GameRoom, max: number, seed = 5) {
  const rng = createRng(seed);
  for (let n = 0; n < max && room.state.phase !== 'finished'; n++) {
    const me = room.state.currentPlayer!;
    room.act(me, chooseBotAction(room.state, me, () => nextFloat(rng))!);
  }
}

/** A finished, recorded fog-of-war game between two seats (not built-in bots, so no timers run). */
function recordedGame(store: Store): GameRecord {
  const { room } = store.create('Original', { fogOfWar: true }, 'Alice');
  room.join('Bob');
  room.start();
  play(room, 10_000);
  return store.archive.get(store.archive.list()[0].id)!;
}

interface Seat {
  playerId: string;
  name: string;
  alive: boolean;
  bot: boolean;
  token: string;
}

async function serve(store: Store) {
  const risk = createRiskServer(store, { clientDir: null, adminToken: 'sekret', sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { risk, base, post };
}

describe('scenarios', () => {
  it('turns a recorded moment into a game that plays to the end and is recorded too', async () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const original = recordedGame(store);
    const step = original.steps.find((s) => s.i > 30 && s.phase === 'attack')!.i;
    const { risk, post } = await serve(store);
    try {
      expect((await post('/admin/scenarios', { recordId: original.id, step })).status).toBe(401);
      const seats = Object.fromEntries(original.players.filter((p) => !p.isNeutral).map((p) => [p.id, 'open']));
      const res = await post('/admin/scenarios', { recordId: original.id, step, seats }, 'sekret');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { gameId: string; seats: Seat[]; scenarioOf: unknown; game: { scenarioOf: unknown } };
      expect(body.scenarioOf).toEqual({ recordId: original.id, step });
      expect(body.game.scenarioOf).toEqual(body.scenarioOf);
      expect(body.seats.map((s) => s.playerId).sort()).toEqual(original.players.filter((p) => !p.isNeutral).map((p) => p.id).sort());
      expect(body.seats.every((s) => !s.bot && s.token)).toBe(true);

      const room = store.get(body.gameId)!;
      expect(room.id).not.toBe(original.room.id);
      expect(room.hostId).toBe('');
      expect(boardOf(room.state, original)).toEqual(original.steps[step].board);
      expect(room.state.currentPlayer).toBe(original.steps[step].player);
      expect(room.state.seed).not.toBe(original.seed);
      expect(room.snapshot().scenarioOf).toEqual(body.scenarioOf);

      // A seat's token plays it over the API like any game.
      const mover = body.seats.find((s) => s.playerId === room.state.currentPlayer)!;
      const acted = await post(`/games/${room.id}/actions`, { action: chooseBotAction(room.state, mover.playerId, () => 0.5) }, mover.token);
      expect(acted.status).toBe(200);

      play(room, 10_000, 8);
      expect(room.state.phase).toBe('finished');
      const entry = store.archive.list().find((e) => e.room === room.id)!;
      expect(entry.scenarioOf).toEqual(body.scenarioOf);
      const record = store.archive.get(entry.id)!;
      expect(record.scenarioOf).toEqual(body.scenarioOf);
      expect(record.start.state.id).toBe(room.id);
      expect(boardOf(record.start.state, record)).toEqual(original.steps[step].board);
      expect(record.outcome.finished).toBe(true);
      expect(verifyRecord(record)).toBeNull();
      // Someone else's position: the result is not ranked.
      expect(store.rankings.rows().reduce((n, r) => n + r.games, 0)).toBe(2);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('seats bots by default, rolls new dice, and lets a token holder take a seat over', async () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const original = recordedGame(store);
    const { risk, post } = await serve(store);
    try {
      const step = original.steps.find((s) => s.i > 10 && s.phase === 'reinforce')!.i;
      const kept = (await (await post('/admin/scenarios', { recordId: original.id, step, keepDice: true }, 'sekret')).json()) as { gameId: string };
      const fresh = (await (await post('/admin/scenarios', { recordId: original.id, step }, 'sekret')).json()) as { gameId: string; seats: Seat[] };
      const keptRoom = store.get(kept.gameId)!;
      const room = store.get(fresh.gameId)!;
      expect(keptRoom.state.seed).toBe(original.seed);
      expect(room.state.seed).not.toBe(original.seed);
      expect(fresh.seats.every((s) => s.bot)).toBe(true);
      expect(room.state.players.every((p) => p.isBot || p.isNeutral)).toBe(true);
      // Bots-only scenarios are kept for watching rather than swept at once.
      expect(store.staleReason(room)).toBeNull();
      store.delete(keptRoom.id);

      const seat = fresh.seats[0];
      expect((await post(`/games/${room.id}/seat`, {}, 'not-a-token')).status).toBe(401);
      expect((await post(`/games/${room.id}/seat`, {}, seat.token)).status).toBe(200);
      expect(room.state.players.find((p) => p.id === seat.playerId)!.isBot).toBe(false);
      expect((await post(`/games/${room.id}/seat`, { bot: true }, seat.token)).status).toBe(200);
      expect(room.state.players.find((p) => p.id === seat.playerId)!.isBot).toBe(true);

      // Only scenario seats can change hands.
      const { room: plain, token } = store.create('Plain', {}, 'Carol');
      expect((await post(`/games/${plain.id}/seat`, {}, token)).status).toBe(400);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('refuses bad scenario requests', async () => {
    const dir = dataDir();
    const store = new Store(join(dir, 'games.json'));
    const original = recordedGame(store);
    const { risk, post } = await serve(store);
    try {
      const create = (body: unknown) => post('/admin/scenarios', body, 'sekret');
      expect((await create({ recordId: 'nope', step: 0 })).status).toBe(404);
      expect((await create({ recordId: original.id, step: -1 })).status).toBe(400);
      expect((await create({ recordId: original.id, step: 1.5 })).status).toBe(400);
      // The last step is after the win.
      expect((await create({ recordId: original.id, step: original.steps.length })).status).toBe(400);
      expect((await create({ recordId: original.id, step: 0, seats: { stranger: 'open' } })).status).toBe(400);
      expect((await create({ recordId: original.id, step: 0, seats: ['open'] })).status).toBe(400);
      expect((await create({ recordId: original.id, step: 0, keepDice: 'yes' })).status).toBe(400);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('keeps a scenario across a restart', () => {
    const dir = dataDir();
    const file = join(dir, 'games.json');
    const first = new Store(file);
    const original = recordedGame(first);
    const open = Object.fromEntries(original.players.filter((p) => !p.isNeutral).map((p) => [p.id, 'open' as const]));
    const { room } = first.createScenario(original, 20, { seats: open });
    play(room, 15);
    first.save();
    first.stopTimers();

    const second = new Store(file);
    const again = second.get(room.id)!;
    expect(again.scenarioOf).toEqual({ recordId: original.id, step: 20 });
    expect(again.summary().scenarioOf).toEqual(again.scenarioOf);
    play(again, 10_000, 9);
    const record = second.archive.get(second.archive.list().find((e) => e.room === room.id)!.id)!;
    expect(record.scenarioOf).toEqual(again.scenarioOf);
    expect(verifyRecord(record)).toBeNull();
    second.stopTimers();
  });
});
