#!/usr/bin/env node
// Writes the ratio-scenario jobs files for Delove Close Range (2 alive) and Mid Range (3 alive): split-close.jobs and
// split-mid.jobs next to this script. Each ratio gets about GAMES games over the 6-10 seat tables of close.jobs /
// mid.jobs (cycle 8's maps and table sizes, the same league settings per table, the same mix of games per table);
// rotations of a 3-way split (who moves first) share their ratio's games. Every line has its own range of game
// numbers (the START column), so no two lines play the same seeds. The stage agents: the branch player and OPPONENT
// (default delove@6) in the other seats. Run it again after changing the tables or ratios:
//
//   node packages/delove/scripts/stage/split-jobs.mjs [GAMES=10000] [OPPONENT=delove@6]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAMES = Number(process.argv[2] ?? 10000);
const OPP = process.argv[3] ?? 'delove@6';
const here = dirname(fileURLToPath(import.meta.url));
const league = { autoSetup: true, balancedBlitz: true, chooseCapitals: true };
const A = { cardValues: 'progressive' };
const B = { cardValues: 'fixed', capitals: true };
const C = { cardValues: 'exponential', blizzards: 8 };
const D = { cardValues: 'progressive', capitals: true, blizzards: 8 };
// [name, map, seats, weight (close.jobs' games), settings] for the a and b tables of each map and size
const TABLES = [
  ['c6', 'classic', 6, 300, [B, C]],
  ['w6', 'world', 6, 200, [C, D]],
  ['w10', 'world', 10, 100, [D, A]],
  ['eu8', 'europe', 8, 125, [A, B]],
  ['us10', 'usa', 10, 100, [B, C]],
  ['as8', 'asia', 8, 125, [C, D]],
  ['bo6', 'bohemia', 6, 150, [D, A]],
  ['nr6', 'nine_realms', 6, 150, [A, B]],
  ['nr8', 'nine_realms', 8, 100, [B, C]],
  ['fa6', 'fantasy', 6, 150, [C, D]],
  ['ge6', 'greater_europe', 6, 125, [D, A]],
  ['ec6', 'europe_classic', 6, 150, [A, B]],
  ['wl10', 'world_large', 10, 75, [B, C]],
];
const STAGES = {
  close: { agents: ['delove-branch@1', OPP], ratios: [['50/50'], ['60/40'], ['40/60'], ['70/30'], ['30/70']] },
  mid: {
    agents: ['delove-branch@1', OPP, OPP],
    ratios: [['34/33/33'], ['50/25/25', '25/50/25', '25/25/50'], ['40/40/20', '40/20/40', '20/40/40'], ['60/20/20', '20/60/20', '20/20/60']],
  },
};
const weight = TABLES.reduce((a, t) => a + 2 * t[3], 0);

for (const [stage, { agents, ratios }] of Object.entries(STAGES)) {
  const lines = [];
  let start = 0;
  let total = 0;
  for (const group of ratios) {
    for (const ratio of group) {
      for (const [name, map, seats, w, settings] of TABLES) {
        settings.forEach((s, k) => {
          const games = Math.round((GAMES * w) / weight / group.length);
          const options = { ...(map === 'classic' ? {} : { map }), maxPlayers: seats, ...league, ...s };
          const id = `${ratio.replaceAll('/', '-')}-${name}${'ab'[k]}`;
          lines.push(`${id.padEnd(18)} ${String(games).padStart(4)} split:${ratio}>${agents.join(',')} ${start} ${JSON.stringify(options)}`);
          start += games;
          total += games;
        });
      }
    }
  }
  const alive = agents.length;
  const head = [
    `# Ratio scenarios for Delove ${stage === 'close' ? 'Close' : 'Mid'} Range: ${alive} players alive, the board split as the`,
    `# ratio says (survivors in turn order from the player to move; packages/selfplay/src/scenario.ts), drawn from each`,
    `# game's seed, so they run on rented GPUs too. ${total} games, about ${GAMES} per ratio${stage === 'mid' ? ' (its rotations share them)' : ''}, over cycle 8's`,
    `# 6-10 seat tables and league settings. Mix them with the real stage games (${stage}.jobs), not instead of them.`,
    `# Written by split-jobs.mjs (edit that, not this file). packages/delove-gpu README "Stage games".`,
  ];
  writeFileSync(join(here, `split-${stage}.jobs`), [...head, ...lines].join('\n') + '\n');
  console.log(`split-${stage}.jobs: ${lines.length} tables, ${total} games`);
}
