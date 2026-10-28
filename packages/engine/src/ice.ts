/**
 * Closing ice (owner, 2026-10-28, for the mega tournament: "blizzards start appearing more and more until the map gets
 * smaller and smaller"): once started, the ice closes in from the North and South poles, one ring of hexes at a time,
 * sea included, at the start of every `iceEveryRounds`-th round, until `iceSafeRings` rings are left open round the
 * middle. A territory the ice reaches becomes a blizzard: its armies retreat to the owner's strongest open neighbour,
 * or are lost with nowhere to go, and a player left with no land is out.
 *
 * Rings: a hex-globe board that carries `poleRings` (Mega Earth) gives each territory its exact ring count from each
 * pole over the whole globe, sea cells counted; any other board bands its territories by their height on the flat map
 * (ICE_BANDS bands from the northernmost territory to the southernmost). The start is the server's call (`iceStartMinutes` after the game starts, through
 * `startIce` in its commit, like the Zerg and stalemate ends): the engine never reads the clock, so a recorded game
 * replays the same. Kept out of the GPU-mirrored engine.ts and types.ts like stall.ts: engine.ts only calls checkIce
 * and validateIceOptions. With `closingIce` off (the default, as in self-play) nothing here touches the state.
 */
import { getMap, type MapDef } from './maps.js';
import { RuleError, type GameEvent, type GameOptions, type GameState, type PlayerId, type TerritoryId } from './types.js';

declare module './types.js' {
  interface GameOptions {
    /** Closing ice (any board; on in mega tournaments): the ice closes in from the poles once started (absent = off). */
    closingIce?: boolean;
    /** Minutes after the game starts that the server starts the ice (0-600; absent = 15). */
    iceStartMinutes?: number;
    /** The ice advances at the start of every this-many rounds (1-10; absent = 1). */
    iceEveryRounds?: number;
    /** Rings each front advances per step (1-5; absent = 1). */
    iceRingsPerStep?: number;
    /** Rings left open round the middle when the ice stops (1-40; absent = 6). */
    iceSafeRings?: number;
  }
}

export const ICE_DEFAULTS = { iceStartMinutes: 15, iceEveryRounds: 1, iceRingsPerStep: 1, iceSafeRings: 6 } as const;
/** A board without pole rings is banded into this many rings by height. */
export const ICE_BANDS = 30;

/** `state.ice` once started: each front's ring count (rings 0..level-1 from each pole are frozen) and the round it began. */
export interface IceState {
  level: number;
  startedRound: number;
}
/** The ice started (startIce). */
export interface IceStartedEvent {
  type: 'ice_started';
}
/** The ice advanced to `level` rings: territories frozen, armies moved (from -> to, count) or lost, players knocked out. */
export interface IceEvent {
  type: 'ice';
  level: number;
  frozen: TerritoryId[];
  retreats: { from: TerritoryId; to: TerritoryId; armies: number }[];
  lost: Record<TerritoryId, number>;
  eliminated: PlayerId[];
}

/** The state with the ice's field (declared here, not in the mirrored types.ts). */
type IceGame = GameState & { ice?: IceState };
export function iceOf(state: GameState): IceState | undefined {
  return (state as IceGame).ice;
}

/** Each territory's ring count from the North and the South pole, and the number of rings pole to pole. */
export function iceRings(map: MapDef): { north: Record<TerritoryId, number>; south: Record<TerritoryId, number>; rings: number } {
  if (map.poleRings) {
    const north: Record<TerritoryId, number> = {};
    const south: Record<TerritoryId, number> = {};
    for (const t of map.territoryIds) [north[t], south[t]] = map.poleRings.territories[t];
    return { north, south, rings: map.poleRings.rings };
  }
  // From the northernmost territory's badge to the southernmost one's.
  const ys = map.territories.map((t) => t.y);
  const [top, span] = [Math.min(...ys), Math.max(1, Math.max(...ys) - Math.min(...ys))];
  const north: Record<TerritoryId, number> = {};
  const south: Record<TerritoryId, number> = {};
  for (const t of map.territoryIds) {
    const band = Math.min(ICE_BANDS - 1, Math.max(0, Math.floor(((map.territoryById[t].y - top) / span) * ICE_BANDS)));
    north[t] = band;
    south[t] = ICE_BANDS - 1 - band;
  }
  return { north, south, rings: ICE_BANDS };
}

/** The furthest each front goes: `iceSafeRings` rings stay open between them. */
export function iceMaxLevel(o: GameOptions, rings: number): number {
  return Math.max(0, Math.floor((rings - (o.iceSafeRings ?? ICE_DEFAULTS.iceSafeRings)) / 2));
}

