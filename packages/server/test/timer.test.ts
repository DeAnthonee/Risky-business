import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameOptions } from '@risk/engine';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';

/** A started 2-seat game of two humans (no bots, so only the turn timer moves it). */
function twoHumans(options: Partial<GameOptions>, store = new Store(null)) {
  const { room, playerId: a, token } = store.create('Timed', { autoSetup: true, maxPlayers: 2, ...options }, 'A');
  const b = room.join('B');
  room.start();
  return { store, room, a, b: b.playerId, tokens: { [a]: token, [b.playerId]: b.token } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('turn timer (GameRoom)', () => {
  it('is off by default: no clock, no timer in the view', () => {
    const { room } = twoHumans({});
    expect(room.view(null).timer).toBeNull();
    expect(room.turnDeadline).toBeNull();
  });

  it('per turn: skips the player when the clock runs out, then times the next one', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { room } = twoHumans({ turnTimer: 'turn', turnTimerSeconds: 15 });
    const first = room.state.currentPlayer!;
    expect(room.view(first).timer).toMatchObject({ mode: 'turn', seconds: 15, player: first, secondsLeft: 15 });
    vi.advanceTimersByTime(14_000);
    expect(room.state.currentPlayer).toBe(first);
    expect(room.view(first).timer!.secondsLeft).toBe(1);
    vi.advanceTimersByTime(1_000);
    const second = room.state.currentPlayer!;
    expect(second).not.toBe(first);
    // The skip is ordinary moves, flagged in the history, with a timeout event first.
    const skipped = room.history.filter((h) => h.timeout);
    expect(skipped.map((h) => h.action.type)).toEqual(['place', 'end_turn']);
    expect(skipped[0].events[0]).toEqual({ type: 'timeout', player: first, scope: 'turn' });
    expect(skipped.flatMap((h) => h.events).some((e) => e.type === 'battle')).toBe(false);
    expect(room.view(null).timer).toMatchObject({ player: second, secondsLeft: 15 });
  });

  it('per turn: moves during the turn do not reset the clock', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { room } = twoHumans({ turnTimer: 'turn', turnTimerSeconds: 15 });
    const me = room.state.currentPlayer!;
    vi.advanceTimersByTime(10_000);
    const t = Object.keys(room.state.territories).find((x) => room.state.territories[x].owner === me)!;
    room.act(me, { type: 'place', placements: { [t]: 1 } });
    expect(room.view(me).timer!.secondsLeft).toBe(5);
    vi.advanceTimersByTime(5_000);
    expect(room.state.currentPlayer).not.toBe(me);
  });

  it('per move: every move restarts the clock; a placement timeout only places', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { room } = twoHumans({ turnTimer: 'move', turnTimerSeconds: 10 });
    const me = room.state.currentPlayer!;
    vi.advanceTimersByTime(8_000);
    const t = Object.keys(room.state.territories).find((x) => room.state.territories[x].owner === me)!;
    room.act(me, { type: 'place', placements: { [t]: 1 } });
    expect(room.view(me).timer!.secondsLeft).toBe(10);
    vi.advanceTimersByTime(10_000);
    // The rest was placed for them; it is still their turn, now attacking, on a fresh clock.
    expect(room.state.currentPlayer).toBe(me);
    expect(room.state.phase).toBe('attack');
    expect(room.history.at(-1)).toMatchObject({ timeout: true, action: { type: 'place' } });
    expect(room.view(me).timer!.secondsLeft).toBe(10);
    // An attack-phase timeout ends the turn (no fortify).
    vi.advanceTimersByTime(10_000);
    expect(room.state.currentPlayer).not.toBe(me);
    expect(room.history.at(-1)!.timeout).toBe(true);
  });

  it('never times a bot', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = new Store(null);
    const { room } = store.create('Bots', { autoSetup: true, maxPlayers: 2, turnTimer: 'turn', turnTimerSeconds: 5 }, 'Bot A', true);
    room.join('Bot B', true);
    room.start();
    expect(room.view(null).timer).toMatchObject({ mode: 'turn', player: null, secondsLeft: null });
    room.close('admin');
  });

  it('stops when the room closes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { room } = twoHumans({ turnTimer: 'turn', turnTimerSeconds: 5 });
    const me = room.state.currentPlayer;
    room.close('admin');
    vi.advanceTimersByTime(10_000);
    expect(room.state.currentPlayer).toBe(me);
  });

  it('games saved before the timer existed load with it off', () => {
    const store = new Store(null);
    const { room } = twoHumans({}, store);
    const snap = room.snapshot();
    delete (snap.state.options as Partial<GameOptions>).turnTimer;
    delete (snap.state.options as Partial<GameOptions>).turnTimerSeconds;
    const dir = mkdtempSync(join(tmpdir(), 'risk-timer-'));
    try {
      const file = join(dir, 'games.json');
      writeFileSync(file, JSON.stringify([snap]));
      const loaded = new Store(file).get(room.id)!;
      expect(loaded.state.options).toMatchObject({ turnTimer: 'off', turnTimerSeconds: 15 });
      expect(loaded.view(null).timer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the game record flags the moves made on a timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-timer-rec-'));
    try {
      const store = new Store(join(dir, 'games.json'));
      const { room } = twoHumans({ turnTimer: 'turn', turnTimerSeconds: 60 }, store);
      const first = room.state.currentPlayer!;
      room.expireTurn();
      const second = room.state.currentPlayer!;
      room.act(second, { type: 'surrender' });
      expect(room.state.phase).toBe('finished');
      const rec = store.archive.get(store.archive.list()[0].id)!;
      const flagged = rec.steps.filter((s) => s.timeout);
      expect(flagged.map((s) => [s.player, s.action.type])).toEqual([[first, 'place'], [first, 'end_turn']]);
      expect(flagged[0].events[0]).toMatchObject({ type: 'timeout', player: first });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('turn timer over HTTP and MCP', () => {
  it('the state carries the clock, and agents are told in plain words', async () => {
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'timer', version: '0' });
    try {
      const { room, tokens } = twoHumans({ turnTimer: 'move', turnTimerSeconds: 20 }, store);
      const me = room.state.currentPlayer!;
      const res = await fetch(`${base}/api/games/${room.id}`, { headers: { authorization: `Bearer ${tokens[me]}` } });
      const { state } = (await res.json()) as { state: { timer: { mode: string; seconds: number; player: string; secondsLeft: number; deadline: number } } };
      expect(state.timer).toMatchObject({ mode: 'move', seconds: 20, player: me });
      expect(state.timer.secondsLeft).toBeGreaterThan(15);
      expect(state.timer.deadline).toBeGreaterThan(Date.now());

      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
        return r.content.map((c) => c.text).join('\n');
      };
      const text = await call('get_state', { gameId: room.id, token: tokens[me] });
      expect(text).toMatch(/TURN TIMER: 20s per move - YOU HAVE \d+s LEFT, act now/);
      expect(text).toMatch(/you are skipped/);
      const tools = (await client.listTools()).tools;
      for (const name of ['get_state', 'wait_for_turn', 'act']) expect(tools.find((t) => t.name === name)!.description).toMatch(/TURN TIMER/);
      expect(await call('rules', {})).toMatch(/TURN TIMER/);
      // A skip shows in the events agents read.
      room.expireTurn();
      const after = await call('get_state', { gameId: room.id, token: tokens[me] });
      expect(after).toContain('TURN TIMER');
    } finally {
      await client.close();
      await risk.shutdown('test');
    }
  });

  it('rejects timer settings out of range', async () => {
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    try {
      const create = (options: unknown) => fetch(`${base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerName: 'H', options }) });
      expect((await create({ turnTimer: 'turn', turnTimerSeconds: 2 })).status).toBe(400);
      expect((await create({ turnTimer: 'sometimes' })).status).toBe(400);
      const ok = await create({ turnTimer: 'turn', turnTimerSeconds: 30 });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { state: { options: GameOptions } }).state.options).toMatchObject({ turnTimer: 'turn', turnTimerSeconds: 30 });
    } finally {
      await risk.shutdown('test');
    }
  });
});
