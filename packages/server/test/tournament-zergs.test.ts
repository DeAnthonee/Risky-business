import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Bots move without the 700 ms pause, so whole tables play out in the test. Set before the store module loads.
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');
const { ZERG_NAMES, isZergSeat } = await import('../src/bot.js');

const ADMIN = 'admin-secret';
let store: InstanceType<typeof Store>;
let risk: ReturnType<typeof createRiskServer>;
let base: string;

async function call<T = any>(path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

const reptile = (name: string) => (ZERG_NAMES as readonly string[]).includes(name.replace(/ \d+$/, ''));

beforeAll(async () => {
  store = new Store(null);
  risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await risk.shutdown('test');
});

describe('Zerg entrants in tournaments', () => {
  it('the host adds Zergs and bots; only the host can; names are unique reptile names', async () => {
    const created = await call('/admin/tournaments', { name: 'Horde Cup', fillBots: false, groupSize: 4, maxEntrants: 30 }, ADMIN);
    const { hostToken } = created.body;
    const id = created.body.tournament.id;
    expect((await call(`/tournaments/${id}/bots`, { kind: 'zerg', count: 2 })).status).toBe(401);
    expect((await call(`/tournaments/${id}/bots`, { kind: 'zerg', count: 2 }, 'not-the-host')).status).toBe(403);
    expect((await call(`/tournaments/${id}/bots`, { kind: 'dragon' }, hostToken)).status).toBe(400);
    expect((await call(`/tournaments/${id}/bots`, { kind: 'zerg', count: 31 }, hostToken)).status).toBe(400);

    // More Zergs than the reptile list: the names go on as "Godzilla 2" and so on, still unique.
    const zergs = await call(`/tournaments/${id}/bots`, { kind: 'zerg', count: ZERG_NAMES.length + 2 }, hostToken);
    expect(zergs.status).toBe(201);
    const names: string[] = zergs.body.added.map((a: any) => a.name);
    expect(names.every(reptile)).toBe(true);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    const bots = await call(`/tournaments/${id}/bots`, { count: 2 }, hostToken);
    expect(bots.body.added.map((a: any) => a.name)).toEqual(['Bot 1', 'Bot 2']);
    expect((await call(`/tournaments/${id}/start`, {}, hostToken)).status).toBe(200);
    expect((await call(`/tournaments/${id}/bots`, { kind: 'zerg' }, hostToken)).status).toBe(400);
  });

  it('Zerg entrants sit as Zergs at their tables, and the tournament plays out to a champion', async () => {
    const created = await call('/admin/tournaments', { name: 'Swarm Cup', fillBots: false, groupSize: 4 }, ADMIN);
    const { hostToken } = created.body;
    const id = created.body.tournament.id;
    await call(`/tournaments/${id}/bots`, { kind: 'zerg', count: 6 }, hostToken);
    await call(`/tournaments/${id}/bots`, { kind: 'bot', count: 2 }, hostToken);
    const t = store.tournaments.get(id)!;
    const done = new Promise<void>((resolve) => store.tournaments.on('change', (changed: string) => changed === id && t.status === 'finished' && resolve()));
    await call(`/tournaments/${id}/start`, {}, hostToken);

    // Round 1: 8 entrants at 2 tables of 4. Every Zerg entrant is a Zerg seat with its tournament name.
    const zergNames = new Set(t.entrants.filter((e) => e.kind === 'zerg').map((e) => e.name));
    for (const m of t.rounds[0].matches) {
      const room = store.get(m.gameId!)!;
      for (const p of room.state.players.filter((x) => !x.isNeutral)) expect(isZergSeat(p.id)).toBe(zergNames.has(p.name));
    }
    await done;
    expect(t.status).toBe('finished');
    expect(t.champion).not.toBeNull();
  }, 60_000);
});
