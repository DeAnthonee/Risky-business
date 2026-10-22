import { chooseBotAction, type RandomSource } from './bot.js';
import { defenseDiceLimit, isBlizzard, legalMoves, territoriesOf } from './engine.js';
import { getMap } from './maps.js';
import { blitzOdds } from './odds.js';
import type { Action, GameState, PlayerId, TerritoryId } from './types.js';

/**
 * A Zerg's judgement numbers. ZERG_1_PARAMS is zerg@1 (the fixed reference horde); tuned sets make later versions.
 * Every Zerg of one horde must share the same numbers, since the target rule (`zergTarget`) reads them.
 */
export interface ZergParams {
  /** Smallest blitz odds to attack the horde's target. */
  targetOdds: number;
  /** ... a player's last territory (a knock-out). */
  killOdds: number;
  /** ... another player's territory when I have no conquest (card) yet this turn. */
  cardOdds: number;
  /** ... another player's territory after my first conquest. */
  extraOdds: number;
  /** ... a neutral territory on the road to the target, and one off it. */
  neutralRoadOdds: number;
  neutralOdds: number;
  /** Score bonus for a knock-out attack (attack scores are about 1-4 otherwise). */
  killBonus: number;
  /** Target rule weights: armies + territoryWeight × territories − exposureWeight × horde armies on its borders. */
  territoryWeight: number;
  exposureWeight: number;
  /** Share of the movable armies sent into a conquered territory when both sides still face prey. */
  occupyShare: number;
  /** Reinforcement staging: score per step closer to the target (the stack size counts 1 per army). */
  stagingDistance: number;
  /** 1: a walled-in Zerg (not the strongest) surrenders to feed the swarm; 0: never. */
  sacrifice: number;
}

export const ZERG_1_PARAMS: ZergParams = {
  targetOdds: 0.45,
  killOdds: 0.5,
  cardOdds: 0.7,
  extraOdds: 0.8,
  neutralRoadOdds: 0.7,
  neutralOdds: 0.8,
  killBonus: 5,
  territoryWeight: 2,
  exposureWeight: 0.5,
  occupyShare: 0.7,
  stagingDistance: 10,
  sacrifice: 1,
};

/**
 * A Zerg: a hand-coded house bot that plays as one of a horde (docs/zergs.md). It rushes, never attacks a fellow
 * Zerg, and hunts eliminations. The horde coordinates without talking: every Zerg runs the same target rule
 * (`zergTarget`) on the same board, so they all pick the same victim.
 *
 * `horde` is the set of Zerg player ids (including `me`), given by the caller: the self-play harness, or later the
 * server from a seat's faction. It is never read from chat or names here. Pure and seedable like `chooseBotAction`.
 */
