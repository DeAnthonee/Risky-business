import { applyAction, chooseZergAction, createRng, getMap, legalMoves, reinforcementsFor, shuffle, type Action, type GameState, type PlayerId } from '@risk/engine';
import { candidateToAction, candidates, isZergName, makeTraits, seededRandom, type Agent, type Candidate, type DecisionContext } from '@risk/selfplay';
import { seatOrder, type NetScorer } from './net-agent.js';

/**
 * A searching Zerg (docs/zergs.md, the trained line): branch and score for the horde. The Zerg's own move
 * (`chooseZergAction`) and a few alternatives are each played on the same `rollouts` copies of the board (own dice and
 * deck per copy, common to every option), `horizon` rounds forward, with every Zerg playing `chooseZergAction` and
 * every other seat playing `opponent` (a model of the prey, default Jacob Sensei 2). The copy is scored for the
 * **horde**, not the seat:
 *
 *   killWeight × prey knocked out since the decision + the horde's share of the alive players' armies and income
 *   (a finished game: killWeight × prey out + 1 if the horde won, else + 0).
 *
 * Alternatives never attack a fellow Zerg. They come from `ranker` (a Delove network's favourite candidates, ally
 * attacks removed) or, without one, from the best-odds attacks on prey plus ending the attack. Only attack-phase
 * decisions and placements branch; the rest is the hand-coded Zerg's move. This is the teacher for a trained Zerg
 * network (the search moves the student, as in Delove's cycles). Not a mirrored file (packages/delove-gpu).
 */
export interface ZergBranchOptions {
  options: number;
  rollouts: number;
  horizon: number;
  killWeight: number;
  /** The Zerg's own move is kept unless another beats it by this much. */
  margin: number;
}

export const DEFAULT_ZERG_BRANCH: ZergBranchOptions = { options: 4, rollouts: 8, horizon: 2, killWeight: 1, margin: 0.02 };

const MAX_ROLLOUT_STEPS = 4000;

/** The horde of a self-play board: every seat named after a Zerg agent (only the harness names seats), plus me. */
export function hordeOf(state: GameState, me: PlayerId): Set<PlayerId> {
  const horde = new Set(state.players.filter((p) => isZergName(p.name)).map((p) => p.id));
  horde.add(me);
  return horde;
}

/** The horde's score of a position (see the top of this file). `preyAtStart`: prey alive when the decision was made. */
export function hordeScore(s: GameState, horde: ReadonlySet<PlayerId>, preyAtStart: number, killWeight: number): number {
  const prey = s.players.filter((p) => p.alive && !p.isNeutral && !horde.has(p.id));
  const kills = killWeight * Math.max(0, preyAtStart - prey.length);
  if (s.phase === 'finished') return kills + (s.winner !== null && horde.has(s.winner) ? 1 : 0);
  if (prey.length === 0) return kills + 1;
  const map = getMap(s.options.map);
  let hordeStrength = 0;
  let total = 0;
  for (const p of s.players) {
    if (!p.alive || p.isNeutral) continue;
    let armies = 0;
    for (const t of map.territoryIds) if (s.territories[t].owner === p.id) armies += s.territories[t].armies;
    const strength = armies + 3 * reinforcementsFor(s, p.id).total;
    total += strength;
    if (horde.has(p.id)) hordeStrength += strength;
  }
  return kills + (total > 0 ? hordeStrength / total : 0);
}

function attacksAlly(state: GameState, horde: ReadonlySet<PlayerId>, a: Action): boolean {
  return a.type === 'attack' && horde.has(state.territories[a.to].owner ?? '');
}

