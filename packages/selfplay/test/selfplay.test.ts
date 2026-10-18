import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { applyAction, getMap, legalMoves, type GameOptions, type GameState } from '@risk/engine';
import {
  candidateScore,
  candidates,
  actionSteps,
  actionToCandidate,
  CANDIDATE_KINDS,
  candidateToAction,
  eloFromScore,
  emptyLadder,
  gameSeed,
  loadLadder,
  makeTraits,
  matchSeats,
  playGame,
  promotionDecision,
  randomAgent,
  recordMatch,
  riskyBot,
  runBatch,
  runMatch,
  saveLadder,
  stepAgent,
  summarizeMatch,
  TRAIT_KEYS,
  type Agent,
  type DecisionRecord,
} from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'risk-selfplay-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const risky2 = [{ agent: riskyBot }, { agent: riskyBot }];

/** Every state a Risky bot decided in, for one game of a config (played once, shared by the tests). */
const stateCache = new Map<string, GameState[]>();
function statesOf({ name, players, options }: (typeof CONFIGS)[number]): GameState[] {
  let states = stateCache.get(name);
  if (!states) {
    const seen: GameState[] = [];
    const spy: Agent = { id: 'risky@1', choose: (ctx) => (seen.push(ctx.state), riskyBot.choose(ctx)) };
    playGame({ seed: 11, seats: Array.from({ length: players }, () => ({ agent: spy })), options });
    stateCache.set(name, (states = seen));
  }
  return states;
}

/** Rules variety so every candidate kind (setup claims, capitals, trades, occupy, fortify) shows up. */
const CONFIGS: { name: string; players: number; options: Partial<GameOptions> }[] = [
  { name: 'classic 2p', players: 2, options: {} },
  { name: 'classic 4p claim + chosen capitals', players: 4, options: { randomDeal: false, capitals: true, chooseCapitals: true } },
  { name: 'skirmish 3p adjacent fortify, fixed cards, blizzards', players: 3, options: { map: 'skirmish', fortifyMode: 'adjacent', cardValues: 'fixed', blizzards: 2 } },
  { name: 'world 5p auto setup, neutrals', players: 5, options: { map: 'world', autoSetup: true, neutrals: 6 } },
];

