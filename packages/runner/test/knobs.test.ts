import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, tradeBonus, viewFor } from '@risk/engine';
import { Commander, parsePlanReply } from '../src/commander.js';
import { cardMath, commanderFacts, boardFacts } from '../src/facts.js';
import { choosePlannedAction, cleanPlan, type Plan } from '../src/planned-bot.js';
import { frozenBoard } from './frozen.js';
import { seeded } from './headless.js';

function smallView() {
  let state = createGame('P2', { maxPlayers: 3 }, 2);
  for (const [id, n] of [['a', 'Shen'], ['b', 'Shaco'], ['c', 'Teemo']]) state = addPlayer(state, id, n, true);
  state = startGame(state).state;
  return viewFor(state, 'a');
}

describe('plan knobs (cleanPlan)', () => {
  it('uses loose defaults when the plan is silent or the values are bad', () => {
    const view = smallView();
    const defaults = { capitalGarrison: null, moveCapitalStack: false, riskTolerance: 0.5, purposeMin: 0.5, borderGuard: 1, fortify: true, stallPressure: true, cardChance: 0.6, skipCard: false, winPath: null };
    expect(cleanPlan(null, view, 'a')).toMatchObject(defaults);
    const bad = { riskTolerance: 'x', moveCapitalStack: 'yes', purposeMin: NaN, borderGuard: 'a', fortify: 1, stallPressure: null, cardChance: Infinity, skipCard: true, winPath: 'conquer' };
    expect(cleanPlan(bad as unknown as Plan, view, 'a')).toMatchObject(defaults);
  });

  it('clamps good values and applies paths', () => {
    const view = smallView();
    const good = { aggression: 0.8, riskTolerance: 9, purposeMin: -2, borderGuard: 9, cardChance: 0.1, moveCapitalStack: true, stallPressure: false, fortify: false, skipCard: true, skipCardReason: 'truce', winPath: 'cards' } as Plan;
    expect(cleanPlan(good, view, 'a')).toMatchObject({ riskTolerance: 1, purposeMin: 0, borderGuard: 2, cardChance: 0.3, moveCapitalStack: true, stallPressure: false, fortify: false, skipCard: true, winPath: 'cards' });
    // The cards path defaults to a quiet stance; hopeless needs a living target and goes all in.
    expect(cleanPlan({ winPath: 'cards' }, view, 'a')).toMatchObject({ aggression: 0.3, purposeMin: 1.5 });
    expect(cleanPlan({ winPath: 'hopeless', target: 'b' }, view, 'a')).toMatchObject({ winPath: 'hopeless', aggression: 1, target: 'b' });
    expect(cleanPlan({ winPath: 'hopeless', target: 'ghost' }, view, 'a').winPath).toBeNull();
    expect(cleanPlan({ winPath: 'hopeless' }, view, 'a').winPath).toBeNull();
  });
});

describe('commander reply parsing of the new fields', () => {
  const view = smallView();
  it('reads winPath, winPlan and knobs; hopeless needs a target; skipCard needs a reason', () => {
    const p = parsePlanReply(JSON.stringify({ plan: 'x', winPath: 'Bonuses', winPlan: 'Hold Australia and out-earn them', riskTolerance: 5, moveCapitalStack: true, purposeMin: 'x', borderGuard: 3, skipCard: true, skipCardReason: '', cardChance: 0.1 }), view, 'a')!;
    expect(p).toMatchObject({ winPath: 'bonuses', winPlan: 'Hold Australia and out-earn them', riskTolerance: 1, moveCapitalStack: true, purposeMin: undefined, borderGuard: 2, skipCard: false, cardChance: 0.3 });
    expect(parsePlanReply(JSON.stringify({ plan: 'x', skipCard: true, skipCardReason: 'a truce with Shaco' }), view, 'a')).toMatchObject({ skipCard: true, skipCardReason: 'a truce with Shaco' });
    expect(parsePlanReply(JSON.stringify({ plan: 'x', winPath: 'hopeless' }), view, 'a')!.winPath).toBeNull();
    expect(parsePlanReply(JSON.stringify({ plan: 'x', winPath: 'hopeless', target: 'Shaco' }), view, 'a')).toMatchObject({ winPath: 'hopeless', target: 'b', aggression: 1 });
    expect(parsePlanReply(JSON.stringify({ plan: 'x', winPath: 'win-by-vibes' }), view, 'a')!.winPath).toBeNull();
  });

  it('logs winPath/winPlan and a skipped card with its reason in the scouting log', async () => {
    const reply = JSON.stringify({ plan: 'Wait', winPath: 'cards', winPlan: 'Stack cards while they bleed', skipCard: true, skipCardReason: 'truce with Shaco' });
    const c = new Commander({ llm: { async chat() { return reply; } }, seatName: 'Shen', playerId: 'a', profile: null, learnings: '', gameId: 'G1', scoutingDir: null });
    await c.planFor(view);
    const line = c.privateLog().join('\n');
    expect(line).toContain('winPath cards: Stack cards while they bleed');
    expect(line).toContain('skipping the card: truce with Shaco');
  });
});

