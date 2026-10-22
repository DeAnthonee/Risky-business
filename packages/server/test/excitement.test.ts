import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, startGame, viewFor, type GameEvent } from '@risk/engine';
import { EXCITEMENT, excitementScore, pickFollow, type Excitement, type FollowCandidate, type TableView } from '../src/excitement.js';

const map = getMap('skirmish');
const ids = map.territoryIds;

/** A started 3-player skirmish game's spectator view, with the board then laid out by hand. */
function table(owners: (t: string, i: number) => [string, number], opts: { players?: number; capitals?: boolean } = {}): TableView {
  let s = createGame('X', { map: 'skirmish', autoSetup: true, maxPlayers: opts.players ?? 3, capitals: opts.capitals ?? false });
  for (let i = 0; i < (opts.players ?? 3); i++) s = addPlayer(s, `p${i}`, `P${i}`);
  const v = viewFor(startGame(s).state, null);
  for (const [i, t] of ids.entries()) {
    const [owner, armies] = owners(t, i);
    v.territories[t] = { owner, armies };
  }
  return v;
}

/** An even board: territories dealt round-robin, 3 armies each (a close race, nothing else). */
const even = (n = 3) => table((_, i) => [`p${i % n}`, 3], { players: n });
const kinds = (e: Excitement) => e.signals.map((s) => s.kind).sort();
const NOW = 1_000_000;
const battle = (lost: number): GameEvent => ({ type: 'battle', attacker: 'p0', defender: 'p1', from: ids[0], to: ids[1], attackerDice: [6], defenderDice: [1], attackerLosses: 0, defenderLosses: lost, fromArmies: 3, toArmies: 1 });

describe('excitementScore', () => {
  it('an even 3-player board is only a close race', () => {
    expect(kinds(excitementScore(even(), [], NOW))).toEqual(['closeRace']);
    expect(excitementScore(even(), [], NOW).score).toBe(EXCITEMENT.closeRace);
  });

  it('a finished or lobby game scores 0', () => {
    expect(excitementScore({ ...even(), phase: 'finished' }, [], NOW).score).toBe(0);
    expect(excitementScore({ ...even(), phase: 'lobby' }, [], NOW).score).toBe(0);
  });

  it('two players left: the endgame', () => {
    expect(kinds(excitementScore(even(2), [], NOW))).toEqual(['closeRace', 'endgame']);
  });

  it('an elimination in the last 20 s scores 40, fading to 0', () => {
    const e = (ago: number) => excitementScore(even(), [{ at: NOW - ago, events: [{ type: 'eliminated', player: 'p2', by: 'p0' }] }], NOW);
    expect(e(0).signals.find((s) => s.kind === 'elimination')!.points).toBe(40);
    expect(e(10_000).signals.find((s) => s.kind === 'elimination')!.points).toBe(20);
    expect(e(21_000).signals.some((s) => s.kind === 'elimination')).toBe(false);
  });

  it('a player about to be knocked out: 2 territories or fewer, facing a stack twice their size', () => {
    // p2 holds one territory with 2 armies; a neighbour of p0 holds 4.
    const lone = ids[0];
    const near = map.adjacency[lone][0];
    const v = table((t, i) => (t === lone ? ['p2', 2] : t === near ? ['p0', 4] : [`p${i % 2}`, 3]));
    expect(kinds(excitementScore(v, [], NOW))).toContain('knockout');
    // Same, but the neighbour is only 3: not yet.
    v.territories[near] = { owner: 'p0', armies: 3 };
    expect(kinds(excitementScore(v, [], NOW))).not.toContain('knockout');
  });

  it('a capital under threat, and one that just fell', () => {
    const cap = ids[0];
    const near = map.adjacency[cap][0];
    const v = table((t, i) => (t === cap ? ['p1', 3] : t === near ? ['p0', 6] : [`p${i % 3}`, 3]), { capitals: true });
    v.capitals = { p1: cap };
    expect(kinds(excitementScore(v, [], NOW))).toContain('capitalThreat');
    const fell = excitementScore(even(), [{ at: NOW - 5_000, events: [{ type: 'capital_captured', player: 'p0', territory: cap, previousOwner: 'p1' }] }], NOW);
    // Only counted in Capital Conquest games.
    expect(kinds(fell)).not.toContain('capitalFell');
    const capsOn = { ...even(), options: { ...even().options, capitals: true } };
    expect(kinds(excitementScore(capsOn, [{ at: NOW - 5_000, events: [{ type: 'capital_captured', player: 'p0', territory: cap, previousOwner: 'p1' }] }], NOW))).toContain('capitalFell');
    expect(kinds(excitementScore(capsOn, [{ at: NOW - 25_000, events: [{ type: 'capital_captured', player: 'p0', territory: cap, previousOwner: 'p1' }] }], NOW))).not.toContain('capitalFell');
  });

  it('heavy fighting: up to 20, scaled to the armies on the table, last 30 s only', () => {
    const v = even(); // 24 territories × 3 = 72 armies: a quarter (18) lost earns the full 20
    const f = (lost: number, ago = 1_000) => excitementScore(v, [{ at: NOW - ago, events: [battle(lost)] }], NOW).signals.find((s) => s.kind === 'fighting')?.points ?? 0;
    expect(f(9)).toBe(10);
    expect(f(18)).toBe(20);
    expect(f(60)).toBe(20);
    expect(f(18, 31_000)).toBe(0);
  });

  it('the final adds 20, and the score is clamped to 100', () => {
    expect(excitementScore(even(), [], NOW, { final: true }).score).toBe(EXCITEMENT.closeRace + EXCITEMENT.final);
    const cap = ids[0];
    const near = map.adjacency[cap][0];
    const hot = table((t, i) => (t === cap ? ['p1', 1] : t === near ? ['p0', 6] : [`p${i % 2}`, 3]), { players: 3, capitals: true });
    hot.capitals = { p1: cap };
    const events = [{ at: NOW, events: [{ type: 'eliminated', player: 'p2', by: 'p0' } as GameEvent, battle(40), { type: 'capital_captured', player: 'p0', territory: ids[5], previousOwner: 'p2' } as GameEvent] }];
    const e = excitementScore(hot, events, NOW, { final: true });
    expect(e.score).toBe(100);
    expect(e.signals[0].kind).toBe('elimination');
  });
});

