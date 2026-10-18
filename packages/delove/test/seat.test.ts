import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, startGame, viewFor, type GameState } from '@risk/engine';
import { teacher } from '../src/index.js';
import { chooseFromView } from '../src/seat.js';

describe('Delove seat player', () => {
  it('plays a whole game from player views alone, every move legal on the real state', () => {
    let state: GameState = createGame('seat-test', { maxPlayers: 3, capitals: true }, 9);
    for (const id of ['a', 'b', 'c']) state = addPlayer(state, id, id, true);
    state = startGame(state).state;
    let moves = 0;
    while (state.phase !== 'finished' && state.turnNumber < 300) {
      const me = state.currentPlayer!;
      const action = chooseFromView(teacher, viewFor(state, me), me, () => 0.5);
      expect(action).not.toBeNull();
      state = applyAction(state, me, action!).state; // throws on an illegal move
      moves++;
    }
    expect(moves).toBeGreaterThan(50);
  });

  it('does nothing when it is not its turn', () => {
    let state: GameState = createGame('seat-test-2', { maxPlayers: 2 }, 1);
    state = addPlayer(addPlayer(state, 'a', 'a', true), 'b', 'b', true);
    state = startGame(state).state;
    const other = state.turnOrder.find((p) => p !== state.currentPlayer)!;
    expect(chooseFromView(teacher, viewFor(state, other), other, () => 0.5)).toBeNull();
  });
});
