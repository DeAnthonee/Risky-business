import { appendFileSync, writeFileSync } from 'node:fs';
import {
  applyAction,
  createRng,
  getMap,
  legalMoves,
  reinforcementsFor,
  shuffle,
  type Action,
  type GameState,
  type PlayerId,
} from '@risk/engine';
import {
  candidateToAction,
  candidates,
  decisionInput,
  encodeDecision,
  makeTraits,
  seededRandom,
  type Agent,
  type Candidate,
  type DecisionContext,
  type StepContext,
} from '@risk/selfplay';
import type { NetScorer } from './net-agent.js';
import { seatOrder } from './net-agent.js';

/** The value model ignores candidates; one placeholder keeps the encoder's shapes valid. */
const END_ONLY: Candidate[] = [['end_turn']];

/**
 * Branch and score: a player that settles each important decision by trying its options.
 *
 * The options are the rollout teacher's own move plus the network's next best candidates. Every option is played on
 * copies of the board `rollouts` times, each copy with its own dice and deck order, the same set of copies for every
 * option (common random numbers), so the only difference between branches is the decision itself. Each copy plays
 * `horizon` rounds forward with the teacher in every seat, and is scored from the decider's side:
 *
 *   won 1, eliminated or lost 0, otherwise a weighted share against the other players still alive of
 *   armies, income (next turn's reinforcements), territories, cards and continents held.
 *
 * Shares capture both halves of "make me stronger and them weaker": taking an opponent's cards or breaking their
 * bonus lowers their share as surely as gaining my own. The option with the best average is played (the teacher's
 * own move unless another beats it by `margin`), so the game the logs record follows the improved choices.
 *
 * Setup and capital picks, decisions with a single option and the kinds in `skip` are played by the teacher directly.
 */
export interface BranchOptions {
  /** Options compared per decision (the teacher's move + network candidates). */
  options: number;
  rollouts: number;
  horizon: number;
  /** Keep the teacher's move unless an alternative scores this much better. */
  margin: number;
  /** Decision kinds (of the teacher's move) played by the teacher without branching, e.g. 'occupy'. */
  skip: string[];
  weights: { armies: number; income: number; territories: number; cards: number; continents: number };
  /**
   * Blend of the network's win chance into a branch's score: score = (1 - valueWeight) * objective share +
   * valueWeight * V(end position), V from the valuer's batched value model (one call per decision). 0 = off.
   */
  valueWeight: number;
}

/**
 * Measured over 2,000 two-player Classic games against delove-teacher@2 each (scripts/branch-variant.sh, README):
 * 3 options instead of 4 and playing occupy decisions without branching lost nothing and cut the time per game by
 * 39%; 4 rollouts instead of 6 cost about 0.035 of score, so rollouts stay at 6.
 */
export const DEFAULT_BRANCH: BranchOptions = {
  options: 3,
  rollouts: 6,
  horizon: 2,
  margin: 0.02,
  skip: ['occupy'],
  valueWeight: 0,
  weights: { armies: 0.3, income: 0.3, territories: 0.15, cards: 0.15, continents: 0.1 },
};

/** What branching did, for the round's summary (written by writeBranchStats). */
export const branchStats = {
  decisions: 0,
  branched: 0,
  simulations: 0,
  simulatedMoves: 0,
  changed: 0,
  /** Sum over branched decisions of (best option's score - teacher move's score). */
  gain: 0,
  changedByKind: {} as Record<string, number>,
  branchedByKind: {} as Record<string, number>,
  /** Average share-score components of the chosen branch end positions, summed (divide by branched). */
  chosen: { score: 0, armies: 0, income: 0, territories: 0, cards: 0, continents: 0, won: 0, lost: 0 },
};

/**
 * DELOVE_BRANCH_TRACE=<file>: append one JSON line per branched decision (game id, turn, seat, the options as candidate
 * indexes, each option's mean score, the pick). For checking other implementations of branch and score option by
 * option (packages/delove-gpu/tests/branch_replay.py); off by default.
 */
const TRACE = process.env.DELOVE_BRANCH_TRACE;

export function writeBranchStats(path: string): void {
  writeFileSync(path, JSON.stringify(branchStats, null, 2));
}

type StepPick = (ctx: StepContext) => number;

interface Score {
  score: number;
  armies: number;
  income: number;
  territories: number;
  cards: number;
  continents: number;
  won: number;
  lost: number;
}

