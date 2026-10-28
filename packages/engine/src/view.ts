import { getMap, type MapDef } from './maps.js';
import { armiesOf, continentsOf, controlsContinent, isBlizzard, legalMoves, reinforcementsFor, territoriesOf, type LegalMoves } from './engine.js';
import type { Card, GameEvent, GameState, Player, PlayerId, ReinforcementBreakdown, TerritoryId, TerritoryState } from './types.js';
import type { AnyGameEvent } from './stall.js';

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
/**
 * Whether fog applies to this viewer: a seated player who is still in a running game. Spectators, players
 * who have been eliminated and everyone once the game is over see the whole board.
 */
function foggedFor(state: GameState, viewer: PlayerId | null): boolean {
  if (!state.options.fogOfWar || state.fogLifted || !viewer || state.phase === 'finished') return false;
  const p = state.players.find((x) => x.id === viewer);
  return !!p && p.alive;
}

export function redactEvents(state: GameState, viewer: PlayerId | null, events: GameEvent[]): GameEvent[] {
  if (!foggedFor(state, viewer)) return events;
  viewer = viewer!;
  const map = getMap(state.options.map);
  const visible = visibleTerritories(state.territories, viewer, map);
  return events.map((e) => {
    if (e.type === 'turn_started' && e.player !== viewer && !territoriesOf(state, e.player).every((t) => visible.has(t))) {
      // Total reinforcement income is public even under fog; only the breakdown behind the fog is hidden.
      return {
        ...e,
        reinforcements: {
          territories: 0,
          fromTerritories: 0,
          continents: [],
          capitals: 0,
          fromCapitals: 0,
          ...(e.reinforcements.fromTurnOrder !== undefined ? { fromTurnOrder: e.reinforcements.fromTurnOrder } : {}),
          total: e.reinforcements.total,
          hidden: true,
        },
      };
    }
    // A storm under fog (stallStorm below stallFogLift): only the losses on territories this player can see.
    const se = e as AnyGameEvent;
    if (se.type === 'storm') return { ...se, losses: Object.fromEntries(Object.entries(se.losses).filter(([t]) => visible.has(t))) } as unknown as GameEvent;
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

/**
 * The territories as a viewer sees them: the whole board for spectators and when fog does not apply to them,
 * otherwise unseen territories blanked and marked hidden. Blizzards are public knowledge, fog or not.
 */
export function boardFor(state: GameState, viewer: PlayerId | null): Record<TerritoryId, TerritoryState> {
  if (!foggedFor(state, viewer)) return state.territories;
  const territories = fogTerritories(state.territories, visibleTerritories(state.territories, viewer!, getMap(state.options.map)));
  for (const t of state.blizzards ?? []) territories[t] = { owner: null, armies: 0 };
  return territories;
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
  /** Armies this player would receive at the start of their next turn, before cards (null for the Neutral; under fog total is visible and breakdown is hidden). */
  income: ReinforcementBreakdown | null;
  /**
   * The seat's self-declared player type ("claude-sonnet-5-5", "delove@10", "bot", "zerg"). Never set by `viewFor`:
   * the server adds it to the spectator view only, so a seated player never sees it.
   */
  agent?: string;
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
/** What every view of one state shares, whoever looks: each player's holdings and income, the continents' owners. */
export interface BoardStats {
  seats: Map<PlayerId, { territories: TerritoryId[]; armies: number; continents: { id: string; territories: TerritoryId[] }[]; income: ReinforcementBreakdown | null }>;
  /** Each continent's whole owner, before fog. */
  continentOwners: Record<string, PlayerId | null>;
}

/**
 * The viewer-independent part of `viewFor`. A caller that builds many views of one state (the server: every move wakes
 * every seat's long-poll, ~100 at a 100-seat Mega Earth table) works it out once and passes it to each `viewFor`;
 * working it out per view was players x territories for every one of them.
 */
export function boardStats(state: GameState): BoardStats {
  const seats: BoardStats['seats'] = new Map();
  for (const p of state.players) {
    seats.set(p.id, {
      territories: territoriesOf(state, p.id),
      armies: armiesOf(state, p.id),
      continents: continentsOf(state, p.id),
      income: p.isNeutral ? null : reinforcementsFor(state, p.id),
    });
  }
  const continentOwners: Record<string, PlayerId | null> = {};
  for (const c of getMap(state.options.map).continents) {
    const first = c.territories.find((t) => !isBlizzard(state, t));
    const owner = first ? state.territories[first].owner : null;
    continentOwners[c.id] = owner && controlsContinent(state, c.territories, owner) ? owner : null;
  }
  return { seats, continentOwners };
}

/** `stats`: `boardStats(state)` of this very state, when the caller already has it. */
export function viewFor(state: GameState, viewer: PlayerId | null, stats: BoardStats = boardStats(state)): GameView {
  const map = getMap(state.options.map);
  const fogged = foggedFor(state, viewer);
  const visible = fogged ? visibleTerritories(state.territories, viewer!, map) : null;
  // Under fog a player sees another player's card count and total reinforcement income, plus any
  // territories they border; territory/army counts, income breakdown and continents are only shown
  // if every territory that player holds is visible.
  const seesAllOf = (pid: PlayerId) => !visible || pid === viewer || stats.seats.get(pid)!.territories.every((t) => visible.has(t));
  const continentVisible = (territories: TerritoryId[]) => !visible || territories.every((t) => isBlizzard(state, t) || visible.has(t));
  const players: PlayerView[] = state.players.map((p) => {
    const open = seesAllOf(p.id);
    const seat = stats.seats.get(p.id)!;
    const rawIncome = seat.income;
    return {
      ...p,
      tradesMade: p.tradesMade ?? 0,
      cards: viewer === null || p.id === viewer ? p.cards : null,
      // Card counts and total reinforcement income are public at the table, fog or not.
      cardCount: p.cards.length,
      territoryCount: open ? seat.territories.length : null,
      armyCount: open ? seat.armies : null,
      continents: seat.continents
        .filter((c) => open || continentVisible(c.territories))
        .map((c) => c.id),
      income: !rawIncome
        ? null
        : open
          ? { ...rawIncome, continents: rawIncome.continents.map((c) => ({ ...c })) }
          : {
              territories: 0,
              fromTerritories: 0,
              continents: [],
              capitals: 0,
              fromCapitals: 0,
              total: rawIncome.total,
              hidden: true,
            },
      // While they reinforce, the armies left to place would give away hidden card trades.
      armiesToPlace: open ? p.armiesToPlace : 0,
    };
  });
  const continentOwners: Record<string, PlayerId | null> = {};
  for (const c of map.continents) continentOwners[c.id] = stats.continentOwners[c.id] && continentVisible(c.territories) ? stats.continentOwners[c.id] : null;
  const { deck, discard, rngState, seed, players: _p, ...rest } = state;
  const territories = boardFor(state, viewer);
  const capitals = fogged ? Object.fromEntries(Object.entries(state.capitals).filter(([, t]) => !territories[t].hidden)) : state.capitals;
  // Another player's pending occupy names both ends of the conquest and the size of the attacking stack.
  const pc = state.pendingConquest;
  const pendingConquest = fogged && pc && state.currentPlayer !== viewer && (territories[pc.from]?.hidden || territories[pc.to]?.hidden) ? null : pc;
  return {
    ...rest,
    pendingConquest,
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

