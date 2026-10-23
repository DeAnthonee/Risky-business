#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MAPS, parseOptions, RECORD_FORMAT, type GameOptions, type GameRecord } from '@risk/engine';
import { knownAgents, resolveAgent } from './agents.js';
import { exportDataset } from './export.js';
import { DEFAULT_PROMOTION, loadLadder, promotionDecision, recordMatch, runMatch, saveLadder } from './ladder.js';
import { positionsFromRecord, readPositions, startState, type StartPosition } from './positions.js';
import { runBatch } from './runner.js';
import { parseSplit, splitPosition, type SplitPosition } from './scenario.js';
import type { Traits } from './traits.js';

const USAGE = `risk-selfplay: headless Risk self-play, rating ladder and decision logs (never touches the game server)

  play     --agents risky@1,risky@1 [--games 100] [--seed 1] [--start 0] [--log DIR] [--no-gzip]
  ladder   --candidate ID [--best ID] [--file ladder.json] [--games 200] [--seed 1]
           [--threshold 0.55] [--min-games 200] [--log DIR]
  export   --log DIR[,DIR...] --out DIR [--maps classic,world] [--only-agents ID[,ID...]]
  positions --records PATH[,PATH...] --out FILE [--alive 3,2]
  agents   list the agent ids that can play

common: [--map classic] [--players N (ladder)] [--options '{"fogOfWar":false}'] [--traits '{"aggression":0.8}']
        [--max-turns 500]

play     plays games i = start .. start+games-1, game i seeded from (seed, i): split one big run over several
         processes with --start and the same --seed. --log writes meta.json, decisions-*.jsonl.gz, games-*.jsonl.
         Stage games (the Delove range specialists, positions.ts): --agents 'A,B,C,D,E,F>X,Y,Z' plays a lead-in with
         A..F until 3 players are left, then X,Y,Z take the survivors' seats and only that part is logged;
         --agents 'pos:FILE>X,Y' plays from a positions file's 2-alive moments (game i: position i mod count, its
         own dice from the game seed); --agents 'split:60/40>X,Y' --options '{"maxPlayers":8,...}' plays ratio
         scenarios (scenario.ts: the board split 60/40 between 2 survivors at an 8-seat table, drawn from the game seed).
positions writes the starting positions of game records (files or archive folders): the moment each record's
         players alive dropped to each --alive count, one JSON per line.
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
      force: { type: 'boolean' },
      'only-agents': { type: 'string' },
      records: { type: 'string' },
      alive: { type: 'string' },
    },
  });

  if (cmd === 'export') {
    if (!values.log || !values.out) fail('export needs --log and --out');
    const t0 = Date.now();
    const maps = values.maps?.split(',').map((m) => m.trim());
    for (const m of maps ?? []) if (!(m in MAPS)) fail(`--maps: unknown map "${m}" (known: ${Object.keys(MAPS).join(', ')})`);
    const agents = values['only-agents']?.split(',').map((a) => a.trim());
    const results = await exportDataset(values.log.split(','), values.out, { ...(maps ? { maps } : {}), ...(agents ? { agents } : {}), force: !!values.force });
    console.log(JSON.stringify({ out: values.out, maps: results, seconds: (Date.now() - t0) / 1000 }, null, 2));
    return;
  }

  if (cmd === 'positions') {
    if (!values.records || !values.out) fail('positions needs --records and --out');
    const alive = (values.alive ?? '3,2').split(',').map((x) => intArg(x.trim(), 'alive', 0));
    if (alive.some((k) => k < 2)) fail('--alive counts must be 2 or more');
    const files = values.records.split(',').flatMap((p) => recordFiles(p.trim()));
    const out: StartPosition[] = [];
    let records = 0;
    for (const f of files) {
      // The server's archive gzips its records (.json.gz); older ones, and copies, are plain JSON.
      const raw = readFileSync(f);
      const r = JSON.parse((f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as GameRecord;
      if (r.format !== RECORD_FORMAT) continue;
      records++;
      out.push(...positionsFromRecord(r, alive));
    }
    writeFileSync(values.out, out.map((p) => JSON.stringify(p) + '\n').join(''));
    const count = (key: (p: StartPosition) => string) => out.reduce<Record<string, number>>((a, p) => ((a[key(p)] = (a[key(p)] ?? 0) + 1), a), {});
    console.log(JSON.stringify({ records, positions: out.length, byAlive: count((p) => String(p.alive)), byMap: count((p) => p.map), bySeats: count((p) => String(p.seats)), out: values.out }, null, 2));
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
    const [lead, stageList] = values.agents.split('>');
    const list = (s: string) => s.split(',').map((id) => resolveAgent(id.trim()));
    const stageAgents = stageList === undefined ? null : list(stageList);
    let positions: StartPosition[] | null = null;
    if (lead.startsWith('pos:')) {
      if (!stageAgents) fail('--agents pos:FILE needs the stage agents after a ">"');
      if (Object.keys(jsonArg<object>(values.options, 'options') ?? {}).length || values.map) fail('a positions file carries its own settings: no --options or --map');
      positions = readPositions(lead.slice(4), stageAgents.length);
      if (!positions.length) fail(`${lead.slice(4)} has no position with ${stageAgents.length} players alive`);
    }
    let split: { shares: number[]; seats: number } | null = null;
    if (lead.startsWith('split:')) {
      if (!stageAgents) fail('--agents split:SHARES needs the stage agents after a ">"');
      const shares = (() => {
        try {
          return parseSplit(lead.slice(6));
        } catch (err) {
          fail((err as Error).message);
        }
      })();
      if (shares.length !== stageAgents.length) fail(`a ${shares.join('/')} split needs ${shares.length} stage agents, not ${stageAgents.length}`);
      if (!options.maxPlayers) fail('--agents split:... needs the table size as maxPlayers in --options');
      split = { shares, seats: options.maxPlayers };
    }
    /** Ratio scenario of game i (seed s), kept for the summary's per-share results. */
    const splits = new Map<number, SplitPosition>();
    const agents = positions || split ? stageAgents! : list(lead);
    const games = intArg(values.games, 'games', 100);
    let done = 0;
    const results = await runBatch({
      games,
      seed,
      startIndex: intArg(values.start, 'start', 0),
      seats: (i) =>
        (positions ? new Array(positions[i % positions.length].seats).fill(agents[0]) : split ? new Array(split.seats).fill(agents[0]) : agents).map((agent) => ({ agent, traits })),
      ...(stageAgents ? { stage: { alive: stageAgents.length, agents: stageAgents } } : {}),
      ...(positions ? { start: (i: number, s: number) => ({ state: startState(positions![i % positions!.length], s, `g${i}`), eliminated: positions![i % positions!.length].eliminated }) } : {}),
      ...(split
        ? {
            start: (i: number, s: number) => {
              const p = splitPosition(split!.shares, options, split!.seats, s);
              splits.set(i, p);
              return { state: startState(p, s, `g${i}`), eliminated: p.eliminated };
            },
          }
        : {}),
      options,
      maxTurns,
      logDir: values.log,
      gzip: !values['no-gzip'],
      onGame: () => progress(++done, games),
    });
    process.stderr.write('\n');
    const winsBySeat = positions || split ? [] : agents.map((_, s) => results.filter((r) => r.winner === s).length);
    // ratio scenarios: how each share did (the survivor holding share j at the start), whoever played it
    const byShare = split?.shares.map((share, j) => {
      const rows = results.map((r) => ({ r, q: splits.get(r.index)!.survivors[j] }));
      return { share, wins: rows.filter(({ r, q }) => r.winner === q).length, meanPlacement: Math.round((rows.reduce((a, { r, q }) => a + r.placement[q], 0) / rows.length) * 100) / 100 };
    });
    console.log(
      JSON.stringify(
        {
          games: results.length,
          agents: agents.map((a) => a.id),
          ...(stageAgents ? { stage: { alive: stageAgents.length, agents: stageAgents.map((a) => a.id), reached: results.filter((r) => r.stage).length } } : {}),
          winsBySeat,
          ...(byShare ? { split: split!.shares.join('/'), byShare } : {}),
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

/** Record files under a path: the file itself, or every .json / .json.gz below a folder (an archive's games/), sorted. */
function recordFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json') || f.endsWith('.json.gz'))
    .map((f) => join(path, f))
    .sort();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
