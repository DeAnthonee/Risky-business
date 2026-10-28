import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  advanceIce,
  applyAction,
  checkIce,
  chooseBotAction,
  createGame,
  getMap,
  iceMaxLevel,
  iceOf,
  iceRings,
  iceStepsDue,
  RuleError,
  startGame,
  startIce,
  underIce,
  type GameEvent,
  type GameOptions,
  type GameState,
  type IceEvent,
} from '../src/index.js';

function game(map: string, n: number, options: Partial<GameOptions> = {}): GameState {
  let s = createGame('I', { map: map as GameOptions['map'], maxPlayers: n, autoSetup: true, ...options });
  for (let i = 0; i < n; i++) s = addPlayer(s, `p${i}`, `P${i}`, true);
  return startGame(s).state;
}

/** Play bot moves until `rounds` more round starts have passed (or the game ends). */
function playRounds(s: GameState, rounds: number): { s: GameState; events: GameEvent[] } {
  const until = s.round + rounds;
  const events: GameEvent[] = [];
  while (s.phase !== 'finished' && s.round < until) {
    const r = applyAction(s, s.currentPlayer!, chooseBotAction(s, s.currentPlayer!)!);
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}

describe('closing ice', () => {
  it('checks its settings', () => {
    expect(() => createGame('I', { map: 'mega_earth', closingIce: true, iceSafeRings: 0 })).toThrow(RuleError);
    expect(() => createGame('I', { map: 'mega_earth', iceRingsPerStep: 6 })).toThrow(/iceRingsPerStep/);
    expect(() => createGame('I', { map: 'mega_earth', closingIce: true, iceStartMinutes: 30, iceEveryRounds: 2 })).not.toThrow();
  });

  it('Mega Earth: rings from both poles over the whole globe; the ice stops with iceSafeRings rings open', () => {
    const map = getMap('mega_earth');
    const r = iceRings(map);
    expect(r.rings).toBe(48);
    for (const t of map.territoryIds) expect(r.north[t] + r.south[t]).toBeGreaterThanOrEqual(r.rings - 2);
    expect(iceMaxLevel({ iceSafeRings: 6 } as GameOptions, r.rings)).toBe(21);
  });

  it('advances one ring a round from both poles: frozen land is a blizzard, armies fall back or are lost, players with no land are out', () => {
    let s = game('mega_earth', 12, { closingIce: true });
    expect(() => startIce({ ...s, options: { ...s.options, closingIce: false } })).toThrow(RuleError);
    s = startIce(s).state;
    expect(iceOf(s)).toEqual({ level: 0, startedRound: s.round });
    const rings = iceRings(getMap('mega_earth'));
    let level = 0;
    for (let k = 0; k < 10 && s.phase !== 'finished'; k++) {
      const before = s;
      const r = playRounds(s, 1);
      s = r.s;
      const ice = r.events.find((e) => (e as unknown as IceEvent).type === 'ice') as unknown as IceEvent | undefined;
      expect(ice?.level).toBe(++level);
      expect(iceOf(s)!.level).toBe(level);
      for (const t of getMap('mega_earth').territoryIds) {
        if (underIce(rings, t, level)) expect([s.blizzards.includes(t), s.territories[t].owner, s.territories[t].armies]).toEqual([true, null, 0]);
      }
      // Every army on a frozen territory fell back to an open neighbour still held (by the frozen one's owner), or is counted lost.
      for (const m of ice!.retreats) {
        expect(getMap('mega_earth').adjacency[m.from]).toContain(m.to);
        expect([s.blizzards.includes(m.to), s.territories[m.to].owner === null]).toEqual([false, false]);
        expect(s.territories[m.to].armies).toBeGreaterThanOrEqual(m.armies);
      }
      expect(Object.keys(ice!.lost).every((t) => before.territories[t] !== undefined)).toBe(true);
      for (const id of ice!.eliminated) expect(s.players.find((p) => p.id === id)!.alive).toBe(false);
      for (const p of s.players.filter((x) => x.alive)) expect(Object.values(s.territories).some((t) => t.owner === p.id)).toBe(true);
    }
    expect(s.blizzards.length).toBeGreaterThan(30);
  }, 60_000);

  it('stops at the safe zone, and advances every iceEveryRounds rounds by iceRingsPerStep', () => {
    let s = game('mega_earth', 10, { closingIce: true, iceEveryRounds: 2, iceRingsPerStep: 3, iceSafeRings: 40 });
    s = startIce(s).state;
    const events: GameEvent[] = [];
    const st = { ...s, round: s.round + 1 } as GameState;
    checkIce(st, events);
    expect(events).toHaveLength(0); // not due on an odd round
    const due = { ...s, round: s.round + 2, territories: { ...s.territories }, players: s.players.map((p) => ({ ...p })), blizzards: [...s.blizzards], capitals: { ...s.capitals }, discard: [...s.discard] } as GameState;
    checkIce(due, events);
    // 40 safe rings of 48: at most 4 per front, here 3 per step.
    expect(iceOf(due)!.level).toBe(3);
    const again = { ...due, round: due.round + 2 } as GameState;
    checkIce(again, events);
    expect(iceOf(again)!.level).toBe(4);
  });

  it('works on a flat board by height, and does nothing when off', () => {
    let s = game('world', 6, { closingIce: true });
    s = startIce(s).state;
    const r = playRounds(s, 2);
    expect(r.s.blizzards.length).toBeGreaterThan(0);
    const off = game('world', 6);
    const played = playRounds(off, 3);
    expect(iceOf(played.s)).toBeUndefined();
    expect(played.s.blizzards).toEqual([]);
  });

  describe('on a clock (iceEveryMinutes)', () => {
    const MIN = 60_000;
    const clock = (n = 4, o: Partial<GameOptions> = {}) => startIce(game('world', n, { closingIce: true, iceStartMinutes: 5, iceEveryMinutes: 1, ...o })).state;
    /** Hand every territory the ice takes next (level 1) to `owner`, and the rest to the others in turn. */
    const dealNorth = (s: GameState, owner: string): string[] => {
      const rings = iceRings(getMap('world'));
      const north = getMap('world').territoryIds.filter((t) => underIce(rings, t, 1));
      const others = s.players.filter((p) => p.id !== owner).map((p) => p.id);
      getMap('world').territoryIds.forEach((t, i) => (s.territories[t] = { owner: north.includes(t) ? owner : others[i % others.length], armies: 3 }));
      return north;
    };

    it('checks the setting, and never steps at a round start', () => {
      expect(() => createGame('I', { map: 'world', closingIce: true, iceEveryMinutes: 61 })).toThrow(/iceEveryMinutes/);
      const s = clock();
      const events: GameEvent[] = [];
      checkIce({ ...s, round: s.round + 1 } as GameState, events);
      expect(events).toHaveLength(0);
    });

    it('is due every iceEveryMinutes from its scheduled start, and catches up', () => {
      const s = { ...clock(), startedAt: 0 };
      expect(iceStepsDue(s, 5 * MIN + 59_000)).toBe(0);
      expect(iceStepsDue(s, 6 * MIN)).toBe(1);
      expect(iceStepsDue(s, 9 * MIN)).toBe(4);
      const one = advanceIce(s).state;
      expect(iceOf(one)).toMatchObject({ level: 1, steps: 1 });
      expect(iceStepsDue(one, 9 * MIN)).toBe(3);
      expect(iceStepsDue({ ...s, options: { ...s.options, iceEveryMinutes: 0 } }, 9 * MIN)).toBe(0);
    });

    it('counts from when it actually started, so a late start is not a burst of steps', () => {
      const base = game('world', 4, { closingIce: true, iceStartMinutes: 5, iceEveryMinutes: 1 });
      const late = startIce({ ...base, startedAt: 0 }, 16 * MIN).state;
      expect(iceStepsDue(late, 16 * MIN + 59_000)).toBe(0);
      expect(iceStepsDue(late, 17 * MIN)).toBe(1);
    });

    it('advances mid-turn; a player frozen out on their own turn is passed', () => {
      const s = clock(4);
      const me = s.currentPlayer!;
      const north = dealNorth(s, me);
      expect(north.length).toBeGreaterThan(0);
      const r = advanceIce(s);
      const ice = r.events.find((e) => (e as unknown as IceEvent).type === 'ice') as unknown as IceEvent;
      expect(ice.eliminated).toContain(me);
      expect(r.state.players.find((p) => p.id === me)!.alive).toBe(false);
      expect(r.state.currentPlayer).not.toBe(me);
      expect(r.state.phase).toBe('reinforce');
      expect(r.events.some((e) => e.type === 'turn_started' && e.player === r.state.currentPlayer)).toBe(true);
      expect(r.state.version).toBe(s.version + 1);
    });

    it('a pending conquest from frozen land moves its armies in; onto frozen land it is cancelled', () => {
      const s = clock(3);
      const me = s.currentPlayer!;
      const north = dealNorth(s, s.players.find((p) => p.id !== me)!.id);
      const map = getMap('world');
      // `me` attacked from a northern territory into an open one, and has not moved in yet.
      const from = north.find((t) => map.adjacency[t].some((n) => !north.includes(n)))!;
      const to = map.adjacency[from].find((n) => !north.includes(n))!;
      s.territories[from] = { owner: me, armies: 7 };
      s.territories[to] = { owner: me, armies: 0 };
      s.phase = 'attack';
      s.pendingConquest = { from, to, minArmies: 3, maxArmies: 6 };
      const moved = advanceIce(s).state;
      expect(moved.pendingConquest).toBeNull();
      expect(moved.territories[to]).toEqual({ owner: me, armies: 7 });
      // The other way round: conquering into the ice cancels the conquest, the attackers stay home.
      const back = clock(3);
      const me2 = back.currentPlayer!;
      dealNorth(back, back.players.find((p) => p.id !== me2)!.id);
      back.territories[to] = { owner: me2, armies: 7 };
      back.territories[from] = { owner: me2, armies: 0 };
      back.phase = 'attack';
      back.pendingConquest = { from: to, to: from, minArmies: 3, maxArmies: 6 };
      const cancelled = advanceIce(back).state;
      expect(cancelled.pendingConquest).toBeNull();
      expect(cancelled.territories[from]).toEqual({ owner: null, armies: 0 });
      expect(cancelled.territories[to].armies).toBe(7);
      expect(cancelled.currentPlayer).toBe(me2);
    });
  });
});
