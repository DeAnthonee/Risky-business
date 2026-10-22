import { describe, expect, it } from 'vitest';
import { riskyBot, stepAgent } from '@risk/selfplay';
import { compareHorde, hordeSchedule, hordeSeats, parseHordeTables, playHordeGame, summarizeHorde } from '../src/index.js';

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
    expect(compareHorde(games, games).diff.mean).toBe(0);
  });
});
