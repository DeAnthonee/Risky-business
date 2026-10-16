import { CONTINENTS, TERRITORY_IDS } from './map.js';
import { armiesOf, continentsOf, legalMoves, territoriesOf, type LegalMoves } from './engine.js';
import type { Card, GameState, Player, PlayerId } from './types.js';

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

/** Redacted view of the state for a given player (or spectator when null). */
export function viewFor(state: GameState, viewer: PlayerId | null): GameView {
  const players: PlayerView[] = state.players.map((p) => ({
    ...p,
    cards: p.id === viewer ? p.cards : null,
    cardCount: p.cards.length,
    territoryCount: territoriesOf(state, p.id).length,
    armyCount: armiesOf(state, p.id),
    continents: continentsOf(state, p.id).map((c) => c.id),
  }));
  const continentOwners: Record<string, PlayerId | null> = {};
  for (const c of CONTINENTS) {
    const owner = state.territories[c.territories[0]].owner;
    continentOwners[c.id] = owner && c.territories.every((t) => state.territories[t].owner === owner) ? owner : null;
  }
  const { deck, discard, rngState, seed, players: _p, ...rest } = state;
  return {
    ...rest,
    players,
    deckSize: deck.length,
    discardSize: discard.length,
    you: viewer,
    legal: viewer ? legalMoves(state, viewer) : null,
    continentOwners,
  };
}

export { TERRITORY_IDS };
