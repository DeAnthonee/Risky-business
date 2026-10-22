import { describe, expect, it } from 'vitest';
import {
  ADJACENCY,
  STORM_MIN,
  addPlayer,
  applyAction,
  createGame,
  describeOptions,
  legalMoves,
  redactEvents,
  setOptions,
  startGame,
  type GameEvent,
  type GameOptions,
  type GameState,
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

/** The current player fortifies one army between two of its own neighbouring territories (that ends the turn). */
function fortifyTurn(s: GameState, events: GameEvent[] = []): { s: GameState; from: string; to: string } {
  s = place(s, events);
  const me = s.currentPlayer!;
  const from = Object.keys(s.territories).find((t) => s.territories[t].owner === me && s.territories[t].armies > 1 && ADJACENCY[t].some((n) => s.territories[n].owner === me))!;
  const to = ADJACENCY[from].find((n) => s.territories[n].owner === me)!;
  const r = applyAction(s, me, { type: 'fortify', from, to, armies: 1 });
  events.push(...r.events);
  return { s: r.state, from, to };
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

const storms = (events: GameEvent[]) => events.filter((e): e is Extract<GameEvent, { type: 'storm' }> => e.type === 'storm');

describe('stall breaker step 2: the storm wears down idle stacks (stallStorm)', () => {
  it('from N stalled rounds, every round start: each idle stack over STORM_MIN loses a fifth; active territories are spared', () => {
    let s = game({ stallStorm: 2 });
    const events: GameEvent[] = [];
    s = passRound(s, events); // 1 stalled round: no storm yet
    expect(storms(events)).toHaveLength(0);
    expect(s).not.toHaveProperty('stallActive');
    // Round 2: the first player fortifies (those two territories saw action); big idle stacks elsewhere.
    const f = fortifyTurn(s, events);
    s = structuredClone(f.s);
    s.territories[f.from].armies = 30; // active: spared
    expect(s.stallActive).toEqual([f.from, f.to]);
    const idle = Object.keys(s.territories).filter((t) => s.territories[t].owner && t !== f.from && t !== f.to).slice(0, 2);
    s.territories[idle[0]].armies = 25;
    s.territories[idle[1]].armies = STORM_MIN; // not more than STORM_MIN: spared
    s = passTurn(s, events);
    s = place(s, events);
    const before = structuredClone(s.territories);
    const r = applyAction(s, s.currentPlayer!, { type: 'end_turn' });
    s = r.state;
    events.push(...r.events);
    const storm = storms(r.events);
    expect(storm).toHaveLength(1);
    expect(storm[0].rounds).toBe(2);
    // The storm comes at the round's start, before the first turn of the new round.
    expect(r.events.findIndex((e) => e.type === 'storm')).toBeLessThan(r.events.findIndex((e) => e.type === 'turn_started'));
    expect(storm[0].losses[idle[0]]).toBe(5);
    expect(storm[0].losses).not.toHaveProperty(f.from);
    expect(storm[0].losses).not.toHaveProperty(f.to);
    expect(storm[0].losses).not.toHaveProperty(idle[1]);
    // Exactly the idle stacks over STORM_MIN, each down by floor(20%), never to 0.
    for (const [t, was] of Object.entries(before)) {
      const hit = !!was.owner && was.armies > STORM_MIN && t !== f.from && t !== f.to;
      expect(storm[0].losses[t] ?? 0, t).toBe(hit ? Math.floor(was.armies * 0.2) : 0);
      expect(s.territories[t].armies, t).toBe(was.armies - (storm[0].losses[t] ?? 0));
      expect(s.territories[t].armies).toBeGreaterThan(0);
    }
    // It repeats every stalled round ...
    s = passRound(s, events);
    expect(storms(events).map((e) => e.rounds)).toEqual([2, 3]);
    // ... until a capture resets the count and the record of active territories.
    s = conquer(s, events);
    expect(s.lastCaptureRound).toBe(4);
    expect(s.stallActive).toHaveLength(2); // the attack's from (and the occupation) after the reset
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

describe('stall breaker, the end: a stalled game is decided on standing (stallEnd)', () => {
  it('ends stallEnd rounds after the last stall breaker came on, on standing, with a stalemate event', () => {
    let s = game({ stallStorm: 2, stallEnd: 2 });
    const events: GameEvent[] = [];
    for (let r = 0; r < 3; r++) s = passRound(s, events);
    expect(s.phase).not.toBe('finished'); // 3 stalled: storm since 2, end at 2 + 2
    s = passRound(s, events);
    expect(s.phase).toBe('finished');
    const stalemate = events.find((e): e is Extract<GameEvent, { type: 'stalemate' }> => e.type === 'stalemate')!;
    expect(stalemate.rounds).toBe(4);
    expect(events.at(-1)).toEqual({ type: 'game_over', winner: stalemate.standing[0], reason: 'stalemate' });
    expect(s.winner).toBe(stalemate.standing[0]);
    expect(s.currentPlayer).toBeNull();
    // Standing: territories first, then armies.
    const held = (p: string) => Object.values(s.territories).filter((t) => t.owner === p).length;
    const armies = (p: string) => Object.values(s.territories).filter((t) => t.owner === p).reduce((n, t) => n + t.armies, 0);
    for (let i = 1; i < stalemate.standing.length; i++) {
      const [a, b] = [stalemate.standing[i - 1], stalemate.standing[i]];
      expect(held(a) > held(b) || (held(a) === held(b) && armies(a) >= armies(b))).toBe(true);
    }
    expect(() => applyAction(s, 'a', { type: 'end_turn' })).toThrow();
  });

  it('counts from the last enabled breaker: the fog lift in a fog game, none at all, and replays the same', () => {
    const endsAfter = (opts: Partial<GameOptions>) => {
      let s = game(opts);
      for (let r = 1; r <= 12; r++) {
        s = passRound(s);
        if (s.phase === 'finished') return { r, s };
      }
      return { r: null, s };
    };
    expect(endsAfter({ fogOfWar: true, stallFogLift: 3, stallEnd: 1 }).r).toBe(4);
    expect(endsAfter({ fogOfWar: false, stallFogLift: 3, stallEnd: 1 }).r).toBe(1); // no fog: the fog lift is not a breaker
    expect(endsAfter({ stallEnd: 2 }).r).toBe(2);
    expect(endsAfter({ fogOfWar: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5 }).r).toBe(10); // the tournament defaults
    // Seeded: the same game ends the same way (all but the wall-clock times).
    const replay = () => ({ ...endsAfter({ stallEnd: 2 }).s, createdAt: 0, startedAt: 0, finishedAt: 0 });
    expect(replay()).toEqual(replay());
  });
});

describe('the storm and the end are off by default and leave other games untouched', () => {
  it('adds no state and no events with 0, and is a validated, described setting', () => {
    for (const opts of [{}, { stallStorm: 0, stallEnd: 0 }]) {
      let s = game(opts);
      const events: GameEvent[] = [];
      s = fortifyTurn(s, events).s;
      for (let r = 0; r < 12; r++) s = passRound(s, events);
      expect(s).not.toHaveProperty('stallActive');
      expect(s.phase).not.toBe('finished');
      expect(events.some((e) => e.type === 'storm' || e.type === 'stalemate')).toBe(false);
    }
    expect(createGame('x', {}).options).toMatchObject({ stallStorm: 0, stallEnd: 0 });
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