function share(mine: number, total: number, players: number): number {
  return total > 0 ? mine / total : 1 / players;
}

export function positionScore(s: GameState, me: PlayerId, w: BranchOptions['weights']): Score {
  const zero = { armies: 0, income: 0, territories: 0, cards: 0, continents: 0 };
  const all1 = { armies: 1, income: 1, territories: 1, cards: 1, continents: 1 };
  if (s.phase === 'finished') return s.winner === me ? { score: 1, ...all1, won: 1, lost: 0 } : { score: 0, ...zero, won: 0, lost: 1 };
  const alive = s.players.filter((p) => p.alive && !p.isNeutral);
  if (!alive.some((p) => p.id === me)) return { score: 0, ...zero, won: 0, lost: 1 };
  const map = getMap(s.options.map);
  const by = (p: PlayerId) => {
    let territories = 0;
    let armies = 0;
    for (const t of map.territoryIds) if (s.territories[t].owner === p) (territories++, (armies += s.territories[t].armies));
    const r = reinforcementsFor(s, p);
    return { territories, armies, income: r.total, continents: r.continents.length, cards: s.players.find((x) => x.id === p)!.cards.length };
  };
  const all = alive.map((p) => ({ id: p.id, ...by(p.id) }));
  const mine = all.find((x) => x.id === me)!;
  const n = all.length;
  const sum = (k: keyof typeof zero) => all.reduce((a, x) => a + x[k], 0);
  const sc = {
    armies: share(mine.armies, sum('armies'), n),
    income: share(mine.income, sum('income'), n),
    territories: share(mine.territories, sum('territories'), n),
    cards: share(mine.cards, sum('cards'), n),
    continents: share(mine.continents, sum('continents'), n),
  };
  const score = w.armies * sc.armies + w.income * sc.income + w.territories * sc.territories + w.cards * sc.cards + w.continents * sc.continents;
  return { score, ...sc, won: 0, lost: 0 };
}

const MAX_ROLLOUT_STEPS = 4000;

/** Play `state` forward `horizon` rounds (or to the end) with `pick` in every seat. */
function rollout(state: GameState, horizon: number, pick: StepPick, random: () => number): { state: GameState; moves: number } {
  let s = state;
  const stopRound = s.round + horizon;
  const traits = makeTraits();
  const seats = seatOrder(s);
  let moves = 0;
  while (s.phase !== 'finished' && s.round < stopRound && moves < MAX_ROLLOUT_STEPS) {
    const p = s.currentPlayer!;
    const legal = legalMoves(s, p);
    const cands = candidates(s, p, legal);
    if (cands.length === 0) break;
    const ctx: StepContext = { state: s, me: p, seat: seats.indexOf(p), legal, candidates: cands, traits, random, fortifyFrom: null };
    const action = completeAction(ctx, pick(ctx), pick);
    s = applyAction(s, p, action).state;
    moves++;
  }
  return { state: s, moves };
}

/** The engine action for candidate i of a step, asking `pick` for the destination after a fortify_from. */
function completeAction(ctx: StepContext, i: number, pick: StepPick): Action {
  const map = getMap(ctx.state.options.map);
  const c = ctx.candidates[i];
  if (c[0] !== 'fortify_from') return candidateToAction(map, c);
  const second = candidates(ctx.state, ctx.me, ctx.legal, map.territoryIds[c[1]]);
  const j = pick({ ...ctx, candidates: second, fortifyFrom: c[1] });
  return candidateToAction(map, second[j], c[1]);
}

function isImportant(ctx: DecisionContext): boolean {
  const ph = ctx.state.phase;
  return (ph === 'reinforce' || ph === 'attack' || ph === 'fortify') && ctx.candidates.length > 1;
}

/**
 * The branching player. `teacher` plays every seat in the rollouts and makes the unimportant decisions; `ranker`
 * (a Delove network) proposes the alternatives worth trying.
 */
