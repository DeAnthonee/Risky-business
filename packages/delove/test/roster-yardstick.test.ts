import { describe, expect, it } from 'vitest';
import { summarizeTable, yardstick, yardstickMarkdown, type RecordLike } from '../src/roster-yardstick.js';

// Records shaped as docs/game-records.md, with the house roster seats in room.roster (player id -> roster id, model).
const rec = (id: string, order: string[], elims: [string, string | null][], roster: Record<string, string>): RecordLike => ({
  id,
  map: 'gen1-s1-p3-t15',
  fog: true,
  players: order.map((name, i) => ({ id: `p${i}`, name })),
  outcome: { placings: order.map((_, i) => `p${i}`), eliminations: elims.map(([p, by]) => ({ player: `p${order.indexOf(p)}`, by: by === null ? null : `p${order.indexOf(by)}` })) },
  room: { roster: Object.fromEntries(Object.entries(roster).map(([name, model]) => [`p${order.indexOf(name)}`, { id: `r_${name}`, model }])) },
});

describe('the house roster yardstick (roster-yardstick.ts)', () => {
  it('sums tables per name and per version: wins, placement, points, kills, rounds, who eliminated it; rates the versions', () => {
    const models = { Ada: 'delove@13', 'Sir Pancake': 'delove@12', 'Lady Noodle': 'delove@12' };
    const t1 = summarizeTable(rec('g1', ['Ada', 'Sir Pancake', 'Zergy'], [['Zergy', 'Ada'], ['Sir Pancake', 'Ada']], { Ada: models.Ada, 'Sir Pancake': models['Sir Pancake'] }), 'T1', 1, { Zergy: 'zerg' }, 1);
    const t2 = summarizeTable(rec('g2', ['Zergy', 'Ada', 'Lady Noodle'], [['Lady Noodle', 'Zergy'], ['Ada', 'Zergy']], { Ada: models.Ada, 'Lady Noodle': models['Lady Noodle'] }), 'T1', 2, { Zergy: 'zerg' }, 2);
    expect(t1.seats[0]).toMatchObject({ name: 'Ada', place: 1, kills: 2, rosterId: 'r_Ada', model: 'delove@13' });
    expect(t2.seats[1]).toMatchObject({ name: 'Ada', place: 2, eliminatedBy: 'Zergy' });
    expect(t1.seats[2]).toMatchObject({ name: 'Zergy', agent: 'zerg' });
    expect(t1.seats[2].model).toBeUndefined();
    const y = yardstick([t1, t2], 'delove@12', 'a', 'b');
    expect(y.perVersion['delove@13']).toMatchObject({ tables: 2, wins: 1, kills: 2, roundsReached: 2, tournaments: 1, eliminatedBy: { zerg: 1 } });
    expect(y.perVersion['delove@13'].relPlace).toBe(0.25); // first (0), then second of three (0.5)
    expect(y.perVersion['delove@13'].points).toBe(1.5); // (+1 place + 2 kills) and (0 place + 0 kills), per table
    expect(y.perVersion['delove@12']).toMatchObject({ tables: 2, wins: 0, eliminatedBy: { 'delove@13': 1, zerg: 1 } });
    expect(y.perName['Ada']).toMatchObject({ model: 'delove@13', tables: 2 });
    expect(y.perVersion['zerg']).toBeUndefined(); // only roster versions get lines
    expect(y.ratings['delove@12']).toBe(0);
    expect(y.ratings['delove@13']).toBeGreaterThan(0);
    expect(yardstickMarkdown(y)).toContain('| delove@13 | 2 | 50% | 0.25 |');
  });
});
