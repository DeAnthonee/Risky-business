import { chooseBotAction, chooseZergAction, getMap, ZERG_1_PARAMS, ZERG_2_PARAMS, type ZergParams, type Action, type GameState, type LegalMoves, type PlayerId, type RandomSource } from '@risk/engine';
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
  /**
   * Set when the agent was trained for fog of war (a network with fog inputs, fog.ts FOG_INPUT_VERSION): the live
   * seat player only sits such agents at fog tables. Every agent can play a fog game fairly (foggedAgent).
   */
  fogInputs?: number;
}

/** The built-in Risky bot (the one that fills seats on the live server), playing exactly the same code. */
export const riskyBot: Agent = {
  id: 'risky@1',
  choose: (ctx) => chooseBotAction(ctx.state, ctx.me, ctx.random),
};

/**
 * A Zerg (docs/zergs.md): the engine's hand-coded horde bot. Its horde is every seat this harness sat a Zerg agent in:
 * self-play names each player after its agent id (game.ts), which no seat can change, so names starting with `zerg` are
 * the horde. The live server will use a seat's faction instead.
 */
/** A Zerg agent's id starts with "zerg" (zerg@1, zerg-branch@1, ...): self-play seats named so are one horde. */
export const isZergName = (name: string) => name.startsWith('zerg');
/** A Zerg agent with its own judgement numbers (zerg@1 is ZERG_1_PARAMS; tuned versions come from zerg-tune). */
export function makeZergAgent(id: string, params: ZergParams): Agent {
  if (!isZergName(id)) throw new Error(`a Zerg agent's id must start with "zerg" (got ${id})`);
  return {
    id,
    choose: (ctx) => {
      const horde = new Set(ctx.state.players.filter((p) => isZergName(p.name)).map((p) => p.id));
      horde.add(ctx.me);
      return chooseZergAction(ctx.state, ctx.me, horde, ctx.random, params);
    },
  };
}
export const zergBot: Agent = makeZergAgent('zerg@1', ZERG_1_PARAMS);
/** zerg@2: zerg@1 without the mid-game surrender; walled-in Zergs mass toward the prey (the live seats' version). */
export const zergBot2: Agent = makeZergAgent('zerg@2', ZERG_2_PARAMS);

/**
 * The numbers a Zerg seat plays, from its self-play name (its agent id): zerg@2's for `zerg@2`, zerg@1's otherwise.
 * For code that plays Zerg seats itself (a branch seat's rollouts), so each Zerg plays its own version.
 */
export function zergParamsFor(name: string): ZergParams {
  return name === 'zerg@2' ? ZERG_2_PARAMS : ZERG_1_PARAMS;
}

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

const REGISTRY = new Map<string, Agent>([riskyBot, randomAgent, zergBot, zergBot2].map((a) => [a.id, a]));

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
