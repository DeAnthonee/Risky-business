import { describe, expect, it } from 'vitest';
import { viewFor } from '@risk/engine';
import { choosePlannedAction, StallTracker } from '../src/planned-bot.js';
import { frozenBoard } from './frozen.js';
import { seeded } from './headless.js';

describe('stalemate: big capital stacks side by side', () => {
  for (const fog of [false, true]) {
    it(`takes the 3-army territory with a measured commit (fog ${fog})`, () => {
      const state = frozenBoard(fog);
      const view = viewFor(state, 's0');
      expect(view.legal!.attacks.some((a) => a.from === 'peru' && a.to === 'argentina')).toBe(true);
      const a = choosePlannedAction(view, 's0', null, seeded(1));
      expect(a).toMatchObject({ type: 'attack', from: 'peru', to: 'argentina', blitz: true });
      const stopAt = (a as { stopAt?: number }).stopAt;
      // Most of the stack stays home: only what the odds need goes.
      expect(stopAt).toBeDefined();
      expect(stopAt!).toBeGreaterThan(28);
      expect(stopAt!).toBeLessThan(41);
    });
  }

  it('keeps exactly the garrison the plan names, and moves with a smaller one', () => {
    const view = viewFor(frozenBoard(false), 's0');
    // A garrison the whole stack cannot spare is a hard floor: no attack leaves the capital.
    const frozen = choosePlannedAction(view, 's0', { capitalGarrison: 60 }, seeded(2), 6);
    expect(frozen?.type).not.toBe('attack');
    const plan = { capitalGarrison: 30 };
    const calm = choosePlannedAction(view, 's0', plan, seeded(2), 0) as { type: string; stopAt?: number };
    expect(calm.type).toBe('attack');
    expect(calm.stopAt!).toBeGreaterThanOrEqual(30); // never below the named garrison
  });

  it('does not throw the capital away: no attack on the big stack next door', () => {
    const view = viewFor(frozenBoard(false), 's0');
    for (let seed = 1; seed <= 10; seed++) {
      const a = choosePlannedAction(view, 's0', null, seeded(seed), 4);
      if (a?.type === 'attack') expect(a.to).not.toBe('venezuela');
    }
  });

  it('commits the promised troops against target when an active troop-commitment deal is in the plan', () => {
    const state = frozenBoard(false);
    // Remove easy 3-army argentina target so only big stacks remain, simulating a frozen border stalemate
    state.territories.argentina = { owner: 's0', armies: 2 };
    state.territories.brazil = { owner: 's0', armies: 2 };
    const view = viewFor(state, 's0');
    expect(choosePlannedAction(view, 's0', null, seeded(1), 3)?.type).not.toBe('attack');
    const committed = choosePlannedAction(view, 's0', { target: 's1', commitArmies: 20, capitalGarrison: 15 }, seeded(1), 3);
    expect(committed).toMatchObject({ type: 'attack', from: 'peru', to: 'venezuela', blitz: true, stopAt: 21 });
  });
});

describe('StallTracker', () => {
  it('counts own turns without a conquest and resets on one', () => {
    const t = new StallTracker();
    const state = frozenBoard(false);
    const step = (turn: number, conquered: boolean) => {
      state.turnNumber = turn;
      state.players.find((p) => p.id === 's0')!.conqueredThisTurn = conquered;
      t.observe(viewFor(state, 's0'), 's0');
    };
    step(10, false);
    step(16, false);
    step(22, false);
    expect(t.stall).toBe(2);
    step(28, true);
    step(34, false);
    expect(t.stall).toBe(0);
    step(40, false);
    expect(t.stall).toBe(1);
  });
});
