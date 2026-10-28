import { describe, expect, it } from 'vitest';
import { applyAction, getMap, viewFor, type GameState } from '@risk/engine';
import { planConquest, findCapRun } from '../src/campaigns.js';
import { choosePlannedAction, isLegalAction, type Plan } from '../src/planned-bot.js';
import { frozenBoard } from './frozen.js';
import { seeded } from './headless.js';

function board(): GameState {
  const s = frozenBoard(false);
  s.options.capitals = false; s.options.cardValues = 'fixed';
  for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 's1', armies: 20 };
  s.players.forEach(p => { p.alive = p.id === 's0' || p.id === 's1'; p.cards = []; });
  s.phase = 'reinforce'; s.currentPlayer = 's0';
  s.players.find(p => p.id === 's0')!.armiesToPlace = 20;
  return s;
}
const options = (reinforcements = 0) => ({ avoid: new Set<string>(), noAttack: new Set<string>(), floor: () => 1, reinforcements });
const australia: Plan = { focus: 'australia', winPath: 'bonuses', purposeMin: 10 };
function australiaBoard() {
  const s = board();
  s.territories.western_australia = { owner: 's0', armies: 4 };
  s.territories.new_guinea = { owner: 's0', armies: 4 };
  s.territories.indonesia.armies = 1; s.territories.eastern_australia.armies = 1;
  return s;
}

