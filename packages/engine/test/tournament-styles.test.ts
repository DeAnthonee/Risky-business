import { describe, expect, it } from 'vitest';
import { RuleError, addPlayer, createGame, endBySurvival, lastSurvivor, planNest, startGame, type GameState } from '../src/index.js';

/** Seats per table, round by round. */
const seats = (players: number, o: Parameters<typeof planNest>[1]) => planNest(players, o).rounds.map((r) => r.map((t) => t.seats));

describe('tournament styles: the planner', () => {
  it('firstMinTable keeps a 100-seat round 1 at 4 or 5 a table, with no Zergs (owner: "not only 3 person games")', () => {
    // The default plans 100 players at 3-seat tables (fewest rounds first).
    expect(Math.min(...seats(100, {})[0])).toBe(3);
    for (const min of [4, 5]) {
      const p = planNest(100, { firstMinTable: min });
      expect(p.zergs).toBe(0);
      expect(Math.min(...p.rounds[0].map((t) => t.seats))).toBeGreaterThanOrEqual(min);
      expect(p.rounds[0].reduce((n, t) => n + t.seats, 0)).toBe(100);
    }
    // Later rounds may still seat 3: only round 1 follows firstMinTable.
    expect(planNest(100, { firstMinTable: 5 }).rounds.length).toBeGreaterThanOrEqual(3);
    expect(() => planNest(10, { firstMinTable: 2 })).toThrow(RuleError);
    expect(() => planNest(10, { firstMinTable: 7 })).toThrow(RuleError);
  });

  it('plans a 1v1 bracket: every table two seats, the final too, Zergs up to the next power of two', () => {
    const one = { minTable: 2, maxTable: 2, minFinal: 2, maxFinal: 2, prefer: 2 };
    const p = planNest(100, one);
    expect(p.zergs).toBe(28);
    expect(p.rounds.map((r) => r.length)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    expect(p.rounds.flat().every((t) => t.seats === 2)).toBe(true);
    // At most one Zerg a table: a Delove meets a Zerg, never a Zerg a Zerg, while there are Deloves to go round.
    expect(Math.max(...p.rounds[0].map((t) => t.zergs))).toBe(1);
    expect(planNest(32, one).zergs).toBe(0);
  });
});

/** A started three-player game: a, b and z (the swarm). */
function game(): GameState {
  let s = createGame('S', { map: 'skirmish', maxPlayers: 3, autoSetup: true });
  for (const id of ['a', 'b', 'z']) s = addPlayer(s, id, id.toUpperCase());
  return startGame(s).state;
}

describe('tournament styles: Zerg survival ends at the last non-Zerg', () => {
  it('ends once one non-Zerg is left, whatever the Zergs hold; not before, nor mid-conquest', () => {
    const s = game();
    const [a, b, z] = s.players.map((p) => p.id);
    const swarm = new Set([z]);
    expect(lastSurvivor(s, swarm)).toBeNull();
    const bOut = { ...s, players: s.players.map((p) => (p.id === b ? { ...p, alive: false } : p)) };
    expect(lastSurvivor(bOut, swarm)).toBe(a);
    expect(lastSurvivor({ ...bOut, pendingConquest: {} as GameState['pendingConquest'] }, swarm)).toBeNull();
    const { state, events } = endBySurvival(bOut, swarm, 5);
    expect(state).toMatchObject({ phase: 'finished', winner: a, finishedAt: 5 });
    expect(events).toEqual([{ type: 'game_over', winner: a }]);
    // One non-Zerg seated from the start: nothing to survive against another, so the rule never fires.
    expect(lastSurvivor(s, new Set([b, z]))).toBeNull();
    expect(() => endBySurvival(s, swarm)).toThrow(RuleError);
  });
});
