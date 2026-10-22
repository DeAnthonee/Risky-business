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
 *
 * With a rollout network (branchAgent's `rolloutNet`, DELOVE_BRANCH_ROLLOUT) the copies are played forward by a Delove
 * network's top move instead of the teacher: in every seat (`seats: 'all'`), or in the decider's seat only with the
 * teacher in the others (`'self'`). Everything else (the options, the seeds, the scores, the pick) is unchanged.
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
   * How the options are chosen and searched: 'top' (the teacher's move and the ranker's `options - 1` favourites, every
   * option `rollouts` copies) or 'gumbel' (Gumbel root: the teacher's move and `gumbelK - 1` candidates sampled
   * without replacement from the ranker's logits plus Gumbel noise, searched by sequential halving; see gumbelRoot).
   */
  root: 'top' | 'gumbel';
  /** 'gumbel': candidates per decision (the teacher's move included). */
  gumbelK: number;
  /** 'gumbel': rollout copies per decision; 0 = `options` x the decision's rollouts (the 'top' budget). */
  copies: number;
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
  root: 'top',
  gumbelK: 8,
  copies: 0,
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

/**
 * A Delove network playing the rollouts (DELOVE_BRANCH_ROLLOUT): its top move (ties: the first candidate, as
 * `delove@N` plays) in every seat, or only in the decider's seat (`'self'`) with the teacher in the others.
 */
export interface RolloutNet {
  net: NetScorer;
  seats: 'all' | 'self';
}

/**
 * Determinized search under fog of war (branchAgent's `fog`, DELOVE_BRANCH_FOG=determinize; docs/delove-fog.md
 * section 4.2). In a fog game each rollout copy starts from a board `sample` draws from the seat's view (one board per
 * rollout seed, the same boards for every option, so options still differ only in the decision), and there are at
 * least `samples` copies per option. `anchor` makes the decisions that aren't branched and gives the option to beat by
 * the margin (the ranker's top move, what the seat plays without fog search); the teacher's own pick on the view is
 * the second option.
 */
export interface FogSearch {
  anchor: StepPick;
  sample: (state: GameState, me: PlayerId, random: () => number) => GameState;
  samples: number;
}

/** The best logit's index and its gap to the second best (Infinity with one candidate). */
function topGap(logits: Float32Array): { best: number; gap: number } {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  let second = -Infinity;
  for (let i = 0; i < logits.length; i++) if (i !== best && logits[i] > second) second = logits[i];
  return { best, gap: logits[best] - second };
}

/**
 * The player of one rollout copy: the network's top move in its seats, the teacher's in the rest. `gap` keeps the
 * smallest top-two logit gap of the network's picks, for the trace: a copy decided by a near-tie can play differently
 * with ONNX in Node than with PyTorch on the GPU.
 */
function rolloutPlayer(teacher: StepPick, rollout: RolloutNet, me: PlayerId): { pick: StepPick; gap: number } {
  const r = {
    gap: Infinity,
    pick: (ctx: StepContext): number => {
      if (rollout.seats === 'self' && ctx.me !== me) return teacher(ctx);
      if (ctx.candidates.length === 1) return 0;
      const t = topGap(rollout.net.score(ctx).logits);
      if (t.gap < r.gap) r.gap = t.gap;
      return t.best;
    },
  };
  return r;
}

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
 * (a Delove network) proposes the alternatives worth trying; `rolloutNet` (optional) is a network that plays the
 * rollouts instead of the teacher, in every seat or in the decider's only.
 */
/** Gumbel root constants (Danihelka et al. 2022, "Policy improvement by planning with Gumbel"): sigma(q) = (C_VISIT +
 * the most copies any candidate has) * C_SCALE * q, for scores on a 0..1 scale. */
export const GUMBEL_C_VISIT = 50;
export const GUMBEL_C_SCALE = 1;

/**
 * Sequential halving for `m` candidates (the teacher's move and m - 1 others) within `budget` copies: per round, the
 * candidates searched (the teacher's move always, plus the others still in) and the new copies each gets,
 * max(1, floor(budget / (rounds * candidates))). The others halve (rounded up) each round until one is left, so with
 * 8 candidates and 30 copies: 8 x 1, 5 x 1, 3 x 2, 2 x 3 (25 copies; the teacher's move and the finalist 7 each).
 */
export function gumbelSchedule(m: number, budget: number): { size: number; copies: number }[] {
  const sizes: number[] = [];
  for (let others = m - 1; ; others = Math.ceil(others / 2)) {
    sizes.push(1 + others);
    if (others <= 1) break;
  }
  return sizes.map((size) => ({ size, copies: Math.max(1, Math.floor(budget / (sizes.length * size))) }));
}

/** A Gumbel(0, 1) draw from a uniform one: -log(-log(u)) (Math.log: V8's fdlibm log, ported as log_fd on the GPU). */
export function gumbel(u: number): number {
  return -Math.log(-Math.log(u));
}

/**
 * branchAgent's decision with `root: 'gumbel'` (Gumbel AlphaZero's root, Danihelka et al. 2022), for one important
 * decision:
 *
 * 1. a Gumbel draw g per candidate, in candidate order, from the seat's stream (after the teacher's pick, before the
 *    fortify completions and the seeds);
 * 2. the candidates: the teacher's move first, then the `gumbelK - 1` others with the highest g + logit (the ranker's
 *    logits; all 0 without a ranker), ties in candidate order: sampling without replacement from softmax(logits);
 * 3. the copies: every candidate on the same seeded copies (common random numbers), copy j of every candidate on seed
 *    j; sequential halving (gumbelSchedule) over the budget, the others ranked after each round by
 *    g + logit + sigma(q), q the candidate's mean score so far (its copies' scores summed seed by seed, divided by
 *    their number), sigma(q) = (GUMBEL_C_VISIT + the most copies any candidate has) * GUMBEL_C_SCALE * q; the
 *    teacher's move is searched in every round, so it is never dropped and ends on the same copies as the finalist;
 * 4. the pick: the highest g + logit + sigma(q) among the teacher's move and the finalist, then the margin rule: the
 *    teacher's move unless the pick's mean beats it by `margin` (both on the same copies).
 *
 * The trace (DELOVE_BRANCH_TRACE) lists every searched candidate with its mean score and copies. valueWeight is not
 * supported here.
 */
function gumbelRoot(
  dctx: DecisionContext,
  base: StepContext,
  teacherIndex: number,
  teacher: StepPick,
  ranker: NetScorer | null,
  opts: BranchOptions,
  rolloutNet: RolloutNet | null,
): Action {
  const n = dctx.candidates.length;
  const logits = ranker ? ranker.score(base).logits : new Float32Array(n);
  const g = Array.from({ length: n }, () => gumbel(dctx.random()));
  const key = (i: number) => g[i] + logits[i];
  const rest = [...Array(n).keys()].filter((i) => i !== teacherIndex);
  rest.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return kb > ka ? 1 : kb < ka ? -1 : a - b;
  });
  const order = [teacherIndex, ...rest.slice(0, Math.max(0, opts.gumbelK - 1))];
  const actions: Action[] = [];
  const kept: number[] = [];
  const keys = new Set<string>();
  for (const i of order) {
    const a = completeAction(base, i, teacher);
    const k = JSON.stringify(a);
    if (!keys.has(k)) (keys.add(k), actions.push(a), kept.push(i));
  }
  if (actions.length === 1) return actions[0];

  branchStats.branched++;
  const kind = dctx.candidates[teacherIndex][0];
  branchStats.branchedByKind[kind] = (branchStats.branchedByKind[kind] ?? 0) + 1;
  const ds = decisionScore(opts, dctx.state.players.filter((p) => p.alive && !p.isNeutral).length);
  const m = actions.length;
  const plan = gumbelSchedule(m, opts.copies > 0 ? opts.copies : opts.options * ds.rollouts);
  const total = plan.reduce((a, r) => a + r.copies, 0);
  const seeds = Array.from({ length: total }, () => Math.floor(dctx.random() * 0xffffffff) >>> 0);
  const zeroScore = (): Score => ({ score: 0, armies: 0, income: 0, territories: 0, cards: 0, continents: 0, won: 0, lost: 0 });
  const sums = actions.map(zeroScore);
  const count = new Array<number>(m).fill(0);
  const dead = new Array<boolean>(m).fill(false);
  const copyScores: { score: number; gap: number }[][] = actions.map(() => []);
  const play = (o: number) => {
    if (dead[o]) return;
    const seed = seeds[count[o]];
    const copy: GameState = { ...dctx.state, rngState: seed, deck: shuffle(createRng(seed ^ 0x5bd1e995), dctx.state.deck) };
    let after: GameState;
    try {
      after = applyAction(copy, dctx.me, actions[o]).state;
    } catch {
      dead[o] = true;
      return;
    }
    const player = rolloutNet ? rolloutPlayer(teacher, rolloutNet, dctx.me) : null;
    const r = rollout(after, ds.horizon, player ? player.pick : teacher, seededRandom(seed));
    branchStats.simulations++;
    branchStats.simulatedMoves += r.moves;
    const sc = positionScore(r.state, dctx.me, opts.weights, ds.mode, opts);
    if (player) copyScores[o].push({ score: sc.score, gap: player.gap });
    for (const k of Object.keys(sums[o]) as (keyof Score)[]) sums[o][k] += sc[k];
    count[o]++;
  };
  const mean = (o: number) => (dead[o] ? -Infinity : sums[o].score / count[o]);
  const priority = (o: number) => {
    const most = Math.max(...count);
    return key(kept[o]) + (GUMBEL_C_VISIT + most) * GUMBEL_C_SCALE * mean(o);
  };
  let live = [...Array(m).keys()];
  for (let r = 0; r < plan.length; r++) {
    for (const o of live) for (let c = 0; c < plan[r].copies; c++) play(o);
    if (r === plan.length - 1) break;
    const others = live.filter((o) => o !== 0);
    others.sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      return pb > pa ? 1 : pb < pa ? -1 : a - b;
    });
    live = [0, ...others.slice(0, plan[r + 1].size - 1).sort((a, b) => a - b)];
  }
  let best = live[0];
  for (const o of live) if (priority(o) > priority(best)) best = o;
  if (best !== 0 && mean(best) - mean(0) < opts.margin) best = 0;
  if (best !== 0) {
    branchStats.changed++;
    branchStats.changedByKind[kind] = (branchStats.changedByKind[kind] ?? 0) + 1;
  }
  branchStats.gain += mean(best) - mean(0);
  if (TRACE) {
    const line: Record<string, unknown> = {
      game: dctx.state.id, turn: dctx.state.turnNumber, seat: dctx.seat, options: kept, means: kept.map((_, o) => mean(o)), copies: count, best,
    };
    if (rolloutNet) {
      line.scores = copyScores.map((o) => o.map((c) => c.score));
      line.gaps = copyScores.map((o) => o.map((c) => (Number.isFinite(c.gap) ? c.gap : null)));
    }
    appendFileSync(TRACE, JSON.stringify(line) + '\n');
  }
  for (const k of Object.keys(branchStats.chosen) as (keyof Score)[]) branchStats.chosen[k] += sums[best][k] / count[best];
  return actions[best];
}

