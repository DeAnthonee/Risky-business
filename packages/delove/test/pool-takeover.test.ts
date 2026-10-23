import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../server/src/store.js';
import { createRiskServer } from '../../server/src/app.js';
import { HttpRiskApi } from '@risk/mcp';
import { riskyBot } from '@risk/selfplay';
import { SeatPool, type PoolEntrant } from '../src/pool.js';
import { playPoolEntrant } from '../src/pool-play.js';
import type { EntrantResult } from '../src/tournament-seat.js';

// Fake value, set only here (the real key lives only in the server's and the pool's environment).
const KEY = 'test-pool-key';

/** A one-table tournament of Ann and Bob, 30 s per move, started on a server with a pool key; Ann is then dropped as disconnected (#301/#302). */
async function droppedSeat(fog = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const store = new Store(null);
  const t = store.tournaments.create({ name: 'Drop Cup', groupSize: 2, maxEntrants: 2, fillBots: false, options: { map: 'classic', autoSetup: true, turnTimer: 'move', turnTimerSeconds: 30, fogOfWar: fog } });
  const ids = ['Ann', 'Bob'].map((n) => store.tournaments.join(t.id, n).entrantId);
  store.tournaments.start(t.id);
  const m = t.rounds[0].matches[0];
  const room = store.get(m.gameId!)!;
  room.stopBot();
  const ann = m.seats[ids[0]];
  const bob = m.seats[ids[1]];
  // The server (with its pool key) first: the drop opens a takeover only when a pool is set up.
  const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0, seatPoolKey: KEY });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  // Two timeouts in a row with Ann silent and Bob present: Ann is dropped, the house bot stands in, a takeover opens.
  vi.setSystemTime(Date.now() + 10 * 60_000);
  for (let drops = 0; drops < 2; drops++) {
    for (let i = 0; i < 50 && room.state.currentPlayer !== ann.playerId; i++) {
      room.playerForToken(bob.token);
      room.expireTurn();
    }
    room.expireTurn();
  }
  const seat = () => room.state.players.find((p) => p.id === ann.playerId)!;
  const requests = async () =>
    ((await (await fetch(`${server}/api/seat-requests?modes=takeover`, { headers: { 'x-seat-pool-key': KEY } })).json()) as { requests: { id: string; status: string }[] }).requests;
  return { store, room, risk, server, seat, requests, ann };
}

function stubPlay() {
  const playing: PoolEntrant[] = [];
  const play = (e: PoolEntrant) => (playing.push(e), new Promise<EntrantResult>(() => {}));
  return { playing, play };
}

afterEach(() => vi.useRealTimers());

describe('the Delove seat pool takes dropped seats over (takeover mode)', () => {
  it('claims the takeover, checks the seat token, reports done and plays the game seat as "<name>-Delove"', async () => {
    const d = await droppedSeat();
    try {
      expect(d.seat()).toMatchObject({ name: 'Ann-bot', isBot: true });
      const st = stubPlay();
      const logs: string[] = [];
      const pool = new SeatPool({ server: d.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, log: (l) => logs.push(l) });
      await pool.tick();
      expect(st.playing).toHaveLength(1);
      expect(st.playing[0]).toMatchObject({ name: 'Ann-Delove', agentId: 'delove@13', search: false, game: { gameId: d.room.id, playerId: d.ann.playerId } });
      expect(d.seat()).toMatchObject({ name: 'Ann-Delove', isBot: false });
      expect(await d.requests()).toEqual([]); // done: no longer open
      // The token the pool holds plays that seat through the ordinary game API.
      const view = (await (await fetch(`${d.server}/api/games/${d.room.id}`, { headers: { authorization: `Bearer ${st.playing[0].token}` } })).json()) as { playerId: string };
      expect(view.playerId).toBe(d.ann.playerId);
      expect(pool.free.free).toBe(9);
      expect(logs.join('\n')).not.toContain(st.playing[0].token);
      expect(logs.join('\n')).not.toContain(KEY);
    } finally {
      d.store.stopTimers();
      await d.risk.shutdown('test');
    }
  });

  it('a seat token that does not play is reported failed, and the house bot keeps the seat', async () => {
    const d = await droppedSeat();
    try {
      const st = stubPlay();
      // Every request goes to the server, except the seat check, which is refused.
      const refuse: typeof fetch = (url, init) => (String(url).includes('/api/games/') ? Promise.resolve(new Response('{"error":"no"}', { status: 401 })) : fetch(url, init));
      const pool = new SeatPool({ server: d.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play, fetch: refuse });
      await pool.tick();
      expect(st.playing).toEqual([]);
      expect(d.seat()).toMatchObject({ name: 'Ann-bot', isBot: true });
      expect(await d.requests()).toEqual([]); // failed: no second request
    } finally {
      d.store.stopTimers();
      await d.risk.shutdown('test');
    }
  });

  it('fog: a fog-blind network leaves the takeover; a fog-trained one takes it, bare', async () => {
    const d = await droppedSeat(true);
    try {
      const blind = stubPlay();
      await new SeatPool({ server: d.server, key: KEY, model: 'delove@11', modelFog: false, maxSeats: 10, maxSearch: 10, play: blind.play }).tick();
      expect(blind.playing).toEqual([]);
      expect(await d.requests()).toHaveLength(1);
      const fog = stubPlay();
      await new SeatPool({ server: d.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 10, play: fog.play }).tick();
      expect(fog.playing.map((e) => [e.name, e.agentId, e.search])).toEqual([['Ann-Delove', 'delove@13', false]]);
    } finally {
      d.store.stopTimers();
      await d.risk.shutdown('test');
    }
  });

  it('the seat it took plays on through the game API (playPoolEntrant), its moves landing on that seat', async () => {
    const d = await droppedSeat();
    try {
      const st = stubPlay();
      await new SeatPool({ server: d.server, key: KEY, model: 'delove@13', modelFog: true, maxSeats: 10, maxSearch: 0, play: st.play }).tick();
      const e = st.playing[0];
      const before = d.room.history.length;
      // The built-in bot stands in for the network here (no models in CI); Bob's clock runs out so the seat gets turns.
      void playPoolEntrant(e, { api: new HttpRiskApi(d.server), agent: riskyBot, paceMs: 0, log: () => {} }).catch(() => {});
      const mine = () => d.room.history.slice(before).filter((h) => h.playerId === d.ann.playerId && !h.timeout && h.action.type !== 'system').length;
      for (let i = 0; i < 200 && mine() < 3; i++) {
        if (d.room.state.currentPlayer !== d.ann.playerId) d.room.expireTurn();
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(mine()).toBeGreaterThanOrEqual(3);
      expect(d.seat()).toMatchObject({ name: 'Ann-Delove', isBot: false });
    } finally {
      d.store.stopTimers();
      await d.risk.shutdown('test');
    }
  });
});