describe('playGame', () => {
  it('replays exactly from a seed', () => {
    const a = playGame({ seed: 42, seats: risky2, record: true });
    const b = playGame({ seed: 42, seats: risky2, record: true });
    expect(b).toEqual(a);
    const c = playGame({ seed: 43, seats: risky2, record: true });
    expect(c.records).not.toEqual(a.records);
  });

  it.each(CONFIGS)('Risky bots finish a game and every bot move is on the candidate list ($name)', ({ players, options }) => {
    const r = playGame({ seed: 7, seats: Array.from({ length: players }, () => ({ agent: riskyBot })), options });
    expect(r.winner).not.toBeNull();
    expect(r.reason).not.toBe('turn_limit');
    expect(r.territories[r.winner!]).toBeGreaterThan(0);
    expect(r.offList).toEqual(new Array(players).fill(0));
    expect(r.illegal).toEqual(new Array(players).fill(0));
    expect([...r.turnOrder].sort()).toEqual(Array.from({ length: players }, (_, i) => i));
  });

  it.each(CONFIGS)('every candidate is a legal action, fortify_to steps included ($name)', (cfg) => {
    // Try candidates of every 7th decision (about 60 per game at most) of a recorded game against the engine (at most 40 per list, spread over it;
    // the fortify_to lists of two sources per decision).
    const states = statesOf(cfg);
    const map = getMap(states[0].options.map);
    let tried = 0;
    const sample = <T,>(xs: T[]) => xs.filter((_, j) => j % Math.max(1, Math.floor(xs.length / 40)) === 0);
    const stride = Math.max(7, Math.floor(states.length / 60));
    for (let i = 0; i < states.length; i += stride) {
      const s = states[i];
      const me = s.currentPlayer!;
      const lm = legalMoves(s, me);
      const cands = candidates(s, me, lm);
      expect(cands.length).toBeGreaterThan(0);
      let expanded = 0;
      for (const c of sample(cands)) {
        tried++;
        if (c[0] !== 'fortify_from') {
          expect(() => applyAction(s, me, candidateToAction(map, c)), JSON.stringify(c)).not.toThrow();
          continue;
        }
        if (expanded++ >= 2) continue; // two sources per decision are enough to check the second step
        const second = candidates(s, me, lm, map.territoryIds[c[1]]);
        expect(second.length).toBeGreaterThan(0);
        for (const c2 of sample(second)) expect(() => applyAction(s, me, candidateToAction(map, c2, c[1])), JSON.stringify(c2)).not.toThrow();
      }
    }
    expect(tried).toBeGreaterThan(100);
  });

  it('the configs above offer every candidate kind (except the v1-only fortify)', () => {
    const seen = new Set<string>();
    for (const cfg of CONFIGS) {
      for (const s of statesOf(cfg)) {
        const lm = legalMoves(s, s.currentPlayer!);
        for (const c of candidates(s, s.currentPlayer!, lm)) {
          seen.add(c[0]);
          if (c[0] === 'fortify_from' && !seen.has('fortify_to')) candidates(s, s.currentPlayer!, lm, getMap(s.options.map).territoryIds[c[1]]).forEach((x) => seen.add(x[0]));
        }
      }
    }
    expect([...seen].sort()).toEqual([...CANDIDATE_KINDS].filter((k) => k !== 'fortify').sort());
  });

  it('records each decision with its state, candidates, choice and final outcome', () => {
    const r = playGame({ seed: 5, seats: [{ agent: riskyBot, traits: { aggression: 0.9 } }, { agent: riskyBot }], record: true });
    const recs = r.records!;
    expect(recs.length).toBe(r.steps);
    // A fortify is two steps on the same board: fortify_from, then fortify_to carrying the chosen source.
    const fortifies = recs.filter((x) => x.state.fortifyFrom >= 0);
    expect(fortifies.length).toBeGreaterThan(0);
    expect(r.steps).toBe(r.decisions + fortifies.length);
    for (const second of fortifies) {
      const first = recs[second.i - 1];
      expect(first.cands[first.choice]).toEqual(['fortify_from', second.state.fortifyFrom]);
      expect(second.cands.every((c) => c[0] === 'fortify_to')).toBe(true);
      expect(second.state.armies).toEqual(first.state.armies);
    }
    const t = getMap('classic').territoryIds.length;
    recs.forEach((rec: DecisionRecord, i) => {
      expect(rec.i).toBe(i);
      expect(rec.state.owner).toHaveLength(t);
      expect(rec.state.armies).toHaveLength(t);
      expect(rec.state.seats).toHaveLength(2);
      expect([...rec.state.order].sort()).toEqual([0, 1]);
      expect(rec.rules).toEqual([0, 0, 0, 0, 0, 0]);
      expect(rec.choice).toBeGreaterThanOrEqual(0);
      expect(rec.choice).toBeLessThan(rec.cands.length);
      expect(rec.traits).toHaveLength(TRAIT_KEYS.length);
      expect(rec.outcome).toEqual({ winner: r.winner, z: rec.seat === r.winner ? 1 : 0, turns: r.turns, reason: r.reason });
    });
    expect(recs.find((x) => x.seat === 0)!.traits[TRAIT_KEYS.indexOf('aggression')]).toBe(0.9);
    // The neutral (2-player games) is coded -2 and owns territories from the start.
    expect(recs[0].state.owner).toContain(-2);
    expect(recs.some((x) => x.state.pending !== null && x.cands.every((c) => c[0] === 'occupy'))).toBe(true);
  });

  it('calls it a draw at the turn limit and survivors share the result', () => {
    const r = playGame({ seed: 3, seats: [{ agent: randomAgent }, { agent: randomAgent }], maxTurns: 6, record: true });
    expect(r.winner).toBeNull();
    expect(r.reason).toBe('turn_limit');
    expect(r.turns).toBe(6);
    expect(new Set(r.records!.map((x) => x.outcome.z))).toEqual(new Set([0.5]));
  });

  it('rejects illegal actions, or surrenders the seat when asked to', () => {
    const cheat: Agent = { id: 'cheat@1', choose: () => ({ type: 'fortify', from: 'alaska', to: 'argentina', armies: 99 }) };
    expect(() => playGame({ seed: 1, seats: [{ agent: cheat }, { agent: riskyBot }] })).toThrow(/cheat@1 \(seat 0\) played an illegal action/);
    const r = playGame({ seed: 1, seats: [{ agent: cheat }, { agent: riskyBot }], onIllegal: 'surrender' });
    expect(r.illegal[0]).toBe(1);
    expect(r.winner).toBe(1);
  });

  it('validates traits', () => {
    expect(makeTraits({ caution: 0.2 }).caution).toBe(0.2);
    expect(makeTraits().aggression).toBe(0.5);
    expect(() => makeTraits({ aggression: 2 })).toThrow(/\[0, 1\]/);
    expect(() => makeTraits({ bravado: 1 } as never)).toThrow(/Unknown trait/);
  });
});

