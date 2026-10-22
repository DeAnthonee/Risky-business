import { describe, expect, it } from 'vitest';
import {
  ADJACENCY,
  STORM_MIN,
  addPlayer,
  applyAction,
  createGame,
  describeOptions,
  endInStalemate,
  legalMoves,
  redactEvents,
  setOptions,
  stallOf,
  stalemateDue,
  stalemateRound,
  startGame,
  type AnyGameEvent,
  type GameEvent,
  type GameOptions,
  type GameState,
  type StormEvent,
} from '../src/index.js';

/** A 3-player classic game, dealt and placed, at the first turn. */
function game(opts: Partial<GameOptions> = {}): GameState {
  let s = createGame('stall', { autoSetup: true, maxPlayers: 3, ...opts }, 7);
  for (const id of ['a', 'b', 'c']) s = addPlayer(s, id, id.toUpperCase());
  return startGame(s).state;
}

/** The current player places everything on their first territory. */
function place(s: GameState, events: GameEvent[] = []): GameState {
  const me = s.currentPlayer!;
  const lm = legalMoves(s, me);
  if (lm.placeLimit <= 0) return s;
  const r = applyAction(s, me, { type: 'place', placements: { [lm.canPlaceOn[0]]: lm.placeLimit } });
  events.push(...r.events);
  return r.state;
}

/** The current player places everything and ends the turn, attacking nobody. */
function passTurn(s: GameState, events: GameEvent[] = []): GameState {
  s = place(s, events);
  const r = applyAction(s, s.currentPlayer!, { type: 'end_turn' });
  events.push(...r.events);
  return r.state;
}

function passRound(s: GameState, events: GameEvent[] = []): GameState {
  for (let i = 0; i < 3; i++) s = passTurn(s, events);
  return s;
}

/** The current player takes one territory: a 30-army stack next to a 1-army enemy, blitzed. */
function conquer(s: GameState, events: GameEvent[] = []): GameState {
  s = place(s, events);
  const me = s.currentPlayer!;
  const next = structuredClone(s);
  const from = Object.keys(next.territories).find((t) => next.territories[t].owner === me && ADJACENCY[t].some((n) => next.territories[n].owner && next.territories[n].owner !== me))!;
  const to = ADJACENCY[from].find((n) => next.territories[n].owner && next.territories[n].owner !== me)!;
  next.territories[from].armies = 30;
  next.territories[to].armies = 1;
  const r = applyAction(next, me, { type: 'attack', from, to, blitz: true, occupy: 'min' } as never);
  events.push(...r.events);
  expect(r.events.some((e) => e.type === 'conquered')).toBe(true);
  return r.state;
}

const storms = (events: GameEvent[]) => (events as AnyGameEvent[]).filter((e): e is StormEvent => e.type === 'storm');

describe('stall reliever step 2: the storm wears down big stacks (stallStorm)', () => {
  it('from N stalled rounds, every round start: each player stack over STORM_MIN loses a fifth, never the last', () => {
    let s = game({ stallStorm: 2 });
    const events: GameEvent[] = [];
    s = passRound(s, events); // 1 stalled round: no storm yet
    expect(storms(events)).toHaveLength(0);
    // Round 2: big stacks, one at the threshold (spared).
    s = passTurn(s, events);
    s = passTurn(s, events);
    s = place(s, events);
    s = structuredClone(s);
    const owned = Object.keys(s.territories).filter((t) => s.territories[t].owner);
    s.territories[owned[0]].armies = 25;
    s.territories[owned[1]].armies = STORM_MIN;
    s.territories[owned[2]].armies = 11;
    const before = structuredClone(s.territories);
    const r = applyAction(s, s.currentPlayer!, { type: 'end_turn' });
    events.push(...r.events);
    s = r.state;
    const storm = storms(r.events);
    expect(storm).toHaveLength(1);
    expect(storm[0].rounds).toBe(2);
    // The storm comes at the round's start, before the first turn of the new round.
    expect(r.events.findIndex((e) => (e as AnyGameEvent).type === 'storm')).toBeLessThan(r.events.findIndex((e) => e.type === 'turn_started'));
    expect(storm[0].losses[owned[0]]).toBe(5);
    expect(storm[0].losses[owned[2]]).toBe(2);
    expect(storm[0].losses).not.toHaveProperty(owned[1]);
    // Exactly the stacks over STORM_MIN, each down by floor(20%) (the new turn's reinforcements are not placed yet).
    for (const [t, was] of Object.entries(before)) {
      const hit = !!was.owner && was.armies > STORM_MIN;
      expect(storm[0].losses[t] ?? 0, t).toBe(hit ? Math.floor(was.armies * 0.2) : 0);
      expect(s.territories[t].armies, t).toBe(was.armies - (storm[0].losses[t] ?? 0));
    }
    expect(stallOf(s)?.stormRound).toBe(3);
    // It repeats every stalled round ...
    s = passRound(s, events);
    expect(storms(events).map((e) => e.rounds)).toEqual([2, 3]);
    // ... until a capture resets the count and stops it.
    s = conquer(s, events);
    expect(stallOf(s)).toEqual({ lastCaptureRound: 4 });
    for (let i = 0; i < 3; i++) s = passTurn(s, events); // the rest of round 4
    s = passRound(s, events); // round 5 played: 1 stalled round
    expect(storms(events)).toHaveLength(2);
    s = passRound(s, events); // round 6 played: 2, the storm is back
    expect(storms(events).map((e) => e.rounds)).toEqual([2, 3, 2]);
  });

  it('under fog, a player sees only the storm losses on territories it can see', () => {
    let s = game({ fogOfWar: true, stallStorm: 1 });
    s = passTurn(s);
    s = passTurn(s);
    s = place(s);
    const big = structuredClone(s);
    for (const t of Object.keys(big.territories)) if (big.territories[t].owner) big.territories[t].armies = 20;
    const r = applyAction(big, big.currentPlayer!, { type: 'end_turn' });
    const storm = storms(r.events)[0];
    expect(Object.keys(storm.losses).length).toBe(Object.keys(big.territories).filter((t) => big.territories[t].owner).length);
    const seen = storms(redactEvents(r.state, 'a', r.events))[0];
    const visible = Object.keys(r.state.territories).filter((t) => r.state.territories[t].owner === 'a' || ADJACENCY[t].some((n) => r.state.territories[n].owner === 'a'));
    expect(Object.keys(seen.losses).sort()).toEqual(visible.filter((t) => storm.losses[t]).sort());
  });
});

