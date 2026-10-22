import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, createRng, nextFloat, rankByStanding, startGame, type GameState } from '../src/index.js';

function seeded(seed: number) {
  const rng = createRng(seed);
  return () => nextFloat(rng);
}

/** A started 4-player classic game whose board is then dealt by hand: `owners` gives [player, territories, armies each]. */
function board(owners: [string, number, number][], out: string[] = []): GameState {
  let s = createGame('st', { map: 'classic', maxPlayers: 4 }, 1);
  for (const id of ['a', 'b', 'c', 'd']) s = addPlayer(s, id, id.toUpperCase());
  s = startGame(s).state;
  s = structuredClone(s);
  const ids = Object.keys(s.territories);
  let at = 0;
  for (const [player, count, armies] of owners) {
    for (let k = 0; k < count; k++, at++) s.territories[ids[at]] = { ...s.territories[ids[at]], owner: player, armies };
  }
  // Whatever is left goes to the first player in the list, one army each, so every territory has an owner.
  for (; at < ids.length; at++) s.territories[ids[at]] = { ...s.territories[ids[at]], owner: owners[0][0], armies: 1 };
  for (const p of s.players) p.alive = !out.includes(p.id);
  return s;
}

/** A dice source that returns these faces (1-6) in order. */
function dice(...faces: number[]) {
  let i = 0;
  return () => (faces[i++] - 1) / 6;
}

describe('rankByStanding', () => {
  it('ranks by territories, then armies, with no dice when nobody ties', () => {
    // Classic has 42 territories: a 14, b 12, c 8 with 3 armies each, d 8 with 2.
    const s = board([['a', 14, 1], ['b', 12, 1], ['c', 8, 3], ['d', 8, 2]]);
    const r = rankByStanding(s, () => {
      throw new Error('no dice needed');
    });
    expect(r.order).toEqual(['a', 'b', 'c', 'd']);
    expect(r.rolls).toEqual({});
  });

  it('breaks a full tie with dice, and re-rolls only the players still tied', () => {
    // b, c and d all hold 10 territories with 2 armies each.
    const s = board([['a', 12, 1], ['b', 10, 2], ['c', 10, 2], ['d', 10, 2]]);
    // b, c and d roll 4, 6 and 4 (in turn order); b and d roll again: 2 then 5.
    const order = s.turnOrder.filter((id) => id !== 'a');
    const faces: Record<string, number[]> = { [order[0]]: [4, 2], [order[1]]: [6], [order[2]]: [4, 5] };
    const r = rankByStanding(s, dice(4, 6, 4, 2, 5));
    expect(r.order).toEqual(['a', order[1], order[2], order[0]]);
    expect(r.rolls).toEqual(faces);
  });

  it('puts players already out after the living, the last one out first', () => {
    const s = board([['a', 20, 2], ['b', 22, 1]], ['c', 'd']);
    const r = rankByStanding(s, Math.random, ['d', 'c']);
    expect(r.order).toEqual(['b', 'a', 'c', 'd']);
  });

  it('is deterministic under a seed and never ranks a neutral', () => {
    const s = board([['a', 10, 2], ['b', 10, 2], ['c', 11, 1], ['d', 11, 1]]);
    s.players.push({ ...s.players[0], id: 'neutral', name: 'Neutral', isNeutral: true });
    const one = rankByStanding(s, seeded(9));
    const two = rankByStanding(s, seeded(9));
    expect(one).toEqual(two);
    expect(one.order).toHaveLength(4);
    expect(one.order).not.toContain('neutral');
    expect(new Set(one.order)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});