const cand = (tableId: string, score: number, finished = false, label = 'a close race'): FollowCandidate => ({
  tableId,
  name: `Table ${tableId}`,
  finished,
  excitement: { score, signals: score ? [{ kind: 'closeRace', points: score, label }] : [] },
});

describe('pickFollow', () => {
  it('starts on the most exciting live table, with a caption saying why', () => {
    const p = pickFollow({ tableId: null, since: 0 }, [cand('1', 10), cand('2', 40, false, 'capital under threat'), cand('3', 90, true)], NOW);
    expect(p).toMatchObject({ tableId: '2', switched: true, caption: 'Following: Table 2 (capital under threat)', state: { tableId: '2', since: NOW } });
  });

  it('stays at least 20 s, then switches only for a table 15 or more ahead', () => {
    const on1 = { tableId: '1', since: NOW };
    expect(pickFollow(on1, [cand('1', 10), cand('2', 80)], NOW + 19_000).tableId).toBe('1');
    expect(pickFollow(on1, [cand('1', 10), cand('2', 24)], NOW + 25_000).tableId).toBe('1');
    const p = pickFollow(on1, [cand('1', 10), cand('2', 25)], NOW + 25_000);
    expect(p).toMatchObject({ tableId: '2', switched: true, state: { since: NOW + 25_000 } });
    // Staying keeps the original start time.
    expect(pickFollow(on1, [cand('1', 10), cand('2', 11)], NOW + 25_000).state).toBe(on1);
  });

  it('leaves a table at once when it ends', () => {
    const p = pickFollow({ tableId: '1', since: NOW }, [cand('1', 50, true), cand('2', 5)], NOW + 1_000);
    expect(p).toMatchObject({ tableId: '2', switched: true });
  });

  it('no live table: nothing to follow', () => {
    expect(pickFollow({ tableId: '1', since: NOW }, [cand('1', 50, true)], NOW)).toMatchObject({ tableId: null, caption: null, switched: true });
    expect(pickFollow({ tableId: null, since: NOW }, [], NOW)).toMatchObject({ tableId: null, switched: false });
  });

  it('a caption with no signal is just the table', () => {
    expect(pickFollow({ tableId: null, since: 0 }, [cand('7', 0)], NOW).caption).toBe('Following: Table 7');
  });
});
