import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  chooseBotAction,
  createGame,
  createRng,
  defaultRegions,
  genMapId,
  getMap,
  maxBlizzards,
  nextFloat,
  pickStartSpots,
  startGame,
  startOnSpots,
  type GameOptions,
  type GameState,
} from '../src/index.js';

function seeded(seed: number) {
  const rng = createRng(seed);
  return () => nextFloat(rng);
}

function lobby(seats: string[], options: Partial<GameOptions> = {}, seed = 3): GameState {
  let s = createGame('ns', { map: 'classic', maxPlayers: Math.max(seats.length, 2), ...options }, seed);
  for (const id of seats) s = addPlayer(s, id, id.toUpperCase(), true);
  return s;
}

/** One spot per player, each in a different continent of the map (classic by default). */
function spotsFor(seats: string[], mapId = 'classic'): Record<string, string> {
  const continents = getMap(mapId).continents;
  return Object.fromEntries(seats.map((id, i) => [id, continents[i % continents.length].territories[i < continents.length ? 0 : 1]]));
}

const count = (s: GameState, p: string) => Object.values(s.territories).filter((t) => t.owner === p).length;
const armies = (s: GameState, p: string) => Object.values(s.territories).filter((t) => t.owner === p).reduce((n, t) => n + t.armies, 0);

describe('startOnSpots', () => {
  const seats = ['a', 'b', 'c', 'd'];

  it('puts every player on their spot and keeps the deal fair (same territory count as a plain start)', () => {
    const spots = spotsFor(seats);
    const { state } = startOnSpots(lobby(seats, { randomDeal: true }), spots, seeded(1));
    const plain = startGame(lobby(seats, { randomDeal: true })).state;
    expect(state.phase).toBe('setup');
    for (const p of seats) {
      expect(state.territories[spots[p]].owner).toBe(p);
      expect(count(state, p)).toBe(count(plain, p));
      expect(armies(state, p)).toBe(armies(plain, p));
    }
    expect(state.turnOrder).toEqual(plain.turnOrder);
  });

  it('with autoSetup, places every army and reaches the first turn', () => {
    const spots = spotsFor(seats);
    const { state } = startOnSpots(lobby(seats, { autoSetup: true }), spots, seeded(2));
    expect(state.phase).not.toBe('setup');
    expect(state.options.autoSetup).toBe(true);
    expect(state.players.every((p) => p.isNeutral || p.id === state.currentPlayer || p.armiesToPlace === 0)).toBe(true);
    for (const p of seats) expect(state.territories[spots[p]].owner).toBe(p);
  });

  it('moves a blizzard off a spot, keeping the number of blizzards', () => {
    const options = { randomDeal: true, blizzards: 4 };
    const plain = startGame(lobby(seats, options)).state;
    const spots = { ...spotsFor(seats), a: plain.blizzards[0] };
    const { state, events } = startOnSpots(lobby(seats, options), spots, seeded(3));
    expect(state.territories[spots.a].owner).toBe('a');
    expect(state.blizzards).toHaveLength(4);
    expect(state.blizzards).not.toContain(spots.a);
    for (const t of state.blizzards) expect(state.territories[t].owner).toBeNull();
    expect(events.find((e) => e.type === 'blizzards')).toMatchObject({ territories: state.blizzards });
  });

  it('moves a blizzard only where pickBlizzards could have put it: the board stays connected and every continent keeps two open territories', () => {
    /** The two rules pickBlizzards keeps, checked from scratch. */
    const playable = (mapId: string, blocked: Set<string>) => {
      const map = getMap(mapId);
      if (map.continents.some((c) => c.territories.filter((t) => !blocked.has(t)).length < 2)) return false;
      const open = map.territoryIds.filter((t) => !blocked.has(t));
      const seen = new Set([open[0]]);
      const queue = [open[0]];
      while (queue.length) for (const n of map.adjacency[queue.pop()!]) if (!blocked.has(n) && !seen.has(n)) (seen.add(n), queue.push(n));
      return seen.size === open.length;
    };
    let naiveWouldBreak = 0;
    let moved = 0;
    let redrawn = 0;
    for (const mapId of ['skirmish', 'classic'] as const) {
      const options = { map: mapId, randomDeal: true, blizzards: 8 };
      for (let seed = 1; seed <= 40; seed++) {
        const plain = startGame(lobby(seats, options, seed)).state;
        const spot = plain.blizzards[0];
        if (!spot) continue;
        // Would the old rule (any open territory) have been able to break the board here?
        const others = plain.blizzards.filter((t) => t !== spot);
        const naive = Object.keys(plain.territories).filter((t) => !plain.blizzards.includes(t) && t !== spot);
        if (naive.some((t) => !playable(mapId, new Set([...others, t])))) naiveWouldBreak++;

        const spots = { ...spotsFor(seats, mapId), a: spot };
        if (new Set(Object.values(spots)).size !== seats.length) continue;
        const { state } = startOnSpots(lobby(seats, options, seed), spots, seeded(seed));
        expect(state.territories[spot].owner).toBe('a');
        // Moved (one territory changes) or, with nowhere legal to go alone, drawn again (#264): the count is kept.
        expect(state.blizzards).toHaveLength(plain.blizzards.length);
        if (state.blizzards.filter((t) => !plain.blizzards.includes(t)).length > 1) redrawn++;
        else moved++;
        expect(state.blizzards).not.toContain(spot);
        expect(playable(mapId, new Set(state.blizzards))).toBe(true);
        for (const t of state.blizzards) expect(state.territories[t].owner).toBeNull();
      }
    }
    // The check matters: on these boards an unchecked move could have split the board or emptied a continent.
    expect(naiveWouldBreak).toBeGreaterThan(0);
    // Both paths ran.
    expect(moved).toBeGreaterThan(0);
    expect(redrawn).toBeGreaterThan(0);
  });

  it('takes a spot the neutral was dealt in a two-player game', () => {
    const two = ['a', 'b'];
    const plain = startGame(lobby(two, { randomDeal: true })).state;
    const neutralHeld = Object.keys(plain.territories).find((t) => plain.territories[t].owner === 'neutral')!;
    const spots = { a: neutralHeld, b: Object.keys(plain.territories).find((t) => plain.territories[t].owner === 'a')! };
    const { state } = startOnSpots(lobby(two, { randomDeal: true }), spots, seeded(4));
    expect(state.territories[spots.a].owner).toBe('a');
    expect(state.territories[spots.b].owner).toBe('b');
    expect(count(state, 'a')).toBe(count(plain, 'a'));
  });

  it('rejects two players on one spot and unknown players or territories', () => {
    const t = getMap('classic').territoryIds[0];
    expect(() => startOnSpots(lobby(seats), { a: t, b: t })).toThrow(/different start spot/);
    expect(() => startOnSpots(lobby(seats), { z: t })).toThrow(/Unknown player/);
    expect(() => startOnSpots(lobby(seats), { a: 'atlantis' })).toThrow(/Unknown territory/);
  });

  it('is deterministic under a seed, and the built-in bot plays the game to a winner', () => {
    const spots = spotsFor(seats);
    const one = startOnSpots(lobby(seats, { autoSetup: true }), spots, seeded(5)).state;
    const two = startOnSpots(lobby(seats, { autoSetup: true }), spots, seeded(5)).state;
    expect(one.territories).toEqual(two.territories);
    let s = one;
    const random = seeded(6);
    for (let n = 0; n < 20_000 && s.phase !== 'finished'; n++) s = applyAction(s, s.currentPlayer!, chooseBotAction(s, s.currentPlayer!, random)!).state;
    expect(s.phase).toBe('finished');
  });
});