/** Whether a territory lies under the ice at `level`. */
export function underIce(rings: ReturnType<typeof iceRings>, t: TerritoryId, level: number): boolean {
  return rings.north[t] < level || rings.south[t] < level;
}

export function validateIceOptions(o: GameOptions): void {
  if (o.closingIce !== undefined && typeof o.closingIce !== 'boolean') throw new RuleError('closingIce must be true or false');
  const ranges = { iceStartMinutes: [0, 600], iceEveryRounds: [1, 10], iceRingsPerStep: [1, 5], iceSafeRings: [1, 40] } as const;
  for (const [key, [lo, hi]] of Object.entries(ranges) as [keyof typeof ranges, readonly [number, number]][]) {
    const n = o[key];
    if (n !== undefined && (!Number.isInteger(n) || n < lo || n > hi)) throw new RuleError(`${key} must be an integer between ${lo} and ${hi}`);
  }
}

/** Is the ice due to start (the server's check: closingIce on, the game under way, not started yet)? */
export function iceCanStart(state: GameState): boolean {
  return !!state.options.closingIce && !iceOf(state) && state.phase !== 'lobby' && state.phase !== 'setup' && state.phase !== 'capitals' && state.phase !== 'finished';
}

/** Start the ice (the server calls it `iceStartMinutes` after the start, through its commit): it advances from the next round. */
export function startIce(state: GameState): { state: GameState; events: GameEvent[] } {
  if (!iceCanStart(state)) throw new RuleError('The closing ice cannot start now');
  const next = { ...state, ice: { level: 0, startedRound: state.round }, version: state.version + 1 } as IceGame;
  return { state: next, events: [{ type: 'ice_started' } as unknown as GameEvent] };
}

/**
 * At a round start (engine.ts nextTurn, after the round count goes up): advance the ice when it is due, freeze what it
 * reaches, move or lose the armies there, knock out players left with no land, and end the game when one is left.
 * Mutates `state` (the engine's working copy).
 */
export function checkIce(state: GameState, events: GameEvent[]): void {
  const ice = iceOf(state);
  if (!ice || !state.options.closingIce) return;
  const every = state.options.iceEveryRounds ?? ICE_DEFAULTS.iceEveryRounds;
  if ((state.round - ice.startedRound) % every !== 0 || state.round === ice.startedRound) return;
  const map = getMap(state.options.map);
  const rings = iceRings(map);
  const level = Math.min(iceMaxLevel(state.options, rings.rings), ice.level + (state.options.iceRingsPerStep ?? ICE_DEFAULTS.iceRingsPerStep));
  if (level <= ice.level) return;
  ice.level = level;
  const frozenBefore = new Set(state.blizzards);
  const frozen = map.territoryIds.filter((t) => !frozenBefore.has(t) && underIce(rings, t, level));
  const nowFrozen = new Set([...frozenBefore, ...frozen]);
  const retreats: IceEvent['retreats'] = [];
  const lost: Record<TerritoryId, number> = {};
  for (const t of frozen) {
    const { owner, armies } = state.territories[t];
    if (owner && armies > 0) {
      // The owner's open neighbour with the most armies (map order breaks ties) takes them; none: they are lost.
      let to: TerritoryId | null = null;
      for (const n of map.adjacency[t]) if (!nowFrozen.has(n) && state.territories[n].owner === owner && (to === null || state.territories[n].armies > state.territories[to].armies)) to = n;
      if (to) {
        state.territories[to].armies += armies;
        retreats.push({ from: t, to, armies });
      } else lost[t] = armies;
    }
    state.territories[t] = { owner: null, armies: 0 };
    for (const [pid, cap] of Object.entries(state.capitals)) if (cap === t) delete state.capitals[pid];
  }
  state.blizzards = [...state.blizzards, ...frozen];
  const eliminated: PlayerId[] = [];
  for (const p of state.players) {
    if (p.isNeutral || !p.alive || map.territoryIds.some((t) => state.territories[t].owner === p.id)) continue;
    p.alive = false;
    state.discard.push(...p.cards);
    p.cards = [];
    p.armiesToPlace = 0;
    eliminated.push(p.id);
  }
  events.push({ type: 'ice', level, frozen, retreats, lost, eliminated } as unknown as GameEvent);
  for (const id of eliminated) events.push({ type: 'eliminated', player: id, by: null });
  const alive = state.players.filter((p) => p.alive && !p.isNeutral);
  // Everyone left was frozen out at once: the first of them in seating order wins (it never happens with land in the safe zone).
  const winner = alive.length === 1 ? alive[0].id : alive.length === 0 && eliminated.length ? eliminated[0] : null;
  if (winner) {
    state.phase = 'finished';
    state.winner = winner;
    state.finishedAt = Date.now();
    state.currentPlayer = null;
    events.push({ type: 'game_over', winner, reason: 'domination' });
  }
}