export function branchAgent(
  id: string,
  teacher: StepPick,
  ranker: NetScorer | null,
  opts: BranchOptions = DEFAULT_BRANCH,
  /** Rates branch end positions when opts.valueWeight > 0 (a NetScorer with its .value.onnx). */
  valuer: NetScorer | null = null,
  rolloutNet: RolloutNet | null = null,
  /** Determinized rollouts in fog games (FogSearch); without it, the copies are of the state as given. */
  fog: FogSearch | null = null,
): Agent {
  if (opts.root === 'gumbel' && opts.valueWeight > 0) throw new Error('branch: the Gumbel root does not blend the value head (valueWeight must be 0)');
  return {
    id,
    choose(dctx) {
      if (dctx.candidates.length === 0) return null;
      const base: StepContext = { ...dctx, fortifyFrom: null };
      branchStats.decisions++;
      const fogged = fog !== null && !!dctx.state.options.fogOfWar;
      const lead = fogged ? fog.anchor : teacher;
      const teacherIndex = lead(base);
      if (!isImportant(dctx) || opts.skip.includes(dctx.candidates[teacherIndex][0])) return completeAction(base, teacherIndex, lead);
      if (opts.root === 'gumbel' && !fogged) return gumbelRoot(dctx, base, teacherIndex, teacher, ranker, opts, rolloutNet);

      // Options: the teacher's move first (under fog search: the anchor's, then the teacher's), then the network's favourites.
      const order: number[] = [teacherIndex];
      if (fogged) {
        const t = teacher(base);
        if (!order.includes(t)) order.push(t);
      }
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
        const a = completeAction(base, i, lead);
        const k = JSON.stringify(a);
        if (!keys.has(k)) (keys.add(k), actions.push(a));
      }
      if (actions.length === 1) return actions[0];

      branchStats.branched++;
      const kind = dctx.candidates[teacherIndex][0];
      branchStats.branchedByKind[kind] = (branchStats.branchedByKind[kind] ?? 0) + 1;
      const ds = decisionScore(opts, dctx.state.players.filter((p) => p.alive && !p.isNeutral).length);
      const seeds = Array.from({ length: fogged ? Math.max(ds.rollouts, fog.samples) : ds.rollouts }, () => Math.floor(dctx.random() * 0xffffffff) >>> 0);
      // Under fog search: one sampled board per seed, shared by every option (common random numbers).
      const boards = fogged ? seeds.map((seed) => fog.sample(dctx.state, dctx.me, seededRandom(seed ^ 0x2545f491))) : null;
      const useValue = opts.valueWeight > 0 && valuer !== null;
      const ends: { option: number; state: GameState }[] = [];
      // with a rollout network: each copy's score and smallest logit gap, option by option (for the trace)
      const copies: { score: number; gap: number }[][] = [];
      const results: { mean: number; parts: Score }[] = actions.map((action, option) => {
        const parts: Score = { score: 0, armies: 0, income: 0, territories: 0, cards: 0, continents: 0, won: 0, lost: 0 };
        const mine: { score: number; gap: number }[] = [];
        copies.push(mine);
        for (const [n, seed] of seeds.entries()) {
          const copy: GameState = boards
            ? { ...boards[n], rngState: seed }
            : { ...dctx.state, rngState: seed, deck: shuffle(createRng(seed ^ 0x5bd1e995), dctx.state.deck) };
          let after: GameState;
          try {
            after = applyAction(copy, dctx.me, action).state;
          } catch {
            parts.score = -Infinity;
            break;
          }
          const player = rolloutNet ? rolloutPlayer(teacher, rolloutNet, dctx.me) : null;
          const r = rollout(after, ds.horizon, player ? player.pick : teacher, seededRandom(seed));
          branchStats.simulations++;
          branchStats.simulatedMoves += r.moves;
          const sc = positionScore(r.state, dctx.me, opts.weights, ds.mode, opts);
          if (player) mine.push({ score: sc.score, gap: player.gap });
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
        const line: Record<string, unknown> = { game: dctx.state.id, turn: dctx.state.turnNumber, seat: dctx.seat, options, means: results.map((r) => r.mean), best };
        if (rolloutNet) {
          // per option, per copy: the score, and the smallest logit gap of its network picks (null: none)
          line.scores = copies.map((o) => o.map((c) => c.score));
          line.gaps = copies.map((o) => o.map((c) => (Number.isFinite(c.gap) ? c.gap : null)));
        }
        appendFileSync(TRACE, JSON.stringify(line) + '\n');
      }
      for (const k of Object.keys(branchStats.chosen) as (keyof Score)[]) branchStats.chosen[k] += results[best].parts[k];
      return actions[best];
    },
  };
}

export type { Candidate };
