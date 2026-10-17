import { chooseBotAction, getMap, type Action, type GameState, type LegalMoves, type PlayerId, type RandomSource } from '@risk/engine';
import { candidateToAction, type Candidate } from './actions.js';
import type { Traits } from './traits.js';

/** Everything a player gets when it is asked for a move. */
export interface DecisionContext {
  state: GameState;
  me: PlayerId;
  seat: number;
  legal: LegalMoves;
  /** The discrete action space for this decision (see actions.ts). Learning players pick one of these. */
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

/** Uniformly random legal candidate. A floor for the ladder, not a real opponent. */
export const randomAgent: Agent = {
  id: 'random@1',
  choose: (ctx) => {
    if (ctx.candidates.length === 0) return null;
    const c = ctx.candidates[Math.floor(ctx.random() * ctx.candidates.length)];
    return candidateToAction(getMap(ctx.state.options.map), c);
  },
};

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