/** Play forward `horizon` rounds: Zergs play the hand-coded horde bot, everyone else `opponent`. */
function rollout(state: GameState, horizon: number, horde: ReadonlySet<PlayerId>, opponent: Agent, random: () => number): GameState {
  let s = state;
  const stop = s.round + horizon;
  const traits = makeTraits();
  const seats = seatOrder(s);
  for (let steps = 0; s.phase !== 'finished' && s.round < stop && steps < MAX_ROLLOUT_STEPS; steps++) {
    const p = s.currentPlayer!;
    let action: Action | null;
    if (horde.has(p)) action = chooseZergAction(s, p, horde, random);
    else {
      const legal = legalMoves(s, p);
      action = opponent.choose({ state: s, me: p, seat: seats.indexOf(p), legal, candidates: candidates(s, p, legal), traits, random });
    }
    try {
      s = applyAction(s, p, action ?? { type: 'surrender' }).state;
    } catch {
      s = applyAction(s, p, { type: 'surrender' }).state;
    }
  }
  return s;
}

function alternatives(ctx: DecisionContext, horde: ReadonlySet<PlayerId>, ranker: NetScorer | null, n: number): Action[] {
  const map = getMap(ctx.state.options.map);
  const usable = ctx.candidates.map((c, i) => ({ c, i })).filter(({ c }) => c[0] !== 'fortify_from' && c[0] !== 'fortify_to');
  let order: Candidate[];
  if (ranker) {
    const { logits } = ranker.score({ ...ctx, fortifyFrom: null });
    order = [...usable].sort((a, b) => logits[b.i] - logits[a.i]).map((x) => x.c);
  } else {
    // Best-odds attacks on prey first (attacker's armies over the defender's), then ending the attack.
    const odds = (c: Candidate) => (c[0] === 'attack' ? ctx.state.territories[map.territoryIds[c[1]]].armies / Math.max(1, ctx.state.territories[map.territoryIds[c[2]]].armies) : c[0] === 'end_turn' ? 0.5 : -1);
    order = usable.map((x) => x.c).filter((c) => odds(c) >= 0).sort((a, b) => odds(b) - odds(a));
  }
  const out: Action[] = [];
  for (const c of order) {
    if (out.length >= n) break;
    const a = candidateToAction(map, c);
    if (!attacksAlly(ctx.state, horde, a)) out.push(a);
  }
  return out;
}

export function zergBranchAgent(id: string, opponent: Agent, ranker: NetScorer | null = null, opts: ZergBranchOptions = DEFAULT_ZERG_BRANCH): Agent {
  if (!isZergName(id)) throw new Error(`a Zerg agent's id must start with "zerg" (got ${id}) so its allies recognise it`);
  return {
    id,
    choose(ctx) {
      const horde = hordeOf(ctx.state, ctx.me);
      const own = chooseZergAction(ctx.state, ctx.me, horde, ctx.random);
      const phase = ctx.state.phase;
      if (!own || ctx.legal.pendingConquest || (phase !== 'attack' && phase !== 'reinforce') || own.type === 'surrender' || own.type === 'trade') return own;
      if (phase === 'reinforce' && own.type !== 'place') return own;

      const actions: Action[] = [own];
      const keys = new Set([JSON.stringify(own)]);
      for (const a of alternatives(ctx, horde, ranker, opts.options * 2)) {
        if (actions.length >= opts.options) break;
        const k = JSON.stringify(a);
        if (!keys.has(k)) (keys.add(k), actions.push(a));
      }
      if (actions.length === 1) return own;

      const preyAtStart = ctx.state.players.filter((p) => p.alive && !p.isNeutral && !horde.has(p.id)).length;
      const seeds = Array.from({ length: opts.rollouts }, () => Math.floor(ctx.random() * 0xffffffff) >>> 0);
      const means = actions.map((action) => {
        let sum = 0;
        for (const seed of seeds) {
          const copy: GameState = { ...ctx.state, rngState: seed, deck: shuffle(createRng(seed ^ 0x5bd1e995), ctx.state.deck) };
          let after: GameState;
          try {
            after = applyAction(copy, ctx.me, action).state;
          } catch {
            return -Infinity;
          }
          sum += hordeScore(rollout(after, opts.horizon, horde, opponent, seededRandom(seed)), horde, preyAtStart, opts.killWeight);
        }
        return sum / seeds.length;
      });
      let best = 0;
      for (let i = 1; i < means.length; i++) if (means[i] > means[best]) best = i;
      if (best !== 0 && means[best] - means[0] < opts.margin) best = 0;
      return actions[best];
    },
  };
}
