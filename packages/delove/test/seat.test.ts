import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, startGame, viewFor, type GameState } from '@risk/engine';
import { seededRandom } from '@risk/selfplay';
import { branchAgent, DEFAULT_BRANCH, jacob, jacobPickWith, JACOB_SENSEI_1_PARAMS, teacher } from '../src/index.js';
import { defaultName, discoverTunedTeachers, chooseFromView, stateFromView } from '../src/seat.js';

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

  it.each([
    ['manual setup, 4 seats', { maxPlayers: 4, fogOfWar: true }],
    ['league fog settings, World 6 seats', { maxPlayers: 6, map: 'world', fogOfWar: true, autoSetup: true, capitals: true, chooseCapitals: true, blizzards: 8 }],
  ] as const)('plays a fog game from fogged views alone, every move legal on the real state (%s)', (_n, options) => {
    let state: GameState = createGame('seat-fog', options, 12);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, options.maxPlayers)) state = addPlayer(state, id, id, true);
    state = startGame(state).state;
    let hidden = 0;
    while (state.phase !== 'finished' && state.turnNumber < 120) {
      const me = state.currentPlayer!;
      const view = viewFor(state, me);
      hidden += Object.values(view.territories).filter((t) => t.hidden).length ? 1 : 0;
      const action = chooseFromView(jacob, view, me, seededRandom(state.version));
      expect(action).not.toBeNull();
      state = applyAction(state, me, action!).state; // throws on an illegal move (e.g. a setup claim on a hidden territory)
    }
    expect(hidden).toBeGreaterThan(50);
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

  it("rebuilds every card count the view hides: opponents' hands, deck and discard", () => {
    let state: GameState = createGame('seat-cards', { maxPlayers: 4, map: 'world' }, 3);
    for (const id of ['a', 'b', 'c', 'd']) state = addPlayer(state, id, id, true);
    state = startGame(state).state;
    // Play until the hands are mixed: some players hold cards and some have traded.
    while (state.phase !== 'finished' && (state.discard.length === 0 || state.players.filter((p) => p.cards.length > 0).length < 3)) {
      const me = state.currentPlayer!;
      state = applyAction(state, me, chooseFromView(jacob, viewFor(state, me), me, () => 0.5)!).state;
    }
    const me = state.currentPlayer!;
    const rebuilt = stateFromView(viewFor(state, me), seededRandom(7));
    for (const p of state.players) {
      const q = rebuilt.players.find((x) => x.id === p.id)!;
      expect(q.cards.length).toBe(p.cards.length);
      if (p.id === me) expect(q.cards).toEqual(p.cards);
    }
    expect(rebuilt.deck.length).toBe(state.deck.length);
    expect(rebuilt.discard.length).toBe(state.discard.length);
    const ids = [...rebuilt.players.flatMap((p) => p.cards), ...rebuilt.deck, ...rebuilt.discard].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('plays branch and score (search at play time) from player views, every move legal', () => {
    let state: GameState = createGame('seat-branch', { maxPlayers: 3 }, 4);
    for (const id of ['a', 'b', 'c']) state = addPlayer(state, id, id, true);
    state = startGame(state).state;
    const search = branchAgent('delove-branch@1', jacobPickWith(JACOB_SENSEI_1_PARAMS), null, { ...DEFAULT_BRANCH, options: 2, rollouts: 2, horizon: 1 });
    const random = seededRandom(11);
    let moves = 0;
    while (state.phase !== 'finished' && state.turnNumber < 12) {
      const me = state.currentPlayer!;
      const agent = me === 'a' ? search : jacob;
      state = applyAction(state, me, chooseFromView(agent, viewFor(state, me), me, random)!).state; // throws on an illegal move
      moves++;
    }
    expect(moves).toBeGreaterThan(30);
    expect(defaultName('delove-branch@1')).toBe('Delove Search');
  });
});
