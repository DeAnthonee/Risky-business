import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '@risk/engine';
import { sumReports, zergReport, type ReportStep } from '../src/zerg-report.js';

// Bots move without the 700 ms pause, so the live game plays out in the test. Set before the store module loads.
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');

const players = [
  { id: 'p_ann', name: 'Ann' },
  { id: 'zerg_a', name: 'Elon Zerg' },
  { id: 'zerg_b', name: 'Mark Zergburg' },
  { id: 'neutral', name: 'Neutral', isNeutral: true },
];
const turn = (player: string, territories: number): GameEvent =>
  ({ type: 'turn_started', player, turnNumber: 1, round: 1, reinforcements: { territories, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0 } }) as unknown as GameEvent;
const battle = (attacker: string, defender: string, attackerLosses: number, defenderLosses: number): GameEvent =>
  ({ type: 'battle', attacker, defender, from: 'x', to: 'y', attackerDice: [], defenderDice: [], attackerLosses, defenderLosses, fromArmies: 0, toArmies: 0 }) as GameEvent;
const conquered = (player: string, previousOwner: string): GameEvent => ({ type: 'conquered', player, from: 'x', to: 'y', previousOwner }) as GameEvent;
const out = (player: string, by: string | null): GameEvent => ({ type: 'eliminated', player, by }) as GameEvent;
const step = (player: string | null, type: string, ...events: GameEvent[]): ReportStep => ({ player, action: { type }, events });

describe('zergReport (a crafted game)', () => {
  const steps: ReportStep[] = [
    step(null, 'start', turn('zerg_a', 10)),
    // Alarm 1: a Zerg attacks a fellow Zerg while Ann (prey) is alive.
    step('zerg_a', 'attack', battle('zerg_a', 'zerg_b', 1, 2)),
    step('zerg_a', 'attack', battle('zerg_a', 'p_ann', 2, 3), conquered('zerg_a', 'p_ann')),
    step('zerg_a', 'attack', battle('zerg_a', 'neutral', 0, 2), conquered('zerg_a', 'neutral')),
    step('zerg_a', 'end_turn', turn('p_ann', 6)),
    step('p_ann', 'attack', battle('p_ann', 'zerg_b', 1, 1)),
    step('p_ann', 'end_turn', turn('zerg_b', 7)),
    // Alarm 2: Mark Zergburg surrenders while Ann is alive; it held 7 territories at its last turn.
    step('zerg_b', 'surrender', out('zerg_b', null)),
    step('zerg_a', 'attack', battle('zerg_a', 'p_ann', 1, 4), conquered('zerg_a', 'p_ann'), out('p_ann', 'zerg_a'), { type: 'game_over', winner: 'zerg_a', reason: 'domination' } as GameEvent),
  ];
  const r = zergReport(steps, players);

  it('counts attacks, trades, conquests and knockouts for the swarm', () => {
    expect(r.zergs).toBe(2);
    expect(r.attacks).toEqual({ onPrey: 2, onZergs: 1, onNeutral: 1 });
    // Destroyed by Zergs: Ann 3 + 4 (+1 Ann lost attacking Mark), Zergs 2, neutral 2. Lost by Zergs: 1+2 (Zerg on Zerg) + 2 + 0 + 1 (Mark defending) + 1.
    expect(r.destroyed).toEqual({ prey: 8, zergs: 2, neutral: 2 });
    expect(r.lost).toBe(7);
    expect(r.tradeRatio).toBe(1.71);
    expect(r.conquests).toEqual({ fromPrey: 2, fromZergs: 0, fromNeutral: 1 });
    expect(r.knockouts).toEqual({ bySwarm: 1, ofSwarm: 1 });
  });

  it('raises both alarms: a Zerg-on-Zerg attack and a surrender while prey was alive', () => {
    expect(r.alarms).toEqual({ zergOnZerg: 1, midGameSurrenders: 1 });
    expect(r.zergOnZergWhilePreyAlive).toEqual([{ step: 1, attacker: 'Elon Zerg', defender: 'Mark Zergburg' }]);
    expect(r.surrenders.list).toEqual([{ step: 7, player: 'Mark Zergburg', midGame: true, landLeft: 7 }]);
  });

  it('a per-seat table, with how each seat ended', () => {
    const by = Object.fromEntries(r.seats.map((s) => [s.name, s]));
    expect(by['Elon Zerg']).toMatchObject({ zerg: true, attacks: 4, rolls: 4, conquests: 3, knockouts: 1, ended: 'won', peakTerritories: 10 });
    expect(by['Mark Zergburg']).toMatchObject({ zerg: true, ended: 'surrendered' });
    expect(by.Ann).toMatchObject({ zerg: false, attacks: 1, ended: 'knocked out by Elon Zerg' });
    expect(r.seats.some((s) => s.name === 'Neutral')).toBe(false);
  });

  it('after the prey is gone, Zerg-on-Zerg attacks and surrenders are the endgame, not alarms', () => {
    const endgame = zergReport(
      [
        step('zerg_a', 'attack', battle('zerg_a', 'p_ann', 0, 2), out('p_ann', 'zerg_a')),
        step('zerg_a', 'attack', battle('zerg_a', 'zerg_b', 1, 1)),
        step('zerg_b', 'surrender', out('zerg_b', null)),
      ],
      players,
    );
    expect(endgame.alarms).toEqual({ zergOnZerg: 0, midGameSurrenders: 0 });
    expect(endgame.attacks.onZergs).toBe(1);
    expect(endgame.surrenders).toMatchObject({ midGame: 0, endgame: 1 });
  });
});

