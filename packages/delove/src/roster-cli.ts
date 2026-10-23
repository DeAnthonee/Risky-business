#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { activeModels, addNames, loadRoster, newRoster, retireOld, saveRoster } from './roster.js';

const USAGE = `delove:roster: the house roster of the daily tournament (packages/delove/README.md "House roster")

  npm run delove:roster -- new --out <roster.json> --models delove@13:50,delove@12:50 --anchor delove@12 [--seed N]
  npm run delove:roster -- promote --roster <roster.json> --newest delove@14 [--add 50] [--seed N]
      retire every version 2+ promotions behind (never the anchor) with its names, and add names for the new one
  npm run delove:roster -- add --roster <roster.json> --model delove@14 --count 10 [--seed N]
  npm run delove:roster -- show --roster <roster.json>

The roster lives on the host, outside the repo (it is what links each name to its model).`;

const today = () => new Date().toISOString().slice(0, 10);

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      roster: { type: 'string' },
      models: { type: 'string' },
      anchor: { type: 'string' },
      newest: { type: 'string' },
      model: { type: 'string' },
      add: { type: 'string' },
      count: { type: 'string' },
      seed: { type: 'string' },
    },
  });
  const seed = Number(values.seed ?? Date.now() % 2 ** 31);
  const cmd = positionals[0];
  if (cmd === 'new') {
    if (!values.out || !values.models || !values.anchor) throw new Error('new needs --out, --models and --anchor');
    if (existsSync(values.out)) throw new Error(`${values.out} exists: a roster is never replaced (names keep their models)`);
    const models = Object.fromEntries(values.models.split(',').map((x) => [x.split(':')[0], Number(x.split(':')[1])]));
    const r = newRoster(models, values.anchor, today(), seed);
    saveRoster(values.out, r);
    console.log(`wrote ${values.out}: ${r.names.length} names`);
    return;
  }
  if (!values.roster) {
    console.error(USAGE);
    process.exit(2);
  }
  const r = loadRoster(values.roster);
  if (cmd === 'promote') {
    if (!values.newest) throw new Error('promote needs --newest');
    const gone = retireOld(r, values.newest, today());
    const added = activeModels(r).includes(values.newest) ? [] : addNames(r, values.newest, Number(values.add ?? 50), today(), seed);
    saveRoster(values.roster, r);
    console.log(`retired ${gone.length ? gone.join(', ') : 'nothing'}; added ${added.length} names for ${values.newest}`);
  } else if (cmd === 'add') {
    if (!values.model || !values.count) throw new Error('add needs --model and --count');
    const added = addNames(r, values.model, Number(values.count), today(), seed);
    saveRoster(values.roster, r);
    console.log(`added ${added.map((n) => n.name).join(', ')}`);
  } else if (cmd === 'show') {
    console.log(`anchor ${r.anchor}`);
    for (const m of activeModels(r)) {
      const ns = r.names.filter((n) => n.model === m && !n.retired);
      console.log(`${m}: ${ns.length} names (${ns.map((n) => n.name).join(', ')})`);
    }
    const retired = r.names.filter((n) => n.retired);
    if (retired.length) console.log(`retired: ${retired.length} names`);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
