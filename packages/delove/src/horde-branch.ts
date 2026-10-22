import { chooseZergAction, getMap } from '@risk/engine';
import { actionSteps, isZergName, zergParamsFor, type StepContext } from '@risk/selfplay';
import { hordeOf } from './zerg-branch.js';

type StepPick = (ctx: StepContext) => number;

/**
 * A rollout policy for branch and score at horde tables (docs/zergs.md): Zerg seats (players named after a Zerg agent)
 * play the hand-coded horde bot's move (each seat its own version: zerg@1 or zerg@2, `zergParamsFor`), mapped onto the candidate list; every other seat plays `base` (the branch
 * teacher). So a searching Delove seat foresees the horde ganging up instead of imagining the Zergs as Jacob Sensei.
 * A Zerg move that is not a candidate (a surrender to feed the swarm, an off-list placement) falls back to `base`, or,
 * when that would attack a fellow Zerg, to ending the turn (else the first candidate that doesn't). Once no prey is
 * left the weaker Zergs surrender (not a candidate, so they end their turns in a rollout) and the strongest keeps the
 * table; Zergs never attack each other.
 * Lives outside the mirrored branch.ts: branchAgent takes any StepPick.
 */
export function hordeRolloutPick(base: StepPick): StepPick {
  return (ctx) => {
    const player = ctx.state.players.find((p) => p.id === ctx.me);
    if (!player || !isZergName(player.name)) return base(ctx);
    const horde = hordeOf(ctx.state, ctx.me);
    const ids = getMap(ctx.state.options.map).territoryIds;
    const safe = (i: number) => {
      const c = ctx.candidates[i];
      return c[0] !== 'attack' || !horde.has(ctx.state.territories[ids[c[2]]].owner ?? '');
    };
    const fallback = () => {
      const b = base(ctx);
      if (safe(b)) return b;
      const end = ctx.candidates.findIndex((c) => c[0] === 'end_turn');
      return end >= 0 ? end : Math.max(0, ctx.candidates.findIndex((_, i) => safe(i)));
    };
    const action = chooseZergAction(ctx.state, ctx.me, horde, ctx.random, zergParamsFor(player.name));
    if (!action || action.type === 'surrender') return fallback();
    const steps = actionSteps(ctx.state, ctx.me, ctx.legal, action);
    let choice = -1;
    if (ctx.fortifyFrom === null) choice = steps[0]?.choice ?? -1;
    else if (steps.length === 2 && steps[1].fortifyFrom === ctx.fortifyFrom) choice = steps[1].choice;
    return choice >= 0 && choice < ctx.candidates.length ? choice : fallback();
  };
}
