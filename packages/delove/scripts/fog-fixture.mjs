// Decisions with their full-board features and fog.ts's seat view, for packages/delove/python/test_fog.py (which checks
// fog.py against them). Built-in bot games on several maps and settings; prints one JSON object. From the repo root,
// after `npm run build`:  node packages/delove/scripts/fog-fixture.mjs [every N-th decision, default 9]
import { getMap } from '../../engine/dist/index.js';
import * as sp from '../../selfplay/dist/index.js';

const every = Number(process.argv[2] ?? 9);
const cases = [
  [4, {}],
  [6, { map: 'world', capitals: true }],
  [3, { map: 'skirmish', blizzards: 2, neutrals: 2 }],
  [2, {}],
  [10, { map: 'greater_europe', blizzards: 6 }],
];
const maps = {};
const rows = [];
for (const [k, [players, options]] of cases.entries()) {
  const seen = [];
  const spy = { id: 'risky@1', choose: (ctx) => (seen.push({ state: ctx.state, me: ctx.me }), sp.riskyBot.choose(ctx)) };
  sp.playGame({ seed: 100 + k, seats: Array.from({ length: players }, () => ({ agent: spy })), options, maxTurns: 150 });
  for (const { state, me } of seen.filter((_, i) => i % every === 0)) {
    const seats = state.players.filter((p) => !p.isNeutral).map((p) => p.id);
    const f = sp.encodeDecision(sp.decisionInput(state, seats, me, sp.makeTraits(), []));
    const x = sp.fogInputs(f, state.options.map, true);
    const map = getMap(state.options.map);
    maps[map.id] ??= { map: map.id, territoryIds: map.territoryIds, adjacency: map.territoryIds.map((t) => map.adjacency[t].map((n) => map.territoryIds.indexOf(n))) };
    rows.push({ map: map.id, territory: Array.from(f.territory), global: Array.from(f.global), fogTerritory: Array.from(x.territory), fogGlobal: Array.from(x.global) });
  }
}
process.stdout.write(JSON.stringify({ territoryFeatures: sp.TERRITORY_FEATURES, globalFeatures: sp.GLOBAL_FEATURES, maps, rows }));