export function chooseZergAction(
  state: GameState,
  me: PlayerId,
  horde: ReadonlySet<PlayerId>,
  random: RandomSource = Math.random,
  params: ZergParams = ZERG_1_PARAMS,
): Action | null {
  const lm = legalMoves(state, me);
  if (!lm.yourTurn) return null;

  const prey = preyOf(state, horde);
  // Nobody but the horde is left: all but the first Zerg in turn order step aside so the game ends.
  if (prey.length === 0 && state.phase !== 'setup' && state.phase !== 'capitals') {
    const first = state.turnOrder.find((p) => horde.has(p) && state.players.find((x) => x.id === p)?.alive);
    if (first !== me) return { type: 'surrender' };
  }

  // Setup, claiming and capital picks: the built-in bot's choices are fine.
  if (state.phase === 'setup' || lm.capitalChoices.length > 0) return chooseBotAction(state, me, random);

  const target = zergTarget(state, horde, params);
  const dist = target ? distanceTo(state, me, horde, target) : null;
  const d = (t: TerritoryId) => dist?.get(t) ?? Infinity;

  // Walled in by fellow Zergs, with no road to any prey: unless I am the strongest Zerg, I feed the swarm. My land turns
  // neutral and the Zergs at the front eat it for cards and continents (otherwise my armies would idle forever).
  if (state.phase === 'reinforce' && !lm.pendingConquest && prey.length > 0 && params.sacrifice > 0 && walledIn(state, me, horde, prey) && !strongestZerg(state, me, horde)) {
    return { type: 'surrender' };
  }

  if (lm.pendingConquest) {
    const pc = lm.pendingConquest;
    const toFront = hostileNeighbours(state, me, horde, pc.to).length > 0;
    const fromFront = hostileNeighbours(state, me, horde, pc.from).length > 0;
    let n = pc.minArmies;
    if (toFront && !fromFront) n = pc.maxArmies;
    else if (toFront) n = Math.ceil(pc.maxArmies * params.occupyShare);
    else if (!fromFront) n = pc.maxArmies;
    return { type: 'occupy', armies: Math.max(pc.minArmies, Math.min(pc.maxArmies, n)) };
  }

  if (lm.tradeableSets.length > 0) return { type: 'trade', cardIds: lm.tradeableSets[0] };

  if (lm.canPlaceOn.length > 0 && lm.placeLimit > 0) {
    return { type: 'place', placements: { [stagingTerritory(state, me, horde, lm.canPlaceOn, d, random, params)]: lm.placeLimit } };
  }

  if (state.phase === 'attack') {
    const attack = bestAttack(state, me, horde, target, lm.attacks, d, random, params);
    if (attack) return { type: 'attack', from: attack.from, to: attack.to, blitz: true };
  }

  if (state.phase === 'attack' || state.phase === 'fortify') {
    const f = bestFortify(state, me, horde, lm.fortifies, d);
    if (f) return { type: 'fortify', from: f.from, to: f.to, armies: f.armies };
    return { type: 'end_turn' };
  }
  return null;
}

/** Alive players the horde hunts: everyone but the horde and the Neutral. */
function preyOf(state: GameState, horde: ReadonlySet<PlayerId>): PlayerId[] {
  return state.players.filter((p) => p.alive && !p.isNeutral && !horde.has(p.id)).map((p) => p.id);
}

/**
 * The horde's shared victim: the alive non-Zerg with the lowest `armies + 2 × territories − exposure / 2`, where
 * exposure is the horde's armies on territories bordering it. The weakest, most exposed player goes first; ties break
 * by turn order. It depends only on the board and the horde, never on which Zerg asks, so every Zerg agrees.
 */
