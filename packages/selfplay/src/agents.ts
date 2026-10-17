import { chooseBotAction, getMap, type Action, type GameState, type LegalMoves, type PlayerId, type RandomSource } from '@risk/engine';
import { candidates, candidateToAction, type Candidate } from './actions.js';
import type { Traits } from './traits.js';

/** Everything a player gets when it is asked for a move. */
export interface DecisionContext {
  state: GameState;
  me: PlayerId;
  seat: number;
  legal: LegalMoves;
  /** The discrete action space for this decision (see actions.ts). Learning players pick one of these (see stepAgent). */
  candidates: Candidate[];
  traits: Traits;
  /** Seeded per game and seat: use it instead of Math.random so games replay exactly. */
  random: RandomSource;
}

/**
 * A player version. `id` is `name@version` and is what the ladder rates and the logs record. An agent must be
 * deterministic given its DecisionContext (all randomness from ctx.random).
 */
export interface Agent {
  id: string;
  choose(ctx: DecisionContext): Action | null;
}

/** The built-in Risky bot (the one that fills seats on the live server), playing exactly the same code. */
export const riskyBot: Agent = {
  id: 'risky@1',
  choose: (ctx) => chooseBotAction(ctx.state, ctx.me, ctx.random),
};

/** One step of a decision: `candidates` are this step's choices; a fortify_to step carries its source. */
export interface StepContext extends DecisionContext {
  fortifyFrom: number | null;
}

/**
 * An agent that picks candidate indexes, one step at a time: after a `fortify_from` it is asked again for the
 * `fortify_to`. This is the shape a trained network plays in (score every candidate, pick one).
 */
export function stepAgent(id: string, pick: (ctx: StepContext) => number): Agent {
  return {
    id,
    choose: (ctx) => {
      if (ctx.candidates.length === 0) return null;
      const map = getMap(ctx.state.options.map);
      const choose = (step: StepContext) => {
        const i = pick(step);
        if (!Number.isInteger(i) || i < 0 || i >= step.candidates.length) throw new Error(`${id} picked candidate ${i} of ${step.candidates.length}`);
        return step.candidates[i];
      };
      const c = choose({ ...ctx, fortifyFrom: null });
      if (c[0] !== 'fortify_from') return candidateToAction(map, c);
      const from = c[1];
      const second = candidates(ctx.state, ctx.me, ctx.legal, map.territoryIds[from]);
      return candidateToAction(map, choose({ ...ctx, candidates: second, fortifyFrom: from }), from);
    },
  };
}

/** Uniformly random legal candidate at every step. A floor for the ladder, not a real opponent. */
export const randomAgent: Agent = stepAgent('random@1', (ctx) => Math.floor(ctx.random() * ctx.candidates.length));

const REGISTRY = new Map<string, Agent>([riskyBot, randomAgent].map((a) => [a.id, a]));

/** Make an agent available by id (e.g. a trained network loaded from disk). */
export function registerAgent(agent: Agent): void {
  REGISTRY.set(agent.id, agent);
}

export function resolveAgent(id: string): Agent {
  const a = REGISTRY.get(id);
  if (!a) throw new Error(`Unknown agent "${id}" (known: ${[...REGISTRY.keys()].join(', ')})`);
  return a;
}

export function knownAgents(): string[] {
  return [...REGISTRY.keys()];
}
