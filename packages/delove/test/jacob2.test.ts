import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, legalMoves, startGame, type GameState } from '@risk/engine';
import { candidates, makeTraits, playGame, runMatch, seededRandom } from '@risk/selfplay';
import {
  jacob,
  jacob2,
  JACOB_2_ID,
  JACOB_SENSEI_1_PARAMS,
  JACOB_SENSEI_2_DUEL_PARAMS,
  JACOB_SENSEI_2_PARAMS,
  jacobPickWith,
  makeJacob,
  type JacobParams,
} from '../src/index.js';

/** Hash of every recorded choice of jacob-sensei@1 self-play games: locks @1's play while @2's terms are added. */
function jacob1Hash(): string {
  const h = createHash('sha256');
  for (const [seed, options, seats] of [
    [1, {}, 2],
    [2, { capitals: true }, 3],
    [3, { map: 'world' as const }, 6],
    [4, { cardValues: 'fixed' as const, balancedBlitz: true, blizzards: 4 }, 4],
  ] as const) {
    const g = playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent: jacob })), options, record: true });
    for (const r of g.records!) h.update(`${r.choice},`);
  }
  return h.digest('hex');
}

/**
 * Classic, 3 players, s0 to attack: s0 holds Alaska with 2 armies, s1 only the Northwest Territory with 1 army and 3
 * cards, s2 everything else with 3 armies. 2 against 1 wins 41.7%: under jacob-sensei@1's least win chance, but s1
 * is killable.
 */
function twoVsOne(): GameState {
  let s = createGame('t', { maxPlayers: 3 }, 5);
  for (const id of ['s0', 's1', 's2']) s = addPlayer(s, id, id, true);
  s = structuredClone(startGame(s).state);
  for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 's2', armies: 3 };
  s.territories.alaska = { owner: 's0', armies: 2 };
  s.territories.northwest_territory = { owner: 's1', armies: 1 };
  for (const p of s.players) (p.cards = []), (p.armiesToPlace = 0);
  s.players.find((p) => p.id === 's1')!.cards = s.deck.splice(0, 3);
  s.phase = 'attack';
  s.currentPlayer = 's0';
  s.players.find((p) => p.id === 's0')!.conqueredThisTurn = true;
  return s;
}

function pick(params: JacobParams, state: GameState) {
  const legal = legalMoves(state, 's0');
  const cands = candidates(state, 's0', legal);
  const i = jacobPickWith(params)({ state, me: 's0', seat: 0, legal, candidates: cands, traits: makeTraits(), random: seededRandom(1), fortifyFrom: null });
  return cands[i];
}

describe('jacob-sensei@2', () => {
  it('leaves jacob-sensei@1 playing exactly as before', () => {
    expect(jacob1Hash()).toBe('a687d99e7f2ab45fb378fa8dd23e6355a4360b648d958170e8b7192eb42dc6b9');
  });

  it('turns every new term off in jacob-sensei@1 and on in jacob-sensei@2', () => {
    const keys = ['killWin', 'killPath', 'killCarry', 'leaderPunch', 'borderDelta', 'dormantWake', 'holdEv', 'cardTight', 'duelDeny', 'duelEv', 'capitalPad'] as const;
    for (const k of keys) {
      expect(JACOB_SENSEI_1_PARAMS[k]).toBe(0);
      expect(JACOB_SENSEI_2_PARAMS[k]).toBeGreaterThan(0);
    }
  });

  it('takes the 2v1 kill that jacob-sensei@1 passes on', () => {
    const map = getMap('classic');
    const nwt = map.territoryIds.indexOf('northwest_territory');
    expect(pick(JACOB_SENSEI_1_PARAMS, twoVsOne())[0]).not.toBe('attack');
    const c = pick(JACOB_SENSEI_2_PARAMS, twoVsOne());
    expect(c[0]).toBe('attack');
    expect(c[2]).toBe(nwt);
  });

  it('plays whole games legally and only from the candidate list', () => {
    for (const [seed, options, seats] of [
      [1, {}, 2],
      [2, { capitals: true }, 3],
      [3, { map: 'world' as const }, 6],
      [4, { cardValues: 'fixed' as const, balancedBlitz: true, blizzards: 4 }, 4],
      [5, { map: 'greater_europe' as const, capitals: true, chooseCapitals: true }, 10],
      [6, { map: 'nine_realms' as const, cardValues: 'exponential' as const }, 8],
    ] as const) {
      const g = playGame({ seed, seats: Array.from({ length: seats }, (_, i) => ({ agent: i % 2 ? jacob : jacob2 })), options, onIllegal: 'throw' });
      expect(g.illegal.every((n) => n === 0)).toBe(true);
      expect(g.offList.every((n) => n === 0)).toBe(true);
    }
  });

  it('is deterministic from the seed and finishes big self-play tables', () => {
    const a = playGame({ seed: 7, seats: [{ agent: jacob2 }, { agent: jacob2 }, { agent: jacob2 }], record: true });
    const b = playGame({ seed: 7, seats: [{ agent: jacob2 }, { agent: jacob2 }, { agent: jacob2 }], record: true });
    expect(a.records!.map((r) => r.choice)).toEqual(b.records!.map((r) => r.choice));
    for (const [seed, map, seats] of [
      [11, 'world', 6],
      [12, 'greater_europe', 10],
    ] as const) {
      expect(playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent: jacob2 })), options: { map } }).winner).not.toBeNull();
    }
  });

  it('plays its duel numbers once one rival is left, its main numbers before', () => {
    const choices = (agent: typeof jacob, seats: number, seed: number) =>
      playGame({ seed, seats: Array.from({ length: seats }, () => ({ agent })), record: true }).records!.map((r) => r.choice);
    // A 2-player game is a duel from the start (the Neutral does not count).
    expect(choices(jacob2, 2, 21)).toEqual(choices(makeJacob('duel@1', JACOB_SENSEI_2_DUEL_PARAMS), 2, 21));
    // At a 4-player table the main numbers play until only two players are left.
    const staged = choices(jacob2, 4, 22);
    const main = choices(makeJacob('main@1', JACOB_SENSEI_2_PARAMS), 4, 22);
    const diverge = staged.findIndex((c, i) => c !== main[i]);
    expect(diverge === -1 || diverge > 50).toBe(true);
    expect(staged).not.toEqual(main);
  });

  it('is not behind jacob-sensei@1 at a 6-player table', async () => {
    const r = await runMatch({ candidate: jacob2, best: jacob, games: 40, seed: 3, players: 6, options: { map: 'world' } });
    expect(r.candidate).toBe(JACOB_2_ID);
    expect(r.pointsDiff).toBeGreaterThan(0);
  });
});
