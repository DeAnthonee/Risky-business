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
  /**
   * 1: a walled-in Zerg (not the strongest) surrenders to feed the swarm, so the front Zerg eats its land; 0: never.
   * On in zerg@1 (the owner's decision, 2026-10-22; it was off from #169 to #176). Off in zerg@2, which live seats
   * play: the owner called the mid-game surrender a bug after a live 10-player game (#198).
   */
  sacrifice: number;
  /**
   * 1: a Zerg walled in by its allies (no front of its own) reinforces and fortifies toward its territory nearest the
   * prey, counted through any land, ready for when the front opens; 0: as zerg@1 (#198, on in zerg@2).
   */
  walledInMass: number;
  // Later behaviours, each 0 = off (as in zerg@1), so zerg@1 plays exactly as before:
  /**
   * Synchronised strike: the horde holds its attacks on the target (knock-outs aside) until its armies bordering the
   * target reach strikeRatio × the target's armies, then every Zerg hits it. Every Zerg reads the same board, so they
   * strike together. 0 = attack whenever the odds allow.
   */
  strikeRatio: number;
  /**
   * Card timing: 1 = hoard cards (trade only when forced) until the target is down to `hoardFinish` territories or
   * fewer and I border it, then trade to finish it: the prey's cards are the prize. 0 = trade at once.
   */
  cardHoard: number;
  hoardFinish: number;
  /** Capital sniping (Capital Conquest): a prey's capital is attacked at the target's odds with this score bonus. 0 = off. */
  capitalBonus: number;
  /** Walls: reinforcement staging is pulled away from fronts facing big stacks, by this much per enemy army. 0 = off. */
  wallWeight: number;
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
  walledInMass: 0,
  strikeRatio: 0,
  cardHoard: 0,
  hoardFinish: 3,
  capitalBonus: 0,
  wallWeight: 0,
};

/**
 * zerg@2: zerg@1 without the mid-game surrender. A Zerg surrenders only when only Zergs are left, and a walled-in Zerg
 * masses toward the prey instead (#198, the owner's call after a live game where 6 of 8 Zergs surrendered in 2.5
 * minutes). Live and tournament Zerg seats play it; training and the horde gate stay on zerg@1 until the Lord of
 * training moves them.
 */
export const ZERG_2_PARAMS: ZergParams = { ...ZERG_1_PARAMS, sacrifice: 0, walledInMass: 1 };

/**
 * A Zerg: a hand-coded house bot that plays as one of a horde (docs/zergs.md). It rushes, never attacks a fellow
 * Zerg, and hunts eliminations. The horde coordinates without talking: every Zerg runs the same target rule
 * (`zergTarget`) on the same board, so they all pick the same victim.
 *
 * `horde` is the set of Zerg player ids (including `me`), given by the caller: the self-play harness, or later the
 * server from a seat's faction. It is never read from chat or names here. Pure and seedable like `chooseBotAction`.
 *
 * The alliance lasts only while there is prey: once every non-Zerg is out, the strongest Zerg (`strongestZergOf`) keeps
 * the table and the others surrender at once (the owner's rule, docs/zergs.md). Before that, the only surrender is a
 * walled-in Zerg feeding the swarm (`sacrifice`, on in zerg@1, off in zerg@2, where a walled-in Zerg masses toward the
 * prey instead: `walledInMass`).
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
  // No prey left: the strongest Zerg keeps the table and every other Zerg surrenders at once (the owner's rule: Zerg
  // has its own agenda, and it ends the game quickly). The strongest keeps playing as an ally until it stands alone. A
  // Zerg that has just taken the last prey territory occupies it first (the occupy below), so it never surrenders with
  // its own conquest left empty.
  if (prey.length === 0 && !state.pendingConquest && state.phase !== 'setup' && state.phase !== 'capitals' && strongestZergOf(state, horde) !== me) {
    return { type: 'surrender' };
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

  // zerg@2: steps to the nearest prey through any land (allies' included), where a walled-in Zerg masses its armies.
  const nearPrey = params.walledInMass > 0 ? distanceThrough(state, prey) : null;
  const near = nearPrey ? (t: TerritoryId) => nearPrey.get(t) ?? Infinity : null;

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

  if (lm.tradeableSets.length > 0 && (lm.mustTrade || params.cardHoard <= 0 || finishing(state, me, horde, target, params))) {
    return { type: 'trade', cardIds: lm.tradeableSets[0] };
  }

  if (lm.canPlaceOn.length > 0 && lm.placeLimit > 0) {
    return { type: 'place', placements: { [stagingTerritory(state, me, horde, lm.canPlaceOn, d, near, random, params)]: lm.placeLimit } };
  }

  if (state.phase === 'attack') {
    const attack = bestAttack(state, me, horde, target, lm.attacks, d, random, params);
    if (attack) return { type: 'attack', from: attack.from, to: attack.to, blitz: true };
  }

  if (state.phase === 'attack' || state.phase === 'fortify') {
    const f = bestFortify(state, me, horde, lm.fortifies, d, near);
    if (f) return { type: 'fortify', from: f.from, to: f.to, armies: f.armies };
    return { type: 'end_turn' };
  }
  return null;
}

/**
 * The Zerg that keeps the table once the prey is gone: most territories, then most armies, then the lowest seat index
 * (the order the players were seated in). Deterministic, so every Zerg agrees on it.
 */
