import { describe, expect, it } from 'vitest';
import { listenFeatures, FEATURE_NAMES } from '../src/talk/features.js';
import { playTalkGame, type TalkSeat } from '../src/talk/game.js';
import { auc, predict, trainListener } from '../src/talk/listener.js';
import { heuristicBelief, impostorSeat, plainSeat, zergSeat } from '../src/talk/roles.js';
import { visibleTo, type TalkMessage } from '../src/talk/vocab.js';

const table = (): TalkSeat[] => [zergSeat(heuristicBelief), plainSeat(true), zergSeat(heuristicBelief, false), impostorSeat('claimer')];

describe('talking tables (learned Zerg, stages 0-1)', () => {
  it('plays to the end, deterministically from the seed', () => {
    const a = playTalkGame({ seed: 11, seats: table(), options: { map: 'classic', autoSetup: true } });
    const b = playTalkGame({ seed: 11, seats: table(), options: { map: 'classic', autoSetup: true } });
    expect(b).toEqual(a);
    expect(a.roles).toEqual(['zerg', 'plain', 'zerg', 'impostor']);
    expect(a.chat.some((m) => m.kind === 'claim_zerg')).toBe(true);
    // The quiet Zerg (seat 2) never speaks.
    expect(a.chat.some((m) => m.from === 's2')).toBe(false);
  });

  it('ends by standing as soon as only true Zergs are left (the strongest wins)', () => {
    let endedByStanding = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = playTalkGame({ seed, seats: [zergSeat(heuristicBelief), plainSeat(), zergSeat(heuristicBelief)], options: { map: 'skirmish', autoSetup: true } });
      if (g.winner === null) continue;
      const out = new Set(g.eliminated.map((e) => e.seat));
      // If the plain seat is out and both Zergs are still in, the game ended by standing, not by a Zerg fight.
      if (out.has(1) && !out.has(0) && !out.has(2)) {
        endedByStanding++;
        expect(g.roles[g.winner]).toBe('zerg');
      }
    }
    expect(endedByStanding).toBeGreaterThan(0);
  });

  it('a seat sees public messages and only the whispers it sent or received', () => {
    const chat: TalkMessage[] = [
      { from: 's0', kind: 'claim_zerg', turn: 1, round: 1 },
      { from: 's0', kind: 'ask', about: 's2', to: 's2', turn: 1, round: 1 },
      { from: 's1', kind: 'accuse', about: 's0', turn: 2, round: 1 },
    ];
    expect(visibleTo(chat, 's2')).toHaveLength(3);
    expect(visibleTo(chat, 's1').map((m) => m.kind)).toEqual(['claim_zerg', 'accuse']);
  });

  it('listening features read claims and behaviour toward claimers, never roles', () => {
    const chat: TalkMessage[] = [
      { from: 's0', kind: 'claim_zerg', turn: 1, round: 1 },
      { from: 's3', kind: 'claim_zerg', turn: 2, round: 1 },
    ];
    const battles = [{ attacker: 's3', defender: 's2', attackerLosses: 1, defenderLosses: 3, turn: 3, round: 2 }];
    const x = listenFeatures('s0', 's3', chat, battles, 2);
    const f = Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, x[i]]));
    expect(f.claimed).toBe(1);
    expect(f.battles_vs_others).toBeCloseTo(Math.log1p(1));
    expect(f.damage_to_others).toBeCloseTo(Math.log1p(3));
    expect(f.battles_vs_claimers).toBe(0);
    expect(x).toHaveLength(FEATURE_NAMES.length);
  });

  it('the listener learns a separable signal, and AUC is right', () => {
    expect(auc([0.9, 0.8, 0.3, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
    const d = FEATURE_NAMES.length;
    const data = Array.from({ length: 200 }, (_, i) => {
      const y = (i % 2) as 0 | 1;
      const x = new Array<number>(d).fill(0).map((_, k) => ((i * 7 + k * 3) % 5) / 5);
      x[13] = y ? 0 : 1 + (i % 3); // Zergs never hit claimers in this toy set
      return { x, y };
    });
    const model = trainListener(data);
    const s = data.map((e) => predict(model, e.x));
    expect(auc(s, data.map((e) => e.y))).toBeGreaterThan(0.95);
  });
});

describe('second-order listening features', () => {
  it('split the target\'s battles by the observer\'s belief in each defender (the observer counts as a believed Zerg)', async () => {
    const { secondOrderFeatures } = await import('../src/talk/features.js');
    const battles = [
      { attacker: 's3', defender: 's0', attackerLosses: 0, defenderLosses: 2, turn: 1, round: 1 },
      { attacker: 's3', defender: 's1', attackerLosses: 1, defenderLosses: 1, turn: 2, round: 1 },
      { attacker: 's3', defender: 's2', attackerLosses: 1, defenderLosses: 1, turn: 3, round: 3 },
    ];
    const p = (seat: string) => (seat === 's1' ? 0.8 : 0.1);
    const [believed, unbelieved, share, recentBelieved, recentShare] = secondOrderFeatures('s0', 's3', battles, 3, p);
    expect(believed).toBeCloseTo(Math.log1p(1 + 0.8 + 0.1));
    expect(unbelieved).toBeCloseTo(Math.log1p(0 + 0.2 + 0.9));
    expect(share).toBeCloseTo(1.9 / (1.9 + 1.1 + 1));
    expect(recentBelieved).toBeCloseTo(Math.log1p(0.1));
    expect(recentShare).toBeCloseTo(0.1 / 2);
  });
});
