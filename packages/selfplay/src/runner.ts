import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GameOptions } from '@risk/engine';
import { playGame, type GameResult, type Seat } from './game.js';
import { JsonlWriter, writeLogMeta } from './log.js';
import { gameSeed } from './seed.js';

export interface BatchConfig {
  /** Number of games to play. */
  games: number;
  /** Base seed: game i plays with gameSeed(seed, i). */
  seed: number;
  /** First game index, so several processes can each play a slice of one run (same games as one process). */
  startIndex?: number;
  /** Seats for game i. */
  seats: (i: number) => Seat[];
  /** Seed of game i. Default gameSeed(seed, i). */
  seedOf?: (i: number) => number;
  options?: Partial<GameOptions>;
  maxTurns?: number;
  onIllegal?: 'throw' | 'surrender';
  /**
   * Write decisions here: meta.json, decisions-<first>-<last>.jsonl.gz (one line per decision) and
   * games-<first>-<last>.jsonl (one summary line per game). Omit to play without logging.
   */
  logDir?: string;
  /** Gzip the decision shard. Default true. */
  gzip?: boolean;
  onGame?: (result: GameResult, i: number) => void;
}

export type GameSummary = Omit<GameResult, 'records'> & { index: number; ms: number };

/** Play a batch of games in this process and optionally log every decision. Returns one summary per game. */
export async function runBatch(cfg: BatchConfig): Promise<GameSummary[]> {
  const first = cfg.startIndex ?? 0;
  const last = first + cfg.games - 1;
  const seedOf = cfg.seedOf ?? ((i: number) => gameSeed(cfg.seed, i));
  let decisions: JsonlWriter | null = null;
  let games: JsonlWriter | null = null;
  if (cfg.logDir) {
    mkdirSync(cfg.logDir, { recursive: true });
    writeLogMeta(cfg.logDir);
    const range = `${first}-${last}`;
    decisions = new JsonlWriter(join(cfg.logDir, `decisions-${range}.jsonl${cfg.gzip === false ? '' : '.gz'}`));
    games = new JsonlWriter(join(cfg.logDir, `games-${range}.jsonl`));
  }

  const out: GameSummary[] = [];
  try {
    for (let i = first; i <= last; i++) {
      const t0 = performance.now();
      const result = playGame({
        id: `g${i}`,
        seed: seedOf(i),
        seats: cfg.seats(i),
        options: cfg.options,
        maxTurns: cfg.maxTurns,
        onIllegal: cfg.onIllegal,
        record: decisions !== null,
      });
      const { records, ...rest } = result;
      const summary: GameSummary = { index: i, ...rest, ms: Math.round(performance.now() - t0) };
      if (decisions && records) await decisions.write(records);
      if (games) await games.write([summary]);
      out.push(summary);
      cfg.onGame?.(result, i);
    }
  } finally {
    await decisions?.close();
    await games?.close();
  }
  return out;
}