describe('blizzards on generated nested boards', () => {
  /** The open territories form one network. */
  function openConnected(s: GameState): boolean {
    const map = getMap(s.options.map);
    const open = map.territoryIds.filter((t) => !s.blizzards.includes(t));
    const seen = new Set([open[0]]);
    const queue = [open[0]];
    while (queue.length) for (const n of map.adjacency[queue.pop()!]) if (!s.blizzards.includes(n) && !seen.has(n)) (seen.add(n), queue.push(n));
    return seen.size === open.length;
  }

  /** What every table of a nested round needs: one open network, two open per region, every capital open and held. */
  function expectPlayable(s: GameState, seats: string[], where: string) {
    const map = getMap(s.options.map);
    expect(s.blizzards.length, where).toBeGreaterThan(0);
    expect(openConnected(s), where).toBe(true);
    for (const c of map.continents) expect(c.territories.filter((t) => !s.blizzards.includes(t)).length, where).toBeGreaterThanOrEqual(2);
    for (const id of seats) {
      expect(count(s, id), where).toBeGreaterThan(0);
      const cap = s.capitals[id];
      expect(cap, where).toBeDefined();
      expect(s.blizzards, where).not.toContain(cap);
      expect(s.territories[cap].owner, where).toBe(id);
    }
  }

  it('a blizzard on a spot that cannot move alone: the set is drawn again away from the spots, count and deal kept (#264)', () => {
    // On this board t13's only way out runs through t14: with both frozen, the blizzard on t13 can go nowhere alone.
    const mapId = 'gen1-s1533255644-p3-t15';
    const seats = ['a', 'b', 'c'];
    const spots = { a: 't04', b: 't09', c: 't13' };
    let hits = 0;
    const opts: Partial<GameOptions> = { map: mapId as GameOptions['map'], autoSetup: true, capitals: true, blizzards: 2 };
    for (let seed = 1; seed <= 3000; seed++) {
      // The deal startOnSpots starts from; only the seeds that freeze t13 and t14 are the case (about 1 in 180).
      const l = lobby(seats, opts, seed);
      const before = startGame({ ...l, options: { ...l.options, randomDeal: true, autoSetup: false } }).state.blizzards;
      if (!(before.includes('t13') && before.includes('t14'))) continue;
      hits++;
      const s = startOnSpots(lobby(seats, opts, seed), spots, seeded(seed)).state;
      const where = `seed ${seed} (${before.join(',')} -> ${s.blizzards.join(',')})`;
      expect(s.blizzards, where).toHaveLength(2);
      expectPlayable(s, seats, where);
      for (const [id, t] of Object.entries(spots)) expect(s.territories[t].owner, where).toBe(id);
      // The deal stays even: territories differ by at most one, as in a plain start.
      const held = seats.map((id) => count(s, id));
      expect(Math.max(...held) - Math.min(...held), where).toBeLessThanOrEqual(1);
    }
    expect(hits).toBeGreaterThan(0); // the case really came up
  });

  it('a parent table keeps its blizzard count and an even deal, and never throws (seed sweep, #264)', () => {
    // As the server builds a parent table: a gen1 board with a region per seat, the nested default of 10% blizzards (at
    // least 1, tournaments.ts blizzardsFor), spots from pickStartSpots. Includes gen1-s22-p6-t30 (seed 22), where a
    // player held only other players' spots and the trade threw, and Reviewer A's gen1-s427-p8-t40, gen1-s65-p10-t50 and
    // gen1-s1072-p10-t50 (the rng as the server seeds it here: createRng(seed * 7 + 1)).
    const cases = [3, 4, 5, 6, 8, 10].flatMap((n) => Array.from({ length: 400 }, (_, i) => [n, i + 1]));
    cases.push([8, 427], [10, 1072]); // Reviewer A's boards past the sweep
    for (const [n, seed] of cases) {
      const seats = Array.from({ length: n }, (_, i) => `p${i}`);
      const mapId = genMapId({ seed, seats: n, territoriesPerSeat: 5, regions: Math.max(defaultRegions(n * 5), n) });
      const map = getMap(mapId);
      const want = Math.min(maxBlizzards(map), Math.max(1, Math.round(0.1 * map.territoryIds.length)));
      const portals = pickStartSpots(map, n, seed);
      const spots = Object.fromEntries(seats.map((id, i) => [id, portals[i]]));
      const opts: Partial<GameOptions> = { map: mapId as GameOptions['map'], autoSetup: true, capitals: true, blizzards: want };
      const where = `${mapId} seed ${seed}`;
      let s!: GameState;
      expect(() => (s = startOnSpots(lobby(seats, opts, seed), spots, seeded(seed * 7 + 1)).state), where).not.toThrow();
      expect(s.blizzards, where).toHaveLength(want);
      expectPlayable(s, seats, where);
      for (const [id, t] of Object.entries(spots)) expect(s.territories[t].owner, where).toBe(id);
      const held = seats.map((id) => count(s, id));
      expect(Math.max(...held) - Math.min(...held), where).toBeLessThanOrEqual(1);
    }
  }, 180_000);

  it('max blizzards never split a generated board (2-10 seats, every board size, many seeds), with capitals and auto setup', () => {
    let tables = 0;
    for (let n = 2; n <= 10; n++)
      for (let tps = 4; tps <= 6; tps++)
        for (let seed = 1; seed <= 20; seed++) {
          const seats = Array.from({ length: n }, (_, i) => `p${i}`);
          const opts = (map: string): Partial<GameOptions> => ({ map: map as GameOptions['map'], autoSetup: true, capitals: true, blizzards: maxBlizzards(getMap(map)) });
          // A leaf table: its board as the planner makes it (default regions), a plain start.
          const leaf = genMapId({ seed: seed * 7919 + n, seats: n, territoriesPerSeat: tps });
          expectPlayable(startGame(lobby(seats, opts(leaf), seed)).state, seats, `${leaf} seed ${seed}`);
          // A parent table: a region per seat (nest.ts boardId), everyone starts on their portal (startOnSpots).
          const parentMap = genMapId({ seed: seed * 7919 + n, seats: n, territoriesPerSeat: tps, regions: Math.max(defaultRegions(n * tps), n) });
          const portals = pickStartSpots(getMap(parentMap), n, seed);
          const spots = Object.fromEntries(seats.map((id, i) => [id, portals[i]]));
          const s = startOnSpots(lobby(seats, opts(parentMap), seed), spots, seeded(seed)).state;
          expectPlayable(s, seats, `${parentMap} seed ${seed} on spots`);
          for (const [id, t] of Object.entries(spots)) {
            expect(s.blizzards).not.toContain(t);
            expect(s.territories[t].owner).toBe(id);
          }
          tables += 2;
        }
    expect(tables).toBe(9 * 3 * 20 * 2);
  }, 60_000);
});
