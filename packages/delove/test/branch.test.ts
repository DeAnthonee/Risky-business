import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KILL_POINTS, placementPoints, type GameState } from '@risk/engine';
import { getMap } from '@risk/engine';
import { playGame, type Agent, type StepContext } from '@risk/selfplay';
import { branchAgent, decisionScore, DEFAULT_BRANCH, gumbel, gumbelSchedule, killCredit, pointsScore, positionScore, threatDeflection } from '../src/branch.js';
import { DEFAULT_TEACHER_PARAMS, NetScorer, teacher, teacherPickWith } from '../src/index.js';

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

  it('long: the share score plus killWeight kill credits', () => {
    const victim = s.players.find((p) => p.id !== me && !p.isNeutral)!;
    const killed: GameState = { ...s, players: s.players.map((p) => (p.id === victim.id ? { ...p, alive: false, eliminatedBy: me } : p)) };
    expect(positionScore(s, me, w, 'long').score).toBe(positionScore(s, me, w).score);
    expect(positionScore(killed, me, w, 'long').score).toBe(positionScore(killed, me, w).score + DEFAULT_BRANCH.killWeight * killCredit(killed, me));
    expect(positionScore(killed, me, w, 'long', { killWeight: 0, threat: 0 }).score).toBe(positionScore(killed, me, w).score);
  });

  it('mid: P(top 2) and the threat deflection with 3 alive, 1 once a rival falls, share at 4+', () => {
    expect(positionScore(s, me, w, 'mid').score).toBe(positionScore(s, me, w).score);
    const [a, b] = s.players.filter((p) => p.id !== me && !p.isNeutral);
    const three: GameState = { ...s, players: s.players.map((p) => (p.id === a.id ? { ...p, alive: false, eliminatedBy: b.id } : p)) };
    const two: GameState = { ...three, players: three.players.map((p) => (p.id === b.id ? { ...p, alive: false } : p)) };
    expect(positionScore(two, me, w, 'mid').score).toBe(1);
    const noThreat = positionScore(three, me, w, 'mid', { killWeight: 2, threat: 0 }).score;
    const onlyThreat = positionScore(three, me, w, 'mid', { killWeight: 2, threat: 1 }).score;
    expect(noThreat).toBeGreaterThanOrEqual(0);
    expect(noThreat).toBeLessThanOrEqual(1);
    expect(onlyThreat).toBeGreaterThanOrEqual(0);
    expect(onlyThreat).toBeLessThanOrEqual(1);
    expect(positionScore(three, me, w, 'mid').score).toBeCloseTo(0.7 * noThreat + 0.3 * onlyThreat, 12);
    // the strongest of the three by P(top 2) is the strongest by share
    const alive = three.players.filter((p) => p.alive && !p.isNeutral);
    const share = alive.map((p) => positionScore(three, p.id, w).score);
    const top2 = alive.map((p) => positionScore(three, p.id, w, 'mid', { killWeight: 2, threat: 0 }).score);
    expect(top2.indexOf(Math.max(...top2))).toBe(share.indexOf(Math.max(...share)));
  });

  it("threat deflection: the strongest rival's border armies facing the third player", () => {
    const map = getMap(s.options.map);
    const [, b, c] = s.players.filter((p) => !p.isNeutral);
    // a board of three: me, b (strong) and c; b borders only c -> 1, only me -> 0
    const owners = (f: (t: string) => string) => Object.fromEntries(map.territoryIds.map((t) => [t, { ...s.territories[t], owner: f(t), armies: 3 }]));
    const ids = map.territoryIds;
    const bT = ids[0];
    const nb = map.adjacency[bT];
    const onlyThird: GameState = { ...s, territories: owners((t) => (t === bT ? b.id : nb.includes(t) ? c.id : me)) };
    const meta = [me, b.id, c.id].map((id) => ({ id, armies: id === b.id ? 0.6 : 0.2, territories: id === b.id ? 0.6 : 0.2 }));
    expect(threatDeflection(onlyThird, me, meta)).toBe(1);
    const onlyMe: GameState = { ...s, territories: owners((t) => (t === bT ? b.id : nb.includes(t) ? me : c.id)) };
    expect(threatDeflection(onlyMe, me, meta)).toBe(0);
    const none: GameState = { ...s, territories: owners(() => b.id) };
    expect(threatDeflection(none, me, meta)).toBe(0.5);
  });

  it('range: long at 4+ alive, mid at 3, close (deeper search, share score) at 2', () => {
    const o = { ...DEFAULT_BRANCH, score: 'range' as const };
    expect(decisionScore(o, 6)).toEqual({ mode: 'long', rollouts: o.rollouts, horizon: o.horizon });
    expect(decisionScore(o, 4).mode).toBe('long');
    expect(decisionScore(o, 3)).toEqual({ mode: 'mid', rollouts: o.rollouts, horizon: o.horizon });
    expect(decisionScore(o, 2)).toEqual({ mode: 'share', rollouts: o.closeRollouts, horizon: o.closeHorizon });
    expect(decisionScore({ ...o, score: 'close' }, 5)).toEqual({ mode: 'share', rollouts: o.closeRollouts, horizon: o.closeHorizon });
    expect(decisionScore({ ...o, score: 'share' }, 2)).toEqual({ mode: 'share', rollouts: o.rollouts, horizon: o.horizon });
  });
});

