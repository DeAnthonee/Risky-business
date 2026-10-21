// Game records for testing stage games from positions (tests/stage_check.py): built-in bot games played through the
// engine and written as the server's GameRecord files (record.ts), so `npm run selfplay -- positions` reads them like
// an archive's. From the repo root, after `npm run build`:
//
//   node packages/delove-gpu/tests/stage_records.mjs OUT_DIR SEED 'MAP SEATS GAMES [OPTIONS JSON]' ...
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPlayer, applyAction, assembleRecord, chooseBotAction, createGame, recordHeader, recordStep, startGame } from '../../engine/dist/index.js';
import { gameSeed, seededRandom } from '../../selfplay/dist/index.js';

const [out, seedArg, ...specs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let n = 0;
for (const [k, spec] of specs.entries()) {
  const [map, seats, games, ...rest] = spec.split(' ');
  const options = { ...(rest.length ? JSON.parse(rest.join(' ')) : {}), map, maxPlayers: Number(seats) };
  for (let i = 0; i < Number(games); i++) {
    const seed = gameSeed(Number(seedArg) + 1000 * k, i);
    let state = createGame(`r${k}-${i}`, options, seed);
    for (let s = 0; s < Number(seats); s++) state = addPlayer(state, `p_${k}_${i}_${s}`, `Bot ${s}`, true);
    state = { ...state, createdAt: 0 };
    const started = startGame(state);
    state = { ...started.state, startedAt: 0 };
    const header = recordHeader(`rec-${k}-${i}`, { id: `R${k}${i}`, name: 'stage test' }, state, started.events);
    const random = seededRandom(seed ^ 0x51);
    const entries = [];
    while (state.phase !== 'finished' && state.turnNumber < 300) {
      const me = state.currentPlayer;
      const action = chooseBotAction(state, me, random) ?? { type: 'surrender' };
      const r = applyAction(state, me, action);
      entries.push(recordStep(header, state, me, action, r.events, 0));
      state = r.state;
    }
    writeFileSync(join(out, `rec-${k}-${i}.json`), JSON.stringify(assembleRecord(header, entries, state, 0)));
    n++;
  }
}
console.log(JSON.stringify({ records: n, out }));
