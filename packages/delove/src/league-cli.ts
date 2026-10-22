#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { expandJobs, kindWeights, leagueMix, loadLeague, withRatings } from './league.js';

const USAGE = `delove:league: the league of a training cycle (packages/delove/README.md "League")

  npm run delove:league -- expand --league <league.json> --jobs <file.jobs> --seed N [--out <file>]
      every "@league" / "@league:<kind>" seat sampled by PFSP; prints the expanded jobs file (or writes --out)
  npm run delove:league -- weights --league <league.json> [--kind snapshot]
      each member's sampling weight
  npm run delove:league -- rate --league <league.json> --scorecard <scorecard.json> [--out <league.json>]
      the members' ratings from an A/B scorecard's Plackett-Luce ratings (npm run delove:abtest -- ... --out)`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { league: { type: 'string' }, jobs: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' }, kind: { type: 'string' }, scorecard: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (!values.league || !['expand', 'weights', 'rate'].includes(cmd)) {
    console.error(USAGE);
    process.exit(2);
  }
  const league = loadLeague(values.league);
  if (cmd === 'weights') {
    for (const { id, w } of kindWeights(league, values.kind ?? 'snapshot')) console.log(`${id}\t${(100 * w).toFixed(1)}%`);
    return;
  }
  if (cmd === 'rate') {
    if (!values.scorecard) throw new Error('rate needs --scorecard');
    const rated = withRatings(league, JSON.parse(readFileSync(values.scorecard, 'utf8')).ratings);
    const text = JSON.stringify(rated, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, text);
    else process.stdout.write(text);
    return;
  }
  if (!values.jobs || values.seed === undefined) throw new Error('expand needs --jobs and --seed');
  const expanded = expandJobs(readFileSync(values.jobs, 'utf8'), league, Number(values.seed));
  if (values.out) writeFileSync(values.out, expanded.endsWith('\n') ? expanded : expanded + '\n');
  else console.log(expanded);
  console.error(`league mix (games per member): ${JSON.stringify(leagueMix(expanded, league))}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
