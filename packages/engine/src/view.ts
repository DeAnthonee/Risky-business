import { getMap, type MapDef } from './maps.js';
import { armiesOf, continentsOf, legalMoves, territoriesOf, type LegalMoves } from './engine.js';
import type { Card, GameEvent, GameState, Player, PlayerId, TerritoryId, TerritoryState } from './types.js';

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
    if (e.type === 'capitals_assigned') return { type: 'capitals_assigned', capitals: Object.fromEntries(Object.entries(e.capitals).filter(([, t]) => visible.has(t))) };
    if (eventPlayers(e).includes(viewer)) return e;
    const ts = eventTerritories(e);
    if (ts.length === 0) return e; // turn/phase/game-level events are public
    return ts.some((t) => visible.has(t)) ? e : { type: 'fogged', kind: e.type };
  });
}

export interface PlayerView extends Omit<Player, 'cards'> {
  cards: Card[] | null;
  cardCount: number;
  territoryCount: number;
  armyCount: number;
  continents: string[];
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
  const players: PlayerView[] = state.players.map((p) => ({
    ...p,
    cards: viewer === null || p.id === viewer ? p.cards : null,
    cardCount: p.cards.length,
    territoryCount: territoriesOf(state, p.id).length,
    armyCount: armiesOf(state, p.id),
    continents: continentsOf(state, p.id).map((c) => c.id),
  }));
  const continentOwners: Record<string, PlayerId | null> = {};
  for (const c of getMap(state.options.map).continents) {
    const owner = state.territories[c.territories[0]].owner;
    continentOwners[c.id] = owner && c.territories.every((t) => state.territories[t].owner === owner) ? owner : null;
  }
  const { deck, discard, rngState, seed, players: _p, ...rest } = state;
  const map = getMap(state.options.map);
  const fogged = !!state.options.fogOfWar && !!viewer && state.players.some((p) => p.id === viewer);
  const territories = fogged ? fogTerritories(state.territories, visibleTerritories(state.territories, viewer!, map)) : state.territories;
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

