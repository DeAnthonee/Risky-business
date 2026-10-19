import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAP_IDS, getMap } from '@risk/engine';
import { HttpRiskApi, RiskHttpError, type RiskApi } from '@risk/mcp';
import { Store } from '../../server/src/store.js';
import { createRiskServer, type RiskServer } from '../../server/src/app.js';
import { gameOptions, mapMaxPlayers, pickLineup, rotationMaps, type RosterEntry } from '../src/presets.js';
import { backoffMs, withRetry } from '../src/resilient.js';
import { discoverRoster, findAiDir, loadCharacter, localRoster, readLocalCharacter } from '../src/roster.js';
import { LoopControl, runLoop } from '../src/loop.js';
import { createGame } from '../src/setup.js';
import { seeded } from './headless.js';

const ten: RosterEntry[] = ['ahri', 'darius', 'jinx', 'leona', 'lux', 'shaco', 'shen', 'teemo', 'thresh', 'tryndamere'].map((n) => ({ id: `league/${n}`, name: n[0].toUpperCase() + n.slice(1) }));

describe('map helpers', () => {
  it('rotation uses each map maxPlayers from the engine', () => {
    for (const id of MAP_IDS) expect(mapMaxPlayers(id)).toBe(getMap(id).maxPlayers);
    for (const n of [2, 6, 8, 10]) for (const id of rotationMaps(n)) expect(getMap(id).maxPlayers).toBeGreaterThanOrEqual(n);
    expect(rotationMaps(10)).not.toContain('classic');
    expect(rotationMaps(10)).not.toContain('europe_advanced');
  });
});

describe('pickLineup', () => {
  it('draws a legal map, 5 to min(10, maxPlayers) distinct characters, unique seat names', () => {
    const counts = new Set<number>();
    const maps = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const { map, seats } = pickLineup({ map: 'random', players: 'random', roster: ten, index: seed, random: seeded(seed) });
      expect(map).not.toBe('skirmish');
      expect(map).not.toBe('europe_advanced');
      expect(seats.length).toBeGreaterThanOrEqual(5);
      expect(seats.length).toBeLessThanOrEqual(Math.min(10, getMap(map).maxPlayers));
      expect(new Set(seats.map((s) => s.characterId)).size).toBe(seats.length);
      expect(new Set(seats.map((s) => s.name.toLowerCase())).size).toBe(seats.length);
      for (const s of seats) expect(s.name).toBe(ten.find((c) => c.id === s.characterId)!.name);
      counts.add(seats.length);
      maps.add(map);
    }
    expect(Math.max(...counts)).toBe(10);
    expect(Math.min(...counts)).toBe(5);
    expect(maps.size).toBeGreaterThan(5);
  });

  it('honours a fixed count and a fixed map, rotates, and refuses what cannot fit', () => {
    const fixed = pickLineup({ map: 'random', players: 8, roster: ten, index: 0, random: seeded(1) });
    expect(fixed.seats).toHaveLength(8);
    expect(getMap(fixed.map).maxPlayers).toBeGreaterThanOrEqual(8);
    const onClassic = pickLineup({ map: 'classic', players: 'random', roster: ten, index: 0, random: seeded(2) });
    expect(onClassic.map).toBe('classic');
    expect([5, 6]).toContain(onClassic.seats.length);
    const first = pickLineup({ map: 'rotate', players: 6, roster: ten, index: 0, random: seeded(3) }).map;
    expect(first).toBe(rotationMaps(6)[0]);
    expect(() => pickLineup({ map: 'classic', players: 8, roster: ten, index: 0 })).toThrow(/at most 6/);
    expect(() => pickLineup({ map: 'random', players: 11, roster: ten, index: 0 })).toThrow();
    expect(() => pickLineup({ map: 'random', players: 'random', roster: ten.slice(0, 1), index: 0 })).toThrow();
    // A small roster still plays: everyone sits.
    expect(pickLineup({ map: 'random', players: 'random', roster: ten.slice(0, 4), index: 0, random: seeded(4) }).seats).toHaveLength(4);
  });

  it('keeps seat names unique when two characters share a display name', () => {
    const dup = [...ten.slice(0, 5), { id: 'league/other', name: 'Ahri' }, ...ten.slice(5)];
    for (let seed = 1; seed <= 20; seed++) {
      const { seats } = pickLineup({ map: 'random', players: 10, roster: dup, index: 0, random: seeded(seed) });
      expect(new Set(seats.map((s) => s.name.toLowerCase())).size).toBe(seats.length);
    }
  });
});

const failing = (status: number): RiskApi =>
  ({
    listCharacters: async () => ({ characters: [] }),
    getCharacter: async () => {
      throw new RiskHttpError('Character not found', status);
    },
  }) as unknown as RiskApi;

