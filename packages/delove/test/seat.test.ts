import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, startGame, viewFor, type GameState } from '@risk/engine';
import { teacher } from '../src/index.js';
import { defaultName, discoverTunedTeachers, chooseFromView } from '../src/seat.js';

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

  it('formats display names for teacher and network models cleanly', () => {
    expect(defaultName('delove-teacher@1')).toBe('Sensei 1');
    expect(defaultName('sensei@1')).toBe('Sensei 1');
    expect(defaultName('sensei')).toBe('Sensei 1');
    expect(defaultName('delove-teacher@2')).toBe('Sensei 2');
    expect(defaultName('sensei@2')).toBe('Sensei 2');
    expect(defaultName('jacob-sensei@1')).toBe('Jacob Sensei');
    expect(defaultName('jacob')).toBe('Jacob Sensei');
    expect(defaultName('delove@3')).toBe('Delove 3');
    expect(defaultName('delove@3-explore')).toBe('Delove 3 (explore)');
    expect(defaultName('custom-agent')).toBe('custom-agent');
  });

  it('discovers tuned teacher agent configurations from files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'teachers-test-'));
    try {
      expect(discoverTunedTeachers(join(tmp, 'nonexistent'))).toEqual([]);

      writeFileSync(join(tmp, 'delove-teacher@2.json'), JSON.stringify({ continentWeight: 2.5 }));
      writeFileSync(join(tmp, 'ignore-me.txt'), 'ignore');

      const discovered = discoverTunedTeachers(tmp);
      expect(discovered.length).toBe(1);
      expect(discovered[0].id).toBe('delove-teacher@2');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
