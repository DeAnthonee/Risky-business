import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BUSY_PLAYING_ROOMS, BUSY_SAVE_DEBOUNCE_MS, SAVE_DEBOUNCE_MS, Store, TABLE_SAVED_HISTORY } from '../src/store.js';
import { spectatorFrame } from '../src/ws.js';
import { createRiskServer } from '../src/app.js';
import type { ChangeMessage } from '../src/store.js';

/** A started game of two built-in bots (they move by themselves). */
function botGame(store: Store, name = 'Bots') {
  const { room } = store.create(name, { autoSetup: true, maxPlayers: 2 }, 'Bot A', true);
  room.join('Bot B', true);
  room.start();
  return room;
}

describe('scale groundwork', () => {
  it('builds one spectator frame per commit and sends the same string to every spectator', async () => {
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${(risk.server.address() as AddressInfo).port}/ws`;
    const room = botGame(store);
    const sockets: WebSocket[] = [];
    try {
      const frames: string[][] = [];
      for (let i = 0; i < 3; i++) {
        const ws = new WebSocket(url);
        sockets.push(ws);
        const got: string[] = [];
        frames.push(got);
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: room.id, reqId: 'a' })));
          ws.on('message', (raw) => {
            const m = JSON.parse(String(raw));
            if (m.reqId === 'a') resolve();
            else if (m.type === 'state') got.push(String(raw));
          });
          ws.on('error', reject);
        });
      }
      // Wait for a few bot moves to reach every spectator.
      const deadline = Date.now() + 10_000;
      while (frames.some((f) => f.length < 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const n = Math.min(...frames.map((f) => f.length));
      expect(n).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < n; i++) {
        expect(frames[1][i]).toBe(frames[0][i]);
        expect(frames[2][i]).toBe(frames[0][i]);
      }
      expect(JSON.parse(frames[0][0])).toMatchObject({ type: 'state', you: null });
    } finally {
      for (const ws of sockets) ws.close();
      await risk.shutdown('test');
    }
  });

  it('caches the spectator frame per commit, and rebuilds it on the next one', () => {
    const store = new Store(null);
    const { room } = store.create('Lobby', {}, 'Host');
    const a: ChangeMessage = { state: room.state, events: [], version: room.state.version, playerId: null };
    const first = spectatorFrame(room, a, 'c');
    expect(spectatorFrame(room, a, 'c')).toBe(first);
    room.rename(room.hostId, 'Renamed');
    const b: ChangeMessage = { state: room.state, events: [], version: room.state.version, playerId: null };
    const second = spectatorFrame(room, b, 'c');
    expect(second).not.toBe(first);
    expect(JSON.parse(second).state.version).toBe(room.state.version);
  });

  it('waits longer between snapshots while more than 10 games are being played', () => {
    const store = new Store(null);
    expect(store.saveDelay()).toBe(SAVE_DEBOUNCE_MS);
    const rooms = Array.from({ length: BUSY_PLAYING_ROOMS }, (_, i) => botGame(store, `G${i}`));
    expect(store.saveDelay()).toBe(SAVE_DEBOUNCE_MS);
    rooms.push(botGame(store, 'one more'));
    expect(store.saveDelay()).toBe(BUSY_SAVE_DEBOUNCE_MS);
    for (const r of rooms) r.close('admin');
  });

  it('a tournament table saves only the tail of its history; other rooms save all of it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-scale-'));
    try {
      const file = join(dir, 'games.json');
      const store = new Store(file);
      const plain = botGame(store, 'Plain');
      const { room: table } = store.createTable('Table', { autoSetup: true }, [{ name: 'A', isBot: true }, { name: 'B', isBot: true }], 'TFAKE1');
      for (const r of [plain, table]) {
        r.stopBot();
        const fill = Array.from({ length: TABLE_SAVED_HISTORY + 100 }, (_, i) => ({ version: i, at: i, playerId: null, action: { type: 'system' as const, note: `n${i}` }, events: [] }));
        r.history.push(...fill);
      }
      store.save();
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { id: string; history: unknown[] }[];
      expect(saved.find((s) => s.id === table.id)!.history).toHaveLength(TABLE_SAVED_HISTORY);
      expect(saved.find((s) => s.id === plain.id)!.history.length).toBeGreaterThan(TABLE_SAVED_HISTORY);
      // In memory the table keeps everything.
      expect(table.history.length).toBeGreaterThan(TABLE_SAVED_HISTORY);
      // And the saved table loads again.
      const again = new Store(file).get(table.id)!;
      expect(again.state.phase).toBe(table.state.phase);
      store.stopTimers();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
