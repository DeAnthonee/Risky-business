import { describe, expect, it } from 'vitest';
import { buildDeck, getMap, reinforcementsFor, type GameOptions, type GameState, type PlayerId } from '@risk/engine';
import { gameSeed, parseSplit, riskyBot, runBatch, SHARE_JITTER, splitPosition, startState, type Agent, type SplitPosition } from '../src/index.js';

const LEAGUE: Partial<GameOptions> = { autoSetup: true, balancedBlitz: true, chooseCapitals: true, cardValues: 'progressive' };
const as = (id: string): Agent => ({ id, choose: riskyBot.choose });

const owned = (s: GameState, id: PlayerId) => Object.entries(s.territories).filter(([, t]) => t.owner === id);

/** Connected pieces of a player's territory. */
function regions(s: GameState, id: PlayerId): number[] {
  const m = getMap(s.options.map);
  const mine = new Set(owned(s, id).map(([t]) => t));
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const t of mine) {
    if (seen.has(t)) continue;
    const q = [t];
    seen.add(t);
    for (let h = 0; h < q.length; h++) for (const u of m.adjacency[q[h]]) if (mine.has(u) && !seen.has(u)) (seen.add(u), q.push(u));
    sizes.push(q.length);
  }
  return sizes.sort((a, b) => b - a);
}

