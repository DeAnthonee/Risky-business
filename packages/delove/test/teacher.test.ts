import { describe, expect, it } from 'vitest';
import { playGame, riskyBot, runMatch } from '@risk/selfplay';
import { teacher, TEACHER_ID } from '../src/index.js';

describe('delove-teacher@1', () => {
  it('plays whole games legally and only from the candidate list', () => {
    for (const [seed, options, seats] of [
      [1, {}, 2],
      [2, { capitals: true }, 3],
      [3, { map: 'world' as const }, 4],
      [4, { cardValues: 'fixed' as const, balancedBlitz: true }, 2],
    ] as const) {
      const g = playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent: teacher })), options, onIllegal: 'throw' });
      expect(g.illegal.every((n) => n === 0)).toBe(true);
      expect(g.offList.every((n) => n === 0)).toBe(true);
    }
  });

  it('is deterministic from the seed', () => {
    const a = playGame({ seed: 7, seats: [{ agent: teacher }, { agent: riskyBot }], record: true });
    const b = playGame({ seed: 7, seats: [{ agent: teacher }, { agent: riskyBot }], record: true });
    expect(a.records!.map((r) => r.choice)).toEqual(b.records!.map((r) => r.choice));
    expect(a.winner).toBe(b.winner);
  });

  it('beats the built-in bot', async () => {
    const result = await runMatch({ candidate: teacher, best: riskyBot, games: 40, seed: 11, players: 2 });
    expect(result.candidate).toBe(TEACHER_ID);
    expect(result.score).toBeGreaterThan(0.75);
  });
});
