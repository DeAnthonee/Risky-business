import { describe, expect, it } from 'vitest';
import { dealTagsOnly } from '../src/seat.js';

describe('pings-only chat: diplomat lines keep only their deal tags', () => {
  it('drops the spoken words around a deal, an answer or a coalition', () => {
    expect(dealTagsOnly('I stand with you against Jinx. Let us strike together. [deal Le1: joint_attack Leona+Shen vs Jinx commit 10 from round 3]'))
      .toBe('[deal Le1: joint_attack Leona+Shen vs Jinx commit 10 from round 3]');
    expect(dealTagsOnly('Alright, Thresh. Let us keep our borders peaceful. [accept T1]')).toBe('[accept T1]');
    expect(dealTagsOnly('Not this time. [reject T1] [deal T2: truce Thresh+Jinx until round 9]')).toBe('[reject T1] [deal T2: truce Thresh+Jinx until round 9]');
    expect(dealTagsOnly('Everyone, Darius is too big. [coalition ShC1: vs Darius until round 12]')).toBe('[coalition ShC1: vs Darius until round 12]');
    expect(dealTagsOnly('Count me in. [join ShC1]')).toBe('[join ShC1]');
    expect(dealTagsOnly('[decline ShC1]')).toBe('[decline ShC1]');
  });

  it('drops a line with no deal tag at all', () => {
    expect(dealTagsOnly('Nice move on Brazil, Shen.')).toBe('');
    expect(dealTagsOnly('I [definitely] mean it.')).toBe('');
    expect(dealTagsOnly('')).toBe('');
  });
});
