import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  chooseBotAction,
  createGame,
  createRng,
  getMap,
  nextFloat,
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

/** One spot per player, each in a different continent of classic. */
function spotsFor(seats: string[]): Record<string, string> {
  const continents = getMap('classic').continents;
  return Object.fromEntries(seats.map((id, i) => [id, continents[i].territories[0]]));
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
