import { appendFileSync, writeFileSync } from 'node:fs';
import {
  applyAction,
  createRng,
  getMap,
  KILL_POINTS,
  legalMoves,
  placementPoints,
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
 * With `score: 'points'` a copy is scored by what the leaderboard ranks instead (pointsScore): placement points plus
 * KILL_POINTS per player the decider has eliminated, scaled so the placement spread is 0 to 1. `score: 'kills'` keeps
 * the share score and only adds the kill credit (KILL_POINTS / the placement spread per player eliminated).
 *
 * Range scores aim each specialist's teacher at its own objective (the range specialists, packages/delove/README.md):
 *
 * - `long` (Delove Long Range: reach the last 3 with the most kills): the share score plus `killWeight` times the kill
 *   credit, so a knock-out inside the rollout counts `killWeight` times what `kills` gives it;
 * - `mid` (Mid Range: finish top 2): with 3 alive, (1 - threat) * P(top 2) + threat * threat deflection. P(top 2) is
 *   1 minus the chance both rivals finish above (each read off the share-score gap as in `points`); the deflection
 *   is the share of the strongest rival's border armies that face the third player rather than the decider
 *   (python/targets.py threat_deflection). 2 alive (a rival fell) = top 2: 1; the decider out: 0; 4 or more alive:
 *   the share score;
 * - `close` (Close Range: win the duel): the share score (with 2 alive, the decider's share of the board) with a
 *   deeper search: `closeRollouts` copies of `closeHorizon` rounds instead of `rollouts` and `horizon`;
 * - `range`: per decision, by the non-neutral players alive: 4 or more `long`, 3 `mid`, 2 `close`.
 *
 * Setup and capital picks, decisions with a single option and the kinds in `skip` are played by the teacher directly.
 */
export const BRANCH_SCORES = ['share', 'points', 'kills', 'long', 'mid', 'close', 'range'] as const;
export type BranchScore = (typeof BRANCH_SCORES)[number];
/** How one decision's rollouts are scored (positionScore): a branch score with 'close' and 'range' resolved. */
export type ScoreMode = 'share' | 'points' | 'kills' | 'long' | 'mid';

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
   * How a rollout's end position is scored: 'share' (positionScore's share score), 'points' (pointsScore) or 'kills'
   * (the share score plus killCredit); the range scores 'long', 'mid', 'close' and 'range' (by players alive).
   */
  score: BranchScore;
  /** `long`: weight of the kill credit added to the share score. */
  killWeight: number;
  /** `mid`: weight of the threat deflection mixed with P(top 2). */
  threat: number;
  /** `close`: rollouts and horizon of the duel search (instead of `rollouts` and `horizon`). */
  closeRollouts: number;
  closeHorizon: number;
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
  score: 'share',
  killWeight: 2,
  threat: 0.3,
  closeRollouts: 12,
  closeHorizon: 2,
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

/** The range settings positionScore reads for 'long' (killWeight) and 'mid' (threat). */
export type RangeWeights = Pick<BranchOptions, 'killWeight' | 'threat'>;

/**
 * A rollout end position from `me`'s side. `mode` 'share' (the default): won 1, lost 0, otherwise the weighted share
 * score. `mode` 'points': pointsScore; 'kills': the share score plus killCredit; 'long': the share score plus
 * killWeight * killCredit; 'mid': P(top 2) mixed with the threat deflection (3 alive), see BranchOptions. The other
 * fields are the share parts either way.
 */
export function positionScore(
  s: GameState,
  me: PlayerId,
  w: BranchOptions['weights'],
  mode: ScoreMode = 'share',
  range: RangeWeights = DEFAULT_BRANCH,
): Score {
  const zero = { armies: 0, income: 0, territories: 0, cards: 0, continents: 0 };
  const all1 = { armies: 1, income: 1, territories: 1, cards: 1, continents: 1 };
  const points = mode === 'points';
  const kills = mode === 'kills';
  const long = mode === 'long';
  const mid = mode === 'mid';
  if (s.phase === 'finished') {
    const won = s.winner === me;
    const v = won ? 1 : 0;
    const score = points ? pointsScore(s, me, won ? 1 : null) : kills ? v + killCredit(s, me) : long ? v + range.killWeight * killCredit(s, me) : v;
    return won ? { score, ...all1, won: 1, lost: 0 } : { score, ...zero, won: 0, lost: 1 };
  }
  const alive = s.players.filter((p) => p.alive && !p.isNeutral);
  if (!alive.some((p) => p.id === me)) {
    const score = points ? pointsScore(s, me, null) : kills ? killCredit(s, me) : long ? 0 + range.killWeight * killCredit(s, me) : 0;
    return { score, ...zero, won: 0, lost: 1 };
  }
  const map = getMap(s.options.map);
  const by = (p: PlayerId) => {
    let territories = 0;
    let armies = 0;
    for (const t of map.territoryIds) if (s.territories[t].owner === p) (territories++, (armies += s.territories[t].armies));
    const r = reinforcementsFor(s, p);
    return { territories, armies, income: r.total, continents: r.continents.length, cards: s.players.find((x) => x.id === p)!.cards.length };
  };
  const all = alive.map((p) => ({ id: p.id, ...by(p.id) }));
  const n = all.length;
  const sum = (k: keyof typeof zero) => all.reduce((a, x) => a + x[k], 0);
  const totals = { armies: sum('armies'), income: sum('income'), territories: sum('territories'), cards: sum('cards'), continents: sum('continents') };
  const shares = (x: (typeof all)[number]) => ({
    armies: share(x.armies, totals.armies, n),
    income: share(x.income, totals.income, n),
    territories: share(x.territories, totals.territories, n),
    cards: share(x.cards, totals.cards, n),
    continents: share(x.continents, totals.continents, n),
  });
  const weighted = (sc: typeof zero) => w.armies * sc.armies + w.income * sc.income + w.territories * sc.territories + w.cards * sc.cards + w.continents * sc.continents;
  const sc = shares(all.find((x) => x.id === me)!);
  const mine = weighted(sc);
  // a rival's chance of finishing above me, read off the gap in share score (even shares: a coin flip; a lead of 1/n
  // of the board or more: certain)
  const beat = (x: (typeof all)[number]) => {
    const b = 0.5 + 0.5 * n * (mine - weighted(shares(x)));
    return b < 0 ? 0 : b > 1 ? 1 : b;
  };
  if (mid && n <= 2) return { score: 1, ...sc, won: 0, lost: 0 };
  if (mid && n === 3) {
    // P(top 2) = 1 - P(both rivals finish above me)
    let last = 1;
    for (const x of all) if (x.id !== me) last *= 1 - beat(x);
    const top2 = 1 - last;
    return { score: (1 - range.threat) * top2 + range.threat * threatDeflection(s, me, all.map((x) => ({ id: x.id, ...shares(x) }))), ...sc, won: 0, lost: 0 };
  }
  if (!points) return { score: kills ? mine + killCredit(s, me) : long ? mine + range.killWeight * killCredit(s, me) : mine, ...sc, won: 0, lost: 0 };
  // Expected place among the players still alive: 1 + for each rival the chance it finishes above me.
  let place = 1;
  for (const x of all) if (x.id !== me) place += 1 - beat(x);
  return { score: pointsScore(s, me, place), ...sc, won: 0, lost: 0 };
}

/**
 * With 3 alive: the share of the strongest rival's border armies that face the third player rather than `me`, in
 * 0..1 (0.5 when it touches neither). Strongest = largest army share + territory share (the first in seat order on a
 * tie); a border army is one on a territory adjacent to a territory of that player (one adjacent to both counts for
 * both). As python/targets.py threat_deflection reads it from the encoded position.
 */
export function threatDeflection(s: GameState, me: PlayerId, alive: { id: PlayerId; armies: number; territories: number }[]): number {
  let lead: PlayerId | null = null;
  let best = -Infinity;
  for (const x of alive) {
    if (x.id === me) continue;
    const v = x.armies + x.territories;
    if (v > best) (best = v), (lead = x.id);
  }
  const third = alive.find((x) => x.id !== me && x.id !== lead)!.id;
  const map = getMap(s.options.map);
  let onMe = 0;
  let onThird = 0;
  for (const t of map.territoryIds) {
    if (s.territories[t].owner !== lead) continue;
    let me1 = false;
    let th1 = false;
    for (const u of map.adjacency[t]) {
      const o = s.territories[u].owner;
      if (o === me) me1 = true;
      else if (o === third) th1 = true;
    }
    if (me1) onMe += s.territories[t].armies;
    if (th1) onThird += s.territories[t].armies;
  }
  const tot = onMe + onThird;
  return tot > 0 ? onThird / tot : 0.5;
}

/** The objective, rollouts and horizon of one decision under `opts` (with `alive` non-neutral players alive). */
export function decisionScore(opts: BranchOptions, alive: number): { mode: ScoreMode; rollouts: number; horizon: number } {
  const score = opts.score === 'range' ? (alive >= 4 ? 'long' : alive === 3 ? 'mid' : 'close') : opts.score;
  if (score === 'close') return { mode: 'share', rollouts: opts.closeRollouts, horizon: opts.closeHorizon };
  return { mode: score, rollouts: opts.rollouts, horizon: opts.horizon };
}

/** KILL_POINTS for each player `me` has eliminated, over the table's placement spread (pointsScore's scale). */
export function killCredit(s: GameState, me: PlayerId): number {
  const ranked = s.players.filter((p) => !p.isNeutral);
  const N = ranked.length;
  const kills = ranked.filter((p) => !p.alive && p.eliminatedBy === me).length;
  return (KILL_POINTS * kills) / (placementPoints(1, N) - placementPoints(N, N));
}

/**
 * The leaderboard's points for `me` at a rollout's end, scaled so last place is 0 and first place 1: placement points
 * (placementPoints for the table's ranked players) plus KILL_POINTS for each player `me` has eliminated. `place` is
 * the (possibly fractional, interpolated between the table's points) place while `me` is alive; null when `me` is out,
 * which places it just below the players still alive (players knocked out later in the same rollout are ignored).
 */
export function pointsScore(s: GameState, me: PlayerId, place: number | null): number {
  const ranked = s.players.filter((p) => !p.isNeutral);
  const N = ranked.length;
  const P = (i: number) => placementPoints(i, N);
  const kills = ranked.filter((p) => !p.alive && p.eliminatedBy === me).length;
  let pts: number;
  if (place === null) {
    const alive = ranked.filter((p) => p.alive).length;
    pts = P(alive + 1 > N ? N : alive + 1);
  } else {
    const i = Math.floor(place);
    const f = place - i;
    pts = i >= N ? P(N) : P(i) + f * (P(i + 1) - P(i));
  }
  return (pts + KILL_POINTS * kills - P(N)) / (P(1) - P(N));
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
      const ds = decisionScore(opts, dctx.state.players.filter((p) => p.alive && !p.isNeutral).length);
      const seeds = Array.from({ length: ds.rollouts }, () => Math.floor(dctx.random() * 0xffffffff) >>> 0);
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
          const r = rollout(after, ds.horizon, teacher, seededRandom(seed));
          branchStats.simulations++;
          branchStats.simulatedMoves += r.moves;
          const sc = positionScore(r.state, dctx.me, opts.weights, ds.mode, opts);
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