describe('runBatch and decision logs', () => {
  it('writes meta, a gzipped decision shard and game summaries', async () => {
    const dir = join(tmp, 'log');
    const results = await runBatch({ games: 3, seed: 9, seats: () => risky2, logDir: dir });
    expect(readdirSync(dir).sort()).toEqual(['decisions-0-2.jsonl.gz', 'games-0-2.jsonl', 'meta.json']);
    const lines = gunzipSync(readFileSync(join(dir, 'decisions-0-2.jsonl.gz'))).toString().trim().split('\n');
    expect(lines.length).toBe(results.reduce((a, r) => a + r.steps, 0));
    const first = JSON.parse(lines[0]) as DecisionRecord;
    expect(first).toMatchObject({ v: 2, game: 'g0', seed: gameSeed(9, 0), map: 'classic', players: 2, i: 0 });
    const games = readFileSync(join(dir, 'games-0-2.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(games.map((g) => g.index)).toEqual([0, 1, 2]);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    expect(meta.traitKeys).toEqual([...TRAIT_KEYS]);
    expect(meta.maps.classic.territoryIds).toEqual(getMap('classic').territoryIds);
    expect(meta.maps.classic.adjacency[0]).toEqual(getMap('classic').adjacency[getMap('classic').territoryIds[0]].map((t) => getMap('classic').territoryIds.indexOf(t)));
  });

  it('plays the same games whether one process runs them or several slices do', async () => {
    const strip = (rs: { ms: number }[]) => rs.map(({ ms: _ms, ...r }) => r);
    const whole = await runBatch({ games: 4, seed: 21, seats: () => risky2 });
    const a = await runBatch({ games: 2, seed: 21, seats: () => risky2 });
    const b = await runBatch({ games: 2, startIndex: 2, seed: 21, seats: () => risky2 });
    expect(strip([...a, ...b])).toEqual(strip(whole));
  });
});

describe('ladder', () => {
  it('seats the two versions alternately and flips them in the mirrored game', () => {
    expect(matchSeats(0, 3, riskyBot, randomAgent).map((s) => s.agent.id)).toEqual(['risky@1', 'random@1', 'risky@1']);
    expect(matchSeats(1, 3, riskyBot, randomAgent).map((s) => s.agent.id)).toEqual(['random@1', 'risky@1', 'random@1']);
    expect([candidateScore(0, 0), candidateScore(1, 0), candidateScore(1, 1), candidateScore(null, 1)]).toEqual([1, 0, 1, 0.5]);
  });

  it('turns scores into Elo and intervals', () => {
    expect(eloFromScore(0.5)).toBe(0);
    expect(Math.round(eloFromScore(0.64))).toBe(100);
    expect(eloFromScore(1)).toBe(800);
    const m = summarizeMatch('a', 'b', [1, 1, 0, 0.5], [10, 20, 30, 40], 1);
    expect(m).toMatchObject({ games: 4, wins: 2, losses: 1, draws: 1, score: 0.625, turnLimit: 1, meanTurns: 25 });
    expect(m.scoreLow).toBeLessThan(0.625);
    expect(m.scoreHigh).toBeGreaterThan(0.625);
  });

  it('computes the interval over mirrored pairs, which are correlated', () => {
    // Pairs that agree (both games won or both lost): the pair is one piece of evidence, not two.
    const agreeing = Array.from({ length: 100 }, (_, i) => (Math.floor(i / 2) % 5 < 3 ? 1 : 0));
    const single = summarizeMatch('c', 'b', agreeing, [], 0, 1);
    const paired = summarizeMatch('c', 'b', agreeing, [], 0, 2);
    expect(paired.score).toBe(single.score);
    expect(paired.scoreHigh - paired.scoreLow).toBeGreaterThan(single.scoreHigh - single.scoreLow);
    // Pairs that split (each side wins once): nothing to tell apart, and the interval stays honest.
    const split = summarizeMatch('c', 'b', Array.from({ length: 40 }, (_, i) => i % 2), [], 0, 2);
    expect(split.score).toBe(0.5);
    expect(split.scoreLow).toBeLessThan(0.5);
  });

  it('promotes only past the minimum games, the threshold and a clear interval', () => {
    const at = (score: number, games: number) => summarizeMatch('c', 'b', Array.from({ length: games }, (_, i) => (i < score * games ? 1 : 0)), [], 0);
    expect(promotionDecision(at(0.9, 100)).promote).toBe(false); // too few games
    expect(promotionDecision(at(0.52, 200)).promote).toBe(false); // below threshold
    expect(promotionDecision(at(0.6, 200)).promote).toBe(true);
    expect(promotionDecision(at(0.56, 40), { minGames: 40, threshold: 0.55 }).promote).toBe(false); // interval reaches 0.5
  });

  it('a clearly stronger version wins the match; a version against itself scores exactly 0.5', async () => {
    const m = await runMatch({ candidate: riskyBot, best: randomAgent, games: 12, seed: 1 });
    expect(m.games).toBe(12);
    expect(m.score).toBeGreaterThan(0.9);
    expect(promotionDecision(m, { minGames: 12, threshold: 0.55 }).promote).toBe(true);
    const mirror = await runMatch({ candidate: riskyBot, best: riskyBot, games: 4, seed: 1 });
    expect(mirror.score).toBe(0.5);
  });

  it('rates candidates against the best and promotes winners in the ladder file', () => {
    const path = join(tmp, 'ladder', 'ladder.json');
    const r = summarizeMatch('net@2', 'risky@1', Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 0 : 1)), [], 0);
    let ladder = recordMatch(emptyLadder(), r, promotionDecision(r), new Date(0));
    expect(ladder.best).toBe('net@2');
    expect(ladder.ratings['risky@1']).toEqual({ elo: 1000, games: 200 });
    expect(ladder.ratings['net@2'].elo).toBe(1000 + r.elo);
    saveLadder(path, ladder);
    ladder = loadLadder(path);
    expect(ladder.history).toHaveLength(1);
    expect(ladder.history[0]).toMatchObject({ candidate: 'net@2', promoted: true, at: '1970-01-01T00:00:00.000Z' });
    expect(() => recordMatch(ladder, r, promotionDecision(r))).toThrow(/ladder's best is net@2/);
  });
});

describe('agents', () => {
  it('a blitz with stopAt is not the plain blitz candidate', () => {
    const map = getMap('classic');
    expect(actionToCandidate(map, { type: 'attack', from: 'alaska', to: 'kamchatka', blitz: true })).toEqual(['attack', 0, map.territoryIds.indexOf('kamchatka')]);
    expect(actionToCandidate(map, { type: 'attack', from: 'alaska', to: 'kamchatka', blitz: true, stopAt: 3 })).toBeNull();
  });

  it('a step agent is asked twice for a fortify: source, then destination', () => {
    const asked: (number | null)[] = [];
    // Always fortify when possible (last fortify_to), else play like Risky.
    const fortifier = stepAgent('fortifier@1', (ctx) => {
      asked.push(ctx.fortifyFrom);
      const i = ctx.candidates.findIndex((c) => c[0] === 'fortify_from');
      if (ctx.fortifyFrom !== null) return ctx.candidates.length - 1;
      if (i >= 0) return i;
      const a = riskyBot.choose(ctx)!;
      const step = actionSteps(ctx.state, ctx.me, ctx.legal, a, ctx.candidates)[0];
      return step.choice;
    });
    const r = playGame({ seed: 4, seats: [{ agent: fortifier }, { agent: riskyBot }], maxTurns: 30, record: true });
    expect(r.offList).toEqual([0, 0]);
    expect(asked.filter((x) => x !== null).length).toBeGreaterThan(0);
    expect(r.records!.filter((x) => x.seat === 0 && x.state.fortifyFrom >= 0).length).toBe(asked.filter((x) => x !== null).length);
  });

  it('a step agent that picks outside the list fails clearly', () => {
    const bad = stepAgent('bad@1', (ctx) => ctx.candidates.length);
    expect(() => playGame({ seed: 1, seats: [{ agent: bad }, { agent: riskyBot }] })).toThrow(/bad@1 picked candidate \d+ of \d+/);
  });

  it('random agent only picks candidates', () => {
    const r = playGame({ seed: 8, seats: [{ agent: randomAgent }, { agent: riskyBot }], maxTurns: 40 });
    expect(r.offList).toEqual([0, 0]);
    expect(r.illegal).toEqual([0, 0]);
  });
});
