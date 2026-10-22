import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandJobs, kindWeights, leagueMix, loadLeague, sampleSeat, winChance, withRatings, type League } from '../src/league.js';
import { seededRandom } from '@risk/selfplay';

const league: League = {
  v: 1,
  main: 'delove@13',
  mainElo: 0,
  pfsp: { curve: 'hard', power: 2 },
  exploiterShare: 0.2,
  splitGames: 100,
  members: [
    { id: 'delove@13', kind: 'snapshot', elo: 0 },
    { id: 'delove@12', kind: 'snapshot', elo: -50 },
    { id: 'delove@8', kind: 'snapshot', elo: -300 },
    { id: 'delove-exploit@1', kind: 'exploiter' },
    { id: 'old-exploit@1', kind: 'exploiter', active: false },
    { id: 'zerg@2', kind: 'zerg' },
  ],
};

describe('league (league.ts)', () => {
  it('PFSP "hard": the opponents the main beats least come up most; inactive members never', () => {
    const w = Object.fromEntries(kindWeights(league, 'snapshot').map((x) => [x.id, x.w]));
    expect(w['delove@13']).toBeGreaterThan(w['delove@12']);
    expect(w['delove@12']).toBeGreaterThan(w['delove@8']);
    expect(w['delove@8']).toBeGreaterThan(0); // the floor keeps every member in play
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(kindWeights(league, 'exploiter').map((x) => x.id)).toEqual(['delove-exploit@1']);
    expect(winChance(0, 0)).toBe(0.5);
  });

  it('an active exploiter takes about its share of "@league" seats; "@league:zerg" samples that kind', () => {
    const random = seededRandom(5);
    const picks = [...Array(4000)].map(() => sampleSeat(league, '@league', random));
    const share = picks.filter((p) => p === 'delove-exploit@1').length / picks.length;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
    expect(sampleSeat(league, '@league:zerg', random)).toBe('zerg@2');
    expect(() => sampleSeat(league, '@league:impostor', random)).toThrow(/no active member of kind "impostor"/);
  });

  it('expands a jobs file: league lines split into sub-lines with their own games, other lines kept, the same every time', () => {
    const jobs = [
      '# a comment',
      'c4a 250 jacob-sensei@1,delove-branch@1,@league,@league {"autoSetup":true}',
      'c4b 100 jacob-sensei@1,delove-branch@1,delove@13 {"capitals":true}',
      'z3 150 delove-branch@1,@league:zerg,@league:zerg 1000 {"map":"skirmish"}',
    ].join('\n');
    const out = expandJobs(jobs, league, 318);
    expect(expandJobs(jobs, league, 318)).toBe(out);
    expect(expandJobs(jobs, league, 319)).not.toBe(out);
    const lines = out.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines.filter((l) => l.startsWith('c4b '))).toEqual(['c4b 100 jacob-sensei@1,delove-branch@1,delove@13 {"capitals":true}']);
    const c4a = lines.filter((l) => l.startsWith('c4a-l'));
    expect(c4a.map((l) => l.split(' ')[1])).toEqual(['100', '100', '50']);
    expect(c4a.map((l) => l.split(' ')[3])).toEqual(['0', '100', '200']);
    expect(c4a.every((l) => !l.includes('@league') && l.endsWith('{"autoSetup":true}'))).toBe(true);
    const z3 = lines.filter((l) => l.startsWith('z3-l'));
    expect(z3).toEqual(['z3-l0 100 delove-branch@1,zerg@2,zerg@2 1000 {"map":"skirmish"}', 'z3-l1 50 delove-branch@1,zerg@2,zerg@2 1100 {"map":"skirmish"}']);
    const mix = leagueMix(out, league);
    expect(mix['zerg@2']).toBe(300);
  });

  it('takes ratings from an A/B scorecard, shifted so the main is at 0', () => {
    const rated = withRatings(league, { 'delove@13': { elo: 40 }, 'delove@12': { elo: 10 }, 'delove@8': { elo: -200 } });
    expect(rated.members.find((m) => m.id === 'delove@12')!.elo).toBe(-30);
    expect(rated.members.find((m) => m.id === 'delove@13')!.elo).toBe(0);
    expect(rated.members.find((m) => m.id === 'zerg@2')!.elo).toBeUndefined();
  });

  it('the shipped league loads, its exploiter slot off until one is trained', () => {
    const l = loadLeague(join(__dirname, '..', 'configs', 'league.json'));
    expect(l.main).toBe('delove@13');
    expect(kindWeights(l, 'exploiter')).toEqual([]);
    expect(kindWeights(l, 'snapshot').length).toBe(4);
  });
});