describe('card set math in the facts', () => {
  it('states the next set value, a card worth, hand sizes and whether a card was taken', () => {
    const view = viewFor(frozenBoard(false), 's0');
    const lines = cardMath(view, 's0').join('\n');
    const value = tradeBonus(view.tradeCount);
    expect(lines).toContain(`next set is worth ${value} armies`);
    expect(lines).toContain(`a card is worth about ${Math.round((value / 3) * 10) / 10} armies now`);
    expect(lines).toContain('grows with every trade');
    expect(lines).toContain('You hold 0 cards and have not yet taken a card this turn');
    expect(commanderFacts(view, 's0')).toContain('Card math:');
    expect(boardFacts(view, 's0')).toContain('Card math:');
    const state = frozenBoard(false);
    state.players.find((p) => p.id === 's0')!.conqueredThisTurn = true;
    expect(cardMath(viewFor(state, 's0'), 's0').join('\n')).toContain('have already taken a card this turn');
    const fixed = frozenBoard(false);
    fixed.options.cardValues = 'fixed';
    expect(cardMath(viewFor(fixed, 's0'), 's0')).toEqual([]);
  });
});

describe('exponential card facts', () => {
  it('uses the viewer personal sequence and public opponent values', () => {
    const state = frozenBoard(false);
    state.options.cardValues = 'exponential'; state.tradeCount = 80;
    state.players.find(p => p.id === 's0')!.tradesMade = 6;
    state.players.find(p => p.id === 's1')!.tradesMade = 1;
    const view = viewFor(state, 's0');
    expect(cardMath(view, 's0').join('\n')).toContain('Your next sets: 30, 39, 51 armies');
    expect(cardMath(view, 's0').join('\n')).toContain('P1: 0 cards, next personal set 7');
    expect(commanderFacts(view, 's0')).toContain('30 armies (your personal exponential sequence)');
  });
});