describe('Zerg reports over HTTP', () => {
  let dir: string;
  let store: InstanceType<typeof Store>;
  let risk: ReturnType<typeof createRiskServer>;
  let base: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'risk-zr-'));
    store = new Store(join(dir, 'games.json'));
    risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await risk.shutdown('test');
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** A game of 2 Zergs + 1 built-in bot (the host surrenders at once). Resolves when it is finished. */
  async function zergGame(finish = true) {
    const created = (await call('/games', { playerName: 'Host', options: { autoSetup: true } })).body;
    for (let i = 0; i < 2; i++) await call(`/games/${created.gameId}/bots`, { kind: 'zerg' }, created.token);
    await call(`/games/${created.gameId}/bots`, {}, created.token);
    const room = store.get(created.gameId)!;
    const finished = new Promise<void>((resolve) => room.on('change', () => room.state.phase === 'finished' && resolve()));
    await call(`/games/${created.gameId}/start`, {}, created.token);
    if (!finish) {
      room.stopBot();
      return created.gameId as string;
    }
    await call(`/games/${created.gameId}/actions`, { action: { type: 'surrender' } }, created.token);
    await finished;
    return created.gameId as string;
  }

  it('a finished game with Zergs: its live tally (added to THE HOUSE as it ends) equals the report from its record', async () => {
    // Fill the finished total first (empty), so this game's live tally is what gets added when it ends.
    expect((await call('/house-bots')).body.swarm.games).toBe(0);
    const gameId = await zergGame();
    expect((store as any).zergTallies.has(gameId)).toBe(false);

    const [entry] = store.archive.list();
    expect(entry.room).toBe(gameId);
    const first = await call(`/history/${entry.id}/report`);
    expect(first.status).toBe(200);
    expect(first.body.zergs).toBe(2);
    expect(first.body.alarms.zergOnZerg).toBe(0);
    expect(first.body.attacks.onPrey).toBeGreaterThan(0);
    expect(first.body.seats).toHaveLength(4);
    expect((await call(`/history/${entry.id}/report`)).body).toEqual(first.body);

    // THE HOUSE's total came from the live walk; it equals the record's walk, number for number.
    const swarm = (await call('/house-bots')).body.swarm;
    expect(swarm).toEqual(sumReports([first.body]));
    expect((await call('/history/NOPE00-xx/report')).status).toBe(404);
  }, 60_000);

  it('a room dropped mid-game leaves no tally behind, and its game counts once', async () => {
    const before = (await call('/house-bots')).body.swarm.games;
    const gameId = await zergGame(false);
    expect((store as any).zergTallies.has(gameId)).toBe(true);
    expect((await call('/house-bots')).body.swarm.games).toBe(before + 1);
    store.delete(gameId, 'admin');
    expect((store as any).zergTallies.has(gameId)).toBe(false);
    // Counted once: as a live game before, as a finished (closed) one after.
    expect((await call('/house-bots')).body.swarm.games).toBe(before + 1);
  }, 60_000);

  it('GET /house-bots does not re-scan the archive per request', async () => {
    const list = vi.spyOn(store.archive, 'list');
    const read = vi.spyOn(store.archive, 'read');
    await call('/house-bots');
    await call('/house-bots');
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    list.mockRestore();
    read.mockRestore();
  });

  it('a fresh server fills the finished total from the archive once, reading each record once', async () => {
    const again = new Store(join(dir, 'games.json'));
    const list = vi.spyOn(again.archive, 'list');
    const read = vi.spyOn(again.archive, 'read');
    const first = again.swarmReport();
    expect(first.games).toBe(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    again.swarmReport();
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    again.stopTimers();
  });
});