export function strongestZergOf(state: GameState, horde: ReadonlySet<PlayerId>): PlayerId | null {
  let best: { id: PlayerId; territories: number; armies: number } | null = null;
  for (const p of state.players) {
    if (!horde.has(p.id) || !p.alive || p.isNeutral) continue;
    const owned = territoriesOf(state, p.id);
    const armies = owned.reduce((n, t) => n + state.territories[t].armies, 0);
    if (!best || owned.length > best.territories || (owned.length === best.territories && armies > best.armies)) {
      best = { id: p.id, territories: owned.length, armies };
    }
  }
  return best?.id ?? null;
}

/** Card timing: the target is down to `hoardFinish` territories or fewer and I border it, so cards now can finish it. */
function finishing(state: GameState, me: PlayerId, horde: ReadonlySet<PlayerId>, target: PlayerId | null, params: ZergParams): boolean {
  if (!target) return true;
  const owned = territoriesOf(state, target);
  if (owned.length > params.hoardFinish) return false;
  const adjacency = getMap(state.options.map).adjacency;
  return owned.some((t) => adjacency[t].some((n) => state.territories[n].owner === me));
}

/** Synchronised strike: the horde's armies bordering the target, against the target's armies. */
function strikeReady(state: GameState, horde: ReadonlySet<PlayerId>, target: PlayerId, params: ZergParams): boolean {
  if (params.strikeRatio <= 0) return true;
  const adjacency = getMap(state.options.map).adjacency;
  const owned = territoriesOf(state, target);
  const armies = owned.reduce((n, t) => n + state.territories[t].armies, 0);
  const borders = new Set<TerritoryId>();
  for (const t of owned) for (const n of adjacency[t]) if (horde.has(state.territories[n].owner ?? '') && !isBlizzard(state, n)) borders.add(n);
  const massed = [...borders].reduce((n, t) => n + state.territories[t].armies, 0);
  return massed >= params.strikeRatio * armies;
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

/** Steps from every territory to the nearest territory of any of `players`, through any land but blizzards. */
function distanceThrough(state: GameState, players: PlayerId[]): Map<TerritoryId, number> {
  const adjacency = getMap(state.options.map).adjacency;
  const dist = new Map<TerritoryId, number>();
  const queue = players.flatMap((p) => territoriesOf(state, p));
  for (const t of queue) dist.set(t, 0);
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    for (const n of adjacency[t]) {
      if (dist.has(n) || isBlizzard(state, n)) continue;
      dist.set(n, dist.get(t)! + 1);
      queue.push(n);
    }
  }
  return dist;
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
  near: ((t: TerritoryId) => number) | null,
  random: RandomSource,
  params: ZergParams,
): TerritoryId {
  // No front: the biggest stack (zerg@1); walled in by allies in zerg@2, my territory nearest the prey (biggest on a tie).
  let best = near
    ? options.reduce((a, b) => {
        const na = near(a);
        const nb = near(b);
        return nb < na || (nb === na && state.territories[b].armies > state.territories[a].armies) ? b : a;
      })
    : options.reduce((a, b) => (state.territories[b].armies > state.territories[a].armies ? b : a));
  let bestScore = -Infinity;
  for (const t of options) {
    const enemies = hostileNeighbours(state, me, horde, t);
    if (enemies.length === 0) continue;
    const dt = d(t);
    const wall = params.wallWeight > 0 ? params.wallWeight * Math.max(...enemies.map((e) => state.territories[e].armies)) : 0;
    const score = (Number.isFinite(dt) ? -params.stagingDistance * dt : -1000) + state.territories[t].armies - wall + random();
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
  const ready = target === null || strikeReady(state, horde, target, params);
  const capitals = params.capitalBonus > 0 && state.options.capitals ? new Set(Object.values(state.capitals)) : null;
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
    const capital = capitals !== null && capitals.has(a.to) && !victim.isNeutral;
    if (defender === target) {
      // Synchronised strike: hold back until the horde has massed, unless this finishes the target.
      if (p < params.targetOdds || (!ready && !lastTerritory)) continue;
      score = 3 + p + (capital ? params.capitalBonus : 0);
    } else if (capital) {
      if (p < params.targetOdds) continue;
      score = 2 + p + params.capitalBonus;
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

/**
 * Move the biggest stack sitting behind the lines to the front nearest the target. In zerg@2, walled in by allies (no
 * front of my own): move it toward my side nearest the prey instead.
 */
function bestFortify(
  state: GameState,
  me: PlayerId,
  horde: ReadonlySet<PlayerId>,
  options: { from: TerritoryId; to: TerritoryId; maxArmies: number }[],
  d: (t: TerritoryId) => number,
  near: ((t: TerritoryId) => number) | null,
) {
  const hasFront = !near || territoriesOf(state, me).some((t) => hostileNeighbours(state, me, horde, t).length > 0);
  if (!hasFront && near) {
    let move: { from: TerritoryId; to: TerritoryId; armies: number } | null = null;
    let moveScore = 0;
    for (const f of options) {
      const gain = near(f.from) - near(f.to);
      if (!(gain > 0) || !Number.isFinite(gain)) continue;
      const score = gain * 10 + f.maxArmies;
      if (score > moveScore) {
        moveScore = score;
        move = { from: f.from, to: f.to, armies: f.maxArmies };
      }
    }
    return move;
  }
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