describe('ratio scenarios (scenario.ts)', () => {
  it('parses splits and refuses bad ones', () => {
    expect(parseSplit('60/40')).toEqual([60, 40]);
    expect(parseSplit('34/33/33')).toEqual([34, 33, 33]);
    for (const bad of ['100', '60/30', '97/3', '50/50.5', 'a/b']) expect(() => parseSplit(bad)).toThrow();
  });

  it('is the same position for the same seed, and another for another seed', () => {
    const a = splitPosition([60, 40], { ...LEAGUE, map: 'europe' }, 8, 42);
    expect(JSON.stringify(splitPosition([60, 40], { ...LEAGUE, map: 'europe' }, 8, 42))).toBe(JSON.stringify(a));
    expect(JSON.stringify(splitPosition([60, 40], { ...LEAGUE, map: 'europe' }, 8, 43))).not.toBe(JSON.stringify(a));
  });

  const cases: [number[], string, number, Partial<GameOptions>][] = [
    [[50, 50], 'classic', 6, {}],
    [[70, 30], 'world', 10, { capitals: true, cardValues: 'fixed' }],
    [[30, 70], 'world_large', 10, { blizzards: 8, cardValues: 'exponential' }],
    [[50, 25, 25], 'world', 6, { capitals: true, blizzards: 8 }],
    [[20, 40, 40], 'asia', 8, {}],
  ];
  for (const [shares, map, seats, extra] of cases) {
    it(`${shares.join('/')} on ${map} ${seats}p: a legal start of the mover's turn with the board split as asked`, () => {
      for (let g = 0; g < 8; g++) {
        const p: SplitPosition = splitPosition(shares, { ...LEAGUE, map, ...extra }, seats, gameSeed(7, g));
        const s = p.state;
        const m = getMap(map);
        const playable = m.territoryIds.filter((t) => !s.blizzards.includes(t));
        expect(p.alive).toBe(shares.length);
        expect(p.seats).toBe(seats);
        expect(s.players.filter((x) => x.isNeutral)).toEqual([]);
        expect(s.options.fogOfWar).toBe(false);
        // the turn: the holder of the first share is to move, at the start of its turn, with its reinforcements
        expect(s.phase).toBe('reinforce');
        expect(s.currentPlayer).toBe(`s${p.survivors[0]}`);
        expect(s.round).toBeGreaterThanOrEqual(2);
        expect(s.players.find((x) => x.id === s.currentPlayer)!.armiesToPlace).toBeGreaterThanOrEqual(3);
        // the fallen: out in order, each taken by a survivor, holding nothing
        expect(p.eliminated.length).toBe(seats - shares.length);
        for (const id of p.eliminated) {
          const x = s.players.find((y) => y.id === id)!;
          expect(x.alive).toBe(false);
          expect(x.cards).toEqual([]);
          expect(p.survivors.map((q) => `s${q}`)).toContain(x.eliminatedBy);
          expect(owned(s, id)).toEqual([]);
        }
        // the board: every playable territory held by a survivor with an army; shares near the split
        expect(playable.every((t) => s.territories[t].armies >= 1 && s.territories[t].owner !== null)).toBe(true);
        // armies count the mover's reinforcements as its own (the balance when its first attack comes)
        const tempo = reinforcementsFor(s, s.currentPlayer!).total;
        const total = playable.reduce((a, t) => a + s.territories[t].armies, 0) + tempo;
        shares.forEach((share, j) => {
          const id = `s${p.survivors[j]}`;
          expect(p.shares[p.survivors[j]]).toBe(share);
          const mine = owned(s, id);
          expect(Math.abs((100 * mine.length) / playable.length - share)).toBeLessThanOrEqual(SHARE_JITTER + 100 / playable.length + 0.5);
          const armies = mine.reduce((a, [, t]) => a + t.armies, 0) + (j === 0 ? tempo : 0);
          expect(Math.abs((100 * armies) / total - share)).toBeLessThanOrEqual(SHARE_JITTER + 4);
          // one region (rarely a second small one when another region closed the way)
          const r = regions(s, id);
          expect(r[0] / mine.length).toBeGreaterThanOrEqual(0.7);
        });
        // the cards: every card once, in a hand, the deck or the discard; trades shared out among the seats
        const cards = [...s.deck, ...s.discard, ...s.players.flatMap((x) => x.cards)].map((c) => c.id).sort((a, b) => a - b);
        expect(cards).toEqual(buildDeck(m).map((c) => c.id).sort((a, b) => a - b));
        expect(s.players.reduce((a, x) => a + (x.tradesMade ?? 0), 0)).toBe(s.tradeCount);
        if (extra.capitals) {
          expect(Object.keys(s.capitals).sort()).toEqual(s.players.map((x) => x.id).sort());
          for (const q of p.survivors) expect(s.territories[s.capitals[`s${q}`]].owner).toBe(`s${q}`);
        } else expect(s.capitals).toEqual({});
      }
    });
  }

  it('plays as a stage game from the first move, each stage agent taking every share in turn', async () => {
    const options = { ...LEAGUE, map: 'europe', maxPlayers: 8 };
    const agents = [as('big@1'), as('small@1')];
    const pos = new Map<number, SplitPosition>();
    const results = await runBatch({
      games: 6,
      seed: 3,
      seats: () => new Array(8).fill({ agent: agents[0] }),
      stage: { alive: 2, agents },
      start: (i, seed) => {
        const p = splitPosition([60, 40], options, 8, seed);
        pos.set(i, p);
        return { state: startState(p, seed, `g${i}`), eliminated: p.eliminated };
      },
      options,
    });
    for (const r of results) {
      const p = pos.get(r.index)!;
      expect(r.stage).toMatchObject({ alive: 2, turn: p.state.turnNumber });
      // stageSeats: the mover (share 60) gets agent (0 + i) % 2
      expect(r.stage!.agents[p.survivors[0]]).toBe(agents[r.index % 2].id);
      expect(r.stage!.agents[p.survivors[1]]).toBe(agents[(r.index + 1) % 2].id);
      expect(r.winner === null || p.survivors.includes(r.winner)).toBe(true);
    }
  });

  it('refuses tables it cannot make', () => {
    expect(() => splitPosition([60, 40], {}, 2, 1)).toThrow(/Neutral/);
    expect(() => splitPosition([50, 25, 25], {}, 2, 1)).toThrow(/at least 3 seats/);
    expect(() => splitPosition([25, 25, 25, 25], {}, 6, 1)).toThrow(/players left/);
  });
});
