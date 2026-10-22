import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { houseBotStats, rankTournaments, scoreTournament, type ScoredBracket } from '../src/tournament-scoring.js';

// Bots move without the 700 ms pause, so a whole tournament plays out in the test. Set before the store module loads.
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');

const st = (lost: number, destroyed: number, conquests: number, peak: number, turns: number) => ({ lost, destroyed, conquests, peak, turns });

/** Two tables of three, then a final: a player (Ann), a Zerg (Komodo) and four fill bots. */
const bracket: ScoredBracket = {
  id: 'THB001',
  name: 'Bot Cup',
  entrants: [
    { id: 'ann', name: 'Ann', isBot: false },
    { id: 'kom', name: 'Komodo', isBot: true, kind: 'zerg' },
    { id: 'b1', name: 'Bot 1', isBot: true },
    { id: 'b2', name: 'Bot 2', isBot: true },
    { id: 'b3', name: 'Bot 3', isBot: true },
    { id: 'b4', name: 'Bot 4', isBot: true },
  ],
  rounds: [
    {
      matches: [
        { entrants: ['ann', 'b1', 'b2'], winner: 'ann', status: 'finished', order: ['ann', 'b1', 'b2'], kills: { ann: 1, b1: 1, b2: 0 }, stats: { ann: st(10, 20, 9, 30, 25), b1: st(14, 6, 4, 18, 25), b2: st(12, 4, 2, 12, 10) } },
        { entrants: ['kom', 'b3', 'b4'], winner: 'b3', status: 'decided', order: ['b3', 'kom', 'b4'], kills: { kom: 0, b3: 1, b4: 0 }, stats: { kom: st(30, 25, 11, 41, 40), b3: st(20, 33, 12, 35, 40), b4: st(25, 2, 1, 9, 22) } },
      ],
    },
    {
      matches: [{ entrants: ['ann', 'b3'], winner: 'b3', status: 'finished', order: ['b3', 'ann'], kills: { b3: 1, ann: 0 }, stats: { ann: st(18, 9, 3, 26, 15), b3: st(9, 18, 7, 44, 15) } }],
    },
  ],
  champion: 'b3',
};

describe('house bots (owner, 2026-10-22)', () => {
  it('fill bots are not ranked; Zergs and players are', () => {
    const rows = rankTournaments([scoreTournament(bracket)!]);
    expect(rows.map((r) => r.name).sort()).toEqual(['Ann', 'Komodo']);
  });

  it('aggregates fun stats for fill bots and Zergs, with records', () => {
    const h = houseBotStats([scoreTournament(bracket)!]);
    expect(h.bots).toMatchObject({ bots: 4, entries: 4, tables: 5, tablesWon: 2, kills: 3, knockedOut: 3, championships: 1, finals: 1 });
    expect(h.bots.armiesLost).toBe(14 + 12 + 20 + 25 + 9);
    expect(h.bots.armiesDestroyed).toBe(6 + 4 + 33 + 2 + 18);
    expect(h.bots.best).toEqual({ name: 'Bot 3', finish: 'champion', tournament: 'Bot Cup' });
    expect(h.bots.records.mostKills).toEqual({ name: 'Bot 3', value: 2, tournament: 'Bot Cup' });
    expect(h.bots.records.mostArmiesLost).toEqual({ name: 'Bot 4', value: 25, tournament: 'Bot Cup' });
    expect(h.bots.records.longestSurvival?.value).toBe(40);
    expect(h.bots.records.biggestArmy).toEqual({ name: 'Bot 3', value: 44, tournament: 'Bot Cup' });
    expect(h.bots.records.mostConquests).toEqual({ name: 'Bot 3', value: 19, tournament: 'Bot Cup' });
    // The Zerg is reported apart (and stays on the ranked board).
    expect(h.zergs).toMatchObject({ bots: 1, entries: 1, tables: 1, kills: 0, knockedOut: 1, armiesLost: 30 });
    expect(h.zergs.records.biggestArmy).toEqual({ name: 'Komodo', value: 41, tournament: 'Bot Cup' });
    expect(h.zergs.records.mostKills).toBeNull();
  });

  it('results saved before fun stats existed still aggregate (counts only)', () => {
    const old = scoreTournament(bracket)!;
    for (const e of [...old.entrants, ...(old.bots ?? [])]) delete e.fun;
    const h = houseBotStats([old]);
    expect(h.bots.entries).toBe(4);
    expect(h.bots.tables).toBe(0);
    expect(h.bots.records.biggestArmy).toBeNull();
  });
});

describe('house bots over HTTP', () => {
  let store: InstanceType<typeof Store>;
  let risk: ReturnType<typeof createRiskServer>;
  let base: string;
  beforeAll(async () => {
    store = new Store(null);
    risk = createRiskServer(store, { clientDir: null, adminToken: 'hb-admin', sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await risk.shutdown('test');
  });
  const call = async (path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    return (await res.json()) as any;
  };

  it('a tournament played by fill bots shows in houseBots, collected from the moves, and none of them is ranked', async () => {
    const id = (await call('/admin/tournaments', { name: 'Fill Cup', groupSize: 4, fillBots: true }, 'hb-admin')).tournament.id;
    await call(`/tournaments/${id}/join`, { playerName: 'Solo' });
    const t = store.tournaments.get(id)!;
    const done = new Promise<void>((resolve) => store.tournaments.on('change', (changed: string) => changed === id && t.status === 'finished' && resolve()));
    await call(`/admin/tournaments/${id}/start`, {}, 'hb-admin');
    // The only person forfeits, so bots play it out.
    const solo = t.entrants.find((e) => !e.isBot)!;
    await call(`/admin/tournaments/${id}/forfeit`, { entrantId: solo.id }, 'hb-admin');
    await done;

    const board = await call('/rankings?board=tournament');
    expect(board.rankings.every((r: any) => !r.key.startsWith('bot:'))).toBe(true);
    const h = board.houseBots;
    expect(h.bots.entries).toBe(3);
    expect(h.bots.tables).toBeGreaterThan(0);
    expect(h.bots.armiesLost).toBeGreaterThan(0);
    expect(h.bots.armiesDestroyed).toBeGreaterThan(0);
    expect(h.bots.records.biggestArmy.value).toBeGreaterThan(0);
    expect(h.bots.records.longestSurvival.value).toBeGreaterThan(0);
    expect(h.bots.best.finish).toMatch(/champion|final/);
    expect(h.zergs.entries).toBe(0);
  }, 60_000);
});