describe('roster and local profiles', () => {
  const aiDir = findAiDir();

  it('finds the repo AI folder and lists the league characters', async () => {
    expect(aiDir).not.toBeNull();
    const roster = await localRoster(aiDir);
    const ids = roster.map((r) => r.id);
    for (const id of ['league/shen', 'league/shaco', 'league/tryndamere', 'league/teemo', 'league/leona', 'league/ahri']) expect(ids).toContain(id);
    expect(ids.every((id) => !id.includes('relationships'))).toBe(true);
    expect(roster.find((r) => r.id === 'league/shen')!.name).toBe('Shen');
  });

  it('falls back to the local file (with relationships) when the server has no profile', async () => {
    const c = await loadCharacter(failing(404), 'league/shen', aiDir);
    expect(c?.source).toBe('local');
    expect(c?.markdown).toContain('Shen');
    expect(c?.relationships).toContain('relationships');
    expect(await loadCharacter(failing(404), 'league/nobody-here', aiDir)).toBeNull();
    expect(await readLocalCharacter(aiDir, '../../CLAUDE')).toBeNull();
    expect(await readLocalCharacter(null, 'league/shen')).toBeNull();
    const api = { getCharacter: async () => ({ markdown: '# From server' }) } as unknown as RiskApi;
    expect(await loadCharacter(api, 'league/shen', aiDir)).toMatchObject({ source: 'server', markdown: '# From server' });
  });

  it('builds the roster from the server list plus local files', async () => {
    const lines: string[] = [];
    const empty = await discoverRoster(failing(404), aiDir, (l) => lines.push(l));
    expect(empty.length).toBeGreaterThanOrEqual(6);
    const some = { listCharacters: async () => ({ characters: [{ id: 'league/shen', name: 'Shen (server)', universe: 'league' }, { id: 'marvel/ultron', name: 'Ultron', universe: 'marvel' }] }) } as unknown as RiskApi;
    const merged = await discoverRoster(some, aiDir, () => {});
    expect(merged.find((r) => r.id === 'league/shen')!.name).toBe('Shen (server)');
    expect(merged.some((r) => r.id.startsWith('marvel/'))).toBe(false);
    expect(merged.length).toBe(empty.length);
    const down = { listCharacters: async () => { throw new Error('offline'); } } as unknown as RiskApi;
    expect((await discoverRoster(down, aiDir, (l) => lines.push(l))).length).toBe(empty.length);
    expect(lines.some((l) => l.includes('offline'))).toBe(true);
    expect(await discoverRoster(down, null, () => {})).toEqual([]);
  });
});

describe('withRetry', () => {
  it('retries 5xx and network errors with growing waits, not 4xx and not moves', async () => {
    let waits = 0;
    let acts = 0;
    let gets = 0;
    const api = {
      wait: async () => {
        if (++waits <= 2) throw new RiskHttpError('bad gateway', 502);
        return { ok: true };
      },
      getGame: async () => {
        if (++gets === 1) throw new TypeError('fetch failed');
        return { id: 'X' };
      },
      act: async () => {
        acts++;
        throw new RiskHttpError('boom', 500);
      },
      leave: async () => {
        throw new RiskHttpError('Game not found', 404);
      },
    } as unknown as RiskApi;
    const slept: number[] = [];
    const wrapped = withRetry(api, { sleep: async (ms) => void slept.push(ms), random: () => 0.5 });
    expect(await wrapped.wait('G', 't', undefined, 1000)).toEqual({ ok: true });
    expect(waits).toBe(3);
    expect(slept).toEqual([1000, 2000]);
    expect(await wrapped.getGame('G')).toEqual({ id: 'X' });
    await expect(wrapped.act('G', 't', { type: 'end_turn' })).rejects.toThrow('boom');
    expect(acts).toBe(1);
    await expect(wrapped.leave('G', 't')).rejects.toThrow('Game not found');
  });

  it('gives up after the attempts and caps the wait', async () => {
    let n = 0;
    const api = { chat: async () => (n++, Promise.reject(new RiskHttpError('down', 503))) } as unknown as RiskApi;
    const slept: number[] = [];
    await expect(withRetry(api, { attempts: 3, sleep: async (ms) => void slept.push(ms), random: () => 0.5 }).chat('G', 0)).rejects.toThrow('down');
    expect(n).toBe(3);
    expect(slept).toHaveLength(2);
    expect(backoffMs(20, 1000, 20_000, () => 0.5)).toBe(20_000);
    expect(backoffMs(0, 1000, 20_000, () => 0)).toBe(750);
  });
});

describe('createGame', () => {
  it('leaves the seats taken so far when a later step fails', async () => {
    const left: string[] = [];
    let joins = 0;
    const api = {
      createGame: async () => ({ gameId: 'G1', playerId: 'p0', token: 'tok0' }),
      joinGame: async () => {
        if (++joins === 2) throw new RiskHttpError('Game is full', 400);
        return { gameId: 'G1', playerId: `p${joins}`, token: `tok${joins}` };
      },
      start: async () => ({}),
      leave: async (_g: string, token: string) => void left.push(token),
    } as unknown as RiskApi;
    await expect(createGame(api, [{ name: 'A' }, { name: 'B' }, { name: 'C' }])).rejects.toThrow('full');
    expect(left.sort()).toEqual(['tok0', 'tok1']);
  });
});

