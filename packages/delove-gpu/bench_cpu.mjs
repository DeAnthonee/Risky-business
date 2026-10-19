// CPU baseline for bench.py: the TypeScript self-play (npm run delove -- play, no logging) in N parallel processes.
//
//   node packages/delove-gpu/bench_cpu.mjs --agents delove-teacher@1,delove-teacher@1 --games 200 --procs 1
//   node packages/delove-gpu/bench_cpu.mjs --agents random@1,random@1 --games 20 --procs 20
//
// Each process plays --games games (disjoint --start ranges, same --seed); prints games/s and engine decisions/s over
// the wall time of the whole run. (Engine decisions count a fortify once; the GPU counts its two steps.)
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values } = parseArgs({
  options: {
    agents: { type: 'string' },
    games: { type: 'string', default: '100' },
    procs: { type: 'string', default: '1' },
    seed: { type: 'string', default: '21' },
  },
});
const procs = Number(values.procs);
const games = Number(values.games);

function run(i) {
  return new Promise((resolve, reject) => {
    const args = ['--import', './packages/delove/dist/register.js', 'packages/selfplay/dist/cli.js', 'play', '--agents', values.agents,
      '--games', String(games), '--start', String(i * games), '--seed', values.seed];
    const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.slice(out.indexOf('{')))) : reject(new Error(`process ${i} exited ${code}`))));
  });
}

const t0 = performance.now();
const results = await Promise.all(Array.from({ length: procs }, (_, i) => run(i)));
const seconds = (performance.now() - t0) / 1000;
const g = results.reduce((a, r) => a + r.games, 0);
const d = results.reduce((a, r) => a + r.decisions, 0);
console.log(JSON.stringify({
  engine: 'typescript (cpu)', agents: values.agents, procs, games: g, seconds: +seconds.toFixed(1),
  games_per_s: +(g / seconds).toFixed(1), decisions_per_s: Math.round(d / seconds), decisions_per_game: +(d / g).toFixed(1),
  turn_limit_share: +(results.reduce((a, r) => a + r.turnLimit, 0) / g).toFixed(3),
}));
