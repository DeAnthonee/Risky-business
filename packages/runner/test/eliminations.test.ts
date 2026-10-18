import { describe, expect, it } from 'vitest';
import { applyAction, getMap, viewFor } from '@risk/engine';
import { planElimination } from '../src/eliminations.js';
import { choosePlannedAction, isLegalAction } from '../src/planned-bot.js';
import { frozenBoard } from './frozen.js';
import { seeded } from './headless.js';
import { Commander } from '../src/commander.js';
import { DealLedger } from '../src/deals.js';

function board() {
  const s = frozenBoard(false);
  s.options.capitals = false;
  for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 's4', armies: 20 };
  s.players.forEach(p => { p.alive = p.id === 's0' || p.id === 's1' || p.id === 's4'; p.cards = []; });
  s.players.find(p => p.id === 's1')!.cards = [0, 1, 2, 3].map(id => ({ id: 1000 + id, kind: 'infantry', territory: null }));
  return s;
}
const opts = () => ({ avoid: new Set<string>(), noAttack: new Set<string>(), floor: () => 1 });

describe('deliberate card-steal eliminations', () => {
  it('lets a commander deliberately betray a treaty partner for a kill and records that choice', async () => {
    const s = board();
    s.territories.peru = { owner: 's0', armies: 35 };
    s.territories.argentina = { owner: 's1', armies: 1 };
    const v = viewFor(s, 's0');
    const ledger = new DealLedger({ me: 'P0', idPrefix: 'S' });
    let prompt = '';
    const c = new Commander({
      llm: { async chat(messages) { prompt = messages.map(m => m.content).join('\n'); return JSON.stringify({ plan: 'Steal the weak partner hand', winPath: 'kills', breakDeals: ['S1'] }); } },
      seatName: 'P0', playerId: 's0', profile: null, learnings: '', gameId: 'F1', scoutingDir: null, ledger,
    });
    c.observe(v);
    const d = ledger.propose({ kind: 'truce', with: 'P1', untilRound: v.round + 3 }, v, 'Peace')!;
    ledger.ingest([{ id: 1, at: 0, name: 'P1', message: `Agreed [accept ${d.id}]` }]);
    expect(c.currentPlan()?.avoid).toContain('s1');
    const plan = await c.planFor(v);
    expect(prompt).toContain('scheme, lie, bluff, or backstab');
    expect(prompt).toContain('P1: 1 territories, 4 cards to steal');
    expect(ledger.get(d.id)).toMatchObject({ status: 'broken', brokenBy: 'P0' });
    expect(c.privateLog().join('\n')).toContain('Broke S1');
    expect(choosePlannedAction(v, 's0', plan, seeded(1))).toMatchObject({ type: 'attack', to: 'argentina' });
  });

  it('chooses and finishes a two-territory victim ahead of an unrelated focus, stealing its hand', () => {
    let s = board();
    s.territories.peru = { owner: 's0', armies: 35 };
    s.territories.argentina = { owner: 's1', armies: 1 };
    s.territories.brazil = { owner: 's1', armies: 1 };
    const first = choosePlannedAction(viewFor(s, 's0'), 's0', { focus: 'venezuela', purposeMin: 10 }, seeded(1));
    expect(first?.type).toBe('attack');
    if (first?.type === 'attack') expect(['brazil', 'argentina']).toContain(first.to);
    for (let i = 0; i < 12 && s.players.find(p => p.id === 's1')!.alive; i++) {
      const action = choosePlannedAction(viewFor(s, 's0'), 's0', { purposeMin: 10 }, seeded(1))!;
      expect(isLegalAction(viewFor(s, 's0'), action)).toBe(true);
      s = applyAction(s, 's0', action).state;
    }
    expect(s.players.find(p => p.id === 's1')!.alive).toBe(false);
    expect(s.players.find(p => p.id === 's0')!.cards).toHaveLength(4);
  });

  it('splits a surviving stack so both opposite branches can finish the victim', () => {
    const s = board();
    s.territories.indonesia = { owner: 's0', armies: 30 };
    s.territories.new_guinea = { owner: 's0', armies: 0 };
    s.territories.siam = { owner: 's1', armies: 2 };
    s.territories.eastern_australia = { owner: 's1', armies: 2 };
    s.pendingConquest = { from: 'indonesia', to: 'new_guinea', minArmies: 3, maxArmies: 29 };
    const a = choosePlannedAction(viewFor(s, 's0'), 's0', null, seeded(1));
    expect(a?.type).toBe('occupy');
    if (a?.type !== 'occupy') throw new Error('expected occupation');
    expect(a.armies).toBeGreaterThanOrEqual(8);
    expect(a.armies).toBeLessThanOrEqual(23);
    const next = applyAction(s, 's0', a).state;
    const kill = planElimination(viewFor(next, 's0'), 's0', opts());
    expect(kill?.attacks.map(x => x.from).sort()).toEqual(['indonesia', 'new_guinea']);
  });

  it('funds both fronts during reinforcement instead of putting every troop into one stack', () => {
    const s = board();
    s.territories.indonesia = { owner: 's0', armies: 4 };
    s.territories.new_guinea = { owner: 's0', armies: 4 };
    s.territories.siam = { owner: 's1', armies: 1 };
    s.territories.eastern_australia = { owner: 's1', armies: 1 };
    s.phase = 'reinforce';
    s.players.find(p => p.id === 's0')!.armiesToPlace = 12;
    const a = choosePlannedAction(viewFor(s, 's0'), 's0', null, seeded(1));
    expect(a?.type).toBe('place');
    if (a?.type !== 'place') throw new Error('expected placement');
    expect(a.placements.indonesia).toBeGreaterThan(0);
    expect(a.placements.new_guinea).toBeGreaterThan(0);
    expect(Object.values(a.placements).reduce((x, y) => x + y, 0)).toBe(12);
    expect(isLegalAction(viewFor(s, 's0'), a)).toBe(true);
  });

  it('respects accepted truces, excluded borders and hard garrisons', () => {
    const s = board();
    s.territories.peru = { owner: 's0', armies: 25 };
    s.territories.argentina = { owner: 's1', armies: 1 };
    const v = viewFor(s, 's0');
    expect(planElimination(v, 's0', { ...opts(), avoid: new Set(['s1']) })).toBeNull();
    expect(planElimination(v, 's0', { ...opts(), noAttack: new Set(['argentina']) })).toBeNull();
    expect(planElimination(v, 's0', { ...opts(), floor: () => 24 })).toBeNull();
  });

  it('does not call partial fog visibility a complete kill or spend future stolen cards', () => {
    const s = board();
    s.territories.peru = { owner: 's0', armies: 3 };
    s.territories.argentina = { owner: 's1', armies: 5 };
    expect(planElimination(viewFor(s, 's0'), 's0', opts())).toBeNull();
    s.territories.peru.armies = 30;
    const v = viewFor(s, 's0');
    v.players.find(p => p.id === 's1')!.territoryCount = null;
    expect(planElimination(v, 's0', opts())).toBeNull();
  });

  it('replans after losses rather than retaining an unaffordable split', () => {
    const s = board();
    s.territories.indonesia = { owner: 's0', armies: 30 };
    s.territories.new_guinea = { owner: 's0', armies: 0 };
    s.territories.siam = { owner: 's1', armies: 3 };
    s.territories.eastern_australia = { owner: 's1', armies: 3 };
    const transfer = { from: 'indonesia', to: 'new_guinea', min: 3, max: 29 };
    expect(planElimination(viewFor(s, 's0'), 's0', { ...opts(), transfer })).not.toBeNull();
    s.territories.indonesia.armies = 7;
    expect(planElimination(viewFor(s, 's0'), 's0', { ...opts(), transfer: { ...transfer, max: 6 } })).toBeNull();
  });
});