describe('card every turn (progressive cards) and plan knobs', () => {
  /** s0's capital peru holds 12 against argentina 5; venezuela 63 and brazil 18 next door. */
  const cardBoard = () => {
    const state = frozenBoard(false);
    state.territories.peru.armies = 12;
    state.territories.argentina.armies = 5;
    return state;
  };
  const lazy: Plan = { aggression: 0, purposeMin: 10 };

  it('takes a card from a capital when only the card attack is left', () => {
    const a = choosePlannedAction(viewFor(cardBoard(), 's0'), 's0', lazy, seeded(1)) as { type: string; from?: string; to?: string; stopAt?: number };
    expect(a).toMatchObject({ type: 'attack', from: 'peru', to: 'argentina' });
    expect(a.stopAt).toBeGreaterThanOrEqual(3); // a soft few stay home
  });

  it('keeps the plan garrison when it names one', () => {
    const a = choosePlannedAction(viewFor(cardBoard(), 's0'), 's0', { ...lazy, capitalGarrison: 10 }, seeded(1));
    expect(a?.type).not.toBe('attack');
  });

  it('skips the card only with skipCard and a reason', () => {
    const view = viewFor(cardBoard(), 's0');
    expect(choosePlannedAction(view, 's0', { ...lazy, skipCard: true, skipCardReason: 'the truce holds' }, seeded(1))?.type).not.toBe('attack');
    expect(choosePlannedAction(view, 's0', { ...lazy, skipCard: true }, seeded(1))?.type).toBe('attack');
    expect(choosePlannedAction(view, 's0', { ...lazy, skipCard: true, skipCardReason: '  ' }, seeded(1))?.type).toBe('attack');
  });

  it('does not force a card attack once a card was taken this turn', () => {
    const state = cardBoard();
    state.players.find((p) => p.id === 's0')!.conqueredThisTurn = true;
    expect(choosePlannedAction(viewFor(state, 's0'), 's0', lazy, seeded(1))?.type).not.toBe('attack');
  });

  it('hopeless: attacks only the chosen target', () => {
    const owners: Record<string, string> = { s1: 'venezuela', s2: 'brazil', s3: 'argentina' };
    let attacked = 0;
    for (const target of Object.keys(owners)) {
      for (let seed = 1; seed <= 4; seed++) {
        const a = choosePlannedAction(viewFor(frozenBoard(false), 's0'), 's0', { winPath: 'hopeless', target }, seeded(seed));
        if (a?.type === 'attack') {
          attacked++;
          expect(a.to).toBe(owners[target]);
        }
      }
    }
    expect(attacked).toBeGreaterThan(0);
    // Aimed at a player it cannot reach, it attacks nobody else.
    expect(choosePlannedAction(viewFor(frozenBoard(false), 's0'), 's0', { winPath: 'hopeless', target: 's5' }, seeded(4))?.type).not.toBe('attack');
  });

  it('fortifies out of a capital only with moveCapitalStack', () => {
    const state = frozenBoard(false);
    for (const t of ['venezuela', 'brazil', 'argentina']) state.territories[t] = { owner: 's0', armies: 1 };
    state.territories.peru.armies = 30;
    state.phase = 'fortify';
    const view = viewFor(state, 's0');
    expect(view.legal!.fortifies.some((f) => f.from === 'peru')).toBe(true);
    expect(choosePlannedAction(view, 's0', null, seeded(1))).toEqual({ type: 'end_turn' });
    expect(choosePlannedAction(view, 's0', { moveCapitalStack: true }, seeded(1))).toMatchObject({ type: 'fortify', from: 'peru' });
    expect(choosePlannedAction(view, 's0', { moveCapitalStack: true, fortify: false }, seeded(1))).toEqual({ type: 'end_turn' });
  });

  it('fortifies from a border stack back into an interior capital or fortifyTo at end of turn', () => {
    const state = frozenBoard(false);
    for (const t of ['venezuela', 'brazil', 'argentina']) state.territories[t] = { owner: 's0', armies: 1 };
    state.territories.peru = { owner: 's0', armies: 3 }; // interior capital
    state.territories.venezuela = { owner: 's0', armies: 25 }; // border stack after expanding out
    state.phase = 'fortify';
    const view = viewFor(state, 's0');
    expect(choosePlannedAction(view, 's0', { fortifyTo: 'peru' }, seeded(1))).toEqual({
      type: 'fortify',
      from: 'venezuela',
      to: 'peru',
      armies: 24,
    });
  });

  it('honors explicit placeOn and route from the Commander and avoids stranding stacks in dead-end pockets', () => {
    const state = frozenBoard(false);
    state.territories.peru = { owner: 's0', armies: 20 };
    state.territories.brazil = { owner: 's0', armies: 5 };
    state.territories.argentina = { owner: 's3', armies: 1 }; // dead-end pocket (only touches peru & brazil, both owned by s0)
    state.territories.venezuela = { owner: 's1', armies: 3 }; // active border
    state.phase = 'reinforce';
    state.players.find((p) => p.id === 's0')!.armiesToPlace = 6;
    const reinforceView = viewFor(state, 's0');
    expect(choosePlannedAction(reinforceView, 's0', { placeOn: ['brazil'] }, seeded(1))).toEqual({
      type: 'place',
      placements: { brazil: 6 },
    });

    // When occupying dead-end pocket argentina from peru while venezuela is still hostile on peru, keep the stack on peru.
    state.phase = 'attack';
    state.territories.argentina = { owner: 's0', armies: 0 };
    state.pendingConquest = { from: 'peru', to: 'argentina', minArmies: 3, maxArmies: 19 };
    const occupyDeadEnd = viewFor(state, 's0');
    expect(choosePlannedAction(occupyDeadEnd, 's0', null, seeded(1))).toEqual({
      type: 'occupy',
      armies: 3,
    });

    // When occupying along an explicit Commander route (peru -> venezuela -> central_america), advance the stack.
    state.territories.venezuela = { owner: 's0', armies: 0 };
    state.territories.central_america = { owner: 's1', armies: 2 };
    state.pendingConquest = { from: 'peru', to: 'venezuela', minArmies: 3, maxArmies: 19 };
    const occupyRoute = viewFor(state, 's0');
    expect(choosePlannedAction(occupyRoute, 's0', { route: ['peru', 'venezuela', 'central_america'] }, seeded(1))).toEqual({
      type: 'occupy',
      armies: 19,
    });
  });

  it('situational attack termination: stops after bonus when border is tight, but continues on surplus or lethal or 1v1', () => {
    const state = frozenBoard(false);
    state.phase = 'attack';
    state.territories.eastern_australia = { owner: 's0', armies: 2 };
    state.territories.western_australia = { owner: 's0', armies: 2 };
    state.territories.new_guinea = { owner: 's0', armies: 2 };
    state.territories.indonesia = { owner: 's0', armies: 6 };
    state.territories.siam = { owner: 's5', armies: 4 };
    state.players.find((p) => p.id === 's0')!.conqueredThisTurn = true;

    // 1. Tight border: stops after bonus to preserve choke garrison.
    const tightView = viewFor(state, 's0');
    const tightAction = choosePlannedAction(tightView, 's0', { stopAfterBonus: true }, seeded(1));
    expect(tightAction?.type).not.toBe('attack');

    // 2. Massive surplus on choke: attacks while keeping the defensive garrison.
    state.territories.indonesia.armies = 30;
    const surplusView = viewFor(state, 's0');
    const surplusAction = choosePlannedAction(surplusView, 's0', { stopAfterBonus: true }, seeded(1));
    expect(surplusAction).toMatchObject({
      type: 'attack',
      from: 'indonesia',
      to: 'siam',
    });
    expect((surplusAction as { stopAt?: number })?.stopAt).toBeGreaterThanOrEqual(3);

    // 3. 1v1 endgame: restraint turns off completely to break and starve the rival.
    state.territories.indonesia.armies = 8;
    for (const p of state.players) {
      if (p.id !== 's0' && p.id !== 's5') p.alive = false;
    }
    const v1v1 = viewFor(state, 's0');
    const action1v1 = choosePlannedAction(v1v1, 's0', { stopAfterBonus: true }, seeded(1));
    expect(action1v1).toMatchObject({
      type: 'attack',
      from: 'indonesia',
      to: 'siam',
    });
  });
});