describe('objective-driven drafting and bonus routes', () => {
  it('reinforces both launch stacks for a bonus and distributes spare casualty reserves', () => {
    const s = australiaBoard();
    const action = choosePlannedAction(viewFor(s, 's0'), 's0', australia, seeded(1));
    expect(action?.type).toBe('place');
    if (action?.type !== 'place') throw Error('expected drafting');
    expect(action.placements.western_australia).toBeGreaterThan(2);
    expect(action.placements.new_guinea).toBeGreaterThan(2);
    expect(Object.values(action.placements).reduce((sum, n) => sum + n, 0)).toBe(20);
    expect(isLegalAction(viewFor(s, 's0'), action)).toBe(true);
  });

  it('executes the funded multi-front route and completes the intended bonus', () => {
    let s = australiaBoard();
    const launchSites = new Set<string>();
    for (let i = 0; i < 16 && !['indonesia', 'eastern_australia'].every(t => s.territories[t].owner === 's0'); i++) {
      const a = choosePlannedAction(viewFor(s, 's0'), 's0', australia, seeded(2))!;
      expect(isLegalAction(viewFor(s, 's0'), a)).toBe(true);
      if (a.type === 'attack') launchSites.add(a.from);
      s = applyAction(s, 's0', a).state;
    }
    expect(viewFor(s, 's0').continentOwners.australia).toBe('s0');
    expect(launchSites).toEqual(new Set(['western_australia', 'new_guinea']));
  });

  it('allocates more troops to the harder branch rather than splitting evenly', () => {
    const s = board();
    for (const t of getMap('classic').continentById.north_america.territories) s.territories[t] = { owner: 's0', armies: 1 };
    s.territories.alberta.armies = 4; s.territories.western_united_states.armies = 4;
    s.territories.alaska = { owner: 's1', armies: 1 };
    s.territories.central_america = { owner: 's1', armies: 6 };
    const action = choosePlannedAction(viewFor(s, 's0'), 's0', { focus: 'north_america', winPath: 'bonuses', purposeMin: 10 }, seeded(1));
    expect(action?.type).toBe('place');
    if (action?.type !== 'place') throw Error('expected drafting');
    expect(action.placements.alberta).toBeGreaterThan(0);
    expect(action.placements.western_united_states).toBeGreaterThan(action.placements.alberta);
    const after = applyAction(s, 's0', action).state;
    expect(planConquest(viewFor(after, 's0'), 's0', ['alaska', 'central_america'], options())).not.toBeNull();
  });

  it('keeps both fronts alive when occupying a territory on a bonus route', () => {
    const s = board(); s.phase = 'attack'; s.players.find(p => p.id === 's0')!.armiesToPlace = 0;
    for (const t of getMap('classic').continentById.north_america.territories) s.territories[t] = { owner: 's0', armies: 1 };
    s.territories.alberta.armies = 30; s.territories.western_united_states.armies = 0;
    s.territories.alaska = { owner: 's1', armies: 1 };
    s.territories.central_america = { owner: 's1', armies: 1 };
    s.pendingConquest = { from: 'alberta', to: 'western_united_states', minArmies: 3, maxArmies: 29 };
    const a = choosePlannedAction(viewFor(s, 's0'), 's0', { focus: 'north_america', winPath: 'bonuses' }, seeded(1));
    expect(a?.type).toBe('occupy');
    if (a?.type !== 'occupy') throw Error('expected occupation');
    expect(a.armies).toBeGreaterThanOrEqual(6);
    expect(a.armies).toBeLessThanOrEqual(24);
    const after = applyAction(s, 's0', a).state;
    const route = planConquest(viewFor(after, 's0'), 's0', ['alaska', 'central_america'], options());
    expect(route?.attacks.map(a => a.from).sort()).toEqual(['alberta', 'western_united_states']);
  });

  it('budgets the sum of branches, not the same launch troops twice', () => {
    const s = board(); s.territories.peru = { owner: 's0', armies: 4 };
    s.territories.argentina.armies = 3; s.territories.brazil.armies = 3;
    const view = viewFor(s, 's0');
    expect(planConquest(view, 's0', ['argentina'], options(10))).not.toBeNull();
    expect(planConquest(view, 's0', ['brazil'], options(10))).not.toBeNull();
    expect(planConquest(view, 's0', ['argentina', 'brazil'], options(10))).toBeNull();
    expect(planConquest(view, 's0', ['argentina', 'brazil'], options(20))).not.toBeNull();
  });

  it('does not plan through protected borders or hidden defenders', () => {
    const s = australiaBoard();
    const v = viewFor(s, 's0');
    expect(planConquest(v, 's0', ['indonesia'], { ...options(20), avoid: new Set(['s1']) })).toBeNull();
    expect(planConquest(v, 's0', ['indonesia'], { ...options(20), noAttack: new Set(['indonesia']) })).toBeNull();
    v.territories.indonesia = { owner: null, armies: null, hidden: true };
    expect(planConquest(v, 's0', ['indonesia'], options(20))).toBeNull();
  });

  describe('multi-hop capital runs and strategic capital valuation', () => {
    it('finds a multi-hop cap run across transit territories to win the game', () => {
      const s = frozenBoard(false);
      s.options.capitals = true;
      s.territories.peru = { owner: 's0', armies: 35 };
      s.territories.venezuela = { owner: 's1', armies: 1 };
      s.territories.central_america = { owner: 's1', armies: 1 };
      s.territories.western_united_states = { owner: 's2', armies: 1 };
      s.territories.brazil = { owner: 's3', armies: 1 };

      s.capitals = { s0: 'peru', s2: 'western_united_states', s3: 'brazil' };
      const v = viewFor(s, 's0');
      const capRun = findCapRun(v, 's0', options(10));
      expect(capRun).not.toBeNull();
      const targets = capRun!.attacks.map((a) => a.to);
      expect(targets).toContain('brazil');
      expect(targets).toContain('western_united_states');
    });

    it('calculates a cap run even if the player holds 0 capitals', () => {
      const s = frozenBoard(false);
      s.options.capitals = true;
      s.territories.argentina = { owner: 's0', armies: 40 };
      s.territories.peru = { owner: 's1', armies: 1 };
      s.territories.brazil = { owner: 's2', armies: 1 };
      s.capitals = { s0: 'peru', s2: 'brazil' };

      const v = viewFor(s, 's0');
      const capRun = findCapRun(v, 's0', options(5));
      expect(capRun).not.toBeNull();
      const targets = capRun!.attacks.map((a) => a.to);
      expect(targets).toContain('peru');
      expect(targets).toContain('brazil');
    });

    it('values and fortifies conquered capitals even after losing starting capital', () => {
      const s = frozenBoard(false);
      s.options.capitals = true;
      s.phase = 'fortify';
      s.territories.peru = { owner: 's1', armies: 10 };
      s.territories.brazil = { owner: 's0', armies: 2 };
      s.territories.argentina = { owner: 's0', armies: 20 };
      s.capitals = { s0: 'peru', s2: 'brazil' };

      const v = viewFor(s, 's0');
      const action = choosePlannedAction(v, 's0', { fortify: true }, seeded(1));
      expect(action).toMatchObject({
        type: 'fortify',
        from: 'argentina',
        to: 'brazil',
      });
      expect((action as any).armies).toBeGreaterThan(10);
    });
  });
});