describe('branch and score with network rollouts (DELOVE_BRANCH_ROLLOUT)', () => {
  // Random weights (hidden 8): plays badly, but goes through encoder -> ONNX -> worker -> move like a trained model.
  const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));
  const opts = { ...DEFAULT_BRANCH, options: 2, rollouts: 2, horizon: 1, margin: 0.01 };

  /** The rollout network wrapped to count its calls by whose turn it is (the decider's or another seat's). */
  function counted(seats: 'all' | 'self') {
    const net = new NetScorer(TINY);
    const calls = { mine: 0, others: 0 };
    let decider = '';
    const spy = { score: (ctx: StepContext) => (ctx.me === decider ? calls.mine++ : calls.others++, net.score(ctx)) } as unknown as NetScorer;
    const agent = branchAgent('b', teacherPickWith(DEFAULT_TEACHER_PARAMS), net, opts, null, { net: spy, seats });
    const wrapped: Agent = { id: 'b', choose: (ctx) => ((decider = ctx.me), agent.choose(ctx)) };
    return { agent: wrapped, calls };
  }

  for (const seats of ['all', 'self'] as const) {
    it(`plays legally and deterministically with the network in ${seats === 'all' ? 'every seat' : "the decider's seat"}`, () => {
      const play = () => {
        const c = counted(seats);
        const g = playGame({ seed: 4, seats: [{ agent: c.agent }, { agent: teacher }, { agent: teacher }], maxTurns: 4, record: true, onIllegal: 'throw' });
        return { choices: g.records!.map((r) => r.choice), calls: c.calls };
      };
      const a = play();
      expect(a).toEqual(play());
      expect(a.calls.mine).toBeGreaterThan(0);
      if (seats === 'all') expect(a.calls.others).toBeGreaterThan(0);
      else expect(a.calls.others).toBe(0);
    });
  }
});

describe('Gumbel root (root: gumbel)', () => {
  it('halves the others each round within the budget, the teacher move in every round', () => {
    expect(gumbelSchedule(8, 30)).toEqual([
      { size: 8, copies: 1 },
      { size: 5, copies: 1 },
      { size: 3, copies: 2 },
      { size: 2, copies: 3 },
    ]);
    expect(gumbelSchedule(2, 30)).toEqual([{ size: 2, copies: 15 }]);
    expect(gumbelSchedule(3, 30)).toEqual([
      { size: 3, copies: 5 },
      { size: 2, copies: 7 },
    ]);
    for (const [m, b] of [[8, 30], [5, 30], [16, 30], [8, 72]]) {
      const plan = gumbelSchedule(m, b);
      expect(plan.at(-1)!.size).toBe(2);
      // the copies spent stay within the budget once every candidate has its first copy
      const spent = plan.reduce((a, r) => a + r.size * r.copies, 0);
      expect(spent).toBeLessThanOrEqual(Math.max(b, m + plan.slice(1).reduce((a, r) => a + r.size * r.copies, 0)));
    }
  });

  it('draws standard Gumbel noise', () => {
    expect(gumbel(Math.exp(-1))).toBeCloseTo(0, 12);
    expect(gumbel(0.5)).toBeCloseTo(0.36651292, 7);
    expect(gumbel(0)).toBe(-Infinity);
  });

  const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));
  it('plays legally and deterministically, searching more candidates than the top options', () => {
    const play = () => {
      const opts = { ...DEFAULT_BRANCH, root: 'gumbel' as const, gumbelK: 6, options: 3, rollouts: 2, horizon: 1, margin: 0.01 };
      const agent = branchAgent('b', teacherPickWith(DEFAULT_TEACHER_PARAMS), new NetScorer(TINY), opts);
      const g = playGame({ seed: 7, seats: [{ agent }, { agent: teacher }, { agent: teacher }], maxTurns: 4, record: true, onIllegal: 'throw' });
      return g.records!.map((r) => r.choice);
    };
    const a = play();
    expect(a.length).toBeGreaterThan(0);
    expect(play()).toEqual(a);
  });

  it('refuses the value blend', () => {
    expect(() => branchAgent('b', teacherPickWith(DEFAULT_TEACHER_PARAMS), null, { ...DEFAULT_BRANCH, root: 'gumbel', valueWeight: 0.5 })).toThrow();
  });
});
