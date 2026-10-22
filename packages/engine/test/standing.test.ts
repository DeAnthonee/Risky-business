import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, createRng, endByStanding, finalPlacements, nextFloat, onlySideLeft, rankByStanding, startGame, type GameState } from '../src/index.js';

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

describe('onlySideLeft', () => {
  it('true only in progress, not mid-conquest, with every living player on the side', () => {
    const s = board([['a', 20, 2], ['b', 22, 2]], ['c', 'd']);
    expect(onlySideLeft(s, new Set(['a', 'b']))).toBe(true);
    expect(onlySideLeft(s, new Set(['a']))).toBe(false); // b is alive and not on the side
    const t = Object.keys(s.territories)[0];
    expect(onlySideLeft({ ...s, pendingConquest: { from: t, to: t, minArmies: 1, maxArmies: 1 } }, new Set(['a', 'b']))).toBe(false);
    expect(onlySideLeft({ ...s, phase: 'finished' }, new Set(['a', 'b']))).toBe(false);
    expect(onlySideLeft({ ...s, players: s.players.map((p) => ({ ...p, alive: false })) }, new Set(['a', 'b']))).toBe(false);
  });

  it('endByStanding refuses a game in the middle of a conquest', () => {
    const s = board([['a', 20, 2], ['b', 22, 2]], ['c', 'd']);
    const t = Object.keys(s.territories)[0];
    expect(() => endByStanding({ ...s, pendingConquest: { from: t, to: t, minArmies: 1, maxArmies: 1 } }, new Set(['a', 'b']))).toThrow(/conquest/);
  });
});

describe('endByStanding (only one side left in a live game)', () => {
  it('ends the game as it stands: the strongest of the side wins, the board and the others are untouched', () => {
    // a and b are "the swarm" (with c out); b holds the most land.
    const s = board([['a', 8, 2], ['b', 20, 3], ['d', 14, 2]], ['c']);
    const side = new Set(['a', 'b', 'd']);
    const { state, events } = endByStanding(s, side, 123);
    expect(state).toMatchObject({ phase: 'finished', winner: 'b', currentPlayer: null, finishedAt: 123, version: s.version + 1 });
    expect(events).toEqual([{ type: 'game_over', winner: 'b' }]);
    expect(state.territories).toEqual(s.territories);
    expect(state.players.map((p) => p.alive)).toEqual(s.players.map((p) => p.alive));
    // The public board's places follow the standing: b, then d (14 territories), then a (8), then c (out).
    expect(finalPlacements(state, ['c']).map((p) => p.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('breaks ties like strongestZergOf: armies, then the lowest seat', () => {
    expect(endByStanding(board([['a', 14, 2], ['b', 14, 3], ['d', 14, 2]], ['c']), new Set(['a', 'b', 'd'])).state.winner).toBe('b');
    expect(endByStanding(board([['d', 14, 2], ['a', 14, 2], ['b', 14, 2]], ['c']), new Set(['a', 'b', 'd'])).state.winner).toBe('a');
  });

  it('only ends a game in progress, with someone of the side alive', () => {
    const s = board([['a', 21, 2], ['b', 21, 2]], ['c', 'd']);
    const done = endByStanding(s, new Set(['a', 'b'])).state;
    expect(() => endByStanding(done, new Set(['a', 'b']))).toThrow(/in progress/);
    expect(() => endByStanding(s, new Set(['c']))).toThrow(/Nobody/);
  });
});
