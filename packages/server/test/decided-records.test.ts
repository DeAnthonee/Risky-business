import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyRecord } from '@risk/engine';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { narrate, playByPlayText } from '../src/playbyplay.js';
import type { TournamentClock } from '../src/tournaments.js';

/** A clock the test moves by hand: round deadlines fire only when it is advanced past them. */
class FakeClock implements TournamentClock {
  t = 1_000_000_000;
  timers: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + ms, fn };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  advance(ms: number) {
    this.t += ms;
    for (const h of this.timers.filter((x) => x.at <= this.t)) {
      this.timers = this.timers.filter((x) => x !== h);
      h.fn();
    }
  }
}

describe('a nested table decided on standing is archived like a finished game', () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-decided-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('its record has the decided winner and standing (reason "standing"), replays, and is in /api/history', async () => {
    const clock = new FakeClock();
    const store = new Store(join(dir, 'games.json'), {}, { clock });
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    try {
      // 2 people (who never move) + 16 Zergs: six tables of 3. The four Zerg-only tables end at once; the round's
      // deadline starts their last lap, and with nobody moving its backstop (a round's time on) decides the two
      // people's tables on standing.
      const t = store.tournaments.create({ format: 'nested', roundMinutes: 20, botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
      store.tournaments.join(t.id, 'Ada');
      store.tournaments.join(t.id, 'Grace');
      store.tournaments.addBots(t.id, 'zerg', 16);
      store.tournaments.start(t.id);
      clock.advance(20 * 60_000);
      expect(t.rounds[0].lastLapAt).toBe(clock.now());
      clock.advance(20 * 60_000);
      const decided = t.rounds[0].matches.filter((m) => m.status === 'decided');
      expect(decided).toHaveLength(2);

      for (const m of decided) {
        const room = store.get(m.gameId!)!;
        expect(room.decidedAt).not.toBeNull();
        // Archived at once, not when the room is swept later: no live journal is left for it.
        const entry = store.archive.list(Infinity).find((e) => e.room === room.id)!;
        expect(entry).toBeDefined();
        expect(entry).toMatchObject({ finished: false, decided: true, reason: 'standing', endedBecause: "decided on standing at its round's end" });
        const winnerSeat = m.seats[m.winner!].playerId;
        expect(entry.winner?.id).toBe(winnerSeat);
        const record = store.archive.get(entry.id)!;
        const order = m.standing!.order.map((eid) => m.seats[eid].playerId);
        expect(record.outcome.decided!.standing).toEqual(order);
        expect(record.outcome.winner).toBe(winnerSeat);
        expect(record.outcome.placings.slice(0, order.length)).toEqual(order);
        expect(verifyRecord(record)).toBeNull();
        // The play-by-play names the decided winner and how.
        expect(playByPlayText(narrate(record))).toMatch(/Winner: .+ \(decided on standing at its round's end\)/);
        // The room closing later does not record it a second time.
        store.delete(room.id, 'admin');
        expect(store.archive.list(Infinity).filter((e) => e.room === room.id)).toHaveLength(1);
      }
      expect(readdirSync(join(dir, 'archive', 'live')).filter((f) => decided.some((m) => f.startsWith(m.gameId!)))).toEqual([]);

      // Match history lists decided tables (they have a winner), marked as decided.
      const history = (await (await fetch(`${base}/api/history?limit=100`)).json()) as { games: { room: string; decided?: boolean; reason: string; winner: { id: string } }[] };
      for (const m of decided) {
        const g = history.games.find((x) => x.room === m.gameId)!;
        expect(g).toMatchObject({ decided: true, reason: 'standing', winner: { id: m.seats[m.winner!].playerId } });
      }
      // The four Zerg-only tables are ordinary finished games, not decided ones.
      for (const m of t.rounds[0].matches.filter((x) => x.status === 'finished')) {
        const g = history.games.find((x) => x.room === m.gameId);
        if (g) expect(g.decided).toBeUndefined();
      }
    } finally {
      store.stopTimers();
      for (const room of store.rooms.values()) room.stopBot();
      await risk.shutdown('test');
    }
  });
});
