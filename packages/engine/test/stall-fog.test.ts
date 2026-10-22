import { describe, expect, it } from 'vitest';
import { ADJACENCY, addPlayer, applyAction, createGame, describeOptions, legalMoves, setOptions, startGame, viewFor, type GameEvent, type GameOptions, type GameState } from '../src/index.js';

/** A 3-player classic game, dealt and placed, at the first turn. */
function game(opts: Partial<GameOptions> = {}): GameState {
  let s = createGame('stall', { autoSetup: true, maxPlayers: 3, ...opts }, 7);
  for (const id of ['a', 'b', 'c']) s = addPlayer(s, id, id.toUpperCase());
  return startGame(s).state;
}

/** The current player places everything on their first territory and ends the turn, attacking nobody. */
function passTurn(s: GameState, events: GameEvent[] = []): GameState {
  const me = s.currentPlayer!;
  let lm = legalMoves(s, me);
  if (lm.placeLimit > 0) {
    const r = applyAction(s, me, { type: 'place', placements: { [lm.canPlaceOn[0]]: lm.placeLimit } });
    s = r.state;
    events.push(...r.events);
    lm = legalMoves(s, me);
  }
  const r = applyAction(s, me, { type: 'end_turn' });
  events.push(...r.events);
  return r.state;
}

/** A full go-around (one turn per living player). */
function passRound(s: GameState, events: GameEvent[] = []): GameState {
  for (let i = 0; i < 3; i++) s = passTurn(s, events);
  return s;
}

/** The current player takes one territory: a 30-army stack next to a 1-army enemy, blitzed. */
function conquer(s: GameState, events: GameEvent[] = []): GameState {
  const me = s.currentPlayer!;
  let lm = legalMoves(s, me);
  if (lm.placeLimit > 0) s = applyAction(s, me, { type: 'place', placements: { [lm.canPlaceOn[0]]: lm.placeLimit } }).state;
  const next = structuredClone(s);
  const from = Object.keys(next.territories).find((t) => next.territories[t].owner === me && ADJACENCY[t].some((n) => next.territories[n].owner && next.territories[n].owner !== me))!;
  const to = ADJACENCY[from].find((n) => next.territories[n].owner && next.territories[n].owner !== me)!;
  next.territories[from].armies = 30;
  next.territories[to].armies = 1;
  lm = legalMoves(next, me);
  const r = applyAction(next, me, { type: 'attack', from, to, blitz: true, occupy: 'min' } as never);
  events.push(...r.events);
  expect(r.events.some((e) => e.type === 'conquered')).toBe(true);
  return r.state;
}

describe('stall breaker: the fog lifts after N full rounds with no capture (stallFogLift)', () => {
  it('lifts after N full rounds without a capture, once, with an event; every view is then unfogged', () => {
    let s = game({ fogOfWar: true, stallFogLift: 2 });
    expect(viewFor(s, 'a').territories[Object.keys(s.territories).find((t) => s.territories[t].owner === 'b' && !ADJACENCY[t].some((n) => s.territories[n].owner === 'a'))!]).toMatchObject({ owner: null });
    const events: GameEvent[] = [];
    s = passRound(s, events);
    expect(s.fogLifted).toBeFalsy();
    s = passRound(s, events);
    expect(s.fogLifted).toBe(true);
    expect(events.filter((e) => e.type === 'fog_lifted')).toEqual([{ type: 'fog_lifted', rounds: 2 }]);
    // Sticky: more rounds (and captures) never bring it back or lift it again.
    s = conquer(s, events);
    s = passTurn(s, events);
    s = passRound(s, events);
    s = passRound(s, events);
    expect(s.fogLifted).toBe(true);
    expect(events.filter((e) => e.type === 'fog_lifted')).toHaveLength(1);
    // Every seat sees the whole board, as a spectator does.
    for (const p of ['a', 'b', 'c']) {
      const v = viewFor(s, p);
      for (const t of Object.keys(s.territories)) expect(v.territories[t].owner, `${p} ${t}`).toBe(s.territories[t].owner);
    }
  });

  it('a capture resets the count: N full rounds are counted from the round after it', () => {
    let s = game({ fogOfWar: true, stallFogLift: 2 });
    const events: GameEvent[] = [];
    s = passRound(s, events); // round 1: no capture
    // Round 2: A captures, then B and C pass.
    s = conquer(s, events);
    s = passTurn(s, events);
    s = passTurn(s, events);
    s = passTurn(s, events);
    expect(s.lastCaptureRound).toBe(2);
    s = passRound(s, events); // round 3: 1 full round after the capture
    expect(s.fogLifted).toBeFalsy();
    s = passRound(s, events); // round 4: 2
    expect(s.fogLifted).toBe(true);
  });

  it('does nothing without fog, or with 0 (the default for normal games)', () => {
    for (const opts of [{ fogOfWar: false, stallFogLift: 2 }, { fogOfWar: true, stallFogLift: 0 }, { fogOfWar: true }]) {
      let s = game(opts);
      const events: GameEvent[] = [];
      for (let r = 0; r < 4; r++) s = passRound(s, events);
      expect(s.fogLifted, JSON.stringify(opts)).toBeFalsy();
      expect(events.some((e) => e.type === 'fog_lifted')).toBe(false);
    }
    expect(createGame('x', {}).options.stallFogLift).toBe(0);
  });

  it('is a validated setting, described in the rules summary of fog games', () => {
    expect(() => createGame('x', { stallFogLift: -1 })).toThrow();
    expect(() => createGame('x', { stallFogLift: 21 })).toThrow();
    expect(setOptions(createGame('x', {}), { stallFogLift: 3 }).options.stallFogLift).toBe(3);
    expect(describeOptions({ ...createGame('x', { fogOfWar: true, stallFogLift: 3 }).options }).join('\n')).toMatch(/fog lifts for good after 3 full rounds/);
  });
});
