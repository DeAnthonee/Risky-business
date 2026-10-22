import { createHash } from 'node:crypto';
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
  strongestZergOf,
  ZERG_1_PARAMS,
  MAPS,
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
  /** Zerg-on-Zerg attacks made while some non-Zerg was still alive (the alliance phase). */
  let allyHits = 0;
  /** The strongest Zerg at the moment the last prey fell (it should keep the table). */
  let keeper: string | null = null;
  let steps = 0;
  while (s.phase !== 'finished' && steps++ < 40_000) {
    const me = s.currentPlayer!;
    const preyAlive = s.players.some((p) => p.alive && !p.isNeutral && !horde.has(p.id));
    const action = horde.has(me) ? chooseZergAction(s, me, horde, random)! : chooseBotAction(s, me, random)!;
    actions.push(action);
    const r = applyAction(s, me, action);
    s = r.state;
    events.push(...r.events);
    for (const e of r.events) if (preyAlive && e.type === 'attack' && horde.has(e.attacker) && horde.has(e.defender)) allyHits++;
    if (preyAlive && !s.players.some((p) => p.alive && !p.isNeutral && !horde.has(p.id))) keeper = strongestZergOf(s, horde);
  }
  return { state: s, events, actions, horde, allyHits, keeper };
}

describe('Zerg horde bot', () => {
  it('never attacks a fellow Zerg while any non-Zerg is alive, and every game ends', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { state, allyHits } = hordeGame(seed, ['a', 'z1', 'z2', 'b', 'z3']);
      expect(state.phase).toBe('finished');
      expect(allyHits).toBe(0);
    }
  });

  it('once the last non-Zerg falls the strongest Zerg keeps the table: the others surrender at once', () => {
    let surrendered = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const { state, events, horde, keeper } = hordeGame(seed, ['a', 'z1', 'z2', 'z3']);
      expect(state.phase).toBe('finished');
      const out = events.filter((e) => e.type === 'eliminated');
      const bot = out.findIndex((e) => e.type === 'eliminated' && e.player === 'a');
      expect(out[bot]).toMatchObject({ by: expect.stringMatching(/^z/) });
      // After the bot: every other Zerg goes out by surrender (by: null), never knocked out by a fellow Zerg.
      for (const e of out.slice(bot + 1)) {
        expect(e.type === 'eliminated' && e.by).toBeNull();
        surrendered++;
      }
      // The winner is the strongest Zerg when the bot fell (most territories, then armies, then seat).
      expect(state.winner).toBe(keeper);
      expect(horde.has(state.winner!)).toBe(true);
    }
    expect(surrendered).toBeGreaterThan(0);
  });

  it('strongest Zerg: most territories, then most armies, then the lowest seat index', () => {
    let s = createGame('k', { map: 'skirmish', maxPlayers: 3 }, 2);
    for (const id of ['z1', 'z2', 'z3']) s = addPlayer(s, id, id, true);
    s = startGame(s).state;
    const ids = Object.keys(s.territories);
    const set = (owner: string, n: number, armies: number) => ids.splice(0, n).forEach((t) => ((s.territories[t].owner = owner), (s.territories[t].armies = armies)));
    set('z1', 8, 1);
    set('z2', 8, 2);
    set('z3', ids.length, 1);
    const horde = new Set(['z1', 'z2', 'z3']);
    expect(territoriesOf(s, 'z3').length).toBe(8);
    expect(strongestZergOf(s, horde)).toBe('z2'); // tie on territories, most armies
    for (const t of territoriesOf(s, 'z2')) s.territories[t].armies = 1;
    expect(strongestZergOf(s, horde)).toBe('z1'); // full tie (8 territories, 8 armies each): the first seated
    s.territories[territoriesOf(s, 'z3')[0]].armies = 2;
    expect(strongestZergOf(s, horde)).toBe('z3'); // one more army breaks the tie
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

describe('Zerg judgement numbers', () => {
  it('zerg@1 plays exactly as recorded (later behaviours are off in ZERG_1_PARAMS)', () => {
    // Golden: 3 Capital Conquest games of the built-in bot against 3 zerg@1, recorded before the later terms existed.
    // Updated on purpose (2026-10-21) for the owner's rule that the alliance ends with the prey: the Zergs used to
    // surrender all but one once the bot was out (568 moves, 7eacf674a9c99eeb); now they fight each other to a winner
    // (762 moves). The alliance phase, every move while the bot is alive, was unchanged by that (543 moves,
    // b4ce79d26322fdb7). Updated again on purpose the same day: sacrifice is now 0 in zerg@1 (the owner's "no surrenders"
    // also rules out a walled-in Zerg surrendering mid-game), which changes the alliance phase too (520 moves).
    // Updated a third time on purpose: the owner replaced the fight with "the strongest Zerg keeps the table, the
    // others surrender at once", and turned the walled-in sacrifice back on. With the sacrifice on, the alliance phase
    // is back to the original recording (543 moves, b4ce79d26322fdb7); whole games run 554 moves. Updated a fourth time
    // on purpose (2026-10-22, urgent): the owner called the walled-in surrender a bug (6 of 8 Zergs surrendered in a live
    // 10-player game), so it is gone and walled-in Zergs mass toward the prey instead (alliance 520 moves).
    const out: unknown[] = [];
    const alliance: unknown[] = [];
    for (const seed of [1, 2, 3]) {
      let s = createGame('g', { map: 'classic', maxPlayers: 4, capitals: true }, seed);
      for (const id of ['a', 'z1', 'z2', 'z3']) s = addPlayer(s, id, id, true);
      s = startGame(s).state;
      const horde = new Set(['z1', 'z2', 'z3']);
      const random = seeded(seed);
      for (let i = 0; i < 3000 && s.phase !== 'finished'; i++) {
        const me = s.currentPlayer!;
        const preyAlive = s.players.some((p) => p.id === 'a' && p.alive);
        const a = horde.has(me) ? chooseZergAction(s, me, horde, random, ZERG_1_PARAMS)! : chooseBotAction(s, me, random)!;
        out.push(a);
        if (preyAlive) alliance.push(a);
        s = applyAction(s, me, a).state;
      }
    }
    const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
    expect(alliance.length).toBe(520);
    expect(hash(alliance)).toBe('a1fab7267260478f');
    expect(out.length).toBe(534);
    expect(hash(out)).toBe('2c0b78cfed7b1cb2');
  });

  it('no Zerg ever surrenders while prey is alive, even 8 Zergs at a 10-player table (the live bug)', () => {
    // The live game that showed the bug: 8 Zergs and 2 others on a 10-player board, where most Zergs are walled in by
    // their allies. The old walled-in sacrifice made them surrender mid-game; now they mass toward the prey instead.
    let surrenders = 0;
    for (const seed of [1, 2, 3, 4]) {
      const ids = ['a', 'b', ...Array.from({ length: 8 }, (_, i) => `z${i + 1}`)];
      let s = createGame('w', { map: 'world', maxPlayers: 10 }, seed);
      for (const id of ids) s = addPlayer(s, id, id, true);
      s = startGame(s).state;
      const horde = new Set(ids.filter((x) => x.startsWith('z')));
      const random = seeded(seed);
      for (let i = 0; i < 20_000 && s.phase !== 'finished'; i++) {
        const me = s.currentPlayer!;
        const preyAlive = s.players.some((p) => p.alive && !p.isNeutral && !horde.has(p.id));
        const a = horde.has(me) ? chooseZergAction(s, me, horde, random)! : chooseBotAction(s, me, random)!;
        if (a.type === 'surrender' && horde.has(me) && preyAlive) surrenders++;
        s = applyAction(s, me, a).state;
      }
      expect(s.phase).toBe('finished');
    }
    expect(surrenders).toBe(0);
  });

  it('each later behaviour changes play when switched on', () => {
    const game = (params: typeof ZERG_1_PARAMS) => {
      let s = createGame('b', { map: 'classic', maxPlayers: 4, capitals: true }, 2);
      for (const id of ['a', 'b', 'z1', 'z2']) s = addPlayer(s, id, id, true);
      s = startGame(s).state;
      const horde = new Set(['z1', 'z2']);
      const random = seeded(2);
      const out: unknown[] = [];
      for (let i = 0; i < 400 && s.phase !== 'finished'; i++) {
        const me = s.currentPlayer!;
        const a = horde.has(me) ? chooseZergAction(s, me, horde, random, params)! : chooseBotAction(s, me, random)!;
        out.push(a);
        s = applyAction(s, me, a).state;
      }
      return JSON.stringify(out);
    };
    const base = game(ZERG_1_PARAMS);
    for (const term of [{ strikeRatio: 4 }, { capitalBonus: 4 }, { wallWeight: 0.5 }]) {
      expect(game({ ...ZERG_1_PARAMS, ...term }), JSON.stringify(term)).not.toBe(base);
    }
  });

  it('card timing: a hoarding Zerg keeps a set while the target is big, and trades to finish it', () => {
    let s = createGame('c', { map: 'classic', maxPlayers: 3 }, 6);
    for (const id of ['a', 'z1', 'z2']) s = addPlayer(s, id, id, true);
    s = startGame(s).state;
    const horde = new Set(['z1', 'z2']);
    const random = seeded(6);
    // Play on to a Zerg's reinforce phase.
    for (let i = 0; i < 2000 && !(horde.has(s.currentPlayer!) && s.phase === 'reinforce'); i++) {
      const me = s.currentPlayer!;
      s = applyAction(s, me, horde.has(me) ? chooseZergAction(s, me, horde, random)! : chooseBotAction(s, me, random)!).state;
    }
    const me = s.currentPlayer!;
    s.players.find((p) => p.id === me)!.cards = [1, 2, 3].map((id) => ({ id: 900 + id, kind: 'infantry' as const, territory: null }));
    const hoard = { ...ZERG_1_PARAMS, cardHoard: 1, hoardFinish: 3 };
    expect(territoriesOf(s, 'a').length).toBeGreaterThan(3);
    expect(chooseZergAction(s, me, horde, seeded(1))!.type).toBe('trade');
    expect(chooseZergAction(s, me, horde, seeded(1), hoard)!.type).toBe('place');
    // With the target cut down to territories next to me, the hoard is spent to finish it.
    expect(chooseZergAction(s, me, horde, seeded(1), { ...hoard, hoardFinish: 99 })!.type).toBe(
      territoriesOf(s, 'a').some((t) => MAPS.classic.adjacency[t].some((n) => s.territories[n].owner === me)) ? 'trade' : 'place',
    );
  });

  it('a timid horde (attacks the target only at near-certain odds) attacks less', () => {
    const timid = { ...ZERG_1_PARAMS, targetOdds: 0.99, killOdds: 0.99, cardOdds: 0.99, extraOdds: 0.99 };
    let s = createGame('q', { map: 'classic', maxPlayers: 3 }, 8);
    for (const id of ['a', 'z1', 'z2']) s = addPlayer(s, id, id, true);
    s = startGame(s).state;
    const horde = new Set(['z1', 'z2']);
    const count = (params: typeof ZERG_1_PARAMS) => {
      let st = s;
      const random = seeded(9);
      let attacks = 0;
      for (let i = 0; i < 400 && st.phase !== 'finished'; i++) {
        const me = st.currentPlayer!;
        const a = horde.has(me) ? chooseZergAction(st, me, horde, random, params)! : chooseBotAction(st, me, random)!;
        if (a.type === 'attack' && horde.has(me)) attacks++;
        st = applyAction(st, me, a).state;
      }
      return attacks;
    };
    expect(count(timid)).toBeLessThan(count(ZERG_1_PARAMS));
  });
});