describe('stall relievers, the end: a stalled game is decided on standing (stallEnd)', () => {
  it('is due stallEnd rounds after the last reliever came on; endInStalemate ends it on standing', () => {
    let s = game({ stallStorm: 2, stallEnd: 2 });
    for (let r = 0; r < 3; r++) s = passRound(s);
    expect(stalemateDue(s)).toBe(false); // 3 stalled: storm since 2, the end at 2 + 2
    expect(() => endInStalemate(s, [], 0)).toThrow();
    s = passRound(s);
    expect(stalemateDue(s)).toBe(true);
    const { state, events } = endInStalemate(s, [], 123);
    const [stalemate, over] = events as AnyGameEvent[];
    expect(stalemate).toMatchObject({ type: 'stalemate', rounds: 4 });
    if (stalemate.type !== 'stalemate') throw new Error('stalemate');
    expect(over).toEqual({ type: 'game_over', winner: stalemate.standing[0], reason: 'stalemate' });
    expect(state).toMatchObject({ phase: 'finished', winner: stalemate.standing[0], currentPlayer: null, finishedAt: 123, version: s.version + 1 });
    expect(stallOf(state)?.stalemate).toEqual({ round: s.round, standing: stalemate.standing, rolls: stalemate.rolls });
    expect(s.phase).not.toBe('finished'); // pure
    // Standing: territories first, then armies.
    const held = (p: string) => Object.values(s.territories).filter((t) => t.owner === p).length;
    const armies = (p: string) => Object.values(s.territories).filter((t) => t.owner === p).reduce((n, t) => n + t.armies, 0);
    for (let i = 1; i < stalemate.standing.length; i++) {
      const [a, b] = [stalemate.standing[i - 1], stalemate.standing[i]];
      expect(held(a) > held(b) || (held(a) === held(b) && armies(a) >= armies(b))).toBe(true);
    }
    expect(() => applyAction(state, 'a', { type: 'end_turn' })).toThrow();
    // Seeded: the same state always ends the same way.
    expect(endInStalemate(s, [], 123)).toEqual(endInStalemate(s, [], 123));
  });

  it('counts from the last enabled reliever: the fog lift only in a fog game, or from the stall itself', () => {
    expect(stalemateRound({ fogOfWar: true, stallFogLift: 3, stallEnd: 1 } as GameOptions)).toBe(4);
    expect(stalemateRound({ fogOfWar: false, stallFogLift: 3, stallEnd: 1 } as GameOptions)).toBe(1);
    expect(stalemateRound({ stallEnd: 2 } as GameOptions)).toBe(2);
    expect(stalemateRound({ fogOfWar: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5 } as GameOptions)).toBe(10); // tournaments
    expect(stalemateRound({ stallStorm: 5 } as GameOptions)).toBeNull();
    let s = game({ stallEnd: 2 });
    s = passRound(s);
    expect(stalemateDue(s)).toBe(false);
    s = passRound(s);
    expect(stalemateDue(s)).toBe(true);
  });
});

describe('the storm and the end are off by default and leave other games bit-identical', () => {
  it('adds no options, state or events when off, and is a validated, described setting', () => {
    const run = (opts: Partial<GameOptions>) => {
      let s = game(opts);
      const events: GameEvent[] = [];
      for (let r = 0; r < 12; r++) s = passRound(s, events);
      return { s, events };
    };
    // Off (fog or not): none of the three stall options is a key, and no stall state appears.
    for (const opts of [{}, { fogOfWar: true }]) {
      const { s } = run(opts);
      for (const key of ['stallFogLift', 'stallStorm', 'stallEnd']) expect(s.options, key).not.toHaveProperty(key);
      expect(s).not.toHaveProperty('stall');
      expect(s).not.toHaveProperty('fogLifted');
    }
    // A capture with only stallEnd on is recorded (the counter runs for any reliever).
    let only = game({ stallEnd: 3 });
    only = passRound(only);
    only = conquer(only);
    expect(stallOf(only)).toEqual({ lastCaptureRound: 2 });
    const off = run({});
    expect(off.s).not.toHaveProperty('stall');
    expect(stalemateDue(off.s)).toBe(false);
    expect((off.events as AnyGameEvent[]).some((e) => e.type === 'storm' || e.type === 'stalemate')).toBe(false);
    for (const key of ['stallStorm', 'stallEnd'] as const) {
      expect(() => createGame('x', { [key]: -1 })).toThrow();
      expect(() => createGame('x', { [key]: 21 })).toThrow();
      expect(setOptions(createGame('x', {}), { [key]: 4 }).options[key]).toBe(4);
    }
    const text = describeOptions({ ...createGame('x', { stallStorm: 5, stallEnd: 5 }).options }).join('\n');
    expect(text).toMatch(/Storm: after 5 full rounds/);
    expect(text).toMatch(/Stalemate: 5 more rounds/);
  });
});
