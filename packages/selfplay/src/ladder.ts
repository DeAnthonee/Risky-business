import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameOptions } from '@risk/engine';
import type { Agent } from './agents.js';
import type { GameResult, Seat } from './game.js';
import { runBatch } from './runner.js';
import { gameSeed } from './seed.js';
import type { Traits } from './traits.js';

/**
 * Head-to-head matches between two player versions, and the ladder that decides promotions.
 *
 * Games are played in mirrored pairs: both games of a pair use the same seed (same deal, same turn order) with the
 * two versions in swapped seats, which cancels most of the luck of the deal. A candidate is promoted only when it
 * has played at least `minGames` and its score clears both `threshold` and the lower end of the 95% interval
 * clears 0.5, so a lucky streak over a few games never replaces the best version.
 */

export interface MatchConfig {
  candidate: Agent;
  best: Agent;
  /** Games to play (rounded up to an even number so every pair is mirrored). Default 200. */
  games?: number;
  seed: number;
  /** Players per game. Default 2 (the engine adds the classic Neutral). Seats alternate candidate/best. */
  players?: number;
  options?: Partial<GameOptions>;
  maxTurns?: number;
  traits?: Partial<Traits>;
  logDir?: string;
  onGame?: (result: GameResult, i: number) => void;
}

export interface MatchResult {
  candidate: string;
  best: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Candidate's mean score per game: win 1, draw 0.5, loss 0. */
  score: number;
  /** 95% interval of the score. */
  scoreLow: number;
  scoreHigh: number;
  /** Elo difference candidate minus best implied by the score, with its 95% interval. */
  elo: number;
  eloLow: number;
  eloHigh: number;
  /** Games that ended at the turn limit. */
  turnLimit: number;
  meanTurns: number;
}

/** Seats of game i: candidate on even seats in even games, on odd seats in odd games. */
export function matchSeats(i: number, players: number, candidate: Agent, best: Agent, traits?: Partial<Traits>): Seat[] {
  return Array.from({ length: players }, (_, s) => ({ agent: (s + i) % 2 === 0 ? candidate : best, traits }));
}

/** Score of the candidate in game i (seated by matchSeats): 1 win, 0 loss, 0.5 when nobody won. */
export function candidateScore(winner: number | null, i: number): number {
  if (winner === null) return 0.5;
  return (winner + i) % 2 === 0 ? 1 : 0;
}

const MAX_ELO = 800;

export function eloFromScore(s: number): number {
  if (s <= 0) return -MAX_ELO;
  if (s >= 1) return MAX_ELO;
  return Math.max(-MAX_ELO, Math.min(MAX_ELO, 400 * Math.log10(s / (1 - s))));
}

/**
 * Summarise a match. `pairSize` 2 means scores come in mirrored pairs (games 2k and 2k+1 share a seed): the two games
 * of a pair are correlated, so the interval is computed over the pair averages, not over single games.
 */
export function summarizeMatch(candidate: string, best: string, scores: number[], turns: number[], turnLimit: number, pairSize = 1): MatchResult {
  const n = scores.length;
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : 0.5;
  const units: number[] = [];
  for (let i = 0; i < n; i += pairSize) {
    const group = scores.slice(i, i + pairSize);
    units.push(group.reduce((a, b) => a + b, 0) / group.length);
  }
  const u = units.length;
  const variance = u > 1 ? units.reduce((a, s) => a + (s - mean) ** 2, 0) / (u - 1) : 0.25;
  // Never trust a zero variance from a handful of games: floor it at what a 90/10 split would give (per game; a
  // pair average of independent games has half that).
  const se = Math.sqrt(Math.max(variance, 0.09 / pairSize) / Math.max(u, 1));
  const lo = Math.max(0, mean - 1.96 * se);
  const hi = Math.min(1, mean + 1.96 * se);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    candidate,
    best,
    games: n,
    wins: scores.filter((s) => s === 1).length,
    losses: scores.filter((s) => s === 0).length,
    draws: scores.filter((s) => s === 0.5).length,
    score: r(mean),
    scoreLow: r(lo),
    scoreHigh: r(hi),
    elo: Math.round(eloFromScore(mean)),
    eloLow: Math.round(eloFromScore(lo)),
    eloHigh: Math.round(eloFromScore(hi)),
    turnLimit,
    meanTurns: n ? Math.round((turns.reduce((a, b) => a + b, 0) / n) * 10) / 10 : 0,
  };
}

