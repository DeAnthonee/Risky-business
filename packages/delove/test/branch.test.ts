import { describe, expect, it } from 'vitest';
import { KILL_POINTS, placementPoints, type GameState } from '@risk/engine';
import { playGame, type Agent } from '@risk/selfplay';
import { DEFAULT_BRANCH, killCredit, pointsScore, positionScore } from '../src/branch.js';
import { teacher } from '../src/index.js';

/** A 4-player World position from the middle of a teacher game. */
function midGame(): GameState {
  let caught: GameState | null = null;
  const spy: Agent = {
    id: 'spy',
    choose(ctx) {
      if (!caught && ctx.state.phase === 'attack' && ctx.state.round >= 4) caught = ctx.state;
      return teacher.choose(ctx);
    },
  };
  playGame({ seed: 5, seats: [{ agent: spy }, { agent: teacher }, { agent: teacher }, { agent: teacher }], options: { map: 'world' } });
  return caught!;
}

describe('branch score', () => {
  const s = midGame();
  const me = s.currentPlayer!;
  const w = DEFAULT_BRANCH.weights;

  it('keeps the share score by default', () => {
    expect(DEFAULT_BRANCH.score).toBe('share');
    expect(positionScore(s, me, w)).toEqual(positionScore(s, me, w, 'share'));
  });

  it('scores leaderboard points from 0 (last) to 1 (first), plus kills', () => {
    const D = placementPoints(1, 4) - placementPoints(4, 4);
    expect(pointsScore(s, me, 1)).toBe(1);
    expect(pointsScore(s, me, 4)).toBe(0);
    expect(pointsScore(s, me, 2.5)).toBeCloseTo((placementPoints(2, 4) + placementPoints(3, 4) - 2 * placementPoints(4, 4)) / 2 / D);
    const victim = s.players.find((p) => p.id !== me && !p.isNeutral)!;
    const killed: GameState = { ...s, players: s.players.map((p) => (p.id === victim.id ? { ...p, alive: false, eliminatedBy: me } : p)) };
    expect(pointsScore(killed, me, 1)).toBe(1 + KILL_POINTS / D);
    // knocked out: just below the players still alive (3 of 4 left: 4th place)
    const out: GameState = { ...s, players: s.players.map((p) => (p.id === me ? { ...p, alive: false, eliminatedBy: victim.id } : p)) };
    expect(pointsScore(out, me, null)).toBe(0);
  });

  it('keeps the share parts and rates the strongest player highest', () => {
    const share = positionScore(s, me, w, 'share');
    const points = positionScore(s, me, w, 'points');
    expect({ ...points, score: 0 }).toEqual({ ...share, score: 0 });
    const all = s.players.filter((p) => p.alive && !p.isNeutral).map((p) => ({ share: positionScore(s, p.id, w).score, points: positionScore(s, p.id, w, 'points').score }));
    for (const x of all) expect(x.points).toBeGreaterThanOrEqual(0);
    const best = all.reduce((a, b) => (b.share > a.share ? b : a));
    expect(Math.max(...all.map((x) => x.points))).toBe(best.points);
  });

  it('kills: the share score plus a kill credit on the points scale', () => {
    const D = placementPoints(1, 4) - placementPoints(4, 4);
    expect(killCredit(s, me)).toBe(0);
    expect(positionScore(s, me, w, 'kills').score).toBe(positionScore(s, me, w).score);
    const victim = s.players.find((p) => p.id !== me && !p.isNeutral)!;
    const killed: GameState = { ...s, players: s.players.map((p) => (p.id === victim.id ? { ...p, alive: false, eliminatedBy: me } : p)) };
    expect(killCredit(killed, me)).toBe(KILL_POINTS / D);
    expect(positionScore(killed, me, w, 'kills').score).toBe(positionScore(killed, me, w).score + KILL_POINTS / D);
  });
});
