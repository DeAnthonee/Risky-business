import { getMap, type MapDef } from './maps.js';
import { armiesOf, continentsOf, controlsContinent, isBlizzard, legalMoves, reinforcementsFor, territoriesOf, type LegalMoves } from './engine.js';
import type { Card, GameEvent, GameState, Player, PlayerId, ReinforcementBreakdown, TerritoryId, TerritoryState } from './types.js';

/**
 * Territories a player can see under fog of war: everything they own plus every territory adjacent
 * to one they own. Works on any ownership map (full state or a view), so clients can preview fog.
 */
export function visibleTerritories(territories: Record<TerritoryId, { owner: PlayerId | null }>, playerId: PlayerId, map: MapDef): Set<TerritoryId> {
  const seen = new Set<TerritoryId>();
  for (const t of map.territoryIds) {
    if (territories[t]?.owner !== playerId) continue;
    seen.add(t);
    for (const n of map.adjacency[t]) seen.add(n);
  }
  return seen;
}

/** Apply fog to a territory map: unseen territories lose owner and armies and are marked hidden. */
export function fogTerritories(territories: Record<TerritoryId, TerritoryState>, visible: Set<TerritoryId>): Record<TerritoryId, TerritoryState> {
  const out: Record<TerritoryId, TerritoryState> = {};
  for (const [t, ts] of Object.entries(territories)) out[t] = visible.has(t) ? ts : { owner: null, armies: 0, hidden: true };
  return out;
}

function eventTerritories(e: GameEvent): TerritoryId[] {
  switch (e.type) {
    case 'placed':
      return [e.territory];
    case 'battle':
    case 'conquered':
    case 'moved':
      return [e.from, e.to];
    case 'capital_captured':
    case 'capital_chosen':
      return [e.territory];
    default:
      return [];
  }
}

function eventPlayers(e: GameEvent): PlayerId[] {
  switch (e.type) {
    case 'placed':
    case 'traded':
    case 'card_drawn':
    case 'turn_ended':
    case 'conquered':
    case 'moved':
    case 'capital_captured':
    case 'capital_chosen':
      return [e.player];
    case 'battle':
      return [e.attacker, e.defender];
    case 'cards_taken':
      return [e.player, e.from];
    case 'eliminated':
      return e.by ? [e.player, e.by] : [e.player];
    default:
      return [];
  }
}

/**
 * Under fog, a player only learns about events they took part in or that touched a territory they can
 * see; everything else is replaced by a bare {type:'fogged'} marker. Spectators (viewer null) see all.
 */
export function redactEvents(state: GameState, viewer: PlayerId | null, events: GameEvent[]): GameEvent[] {
  if (!state.options.fogOfWar || !viewer) return events;
  const map = getMap(state.options.map);
  const visible = visibleTerritories(state.territories, viewer, map);
  return events.map((e) => {
    if (e.type === 'turn_started' && e.player !== viewer && !territoriesOf(state, e.player).every((t) => visible.has(t))) {
      // Someone else's income would reveal what they hold behind the fog.
      return { ...e, reinforcements: { territories: 0, fromTerritories: 0, continents: [], capitals: 0, fromCapitals: 0, total: 0, hidden: true } };
    }
        if (e.type === 'capitals_assigned') return { type: 'capitals_assigned', capitals: Object.fromEntries(Object.entries(e.capitals).filter(([, t]) => visible.has(t))) };
    if (eventPlayers(e).includes(viewer)) return e;
    // Another player's card activity says something about them (they conquered, they traded): hide it.
    // A trade shows which cards (territories) and how many armies: hide it. Draws stay public, like card counts.
    if (e.type === 'traded') return { type: 'fogged', kind: e.type };
    const ts = eventTerritories(e);
    if (ts.length === 0) return e; // turn/phase/game-level events are public
    return ts.some((t) => visible.has(t)) ? e : { type: 'fogged', kind: e.type };
  });
}

export interface PlayerView extends Omit<Player, 'cards'> {
  cards: Card[] | null;
  /** Always visible, fog or not. */
  cardCount: number;
  /** null under fog of war when the viewer cannot see every territory this player holds. */
  territoryCount: number | null;
  /** null under fog of war when the viewer cannot see every territory this player holds. */
  armyCount: number | null;
  continents: string[];
  /** Armies this player would receive at the start of their next turn, before cards (null for the Neutral, and under fog when hidden). */
  income: ReinforcementBreakdown | null;
}

export interface GameView extends Omit<GameState, 'players' | 'deck' | 'discard' | 'rngState' | 'seed'> {
  players: PlayerView[];
  deckSize: number;
  discardSize: number;
  /** The viewer's own id, or null for spectators. */
  you: PlayerId | null;
  legal: LegalMoves | null;
  continentOwners: Record<string, PlayerId | null>;
}

/**
 * Redacted view of the state for a given player, or for a spectator when viewer is null.
 * Players see only their own hand; spectators see every hand (they are not playing).
 */
export function viewFor(state: GameState, viewer: PlayerId | null): GameView {
  const map = getMap(state.options.map);
  const fogged = !!state.options.fogOfWar && !!viewer && state.players.some((p) => p.id === viewer);
  const visible = fogged ? visibleTerritories(state.territories, viewer!, map) : null;
  // Under fog a player learns nothing about another player beyond the territories they can see and their
  // card count: their territory and army counts, income and continents are only shown if every territory
  // that player holds is visible (e.g. they border all of it).
  const seesAllOf = (pid: PlayerId) => !visible || pid === viewer || territoriesOf(state, pid).every((t) => visible.has(t));
  const continentVisible = (territories: TerritoryId[]) => !visible || territories.every((t) => isBlizzard(state, t) || visible.has(t));
  const players: PlayerView[] = state.players.map((p) => {
    const open = seesAllOf(p.id);
    return {
      ...p,
      cards: viewer === null || p.id === viewer ? p.cards : null,
      // Card counts are public at the table, fog or not.
      cardCount: p.cards.length,
      territoryCount: open ? territoriesOf(state, p.id).length : null,
      armyCount: open ? armiesOf(state, p.id) : null,
      continents: continentsOf(state, p.id)
        .filter((c) => open || continentVisible(c.territories))
        .map((c) => c.id),
      income: p.isNeutral || !open ? null : reinforcementsFor(state, p.id),
    };
  });
  const continentOwners: Record<string, PlayerId | null> = {};
  for (const c of map.continents) {
    const first = c.territories.find((t) => !isBlizzard(state, t));
    const owner = first ? state.territories[first].owner : null;
    continentOwners[c.id] = owner && controlsContinent(state, c.territories, owner) && continentVisible(c.territories) ? owner : null;
  }
  const { deck, discard, rngState, seed, players: _p, ...rest } = state;
  let territories = fogged ? fogTerritories(state.territories, visible!) : state.territories;
  // Blizzards are public knowledge, fog or not.
  if (fogged && state.blizzards?.length) {
    territories = { ...territories };
    for (const t of state.blizzards) territories[t] = { owner: null, armies: 0 };
  }
  const capitals = fogged ? Object.fromEntries(Object.entries(state.capitals).filter(([, t]) => !territories[t].hidden)) : state.capitals;
  return {
    ...rest,
    territories,
    capitals,
    players,
    deckSize: deck.length,
    discardSize: discard.length,
    you: viewer,
    legal: viewer ? legalMoves(state, viewer) : null,
    continentOwners,
  };
}

