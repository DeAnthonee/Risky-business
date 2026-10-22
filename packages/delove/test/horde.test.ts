import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame } from '@risk/engine';
import { riskyBot, stepAgent } from '@risk/selfplay';
import { compareHorde, hordeOf, hordeSchedule, hordeScore, hordeSeats, parseHordeTables, playHordeGame, summarizeHorde, zergBranchAgent } from '../src/index.js';

describe('Zerg-horde table', () => {
  const filler = stepAgent('first@1', () => 0);

  it('parses tables and rejects a table without a non-Zerg seat', () => {
    expect(parseHordeTables('classic:4:3,skirmish:4:2')).toEqual([
      { map: 'classic', players: 4, zergs: 3 },
      { map: 'skirmish', players: 4, zergs: 2 },
    ]);
    expect(() => parseHordeTables('classic:3:3')).toThrow(/bad horde table/);
  });

  it('seats the candidate, then the Zergs, then fillers, rotating with the shift', () => {
    const [t] = parseHordeTables('classic:5:2');
    const { seats, me, zergSeats } = hordeSeats(riskyBot, filler, t, 3);
    expect(me).toBe(3);
    expect(zergSeats).toEqual([4, 0]);
    expect(seats.map((s) => s.agent.id)).toEqual(['zerg@1', 'first@1', 'first@1', 'risky@1', 'zerg@1']);
  });

  it('plays a solo table to the end, deterministically, and scores it', () => {
    const [t] = parseHordeTables('skirmish:3:2');
    const a = playHordeGame(riskyBot, filler, t, 7, 0);
    expect(playHordeGame(riskyBot, filler, t, 7, 0)).toEqual(a);
    expect(a.turnLimit).toBe(0);
    expect(a.hold).toBe(a.win ? 1 : Math.min(0.99, a.rounds / 30));
  });

  it('pairs candidate and base on the same games', () => {
    const tables = parseHordeTables('skirmish:3:2,skirmish:4:2');
    const games = hordeSchedule(tables, 4, 1).map((g) => playHordeGame(riskyBot, filler, g.table, g.seed, g.shift));
    expect(games).toHaveLength(8);
    expect(summarizeHorde(games).games).toBe(8);
    const same = compareHorde(games, games);
    expect(same.diff.mean).toBe(0);
    expect(same.diffs.points.mean).toBe(0);
    expect(same.diffs.kills.mean).toBe(0);
  });
});

describe('searching Zerg (zerg-branch)', () => {
  const small = { options: 3, rollouts: 2, horizon: 1, killWeight: 2, margin: 0.02 };

  it('needs a Zerg id, so its allies recognise it', () => {
    expect(() => zergBranchAgent('hunter@1', riskyBot, null, small)).toThrow(/must start with "zerg"/);
  });

  it('plays a horde table to the end without hitting a fellow Zerg', () => {
    const zerg = zergBranchAgent('zerg-branch@test', riskyBot, null, small);
    const [t] = parseHordeTables('skirmish:4:3');
    const r = playHordeGame(riskyBot, riskyBot, t, 11, 1, {}, 500, zerg);
    expect(r.turnLimit).toBe(0);
    expect(r.points).toBeTypeOf('number');
  });

  it('scores the horde: a prey knocked out is worth the kill weight, a horde win adds 1', () => {
    let s = createGame('h', { map: 'skirmish', maxPlayers: 3 }, 3);
    for (const [id, name] of [['a', 'risky@1'], ['z1', 'zerg@1'], ['z2', 'zerg@1']]) s = addPlayer(s, id, name, true);
    s = startGame(s).state;
    const horde = hordeOf(s, 'z1');
    expect([...horde].sort()).toEqual(['z1', 'z2']);
    const share = hordeScore(s, horde, 1, 3);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    const won = { ...s, phase: 'finished' as const, winner: 'z2', players: s.players.map((p) => (p.id === 'a' ? { ...p, alive: false } : p)) };
    expect(hordeScore(won, horde, 1, 3)).toBe(4);
  });
});
