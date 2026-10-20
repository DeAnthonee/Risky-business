import { describe, expect, it } from 'vitest';
import { playGame, runMatch } from '@risk/selfplay';
import { jacob, JACOB_ID, makeTeacher } from '../src/index.js';

describe('jacob-sensei@1', () => {
  it('plays whole games legally and only from the candidate list', () => {
    for (const [seed, options, seats] of [
      [1, {}, 2],
      [2, { capitals: true }, 3],
      [3, { map: 'world' as const }, 6],
      [4, { cardValues: 'fixed' as const, balancedBlitz: true }, 2],
      [5, { map: 'greater_europe' as const }, 10],
    ] as const) {
      const g = playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent: jacob })), options, onIllegal: 'throw' });
      expect(g.illegal.every((n) => n === 0)).toBe(true);
      expect(g.offList.every((n) => n === 0)).toBe(true);
    }
  });

  it('is deterministic from the seed', () => {
    const a = playGame({ seed: 7, seats: [{ agent: jacob }, { agent: jacob }, { agent: jacob }], record: true });
    const b = playGame({ seed: 7, seats: [{ agent: jacob }, { agent: jacob }, { agent: jacob }], record: true });
    expect(a.records!.map((r) => r.choice)).toEqual(b.records!.map((r) => r.choice));
    expect(a.winner).toBe(b.winner);
  });

  it('finishes big self-play tables before the turn limit', () => {
    for (const [seed, map, seats] of [
      [11, 'world', 6],
      [12, 'greater_europe', 10],
      [13, 'fantasy', 8],
    ] as const) {
      const g = playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent: jacob })), options: { map } });
      expect(g.winner).not.toBeNull();
    }
  });

  it('beats delove-teacher@1 at a 4-player table', async () => {
    const result = await runMatch({ candidate: jacob, best: makeTeacher('delove-teacher@1', {}), games: 40, seed: 11, players: 4 });
    expect(result.candidate).toBe(JACOB_ID);
    expect(result.score).toBeGreaterThan(0.55);
  });
});
