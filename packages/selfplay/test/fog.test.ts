import { describe, expect, it } from 'vitest';
import { getMap, viewFor, type GameOptions, type GameState } from '@risk/engine';
import {
  decisionInput,
  encodeDecision,
  FOG_GLOBAL_FEATURES,
  FOG_TERRITORY_FEATURES,
  fogInputs,
  GLOBAL_FEATURES,
  hiddenMask,
  makeTraits,
  playGame,
  randomAgent,
  riskyBot,
  runBatch,
  seatInput,
  stateFromView,
  seededRandom,
  TERRITORY_FEATURES,
  type Agent,
} from '../src/index.js';

const TF = TERRITORY_FEATURES.length;
const GF = GLOBAL_FEATURES.length;

/** Every state a decision was made in (by any seat), with who decided, for one Risky-bot game. */
function decisions(players: number, options: Partial<GameOptions>, seed = 5): { state: GameState; me: string }[] {
  const out: { state: GameState; me: string }[] = [];
  const spy: Agent = { id: 'risky@1', choose: (ctx) => (out.push({ state: ctx.state, me: ctx.me }), riskyBot.choose(ctx)) };
  playGame({ seed, seats: Array.from({ length: players }, () => ({ agent: spy })), options, maxTurns: 120 });
  return out;
}

const seatsOf = (s: GameState) => s.players.filter((p) => !p.isNeutral).map((p) => p.id);
const encode = (s: GameState, me: string, input = decisionInput) => encodeDecision(input(s, seatsOf(s), me, makeTraits(), []));

describe('fog inputs (fog.ts)', () => {
  it('on a normal game: the full-board features unchanged, the fog columns 0', () => {
    for (const { state, me } of decisions(4, {}).filter((_, i) => i % 40 === 0)) {
      const f = encode(state, me);
      const x = fogInputs(f, state.options.map, false);
      const T = f.territories;
      for (let i = 0; i < T; i++) {
        expect(Array.from(x.territory.subarray(i * (TF + 1), i * (TF + 1) + TF))).toEqual(Array.from(f.territory.subarray(i * TF, (i + 1) * TF)));
        expect(x.territory[i * (TF + 1) + TF]).toBe(0);
      }
      expect(Array.from(x.global.subarray(0, GF))).toEqual(Array.from(f.global));
      expect(x.global[GF]).toBe(0);
    }
    expect(FOG_TERRITORY_FEATURES.length + FOG_GLOBAL_FEATURES.length).toBe(2);
  });

  it('a seat view with nothing hidden is the full board (the recomputed features agree with encode.ts)', () => {
    // early in a 2-player Four Crowns game most of the board touches each seat; pick moments with nothing hidden
    let checked = 0;
    for (const { state, me } of decisions(2, { map: 'skirmish' })) {
      const f = encode(state, me);
      if (hiddenMask(f, state.options.map).some((h) => h)) continue;
      const a = fogInputs(f, state.options.map, true);
      const b = fogInputs(f, state.options.map, false);
      expect(Array.from(a.territory)).toEqual(Array.from(b.territory));
      expect(Array.from(a.global)).toEqual(Array.from(b.global));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each([
    ['world 6p', 6, { map: 'world', fogOfWar: true }],
    ['classic 4p capitals', 4, { fogOfWar: true, capitals: true, chooseCapitals: true }],
    ['skirmish 3p blizzards, neutrals', 3, { map: 'skirmish', fogOfWar: true, blizzards: 2, neutrals: 2 }],
    ['classic 2p (the Neutral)', 2, { fogOfWar: true }],
  ] as const)('in a fog game the seat view reads nothing hidden: true board and the seat view give the same inputs (%s)', (_n, players, options) => {
    let hiddenSeen = 0;
    const all = decisions(players, options);
    for (const { state, me } of all.filter((_, i) => i % 7 === 0)) {
      const view = stateFromView(viewFor(state, me), seededRandom(3));
      const truth = fogInputs(encode(state, me), state.options.map, true);
      const seen = fogInputs(encode(view, me, seatInput), state.options.map, true);
      expect(Array.from(seen.territory)).toEqual(Array.from(truth.territory));
      expect(Array.from(seen.global)).toEqual(Array.from(truth.global));
      if (truth.global[GF] > 0) hiddenSeen++;
    }
    expect(hiddenSeen).toBeGreaterThan(0);
  });

  it('hidden territories carry no owner, armies or enemy capital', () => {
    for (const { state, me } of decisions(6, { map: 'world', fogOfWar: true, capitals: true }).filter((_, i) => i % 25 === 0)) {
      const f = encode(state, me);
      const hidden = hiddenMask(f, state.options.map);
      const x = fogInputs(f, state.options.map, true);
      const map = getMap(state.options.map);
      map.territoryIds.forEach((t, i) => {
        const row = x.territory.subarray(i * (TF + 1), (i + 1) * (TF + 1));
        expect(row[TF]).toBe(hidden[i]);
        if (!hidden[i]) return;
        expect(state.territories[t].owner).not.toBe(me);
        for (const name of ['owner_neutral', 'owner_none', 'armies_log', 'armies_lin', 'my_capital', 'enemy_capital', 'border', 'enemy_adjacent_log', 'own_adjacent_log'] as const)
          expect(row[TERRITORY_FEATURES.indexOf(name)]).toBe(0);
        for (let k = 0; k < 10; k++) expect(row[k]).toBe(0);
      });
    }
  });
});

describe('fog games in self-play: no seat sees through the fog (foggedAgent in runBatch)', () => {
  it('every agent of a fog game decides on its seat view: no hidden territory, no opponent hand', async () => {
    let checked = 0;
    const watcher: Agent = {
      id: 'watch@1',
      choose: (ctx) => {
        // the state an agent gets is its seat's view: hidden territories blank, its own hand only (the engine's state
        // never marks a territory hidden, so a hidden one proves the agent is not handed the true state)
        for (const ts of Object.values(ctx.state.territories)) if (ts.hidden) expect([ts.owner, ts.armies]).toEqual([null, 0]);
        expect(ctx.state.deck.length + ctx.state.discard.length + ctx.state.players.reduce((n, p) => n + p.cards.length, 0)).toBe(getMap(ctx.state.options.map).territoryIds.length + 2);
        const hidden = Object.values(ctx.state.territories).filter((t) => t.hidden).length;
        if (hidden) checked++;
        return randomAgent.choose(ctx); // picks from ctx.candidates (risky@1 works out its own legal moves)
      },
    };
    await runBatch({ games: 2, seed: 9, seats: () => Array.from({ length: 4 }, () => ({ agent: watcher })), options: { map: 'world', fogOfWar: true }, maxTurns: 60 });
    expect(checked).toBeGreaterThan(50);
  });

  it('a normal game is unchanged by the wrapper', async () => {
    const seats = () => [{ agent: riskyBot }, { agent: riskyBot }, { agent: riskyBot }];
    const a = await runBatch({ games: 2, seed: 4, seats });
    const b = [0, 1].map((i) => playGame({ id: `g${i}`, seed: a[i].seed, seats: seats() }));
    expect(a.map((r) => [r.winner, r.turns, r.steps])).toEqual(b.map((r) => [r.winner, r.turns, r.steps]));
  });
});
