#!/usr/bin/env node
// Measures what real 3- and 2-alive stage starts look like, for the ratio scenarios' STAGE_STATS
// (packages/selfplay/src/scenario.ts): Jacob Sensei plays every seat of a league-settings game on each 6-10 seat table
// of the split jobs (4 settings each), and the first turn start with 3 and with 2 real players alive is measured:
// armies per playable territory, rounds played (turns / seats), card sets traded per seat, the discard pile's share of
// the undrawn cards and hand sizes. Prints STAGE_STATS as JSON (median per map-seats, pooled deciles of value / median)
// plus the leader's shares and how lumpy the armies are, for comparing with the scenarios. From the repo root, after
// npm run build:
//
//   node packages/delove/scripts/stage/measure-stages.mjs [GAMES_PER_SETTING=25] [SEED=777]
import { addPlayer, applyAction, createGame, getMap, legalMoves, startGame } from '@risk/engine';
import { aliveCount, candidates, gameSeed, makeTraits, mixSeed, resolveAgent, seededRandom } from '@risk/selfplay';
import '../../dist/register.js';

const per = Number(process.argv[2] ?? 25);
const seed0 = Number(process.argv[3] ?? 777);
const SETTINGS = [
  { cardValues: 'progressive' },
  { cardValues: 'fixed', capitals: true },
  { cardValues: 'exponential', blizzards: 8 },
  { cardValues: 'progressive', capitals: true, blizzards: 8 },
];
const TABLES = [
  ['classic', 6], ['world', 6], ['world', 10], ['europe', 8], ['usa', 10], ['asia', 8], ['bohemia', 6],
  ['nine_realms', 6], ['nine_realms', 8], ['fantasy', 6], ['greater_europe', 6], ['europe_classic', 6], ['world_large', 10],
];
const jacob = resolveAgent('jacob-sensei@1');
const traits = makeTraits({});
const rows = [];
let game = 0;
for (const [map, n] of TABLES) {
  for (const o of SETTINGS) {
    for (let g = 0; g < per; g++, game++) {
      const seed = gameSeed(seed0, game);
      let s = createGame('m', { map, maxPlayers: n, autoSetup: true, balancedBlitz: true, chooseCapitals: true, ...o }, seed);
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      for (const id of ids) s = addPlayer(s, id, id, true);
      s = startGame(s).state;
      const m = getMap(map);
      const rnd = ids.map((_, i) => seededRandom(mixSeed(seed, 0x5eed + i)));
      const want = new Set([3, 2]);
      const T = m.territoryIds.length - s.blizzards.length;
      while (s.phase !== 'finished' && s.turnNumber < 500 && want.size) {
        const k = aliveCount(s);
        if (want.has(k) && s.phase === 'reinforce') {
          want.delete(k);
          const alive = s.players.filter((p) => !p.isNeutral && p.alive);
          const mine = (p) => Object.entries(s.territories).filter(([, t]) => t.owner === p.id);
          const arm = alive.map((p) => mine(p).reduce((a, [, t]) => a + t.armies, 0));
          const total = arm.reduce((a, b) => a + b, 0);
          rows.push({
            key: `${map}-${n}`, k, n, perT: total / T, rounds: s.turnNumber / n, trades: s.tradeCount / n,
            discard: s.discard.length / Math.max(1, s.deck.length + s.discard.length), hands: alive.map((p) => p.cards.length),
            topArmy: Math.max(...arm) / total, topTerr: Math.max(...alive.map((p) => mine(p).length)) / T,
            lumps: alive.map((p) => {
              const a = mine(p).map(([, t]) => t.armies).sort((x, y) => y - x);
              const sum = a.reduce((x, y) => x + y, 0);
              return { top1: a[0] / sum, top3: (a[0] + (a[1] ?? 0) + (a[2] ?? 0)) / sum, ones: a.filter((x) => x === 1).length / a.length };
            }),
          });
        }
        const me = s.currentPlayer;
        const seat = ids.indexOf(me);
        const legal = legalMoves(s, me);
        s = applyAction(s, me, jacob.choose({ state: s, me, seat, legal, candidates: candidates(s, me, legal), traits, random: rnd[seat] }) ?? { type: 'surrender' }).state;
      }
    }
  }
  process.stderr.write(`${map}-${n} `);
}
process.stderr.write('\n');

const r2 = (x) => Math.round(x * 100) / 100;
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];
const deciles = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return Array.from({ length: 11 }, (_, p) => r2(s[Math.min(s.length - 1, Math.round((p * (s.length - 1)) / 10))]));
};
const out = {};
for (const k of [3, 2]) {
  const rs = rows.filter((x) => x.k === k);
  const keys = [...new Set(rs.map((x) => x.key))].sort();
  const med = {};
  for (const key of keys) {
    const rr = rs.filter((x) => x.key === key);
    med[key] = { perT: r2(median(rr.map((x) => x.perT))), rounds: r2(median(rr.map((x) => x.rounds))), trades: r2(median(rr.map((x) => x.trades))) };
  }
  med['*'] = { perT: r2(median(rs.map((x) => x.perT))), rounds: r2(median(rs.map((x) => x.rounds))), trades: r2(median(rs.map((x) => x.trades))) };
  const spread = Object.fromEntries(['perT', 'rounds', 'trades'].map((f) => [f, deciles(rs.map((x) => x[f] / Math.max(1e-9, med[x.key][f])))]));
  const hands = rs.flatMap((x) => x.hands);
  const lumps = rs.flatMap((x) => x.lumps);
  out[k] = {
    stages: rs.length,
    median: med,
    spread,
    discard: deciles(rs.map((x) => x.discard)),
    hands: [0, 1, 2, 3, 4, 5].map((h) => Math.round((100 * hands.filter((x) => x === h).length) / hands.length)),
    leader: { army: deciles(rs.map((x) => x.topArmy)), territories: deciles(rs.map((x) => x.topTerr)) },
    lumps: { top1: r2(median(lumps.map((x) => x.top1))), top3: r2(median(lumps.map((x) => x.top3))), ones: r2(median(lumps.map((x) => x.ones))) },
  };
}
console.log(JSON.stringify(out, null, 2));
