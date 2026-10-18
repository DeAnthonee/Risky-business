import { chooseBotAction, type Action, type GameState, type GameView, type PlayerId, type RandomSource } from '@risk/engine';

/**
 * Rebuild a GameState the engine bot can use from one player's view. Hidden parts (deck, discard, other
 * hands, the RNG) are filled with empty values: the bot never reads them. Under fog the hidden territories
 * stay blanked, exactly what the player knows.
 */
export function stateFromView(view: GameView): GameState {
  const { players, deckSize: _d, discardSize: _s, you: _y, legal: _l, continentOwners: _c, ...rest } = view;
  return {
    ...rest,
    players: players.map(({ cardCount: _cc, territoryCount: _tc, armyCount: _ac, continents: _co, income: _i, cards, ...p }) => ({
      ...p,
      cards: cards ?? [],
    })),
    deck: [],
    discard: [],
    seed: 0,
    rngState: 0,
  };
}

/** The built-in bot's move for this view; end_turn when it has none but the server says ending is legal. */
export function chooseMove(view: GameView, me: PlayerId, random: RandomSource = Math.random): Action | null {
  const action = chooseBotAction(stateFromView(view), me, random);
  if (action) return action;
  // canEndTurn is false in setup and claiming phases, so we never send end_turn there.
  if (view.legal?.yourTurn && view.legal.canEndTurn) return { type: 'end_turn' };
  return null;
}
