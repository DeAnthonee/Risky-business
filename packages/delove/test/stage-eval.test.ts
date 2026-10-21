import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { playGame, riskyBot, stepAgent } from '@risk/selfplay';
import {
  aliveSeats,
  alivePlayers,
  candidateSeats,
  capturePosition,
  discoverNetAgents,
  jacob,
  playPair,
  playStageGame,
  rangeOf,
  routedAgent,
  stagedAgent,
  STAGES,
  summarize,
  type PairResult,
  type Range,
  weakestShare,
} from '../src/index.js';

const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));

describe('playStageGame (games from a position)', () => {
  // Deterministic and random-free, so a continued game must replay the uninterrupted one exactly.
  const first = stepAgent('first@1', () => 0);
  const four = Array.from({ length: 4 }, () => first);

  it('plays the same games as self-play playGame from a new deal', () => {
    for (const [seed, n, map] of [[1, 2, 'classic'], [2, 4, 'classic'], [3, 6, 'world']] as const) {
      const a = playGame({ seed, seats: Array.from({ length: n }, () => ({ agent: riskyBot })), options: { map }, maxTurns: 300, onIllegal: 'surrender' });
      const b = playStageGame({ seed, agents: Array.from({ length: n }, () => riskyBot), options: { map }, maxTurns: 300 });
      expect([b.winner, b.turns, b.placement, b.kills, b.points]).toEqual([a.winner, a.turns, a.placement, a.kills, a.points]);
    }
  });

  it('stops before the first decision stopWhen accepts and continues to the same end', () => {
    const whole = playStageGame({ seed: 3, agents: four, maxTurns: 60 });
    const half = playStageGame({ seed: 3, agents: four, maxTurns: 60, stopWhen: (s) => s.turnNumber >= 25 });
    expect(half.final!.state.turnNumber).toBe(25);
    // Through JSON, as a saved position set is.
    const rest = playStageGame({ seed: 3, agents: four, maxTurns: 60, start: JSON.parse(JSON.stringify(half.final)) });
    expect(rest).toEqual(whole);
  });

  it('keeps earlier eliminations in the placements', () => {
    const agents = Array.from({ length: 6 }, () => riskyBot);
    const whole = playStageGame({ seed: 4, agents, maxTurns: 400 });
    const half = playStageGame({ seed: 4, agents, maxTurns: 400, stopWhen: (s) => alivePlayers(s) === 3 });
    expect(half.final!.eliminationOrder).toHaveLength(3);
    const rest = playStageGame({ seed: 4, agents, maxTurns: 400, start: half.final });
    // risky@1 draws on its seeded random source, which restarts with the continuation: only the earlier part is fixed.
    for (const p of half.final!.eliminationOrder) expect(rest.placement[Number(p.slice(1))]).toBe(whole.placement[Number(p.slice(1))]);
  });

  it('refuses a position whose players are not the seats', () => {
    const half = playStageGame({ seed: 3, agents: four, maxTurns: 60, stopWhen: (s) => s.turnNumber >= 5 });
    expect(() => playStageGame({ seed: 3, agents: four.slice(0, 3), start: half.final })).toThrow(/position has players/);
  });
});

