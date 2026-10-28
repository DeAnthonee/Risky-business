import { applyAction, getMap, type Action, type GameState } from '@risk/engine';
import { candidateToAction, candidates, decisionInput, encodeDecision, stepAgent, type Agent, type Candidate, type Features, type StepContext } from '@risk/selfplay';
import { focusSeats, focusView } from './focus.js';
import { NetScorer, seatOrder } from './net-agent.js';

/**
 * Value-guided lookahead: a Delove network that thinks one move ahead.
 *
 * At each decision the policy proposes its `topK` candidates. Each one is played out on a copy of the board and the
 * value model rates the position it leads to from the decider's side; attacks are rolled `samples` times with fresh
 * dice (never the game's own dice) and averaged. A fortify source is rated by its best destination. The move picked
 * maximises Q + priorWeight * log(prior): the lookahead decides, the policy breaks near-ties. The setup phase (one
 * army at a time) and moves the policy is `confident` about are played from the policy alone.
 *
 * The board copy has an empty deck, so a lookahead never sees the cards to come (live seats have none either).
 */
export interface SearchOptions {
  topK: number;
  samples: number;
  priorWeight: number;
  /** 0 plays the best score; above 0 samples softmax(score / temperature) with ctx.random (training games). */
  temperature: number;
  /** Play the policy's move without looking ahead when it is at least this sure (saves most of the time). */
  confident: number;
}

export const DEFAULT_SEARCH: SearchOptions = { topK: 4, samples: 8, priorWeight: 0.1, temperature: 0, confident: 0.9 };

const END_ONLY: Candidate[] = [['end_turn']];

interface Leaf {
  /** Index of the candidate this position is for. */
  cand: number;
  /** Win probability fixed without the network (the game ended). */
  fixed: number | null;
  features: Features | null;
}

function softmax(xs: ArrayLike<number>, t = 1): number[] {
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) max = Math.max(max, xs[i]);
  const e = Array.from(xs, (x) => Math.exp((x - max) / t));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

/** A seeded 32-bit value from ctx.random, for the lookahead's own dice. */
const freshSeed = (random: () => number) => Math.floor(random() * 0xffffffff) >>> 0;

export class Lookahead {
  constructor(
    readonly scorer: NetScorer,
    readonly opts: SearchOptions = DEFAULT_SEARCH,
  ) {}

  /** The candidate index to play, and the lookahead's rating of every candidate it rated (NaN for the others). */
  pick(ctx: StepContext): { index: number; q: Float64Array } {
    const C = ctx.candidates.length;
    const q = new Float64Array(C).fill(NaN);
    if (C === 1) return { index: 0, q };
    const { logits } = this.scorer.score(ctx);
    const prior = softmax(logits);
    const order = [...prior.keys()].sort((a, b) => prior[b] - prior[a]).slice(0, this.opts.topK);
    if (ctx.state.phase === 'setup' || prior[order[0]] >= this.opts.confident) return { index: order[0], q };
    const map = getMap(ctx.state.options.map);
    // A mega table: each leaf is seen through the decider's focused view, like the policy (focus.ts).
    const seatIds = focusSeats(focusView(ctx.state, ctx.me), seatOrder(ctx.state));
    const base: GameState = { ...ctx.state, deck: [], discard: [] };
    const leaves: Leaf[] = [];
    const leaf = (cand: number, after: GameState) => {
      if (after.phase === 'finished') return leaves.push({ cand, fixed: after.winner === ctx.me ? 1 : 0, features: null });
      const view = seatIds.length < seatOrder(after).length ? focusView(after, ctx.me) : after;
      leaves.push({ cand, fixed: null, features: encodeDecision(decisionInput(view, focusSeats(view, seatIds), ctx.me, ctx.traits, END_ONLY)) });
    };
    const play = (cand: number, action: Action, state: GameState = base) => {
      try {
        leaf(cand, applyAction(state, ctx.me, action).state);
      } catch {
        // A move the copy cannot replay (should not happen) is rated by the policy alone.
      }
    };

    for (const i of order) {
      const c = ctx.candidates[i];
      switch (c[0]) {
        case 'end_turn':
          // Ending the turn changes nothing on the board: rate the position as it stands.
          leaves.push({ cand: i, fixed: null, features: encodeDecision(decisionInput(ctx.state, seatIds, ctx.me, ctx.traits, END_ONLY)) });
          break;
        case 'attack':
          for (let k = 0; k < this.opts.samples; k++) play(i, candidateToAction(map, c), { ...base, rngState: freshSeed(ctx.random) });
          break;
        case 'fortify_from': {
          const from = map.territoryIds[c[1]];
          for (const d of candidates(base, ctx.me, ctx.legal, from)) play(i, candidateToAction(map, d, c[1]));
          break;
        }
        case 'fortify_to':
          play(i, candidateToAction(map, c, ctx.fortifyFrom ?? undefined));
          break;
        default:
          play(i, candidateToAction(map, c));
      }
    }

    const toRate = leaves.filter((l) => l.features);
    const rated = this.scorer.values(toRate.map((l) => l.features!), map.id, !!ctx.state.options.fogOfWar);
    let r = 0;
    const sums = new Map<number, { sum: number; n: number; max: number; fortify: boolean }>();
    for (const l of leaves) {
      const v = l.fixed ?? rated[r++];
      const fortify = ctx.candidates[l.cand][0] === 'fortify_from';
      const s = sums.get(l.cand) ?? { sum: 0, n: 0, max: -Infinity, fortify };
      s.sum += v;
      s.n++;
      s.max = Math.max(s.max, v);
      sums.set(l.cand, s);
    }
    const score = new Float64Array(C).fill(-Infinity);
    for (const [i, s] of sums) {
      q[i] = s.fortify ? s.max : s.sum / s.n;
      score[i] = q[i] + this.opts.priorWeight * Math.log(Math.max(prior[i], 1e-9));
    }
    if (sums.size === 0) return { index: order[0], q };
    if (this.opts.temperature > 0) {
      const ids = [...sums.keys()];
      const p = softmax(ids.map((i) => score[i]), this.opts.temperature);
      let x = ctx.random();
      for (let j = 0; j < ids.length; j++) if ((x -= p[j]) <= 0) return { index: ids[j], q };
      return { index: ids[ids.length - 1], q };
    }
    let best = order[0];
    for (const i of sums.keys()) if (score[i] > score[best] || !Number.isFinite(score[best])) best = i;
    return { index: best, q };
  }
}

/** A Delove version that plays with the lookahead (policy model + its batched value model). */
export function searchAgent(id: string, modelPath: string, valuePath: string, opts: Partial<SearchOptions> = {}): Agent {
  const look = new Lookahead(new NetScorer(modelPath, valuePath), { ...DEFAULT_SEARCH, ...opts });
  return stepAgent(id, (ctx) => look.pick(ctx).index);
}