export async function runMatch(cfg: MatchConfig): Promise<MatchResult> {
  const games = Math.ceil((cfg.games ?? 200) / 2) * 2;
  const players = cfg.players ?? 2;
  const scores: number[] = [];
  const turns: number[] = [];
  let turnLimit = 0;
  await runBatch({
    games,
    seed: cfg.seed,
    seedOf: (i) => gameSeed(cfg.seed, Math.floor(i / 2)),
    seats: (i) => matchSeats(i, players, cfg.candidate, cfg.best, cfg.traits),
    options: cfg.options,
    maxTurns: cfg.maxTurns,
    onIllegal: 'surrender',
    logDir: cfg.logDir,
    onGame: (result, i) => {
      scores.push(candidateScore(result.winner, i));
      turns.push(result.turns);
      if (result.winner === null) turnLimit++;
      cfg.onGame?.(result, i);
    },
  });
  return summarizeMatch(cfg.candidate.id, cfg.best.id, scores, turns, turnLimit, 2);
}

export interface PromotionRule {
  /** Minimum games before a promotion can happen. Default 200. */
  minGames: number;
  /** Minimum score against the current best. Default 0.55 (about +35 Elo). */
  threshold: number;
}

export const DEFAULT_PROMOTION: PromotionRule = { minGames: 200, threshold: 0.55 };

export function promotionDecision(r: MatchResult, rule: PromotionRule = DEFAULT_PROMOTION): { promote: boolean; reason: string } {
  if (r.games < rule.minGames) return { promote: false, reason: `only ${r.games} games (need ${rule.minGames})` };
  if (r.score < rule.threshold) return { promote: false, reason: `score ${r.score} below ${rule.threshold}` };
  if (r.scoreLow <= 0.5) return { promote: false, reason: `95% interval reaches ${r.scoreLow}, not clearly better than 0.5` };
  return { promote: true, reason: `score ${r.score} (95% ${r.scoreLow}-${r.scoreHigh}, ${r.elo >= 0 ? '+' : ''}${r.elo} Elo) over ${r.games} games` };
}

// ---------- Ladder file ----------

export interface LadderEntry {
  /** Rating anchored at the first best version (1000). */
  elo: number;
  games: number;
}

export interface LadderFile {
  v: 1;
  best: string | null;
  ratings: Record<string, LadderEntry>;
  history: (MatchResult & { at: string; promoted: boolean; reason: string })[];
}

export const BASE_ELO = 1000;

export function emptyLadder(): LadderFile {
  return { v: 1, best: null, ratings: {}, history: [] };
}

export function loadLadder(path: string): LadderFile {
  if (!existsSync(path)) return emptyLadder();
  const l = JSON.parse(readFileSync(path, 'utf8')) as LadderFile;
  if (l.v !== 1) throw new Error(`${path}: unsupported ladder version ${l.v}`);
  return l;
}

export function saveLadder(path: string, ladder: LadderFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ladder, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Record a finished match against the ladder's current best: rate the candidate relative to the best, and make it
 * the new best when `promote` is set. A ladder with no best yet takes the match's `best` as its anchor.
 */
export function recordMatch(ladder: LadderFile, r: MatchResult, decision: { promote: boolean; reason: string }, at = new Date()): LadderFile {
  const next: LadderFile = structuredClone(ladder);
  if (next.best === null) {
    next.best = r.best;
    next.ratings[r.best] ??= { elo: BASE_ELO, games: 0 };
  }
  if (next.best !== r.best) throw new Error(`Match was against ${r.best} but the ladder's best is ${next.best}`);
  // The same entry on both sides would count every game twice.
  if (r.candidate === r.best) throw new Error(`Candidate ${r.candidate} is already the best version`);
  const bestEntry = next.ratings[r.best];
  bestEntry.games += r.games;
  const prev = next.ratings[r.candidate];
  next.ratings[r.candidate] = { elo: bestEntry.elo + r.elo, games: (prev?.games ?? 0) + r.games };
  if (decision.promote) next.best = r.candidate;
  next.history.push({ ...r, at: at.toISOString(), promoted: decision.promote, reason: decision.reason });
  return next;
}