describe('range specialist yardstick (stage-eval)', () => {
  it('captures mid and close positions at a turn start with exactly 3 / 2 players alive, the same every time', () => {
    for (const [stage, alive] of [['mid', 3], ['close', 2]] as const) {
      for (const i of [0, 1, 2, 3]) {
        const p = capturePosition(STAGES[stage], i, 7, jacob, {});
        expect(p.table).toEqual(STAGES[stage].tables[i % STAGES[stage].tables.length]);
        expect(alivePlayers(p.start!.state)).toBe(alive);
        expect(p.start!.state.phase).toBe('reinforce');
        expect(aliveSeats(p)).toHaveLength(alive);
        expect(weakestShare(p.start!.state)).toBeGreaterThanOrEqual(STAGES[stage].balance);
        expect(JSON.stringify(capturePosition(STAGES[stage], i, 7, jacob, {}))).toBe(JSON.stringify(p));
      }
    }
  });

  it('starts long positions on turn 1 with every seat alive, and full ones from the deal', () => {
    const p = capturePosition(STAGES.long, 1, 7, jacob, {});
    expect(p.start!.state.round).toBe(1);
    expect(p.start!.state.currentPlayer).toBe(p.start!.state.turnOrder[0]);
    expect(p.start!.state.phase).toBe('reinforce');
    expect(alivePlayers(p.start!.state)).toBe(p.table.players);
    expect(capturePosition(STAGES.full, 0, 7, jacob, {}).start).toBeUndefined();
  });

  it('swaps the candidate over every alive seat across the pair', () => {
    const p = capturePosition(STAGES.mid, 0, 7, jacob, {});
    const a = candidateSeats(p, 0);
    const b = candidateSeats(p, 1);
    expect([...a, ...b].sort()).toEqual(aliveSeats(p));
    expect([...a].some((s) => b.has(s))).toBe(false);
  });

  it('a model against itself is even, and the pair replays exactly', () => {
    const p = capturePosition(STAGES.close, 2, 7, jacob, {});
    const r = playPair(p, jacob, jacob, {});
    expect(r.cand.win + r.base.win).toBeCloseTo(1);
    expect(playPair(p, jacob, jacob, {})).toEqual(r);
  });

  it('plays the specialist only inside its range', () => {
    const seen = new Set<Range>();
    const spy = stepAgent('spy@1', (ctx) => (seen.add(rangeOf(ctx.state)), 0));
    const staged = stagedAgent('staged@1', spy, riskyBot, 'mid');
    const p = capturePosition(STAGES.mid, 1, 7, jacob, {});
    playPair(p, staged, riskyBot, {});
    expect([...seen]).toEqual(['mid']);
  });

  it('routes the trio by players alive', () => {
    const used = new Map<string, Set<Range>>();
    const spy = (name: string) => stepAgent(name, (ctx) => (used.set(name, (used.get(name) ?? new Set()).add(rangeOf(ctx.state))), 0));
    const trio = routedAgent('trio@1', { long: spy('long'), mid: spy('mid'), close: spy('close') });
    playPair(capturePosition(STAGES.long, 0, 7, jacob, {}), trio, riskyBot, {}, 300);
    for (const [name, ranges] of used) expect([...ranges]).toEqual([name]);
    expect(used.has('long')).toBe(true);
  });

  it('calls a clear difference better or worse and a small one even', () => {
    const pair = (d: number): PairResult => ({ index: 0, table: 't', cand: { points: d, top3: 0, top2: 0, win: 0.5 + d / 10 }, base: { points: 0, top3: 0, top2: 0, win: 0.5 }, turnLimit: 0, turns: 10, decided: false });
    expect(summarize([1, 1.2, 0.8, 1.1, 0.9].map(pair), ['points']).verdict).toBe('better');
    expect(summarize([-1, -1.2, -0.8, -1.1].map(pair), ['points']).verdict).toBe('worse');
    expect(summarize([1, -1, 0.5, -0.5].map(pair), ['points']).verdict).toBe('even');
    // Win shares never read as certain from a handful of positions (the variance floor).
    expect(summarize([0.1, 0.1, 0.1].map((x) => pair(x * 10)), ['win']).verdict).toBe('even');
  });

  it('discovers the library names delove-long-range@N, delove-mid-range@N and delove-close-range@N', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delove-lib-'));
    for (const m of ['delove-long-range@1', 'delove-mid-range@1', 'delove-close-range@2']) copyFileSync(TINY, join(dir, `${m}.onnx`));
    const ids = discoverNetAgents(dir).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['delove-long-range@1', 'delove-mid-range@1', 'delove-close-range@2']));
  });
});