export function zergTarget(state: GameState, horde: ReadonlySet<PlayerId>, params: ZergParams = ZERG_1_PARAMS): PlayerId | null {
  const adjacency = getMap(state.options.map).adjacency;
  let best: PlayerId | null = null;
  let bestScore = Infinity;
  const prey = new Set(preyOf(state, horde));
  for (const p of state.turnOrder) {
    if (!prey.has(p)) continue;
    const owned = territoriesOf(state, p);
    const armies = owned.reduce((n, t) => n + state.territories[t].armies, 0);
    const borders = new Set<TerritoryId>();
    for (const t of owned) for (const n of adjacency[t]) if (horde.has(state.territories[n].owner ?? '') && !isBlizzard(state, n)) borders.add(n);
    const exposure = [...borders].reduce((n, t) => n + state.territories[t].armies, 0);
    const score = armies + params.territoryWeight * owned.length - params.exposureWeight * exposure;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** No road from any of my territories to any prey, through anything but fellow Zergs' land. */
function walledIn(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, prey: PlayerId[]): boolean {
  return prey.every((p) => {
    const dist = distanceTo(state, me, horde, p);
    return territoriesOf(state, me).every((t) => !dist.has(t));
  });
}

/** Most armies in the horde (ties: first in turn order): the one Zerg that never sacrifices itself. */
function strongestZerg(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>): boolean {
  let best: PlayerId | null = null;
  let bestArmies = -1;
  for (const p of state.turnOrder) {
    if (!horde.has(p) || !state.players.find((x) => x.id === p)?.alive) continue;
    const armies = territoriesOf(state, p).reduce((n, t) => n + state.territories[t].armies, 0);
    if (armies > bestArmies) {
      bestArmies = armies;
      best = p;
    }
  }
  return best === me;
}

function hostile(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, t: TerritoryId): boolean {
  const owner = state.territories[t].owner;
  return owner !== null && owner !== me && !horde.has(owner) && !isBlizzard(state, t);
}

function hostileNeighbours(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, t: TerritoryId): TerritoryId[] {
  return getMap(state.options.map).adjacency[t].filter((n) => hostile(state, me, horde, n));
}

/** Steps from every territory to the target's nearest territory, walking around blizzards and the horde's land (not mine). */
function distanceTo(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, target: PlayerId): Map<TerritoryId, number> {
  const adjacency = getMap(state.options.map).adjacency;
  const dist = new Map<TerritoryId, number>();
  const queue = territoriesOf(state, target);
  for (const t of queue) dist.set(t, 0);
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    for (const n of adjacency[t]) {
      if (dist.has(n) || isBlizzard(state, n)) continue;
      const owner = state.territories[n].owner;
      if (owner !== null && owner !== me && horde.has(owner)) continue;
      dist.set(n, dist.get(t)! + 1);
      queue.push(n);
    }
  }
  return dist;
}

/** Where to pile reinforcements: the front closest to the target, the bigger the stack the better. */
function stagingTerritory(
  state: GameState,
  me: PlayerId,
  horde: ReadonlySet<PlayerId>,
  options: TerritoryId[],
  d: (t: TerritoryId) => number,
  random: RandomSource,
  params: ZergParams,
): TerritoryId {
  let best = options.reduce((a, b) => (state.territories[b].armies > state.territories[a].armies ? b : a));
  let bestScore = -Infinity;
  for (const t of options) {
    const enemies = hostileNeighbours(state, me, horde, t);
    if (enemies.length === 0) continue;
    const dt = d(t);
    const score = (Number.isFinite(dt) ? -params.stagingDistance * dt : -1000) + state.territories[t].armies + random();
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function bestAttack(
  state: GameState,
  me: PlayerId,
  horde: ReadonlySet<PlayerId>,
  target: PlayerId | null,
  attacks: { from: TerritoryId; to: TerritoryId }[],
  d: (t: TerritoryId) => number,
  random: RandomSource,
  params: ZergParams,
) {
  const conquered = state.players.find((p) => p.id === me)!.conqueredThisTurn;
  let best: { from: TerritoryId; to: TerritoryId } | null = null;
  let bestScore = 0;
  for (const a of attacks) {
    const defender = state.territories[a.to].owner;
    // Never Zerg on Zerg.
    if (defender === null || defender === me || horde.has(defender)) continue;
    const from = state.territories[a.from].armies;
    const to = state.territories[a.to].armies;
    const p = blitzOdds(from, to, defenseDiceLimit(state, a.to)).win;
    const victim = state.players.find((x) => x.id === defender)!;
    const lastTerritory = !victim.isNeutral && territoriesOf(state, defender).length === 1;
    let score: number;
    if (defender === target) {
      if (p < params.targetOdds) continue;
      score = 3 + p;
    } else if (victim.isNeutral) {
      // To clear the road to the target, or for a card and land when the odds are good.
      const onRoad = d(a.to) < d(a.from);
      if (p < (onRoad ? params.neutralRoadOdds : params.neutralOdds)) continue;
      score = (onRoad ? 1 : 0.6) + p;
    } else {
      if (p < (lastTerritory ? params.killOdds : conquered ? params.extraOdds : params.cardOdds)) continue;
      score = 1.5 + p;
    }
    if (lastTerritory) score += params.killBonus;
    if (!conquered) score += 0.5;
    score += random() * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

/** Move the biggest stack sitting behind the lines to the front nearest the target. */
function bestFortify(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, options: { from: TerritoryId; to: TerritoryId; maxArmies: number }[], d: (t: TerritoryId) => number) {
  let best: { from: TerritoryId; to: TerritoryId; armies: number } | null = null;
  let bestScore = -Infinity;
  for (const f of options) {
    if (hostileNeighbours(state, me, horde, f.from).length > 0) continue;
    if (hostileNeighbours(state, me, horde, f.to).length === 0) continue;
    const dt = d(f.to);
    const score = f.maxArmies * 10 - (Number.isFinite(dt) ? dt : 50);
    if (score > bestScore) {
      bestScore = score;
      best = { from: f.from, to: f.to, armies: f.maxArmies };
    }
  }
  return best;
}
