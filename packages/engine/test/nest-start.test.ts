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
    let thawed = 0;
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
        // Moved (same count) or, with nowhere legal to go, thawed (one fewer).
        expect(state.blizzards.length === plain.blizzards.length || state.blizzards.length === plain.blizzards.length - 1).toBe(true);
        if (state.blizzards.length < plain.blizzards.length) thawed++;
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
    expect(thawed).toBeGreaterThan(0);
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
  });
});
