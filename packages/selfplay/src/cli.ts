#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { parseOptions, type GameOptions } from '@risk/engine';
import { knownAgents, resolveAgent } from './agents.js';
import { exportDataset } from './export.js';
import { DEFAULT_PROMOTION, loadLadder, promotionDecision, recordMatch, runMatch, saveLadder } from './ladder.js';
import { runBatch } from './runner.js';
import type { Traits } from './traits.js';

const USAGE = `risk-selfplay: headless Risk self-play, rating ladder and decision logs (never touches the game server)

  play     --agents risky@1,risky@1 [--games 100] [--seed 1] [--start 0] [--log DIR] [--no-gzip]
  ladder   --candidate ID [--best ID] [--file ladder.json] [--games 200] [--seed 1]
           [--threshold 0.55] [--min-games 200] [--log DIR]
  export   --log DIR[,DIR...] --out DIR [--maps classic,world]
  agents   list the agent ids that can play

common: [--map classic] [--players N (ladder)] [--options '{"fogOfWar":false}'] [--traits '{"aggression":0.8}']
        [--max-turns 500]

play     plays games i = start .. start+games-1, game i seeded from (seed, i): split one big run over several
         processes with --start and the same --seed. --log writes meta.json, decisions-*.jsonl.gz, games-*.jsonl.
export   encodes decision logs (format v2) into NumPy arrays for the trainer, one folder per map
         (see packages/selfplay/README.md "Dataset export").
ladder   plays mirrored pairs of games candidate vs best; with --file, rates the candidate against the file's best
         and promotes it when it clears the promotion rule (see README "Self-play").`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

function intArg(v: string | undefined, name: string, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}

function jsonArg<T>(v: string | undefined, name: string): T | undefined {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    fail(`--${name} must be JSON`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      agents: { type: 'string' },
      candidate: { type: 'string' },
      best: { type: 'string' },
      file: { type: 'string' },
      games: { type: 'string' },
      seed: { type: 'string' },
      start: { type: 'string' },
      players: { type: 'string' },
      map: { type: 'string' },
      options: { type: 'string' },
      traits: { type: 'string' },
      'max-turns': { type: 'string' },
      threshold: { type: 'string' },
      'min-games': { type: 'string' },
      log: { type: 'string' },
      'no-gzip': { type: 'boolean' },
      out: { type: 'string' },
      maps: { type: 'string' },
    },
  });

  if (cmd === 'export') {
    if (!values.log || !values.out) fail('export needs --log and --out');
    const t0 = Date.now();
    const results = await exportDataset(values.log.split(','), values.out, values.maps ? { maps: values.maps.split(',') } : {});
    console.log(JSON.stringify({ out: values.out, maps: results, seconds: (Date.now() - t0) / 1000 }, null, 2));
    return;
  }

  if (cmd === 'agents') {
    console.log(knownAgents().join('\n'));
    return;
  }

  const options: Partial<GameOptions> = parseOptions({ ...jsonArg<object>(values.options, 'options'), ...(values.map ? { map: values.map } : {}) });
  const traits = jsonArg<Partial<Traits>>(values.traits, 'traits');
  const seed = intArg(values.seed, 'seed', 1);
  const maxTurns = intArg(values['max-turns'], 'max-turns', 500);
  const t0 = Date.now();
  const progress = (done: number, total: number) => {
    if (done % 50 === 0 || done === total) process.stderr.write(`\r${done}/${total} games, ${((done * 1000) / (Date.now() - t0)).toFixed(1)}/s `);
  };

  if (cmd === 'play') {
    if (!values.agents) fail('play needs --agents');
    const agents = values.agents.split(',').map((id) => resolveAgent(id.trim()));
    const games = intArg(values.games, 'games', 100);
    let done = 0;
    const results = await runBatch({
      games,
      seed,
      startIndex: intArg(values.start, 'start', 0),
      seats: () => agents.map((agent) => ({ agent, traits })),
      options,
      maxTurns,
      logDir: values.log,
      gzip: !values['no-gzip'],
      onGame: () => progress(++done, games),
    });
    process.stderr.write('\n');
    const winsBySeat = agents.map((_, s) => results.filter((r) => r.winner === s).length);
    console.log(
      JSON.stringify(
        {
          games: results.length,
          agents: agents.map((a) => a.id),
          winsBySeat,
          turnLimit: results.filter((r) => r.winner === null).length,
          meanTurns: Math.round((results.reduce((a, r) => a + r.turns, 0) / results.length) * 10) / 10,
          decisions: results.reduce((a, r) => a + r.decisions, 0),
          offList: results.reduce((a, r) => a + r.offList.reduce((x, y) => x + y, 0), 0),
          seconds: (Date.now() - t0) / 1000,
          ...(values.log ? { log: values.log } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'ladder') {
    if (!values.candidate) fail('ladder needs --candidate');
    const ladder = values.file ? loadLadder(values.file) : null;
    const bestId = values.best ?? ladder?.best;
    if (!bestId) fail('ladder needs --best (the ladder file has no best version yet)');
    if (ladder?.best && values.best && values.best !== ladder.best) fail(`--best ${values.best} differs from the ladder's best ${ladder.best}`);
    const games = intArg(values.games, 'games', DEFAULT_PROMOTION.minGames);
    const rule = {
      minGames: intArg(values['min-games'], 'min-games', DEFAULT_PROMOTION.minGames),
      threshold: values.threshold === undefined ? DEFAULT_PROMOTION.threshold : Number(values.threshold),
    };
    // NaN would make every `score < threshold` check false and silently skip the rule.
    if (!Number.isFinite(rule.threshold) || rule.threshold < 0 || rule.threshold > 1) fail('--threshold must be a number between 0 and 1');
    if (resolveAgent(values.candidate).id === resolveAgent(bestId).id) fail('--candidate and --best are the same version');
    const players = intArg(values.players, 'players', 2);
    // Seats alternate between the two versions, so an odd table gives one of them more seats in every game.
    if (players < 2 || players % 2 !== 0) fail('--players must be an even number (2, 4, ...) for a ladder match');
    let done = 0;
    const result = await runMatch({
      candidate: resolveAgent(values.candidate),
      best: resolveAgent(bestId),
      games,
      seed,
      players,
      options,
      maxTurns,
      traits,
      logDir: values.log,
      onGame: () => progress(++done, Math.ceil(games / 2) * 2),
    });
    process.stderr.write('\n');
    const decision = promotionDecision(result, rule);
    if (ladder && values.file) {
      const next = recordMatch(ladder, result, decision);
      saveLadder(values.file, next);
      console.log(JSON.stringify({ ...result, ...decision, ladderBest: next.best, rating: next.ratings[result.candidate] }, null, 2));
    } else {
      console.log(JSON.stringify({ ...result, ...decision }, null, 2));
    }
    return;
  }

  fail(cmd ? `Unknown command "${cmd}"` : 'No command given');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