export function branchAgent(
  id: string,
  teacher: StepPick,
  ranker: NetScorer | null,
  opts: BranchOptions = DEFAULT_BRANCH,
  /** Rates branch end positions when opts.valueWeight > 0 (a NetScorer with its .value.onnx). */
  valuer: NetScorer | null = null,
): Agent {
  return {
    id,
    choose(dctx) {
      if (dctx.candidates.length === 0) return null;
      const base: StepContext = { ...dctx, fortifyFrom: null };
      branchStats.decisions++;
      const teacherIndex = teacher(base);
      if (!isImportant(dctx) || opts.skip.includes(dctx.candidates[teacherIndex][0])) return completeAction(base, teacherIndex, teacher);

      // Options: the teacher's move first, then the network's favourites.
      const order: number[] = [teacherIndex];
      if (ranker) {
        const { logits } = ranker.score(base);
        const ranked = [...logits.keys()].sort((a, b) => logits[b] - logits[a]);
        for (const i of ranked) if (order.length < opts.options && !order.includes(i)) order.push(i);
      } else {
        for (let i = 0; i < dctx.candidates.length && order.length < opts.options; i++) if (!order.includes(i)) order.push(i);
      }
      const actions: Action[] = [];
      const keys = new Set<string>();
      for (const i of order) {
        const a = completeAction(base, i, teacher);
        const k = JSON.stringify(a);
        if (!keys.has(k)) (keys.add(k), actions.push(a));
      }
      if (actions.length === 1) return actions[0];

      branchStats.branched++;
      const kind = dctx.candidates[teacherIndex][0];
      branchStats.branchedByKind[kind] = (branchStats.branchedByKind[kind] ?? 0) + 1;
      const seeds = Array.from({ length: opts.rollouts }, () => Math.floor(dctx.random() * 0xffffffff) >>> 0);
      const useValue = opts.valueWeight > 0 && valuer !== null;
      const ends: { option: number; state: GameState }[] = [];
      const results: { mean: number; parts: Score }[] = actions.map((action, option) => {
        const parts: Score = { score: 0, armies: 0, income: 0, territories: 0, cards: 0, continents: 0, won: 0, lost: 0 };
        for (const seed of seeds) {
          const copy: GameState = { ...dctx.state, rngState: seed, deck: shuffle(createRng(seed ^ 0x5bd1e995), dctx.state.deck) };
          let after: GameState;
          try {
            after = applyAction(copy, dctx.me, action).state;
          } catch {
            parts.score = -Infinity;
            break;
          }
          const r = rollout(after, opts.horizon, teacher, seededRandom(seed));
          branchStats.simulations++;
          branchStats.simulatedMoves += r.moves;
          const sc = positionScore(r.state, dctx.me, opts.weights);
          for (const k of Object.keys(parts) as (keyof Score)[]) parts[k] += sc[k];
          if (useValue) ends.push({ option, state: r.state });
        }
        for (const k of Object.keys(parts) as (keyof Score)[]) parts[k] /= seeds.length;
        return { mean: parts.score, parts };
      });
      if (useValue) {
        // One batched value call for every unfinished end position; a finished game is worth its result.
        const open = ends.filter((e) => e.state.phase !== 'finished');
        const traits = makeTraits();
        const v = valuer!.values(
          open.map((e) => encodeDecision(decisionInput(e.state, seatOrder(e.state), dctx.me, traits, END_ONLY))),
          dctx.state.options.map,
        );
        const sum = new Array<number>(actions.length).fill(0);
        let j = 0;
        for (const e of ends) sum[e.option] += e.state.phase === 'finished' ? (e.state.winner === dctx.me ? 1 : 0) : v[j++];
        results.forEach((r, i) => {
          if (Number.isFinite(r.mean)) r.mean = (1 - opts.valueWeight) * r.mean + (opts.valueWeight * sum[i]) / seeds.length;
        });
      }
      let best = 0;
      for (let i = 1; i < results.length; i++) if (results[i].mean > results[best].mean) best = i;
      if (best !== 0 && results[best].mean - results[0].mean < opts.margin) best = 0;
      if (best !== 0) {
        branchStats.changed++;
        branchStats.changedByKind[kind] = (branchStats.changedByKind[kind] ?? 0) + 1;
      }
      branchStats.gain += results[best].mean - results[0].mean;
      if (TRACE) {
        const options = order.slice(0, actions.length);
        appendFileSync(TRACE, JSON.stringify({ game: dctx.state.id, turn: dctx.state.turnNumber, seat: dctx.seat, options, means: results.map((r) => r.mean), best }) + '\n');
      }
      for (const k of Object.keys(branchStats.chosen) as (keyof Score)[]) branchStats.chosen[k] += results[best].parts[k];
      return actions[best];
    },
  };
}

export type { Candidate };
