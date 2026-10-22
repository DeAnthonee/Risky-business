/**
 * The turn timer's skip: what happens when a human or agent seat runs out of time (the turnTimer option).
 *
 * The clock lives in the server (GameRoom); this file only decides which ordinary actions to make for the player,
 * one at a time through applyAction, so a skipped turn is journalled and replayed like any other. It is
 * deterministic (no clock, no randomness of its own) and is never used by self-play or training, which never turn
 * the timer on.
 */
import { getMap } from './maps.js';
import { applyAction, bestSet, mustTrade, playerOf, territoriesOf } from './engine.js';
import type { Action, GameEvent, GameOptions, GameState, PlayerId, TerritoryId } from './types.js';

export type TimerScope = 'move' | 'turn';

/** The timer a game runs, or null when it is off (also for games saved before the option existed). */
export function timerOf(o: Partial<GameOptions>): { mode: TimerScope; seconds: number } | null {
  if (o.turnTimer !== 'move' && o.turnTimer !== 'turn') return null;
  const s = Number(o.turnTimerSeconds);
  return { mode: o.turnTimer, seconds: Number.isFinite(s) ? Math.min(600, Math.max(5, Math.round(s))) : 15 };
}

export interface TimeoutStep {
  action: Action;
  state: GameState;
  events: GameEvent[];
}

/** One-line rule for agents and the rules text. */
export const TIMEOUT_RULE =
  'On a timeout you are skipped: pending armies are placed for you over your border territories (weakest first), a pending conquest is occupied with the minimum, and your turn ends (no more attacks, no fortify). Per move, running out while placing only places your armies and the turn goes on with a fresh clock. Setup placements and capital picks are made for you the same way.';

/**
 * The moves made for `player` when their timer runs out, each applied to the state the previous one left.
 * `scope` 'turn' finishes the whole turn; 'move' finishes only the decision that timed out: a placement places
 * every pending army (the turn goes on to the attack phase), an attack or fortify decision ends the turn.
 * The first step's events start with a `timeout` event. Returns [] when it is not that player's decision.
 */
export function timeoutSteps(state: GameState, player: PlayerId, scope: TimerScope): TimeoutStep[] {
  if (state.currentPlayer !== player || state.phase === 'lobby' || state.phase === 'finished') return [];
  const steps: TimeoutStep[] = [];
  let s = state;
  const startPhase = s.phase;
  const startTurn = s.turnNumber;
  // A turn has at most a few forced steps (occupy, trades, one placement, end turn); the cap only guards a bug.
  for (let i = 0; i < 20; i++) {
    if (s.currentPlayer !== player || s.phase === 'finished') break;
    // Stop at the end of the decision that timed out.
    if (steps.length) {
      if (s.turnNumber !== startTurn) break;
      if (s.phase === 'setup' || s.phase === 'capitals') break;
      if (scope === 'move' && startPhase === 'reinforce' && s.phase === 'attack') break;
    }
    const action = nextAction(s, player);
    if (!action) break;
    const r = applyAction(s, player, action);
    steps.push({ action, state: r.state, events: r.events });
    s = r.state;
  }
  if (steps.length) steps[0].events = [{ type: 'timeout', player, scope }, ...steps[0].events];
  return steps;
}

function nextAction(s: GameState, player: PlayerId): Action | null {
  const me = playerOf(s, player);
  switch (s.phase) {
    case 'setup': {
      const unclaimed = getMap(s.options.map).territoryIds.filter((t) => s.territories[t].owner === null && !s.blizzards?.includes(t));
      if (unclaimed.length) {
        const map = getMap(s.options.map);
        const near = unclaimed.find((t) => map.adjacency[t].some((n) => s.territories[n]?.owner === player));
        return { type: 'place', placements: { [near ?? unclaimed[0]]: 1 } };
      }
      return { type: 'place', placements: spread(s, player, Math.min(me.armiesToPlace, s.options.setupBatch)) };
    }
    case 'capitals': {
      // The engine's own automatic rule: the most garrisoned territory (ties: first in map order).
      const taken = new Set(Object.values(s.capitals));
      const owned = territoriesOf(s, player).filter((t) => !taken.has(t));
      if (!owned.length) return null;
      let best = owned[0];
      for (const t of owned) if (s.territories[t].armies > s.territories[best].armies) best = t;
      return { type: 'choose_capital', territory: best };
    }
    case 'reinforce':
    case 'attack':
    case 'fortify': {
      if (s.pendingConquest) return { type: 'occupy', armies: s.pendingConquest.minArmies };
      if (mustTrade(s, player)) {
        const set = bestSet(s, player);
        if (set) return { type: 'trade', cardIds: set.map((c) => c.id) };
      }
      if (me.armiesToPlace > 0 && s.phase !== 'fortify') return { type: 'place', placements: spread(s, player, me.armiesToPlace) };
      return { type: 'end_turn' };
    }
    default:
      return null;
  }
}

/** `armies` spread one at a time over the player's border territories, always onto the weakest (ties: map order). */
function spread(s: GameState, player: PlayerId, armies: number): Record<TerritoryId, number> {
  const map = getMap(s.options.map);
  const owned = territoriesOf(s, player);
  const border = owned.filter((t) => map.adjacency[t].some((n) => { const o = s.territories[n]?.owner; return o !== null && o !== undefined && o !== player; }));
  const targets = border.length ? border : owned;
  const armiesNow = new Map(targets.map((t) => [t, s.territories[t].armies]));
  const out: Record<TerritoryId, number> = {};
  for (let i = 0; i < armies; i++) {
    let best = targets[0];
    for (const t of targets) if (armiesNow.get(t)! < armiesNow.get(best)!) best = t;
    armiesNow.set(best, armiesNow.get(best)! + 1);
    out[best] = (out[best] ?? 0) + 1;
  }
  return out;
}
