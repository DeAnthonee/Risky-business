#!/usr/bin/env node
// Behaviour lock for speed work: plays a fixed set of ~60 seeded self-play games across maps, player counts,
// settings and players (teachers, risky@1, the network, the branch-and-score player) and records every logged
// decision's `choice` plus a hash of the full decision records (features included) and the game result. After
// changing the engine, self-play or Delove code, `check` replays them and fails on any difference.
//
//   node --import ./packages/delove/dist/register.js packages/delove/scripts/golden.mjs record runs/delove/golden.json
//   node --import ./packages/delove/dist/register.js packages/delove/scripts/golden.mjs check  runs/delove/golden.json
//
// Needs the trained models (DELOVE_MODELS) for delove@2 and the branch player's ranker. JOBS (default 20) games run
// at once in child processes.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { playGame, resolveAgent } from '@risk/selfplay';

const T1 = 'delove-teacher@1';
const T2 = 'delove-teacher@2';
const R = 'risky@1';
const B = 'delove-branch@1';
const N = 'delove@2';
const X = 'delove@2-explore';
const sets = [
  ['classic-2p', [T1, R], {}, 3],
  ['classic-2p-t2', [T2, T2], {}, 3],
  ['classic-2p-branch', [B, T2], {}, 3],
  ['classic-2p-net', [N, T2], {}, 2],
  ['classic-2p-explore', [X, B], {}, 1],
  ['classic-4p', [T2, R, T1, R], {}, 3],
  ['classic-4p-branch', [B, T2, N, R], {}, 2],
  ['classic-6p', [T2, R, T1, R, T2, R], {}, 3],
  ['classic-6p-branch', [B, T2, R, T1, R, N], {}, 1],
  ['world-2p', [T2, R], { map: 'world' }, 3],
  ['world-4p', [T1, R, T2, R], { map: 'world' }, 2],
  ['skirmish-2p', [T2, T1], { map: 'skirmish' }, 3],
  ['skirmish-2p-branch', [B, T2], { map: 'skirmish' }, 4],
  ['skirmish-2p-net', [T2, N], { map: 'skirmish' }, 2],
  ['skirmish-3p', [T2, R, T1], { map: 'skirmish' }, 2],
  ['capitals-4p', [T2, R, T1, R], { capitals: true }, 3],
  ['capitals-choose-4p', [T2, R, T2, R], { capitals: true, chooseCapitals: true }, 2],
  ['capitals-2p-branch', [B, T2], { capitals: true }, 1],
  ['fixed-2p', [T2, R], { cardValues: 'fixed' }, 3],
  ['fixed-2p-branch', [T2, B], { cardValues: 'fixed' }, 1],
  ['exponential-4p', [T1, R, T2, R], { cardValues: 'exponential' }, 2],
  ['blizzards-neutrals-4p', [T2, R, T1, R], { blizzards: 6, neutrals: 4 }, 2],
  ['adjacent-2p', [T2, R], { fortifyMode: 'adjacent' }, 2],
  ['balanced-2p', [T1, R], { balancedBlitz: true, setupBatch: 3 }, 2],
  ['autosetup-4p', [R, T2, R, T1], { autoSetup: true, firstRoundBonus: false }, 2],
];
const games = sets.flatMap(([name, agents, options, n]) => Array.from({ length: n }, (_, k) => ({ name: `${name}#${k}`, agents, options, seed: 9001 + 97 * k + name.length })));

function play(i) {
  const g = games[i];
  const t0 = performance.now();
  const r = playGame({ seed: g.seed, seats: g.agents.map((id) => ({ agent: resolveAgent(id) })), options: g.options, record: true, maxTurns: 300 });
  const ms = performance.now() - t0;
  const hash = createHash('sha256');
  for (const rec of r.records) hash.update(JSON.stringify(rec) + '\n');
  return {
    name: g.name,
    winner: r.winner,
    turns: r.turns,
    decisions: r.decisions,
    steps: r.steps,
    choices: r.records.map((x) => x.choice).join(','),
    records: hash.digest('hex'),
    ms: Math.round(ms),
  };
}

if (process.argv[2] === '--one') {
  process.send(play(Number(process.argv[3])), () => process.exit(0));
} else {
  const [mode, file] = process.argv.slice(2);
  if (!['record', 'check'].includes(mode) || !file) {
    console.error('usage: golden.mjs record|check <file>');
    process.exit(2);
  }
  const jobs = Number(process.env.JOBS ?? 20);
  const results = new Array(games.length);
  const t0 = Date.now();
  let next = 0;
  const self = fileURLToPath(import.meta.url);
  const worker = () =>
    new Promise((resolve, reject) => {
      const go = () => {
        if (next >= games.length) return resolve();
        const i = next++;
        const child = fork(self, ['--one', String(i)], { execArgv: process.execArgv });
        child.on('message', (m) => (results[i] = m));
        child.on('exit', (code) => (code === 0 && results[i] ? go() : reject(new Error(`game ${games[i].name} failed (${code})`))));
      };
      go();
    });
  await Promise.all(Array.from({ length: jobs }, worker));
  const seconds = (Date.now() - t0) / 1000;
  const cpu = results.reduce((a, r) => a + r.ms, 0) / 1000;
  if (mode === 'record') {
    writeFileSync(file, JSON.stringify({ games: results }, null, 1));
    console.log(`recorded ${results.length} games (${results.reduce((a, r) => a + r.steps, 0)} steps) in ${seconds}s, ${cpu.toFixed(1)}s of game time -> ${file}`);
  } else {
    if (!existsSync(file)) throw new Error(`no golden file ${file}`);
    const want = JSON.parse(readFileSync(file, 'utf8')).games;
    let bad = 0;
    const wantCpu = want.reduce((a, r) => a + r.ms, 0) / 1000;
    for (let i = 0; i < want.length; i++) {
      const a = want[i];
      const b = results[i];
      for (const k of ['name', 'winner', 'turns', 'decisions', 'steps', 'choices', 'records']) {
        if (a[k] !== b?.[k]) {
          bad++;
          console.log(`DIFF ${a.name}: ${k}`);
          break;
        }
      }
    }
    console.log(`${want.length - bad}/${want.length} games identical; game time ${cpu.toFixed(1)}s (recorded ${wantCpu.toFixed(1)}s, x${(wantCpu / cpu).toFixed(2)})`);
    if (bad) process.exit(1);
  }
}
