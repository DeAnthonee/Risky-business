import { describe, expect, it } from 'vitest';
import { isGenerationGame, pickNextGenerationGame, pickLiveGame } from '../../client/src/components/AutoAdvance.js';
import type { GameSummary } from '../../client/src/api.js';

describe('Generation match lobby refresh and auto-advance', () => {
  it('correctly identifies generation training matches by name', () => {
    expect(isGenerationGame({ name: 'Generation 5 Match 74' })).toBe(true);
    expect(isGenerationGame({ name: 'gen5' })).toBe(true);
    expect(isGenerationGame({ name: 'Generation 6 Match 1' })).toBe(true);
    expect(isGenerationGame({ name: 'Bot table' })).toBe(false);
    expect(isGenerationGame({ name: 'Mechanics lab' })).toBe(false);
    expect(isGenerationGame({ name: "Player's room" })).toBe(false);
    expect(isGenerationGame(null)).toBe(false);
    expect(isGenerationGame(undefined)).toBe(false);
  });

  it('pickNextGenerationGame finds generation lobby or live games, ignoring standard games', () => {
    const games: Partial<GameSummary>[] = [
      { id: 'std1', name: 'Standard Game', phase: 'turn' },
      { id: 'std2', name: 'Standard Lobby', phase: 'lobby' },
      { id: 'genLobby', name: 'Generation 5 Match 75', phase: 'lobby' },
    ];

    // Standard picker ignores all lobbies and picks the live standard game
    expect(pickLiveGame(games as GameSummary[], null)?.id).toBe('std1');

    // Generation picker finds the generation lobby
    expect(pickNextGenerationGame(games as GameSummary[], null)?.id).toBe('genLobby');

    // When a live generation game is available, it prioritizes live over lobby
    const gamesWithLiveGen: Partial<GameSummary>[] = [
      { id: 'genLobby', name: 'Generation 5 Match 76', phase: 'lobby' },
      { id: 'genLive', name: 'Generation 5 Match 75', phase: 'turn' },
    ];
    expect(pickNextGenerationGame(gamesWithLiveGen as GameSummary[], null)?.id).toBe('genLive');

    // Excludes the current game
    expect(pickNextGenerationGame(gamesWithLiveGen as GameSummary[], 'genLive')?.id).toBe('genLobby');
  });
});
