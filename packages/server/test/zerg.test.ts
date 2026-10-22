import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '@risk/engine';

type BattleEvent = Extract<GameEvent, { type: 'battle' }>;

// Bots move without the 700 ms pause, so a whole game plays out in the test. Set before the store module loads.
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');
const { ZERG_NAMES, isZergSeat } = await import('../src/bot.js');

let risk: ReturnType<typeof createRiskServer>;
let store: InstanceType<typeof Store>;
let base: string;

async function api<T = any>(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  store = new Store(null);
  risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await risk.shutdown('test');
});

describe('Zerg seats', () => {
  it('seats Zergs with distinct reptile names, and rejects a custom name or an unknown kind', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { maxPlayers: 6 } }) });
    const { gameId, token } = created.body;
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await api(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind: 'zerg' }) }, token);
      expect(r.status).toBe(201);
      expect(isZergSeat(r.body.playerId)).toBe(true);
      names.push(r.body.name);
    }
    expect(names.every((n) => (ZERG_NAMES as readonly string[]).includes(n))).toBe(true);
    expect(new Set(names).size).toBe(4);
    expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind: 'zerg', name: 'Bob' }) }, token)).status).toBe(400);
    expect((await api(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind: 'dragon' }) }, token)).status).toBe(400);
    const plain = await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token);
    expect(plain.status).toBe(201);
    expect(isZergSeat(plain.body.playerId)).toBe(false);
  });

  it('plays 2 Zergs + 1 built-in bot to the end: no Zerg-on-Zerg attack while the bot lives, then they fight to one winner', async () => {
    const created = await api('/games', { method: 'POST', body: JSON.stringify({ playerName: 'Host', options: { autoSetup: true } }) });
    const { gameId, token, playerId: host } = created.body;
    const zergs: string[] = [];
    for (let i = 0; i < 2; i++) zergs.push((await api(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ kind: 'zerg' }) }, token)).body.playerId);
    const bot = (await api(`/games/${gameId}/bots`, { method: 'POST', body: '{}' }, token)).body.playerId as string;

    const room = store.get(gameId)!;
    const zergOnZerg: BattleEvent[] = [];
    let fallingOut = 0;
    let zergBattles = 0;
    let bothZergsLeft = false;
    const zergSurrenders: string[] = [];
    room.on('commit', ({ before, next, events, playerId, action }) => {
      const botAlive = before.players.find((p) => p.id === bot)!.alive;
      for (const e of events) {
        if (e.type === 'battle' && isZergSeat(e.attacker)) zergBattles++;
        if (e.type !== 'battle' || !isZergSeat(e.attacker) || !isZergSeat(e.defender)) continue;
        if (botAlive) zergOnZerg.push(e);
        else fallingOut++;
      }
      if (botAlive && !next.players.find((p) => p.id === bot)!.alive) bothZergsLeft = zergs.every((z) => next.players.find((p) => p.id === z)!.alive);
      if (action.type === 'surrender' && playerId && isZergSeat(playerId)) zergSurrenders.push(playerId);
    });
    const finished = new Promise<void>((resolve) => room.on('change', () => room.state.phase === 'finished' && resolve()));

    expect((await api(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token)).status).toBe(200);
    // The host steps aside: 2 Zergs against 1 built-in bot.
    expect((await api(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action: { type: 'surrender' } }) }, token)).status).toBe(200);
    await finished;

    expect(room.state.phase).toBe('finished');
    expect(zergBattles).toBeGreaterThan(0);
    expect(zergOnZerg).toEqual([]);
    // The horde hunts the bot down first, and a Zerg takes the game.
    expect(room.eliminationOrder).toContain(bot);
    expect(zergs).toContain(room.state.winner);
    // No Zerg ever surrenders; when both outlive the bot, they fight it out to one winner.
    expect(zergSurrenders).toEqual([]);
    if (bothZergsLeft) expect(fallingOut).toBeGreaterThan(0);
    expect(room.state.players.filter((p) => isZergSeat(p.id)).every((p) => (ZERG_NAMES as readonly string[]).includes(p.name))).toBe(true);
    expect(room.state.players.find((p) => p.id === host)!.alive).toBe(false);
  }, 60_000);
});
