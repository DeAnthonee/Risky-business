import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  chooseBotAction,
  chooseZergAction,
  createGame,
  createRng,
  nextFloat,
  startGame,
  territoriesOf,
  zergTarget,
  type GameEvent,
  type GameState,
} from '../src/index.js';

function seeded(seed: number) {
  const rng = createRng(seed);
  return () => nextFloat(rng);
}

/** One game: seat ids z* are the horde, the rest play the built-in bot. */
function hordeGame(seed: number, seats: string[], map: 'classic' | 'skirmish' = 'classic') {
  let s = createGame('z', { map, maxPlayers: seats.length }, seed);
  for (const id of seats) s = addPlayer(s, id, id, true);
  s = startGame(s).state;
  const horde = new Set(seats.filter((id) => id.startsWith('z')));
  const random = seeded(seed);
  const events: GameEvent[] = [];
  const actions: unknown[] = [];
  let steps = 0;
  while (s.phase !== 'finished' && steps++ < 40_000) {
    const me = s.currentPlayer!;
    const action = horde.has(me) ? chooseZergAction(s, me, horde, random)! : chooseBotAction(s, me, random)!;
    actions.push(action);
    const r = applyAction(s, me, action);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events, actions, horde };
}

describe('Zerg horde bot', () => {
  it('never attacks a fellow Zerg, and every game ends', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { state, events, horde } = hordeGame(seed, ['a', 'z1', 'z2', 'b', 'z3']);
      expect(state.phase).toBe('finished');
      for (const e of events) if (e.type === 'attack' && horde.has(e.attacker)) expect(horde.has(e.defender)).toBe(false);
    }
  });

  it('wipes out a lone built-in bot, then all but one Zerg step aside so the game ends', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { state, events, horde } = hordeGame(seed, ['a', 'z1', 'z2', 'z3']);
      expect(state.phase).toBe('finished');
      expect(horde.has(state.winner!)).toBe(true);
      // The bot was knocked out by a Zerg; the other Zergs surrendered (by nobody) or were never touched.
      const out = events.filter((e) => e.type === 'eliminated');
      expect(out.find((e) => e.type === 'eliminated' && e.player === 'a')).toMatchObject({ by: expect.stringMatching(/^z/) });
      for (const e of out) if (e.type === 'eliminated' && horde.has(e.player)) expect(e.by).toBeNull();
    }
  });

  it('plays the same moves for the same random source (self-play depends on it)', () => {
    expect(hordeGame(3, ['a', 'z1', 'z2']).actions).toEqual(hordeGame(3, ['a', 'z1', 'z2']).actions);
  });

  it('agrees on one target: the weakest, most exposed non-Zerg', () => {
    let s: GameState = createGame('t', { map: 'skirmish', maxPlayers: 4 }, 5);
    for (const id of ['a', 'b', 'z1', 'z2']) s = addPlayer(s, id, id, true);
    s = startGame(s).state;
    const horde = new Set(['z1', 'z2']);
    // Strip b down to one territory with one army: it is now the obvious victim.
    const bLand = territoriesOf(s, 'b');
    for (const t of bLand.slice(1)) s.territories[t].owner = 'a';
    s.territories[bLand[0]].armies = 1;
    expect(zergTarget(s, horde)).toBe('b');
    // The target never depends on which Zerg asks, and never names a Zerg.
    expect(zergTarget(s, new Set(['z2', 'z1']))).toBe('b');
  });
});