describe('runLoop with random lineups against a real server', () => {
  let risk: RiskServer;
  let base: HttpRiskApi;
  beforeAll(async () => {
    risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    base = new HttpRiskApi(`http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`);
  });
  afterAll(async () => {
    await risk.shutdown('test');
  });

  const common = { llm: null, learningsDir: 'unused', paceMs: 0, planTimeoutMs: 1000, commander: false, learn: false, chat: false, maxChatPerTurn: 1 } as const;

  it('runs two lobbies simultaneously through the built CLI', async () => {
    const server = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, '--server', server, '--lobbies', '2', '--games', '1', '--players', '2', '--map', 'skirmish', '--pace', '0', '--no-commander', '--no-chat', '--no-learn'], { timeout: 90000 });
    expect(stdout).toContain('[Lobby 1] Game 1/1:');
    expect(stdout).toContain('[Lobby 2] Game 1/1:');
    expect(stdout).toContain('Done: 2 games played.');
  }, 100000);

  it('seats distinct roster characters under their display names and plays to a winner', async () => {
    const lines: string[] = [];
    const results = await runLoop({ ...common, api: base, roster: ten, players: 7, map: 'asia', games: 1, log: (l) => lines.push(l), random: seeded(5) });
    expect(results).toHaveLength(1);
    expect(results[0].winner).toBeTruthy();
    expect(results[0].map).toBe('asia');
    expect(results[0].seats).toHaveLength(7);
    expect(results[0].options).toMatchObject({ maxPlayers: 7, fogOfWar: true, cardValues: expect.stringMatching(/^(progressive|fixed|exponential)$/) });
    for (const s of results[0].seats) expect(ten.map((c) => c.name)).toContain(s.name);
    expect(lines.some((l) => /7 players/.test(l))).toBe(true);
  }, 120_000);

  it('gives up on a game past the time cap: the seats leave and the loop moves on', async () => {
    const left: string[] = [];
    const counting = new Proxy(base, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === 'leave') return (g: string, token: string) => (left.push(token), t.leave(g, token));
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as RiskApi;
    const lines: string[] = [];
    const results = await runLoop({ ...common, api: counting, roster: ten, players: 6, map: 'classic', games: 1, paceMs: 400, maxGameMs: 500, log: (l) => lines.push(l), random: seeded(6) });
    expect(results).toHaveLength(0);
    expect(lines.some((l) => /time cap/.test(l))).toBe(true);
    expect(left).toHaveLength(6);
  }, 60_000);

  it('a hard stop makes the seats leave', async () => {
    const left: string[] = [];
    const counting = new Proxy(base, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === 'leave') return (g: string, token: string) => (left.push(token), t.leave(g, token));
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as RiskApi;
    const control = new LoopControl();
    await runLoop({
      ...common,
      api: counting,
      roster: ten,
      players: 6,
      map: 'classic',
      games: 0,
      paceMs: 100,
      control,
      random: seeded(7),
      log: (l) => {
        if (l.startsWith('Game 1:')) setTimeout(() => (control.request(), control.request()), 300);
      },
    });
    expect(left).toHaveLength(6);
  }, 60_000);
});

describe('random game settings', () => {
  it('supports every independent toggle combination while preserving the other settings', () => {
    for (let mask = 0; mask < 16; mask++) {
      let call = 0;
      const options = gameOptions(5, 'classic', {}, () => (mask & (1 << call++)) ? 0.75 : 0.25);
      expect(call).toBe(4);
      expect(options).toMatchObject({
        blizzards: mask & 1 ? 0 : 8,
        capitals: !(mask & 2), fogOfWar: !(mask & 4),
        autoSetup: true, randomDeal: true, cardValues: mask & 8 ? 'exponential' : 'progressive',
        maxPlayers: 5, map: 'classic', chooseCapitals: true,
        neutrals: 0, balancedBlitz: true, firstRoundBonus: true,
        spectatorChat: true, fortifyMode: 'connected',
      });
    }
  });
  it('samples all three card modes equally and respects older server capabilities', () => {
    expect([0, 1, 2].map(i => gameOptions(5, 'classic', {}, () => (i + 0.5) / 3).cardValues)).toEqual(['progressive', 'fixed', 'exponential']);
    expect(gameOptions(5, 'classic', {}, () => 0.9, ['progressive', 'fixed']).cardValues).toBe('fixed');
    expect(() => gameOptions(5, 'classic', { cardValues: 'exponential' }, () => 0, ['progressive', 'fixed'])).toThrow('does not support exponential');
  });
  it('honours explicit overrides after randomizing', () => {
    expect(gameOptions(5, 'classic', { fogOfWar: true, capitals: true, blizzards: 8, cardValues: 'progressive' }, () => 0.75))
      .toMatchObject({ fogOfWar: true, capitals: true, blizzards: 8, cardValues: 'progressive' });
    expect(gameOptions(5, 'classic', { cardValues: 'fixed' }, () => 0.25)).toMatchObject({ cardValues: 'fixed' });
  });
});
