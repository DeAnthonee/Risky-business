import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, getMap, parseOptions, playerOf, startGame, territoriesOf, timeoutSteps, timerOf, type GameState } from '../src/index.js';

function game(n: number, opts = {}, seed = 7): GameState {
  let s = createGame('g', opts, seed);
  for (let i = 0; i < n; i++) s = addPlayer(s, `p${i}`, `Player ${i}`);
  return startGame(s).state;
}

const last = (steps: ReturnType<typeof timeoutSteps>) => steps.at(-1)!.state;

describe('turn timer settings', () => {
  it('is off by default and for games saved before it existed', () => {
    expect(timerOf(createGame('g').options)).toBeNull();
    expect(timerOf({})).toBeNull();
    expect(timerOf({ turnTimer: 'move' })).toEqual({ mode: 'move', seconds: 15 });
    expect(timerOf({ turnTimer: 'turn', turnTimerSeconds: 60 })).toEqual({ mode: 'turn', seconds: 60 });
  });

  it('parses only off/move/turn and 5-600 seconds', () => {
    expect(parseOptions({ turnTimer: 'turn', turnTimerSeconds: '30' })).toEqual({ turnTimer: 'turn', turnTimerSeconds: 30 });
    expect(() => parseOptions({ turnTimer: 'fast' })).toThrow(/turnTimer must be one of/);
    expect(() => parseOptions({ turnTimerSeconds: 4 })).toThrow(/at least 5/);
    expect(() => parseOptions({ turnTimerSeconds: 601 })).toThrow(/at most 600/);
  });
});

describe('timeoutSteps (skip on timeout)', () => {
  it('per turn: places every pending army on border territories, no attacks, and ends the turn', () => {
    const s = game(3, { autoSetup: true });
    const me = s.currentPlayer!;
    const pending = playerOf(s, me).armiesToPlace;
    const steps = timeoutSteps(s, me, 'turn');
    expect(steps.map((x) => x.action.type)).toEqual(['place', 'end_turn']);
    expect(steps[0].events[0]).toEqual({ type: 'timeout', player: me, scope: 'turn' });
    const placed = steps[0].action.type === 'place' ? steps[0].action.placements : {};
    expect(Object.values(placed).reduce((a, b) => a + b, 0)).toBe(pending);
    expect(steps.flatMap((x) => x.events).some((e) => e.type === 'battle')).toBe(false);
    const after = last(steps);
    expect(after.currentPlayer).not.toBe(me);
    // Every step replays as an ordinary action.
    let r = s;
    for (const st of steps) r = applyAction(r, me, st.action).state;
    expect(r).toEqual(after);
  });

  it('per move: a placement timeout only places, and the turn goes on in the attack phase', () => {
    const s = game(2, { autoSetup: true });
    const me = s.currentPlayer!;
    const steps = timeoutSteps(s, me, 'move');
    expect(steps.map((x) => x.action.type)).toEqual(['place']);
    expect(last(steps).phase).toBe('attack');
    expect(last(steps).currentPlayer).toBe(me);
    // Then an attack-phase timeout ends the turn (no fortify).
    const next = timeoutSteps(last(steps), me, 'move');
    expect(next.map((x) => x.action.type)).toEqual(['end_turn']);
    expect(last(next).currentPlayer).not.toBe(me);
  });

  it('occupies a pending conquest with the minimum before ending the turn', () => {
    let s = game(2, { autoSetup: true });
    const me = s.currentPlayer!;
    s = last(timeoutSteps(s, me, 'move'));
    // Set up a sure win: a big stack next to a lone enemy army, then blitz without choosing how many move in.
    const map = getMap(s.options.map);
    const from = territoriesOf(s, me).find((t) => map.adjacency[t].some((n) => s.territories[n].owner && s.territories[n].owner !== me))!;
    const to = map.adjacency[from].find((n) => s.territories[n].owner && s.territories[n].owner !== me)!;
    s.territories[from].armies = 60;
    s.territories[to].armies = 1;
    const pending = applyAction(s, me, { type: 'attack', from, to, blitz: true }).state;
    expect(pending.pendingConquest).not.toBeNull();
    const steps = timeoutSteps(pending, me, 'move');
    expect(steps[0].action).toEqual({ type: 'occupy', armies: pending.pendingConquest!.minArmies });
    expect(steps.at(-1)!.action.type).toBe('end_turn');
  });

  it('makes setup placements and capital picks for you', () => {
    let s = game(3, { capitals: true, chooseCapitals: true, setupBatch: 40 });
    expect(s.phase).toBe('setup');
    let guard = 0;
    while (s.phase === 'setup' && guard++ < 50) {
      const steps = timeoutSteps(s, s.currentPlayer!, 'turn');
      expect(steps.map((x) => x.action.type)).toEqual(['place']);
      s = last(steps);
    }
    expect(s.phase).toBe('capitals');
    const picker = s.currentPlayer!;
    const steps = timeoutSteps(s, picker, 'move');
    expect(steps.map((x) => x.action.type)).toEqual(['choose_capital']);
    expect(last(steps).capitals[picker]).toBeDefined();
  });

  it('claims territories in claim mode', () => {
    const s = game(2, { randomDeal: false });
    const me = s.currentPlayer!;
    const steps = timeoutSteps(s, me, 'turn');
    expect(steps).toHaveLength(1);
    expect(territoriesOf(last(steps), me)).toHaveLength(1);
  });

  it('does nothing when it is not that player’s decision', () => {
    const s = game(2, { autoSetup: true });
    const other = s.turnOrder.find((id) => id !== s.currentPlayer)!;
    expect(timeoutSteps(s, other, 'turn')).toEqual([]);
  });

  it('a timed-out player loses no armies and the game keeps going round after round', () => {
    let s = game(3, { autoSetup: true });
    for (let i = 0; i < 30 && s.phase !== 'finished'; i++) s = last(timeoutSteps(s, s.currentPlayer!, 'turn'));
    expect(s.phase).toBe('reinforce');
    expect(s.turnNumber).toBe(31);
  });
});
