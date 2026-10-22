import type { RandomSource } from './bot.js';
import { armiesOf, territoriesOf } from './engine.js';
import { RuleError, type ActionResult, type GameState, type PlayerId } from './types.js';
import { strongestZergOf } from './zerg.js';

/** The order a game stopped before its end is decided in, and the dice rolled to break ties (each roll is 1-6). */
export interface Standing {
  order: PlayerId[];
  rolls: Record<PlayerId, number[]>;
}

/**
 * Rank the players of an unfinished game (a tournament table stopped at its round's end, docs/tournaments.md):
 * players still in, by territories, then armies, then dice; then players already out, the last one out first.
 *
 * Dice: every tied player rolls one die and the higher roll ranks first. Players still tied roll again, only among
 * themselves, until the order is total. `eliminated` is the order players went out in (earliest first); players out
 * but missing from it rank last, in turn order. Neutrals are never ranked. Pure apart from `random`.
 */
export function rankByStanding(state: GameState, random: RandomSource = Math.random, eliminated: readonly PlayerId[] = []): Standing {
  const rolls: Record<PlayerId, number[]> = {};
  const seated = state.turnOrder.length > 0 ? state.turnOrder : state.players.map((p) => p.id);
  const players = seated.map((id) => state.players.find((p) => p.id === id)!).filter((p) => p && !p.isNeutral);
  const alive = players.filter((p) => p.alive).map((p) => ({ id: p.id, territories: territoriesOf(state, p.id).length, armies: armiesOf(state, p.id) }));

  alive.sort((a, b) => b.territories - a.territories || b.armies - a.armies);
  const order: PlayerId[] = [];
  for (let i = 0; i < alive.length; ) {
    let j = i + 1;
    while (j < alive.length && alive[j].territories === alive[i].territories && alive[j].armies === alive[i].armies) j++;
    order.push(...breakTie(alive.slice(i, j).map((p) => p.id), random, rolls));
    i = j;
  }

  const out = players.filter((p) => !p.alive).map((p) => p.id);
  const known = [...eliminated].reverse().filter((id) => out.includes(id));
  order.push(...known, ...out.filter((id) => !known.includes(id)));
  return { order, rolls };
}

/** Order tied players by dice: one die each, the higher first; ties roll again among themselves. */
function breakTie(ids: PlayerId[], random: RandomSource, rolls: Record<PlayerId, number[]>): PlayerId[] {
  if (ids.length <= 1) return ids;
  const roll = new Map<PlayerId, number>();
  for (const id of ids) {
    const die = 1 + Math.floor(random() * 6);
    roll.set(id, die);
    (rolls[id] ??= []).push(die);
  }
  const faces = [...new Set(roll.values())].sort((a, b) => b - a);
  return faces.flatMap((f) => breakTie(ids.filter((id) => roll.get(id) === f), random, rolls));
}

/**
 * Whether only `side` is left: the game is in progress, not in the middle of a conquest (the armies have not moved in
 * yet: the engine's own victory waits for the occupy too), and every living player is one of `side`, with at least
 * one alive. The server says who the side is (it knows which seats are Zergs); the decision is the engine's.
 */
export function onlySideLeft(state: GameState, side: ReadonlySet<PlayerId>): boolean {
  if (state.phase === 'lobby' || state.phase === 'finished' || state.pendingConquest) return false;
  const living = state.players.filter((p) => !p.isNeutral && p.alive);
  return living.length > 0 && living.every((p) => side.has(p.id));
}

/**
 * End a game as it stands when only one side is left: the swarm of a live game (owner's rule A, docs/zergs.md). The
 * strongest player of `side` wins (most territories, then most armies, then the lowest seat: zerg.ts's
 * strongestZergOf, so a live game and a self-play game, where the weaker Zergs surrender instead, crown the same
 * Zerg). Nothing else changes: nobody surrenders, no land turns neutral, the others stay in and are placed by the
 * public board's own order (finalPlacements: territories, armies, seat). Emits the usual `game_over` (no reason).
 *
 * Called by the server only (a live room ends the game through its commit); self-play never calls it.
 */
export function endByStanding(state: GameState, side: ReadonlySet<PlayerId>, at = Date.now()): ActionResult {
  if (state.phase === 'lobby' || state.phase === 'finished') throw new RuleError('Only a game in progress can end by standing');
  if (state.pendingConquest) throw new RuleError('A conquest is being occupied: the game ends by standing after the armies move in');
  const winner = strongestZergOf(state, side);
  if (!winner) throw new RuleError('Nobody of that side is left to win');
  return {
    state: { ...state, phase: 'finished', winner, currentPlayer: null, finishedAt: at, version: state.version + 1 },
    events: [{ type: 'game_over', winner }],
  };
}
