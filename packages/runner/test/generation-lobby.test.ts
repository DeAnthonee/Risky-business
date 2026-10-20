import { describe, expect, it } from 'vitest';
import { isGenerationGame, pickNextGenerationGame, pickLiveGame } from '../../client/src/components/AutoAdvance.js';
import type { GameSummary } from '../../client/src/api.js';

describe('Generation match lobby refresh and auto-advance', () => {
  it('identifies generation training matches by the runner\'s exact room name only', () => {
    expect(isGenerationGame('Generation 5 Match 74')).toBe(true);
    expect(isGenerationGame('Generation 6 Match 1')).toBe(true);
    expect(isGenerationGame('Generation mechanics Match 2')).toBe(true);
    // Loose matches a person might type, and tournament table names, never count
    expect(isGenerationGame('gen5')).toBe(false);
    expect(isGenerationGame('Imagen 3 night')).toBe(false);
    expect(isGenerationGame('Gen5 Cup · R1 Table 1')).toBe(false);
    expect(isGenerationGame('Bot table')).toBe(false);
    expect(isGenerationGame('Mechanics lab')).toBe(false);
    expect(isGenerationGame("Player's room")).toBe(false);
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

    // Never picks a tournament table, whatever its name
    const withTable: Partial<GameSummary>[] = [
      { id: 'table', name: 'Generation 5 Match 77', phase: 'turn', tournamentId: 't1' },
      { id: 'genLobby', name: 'Generation 5 Match 78', phase: 'lobby' },
    ];
    expect(pickNextGenerationGame(withTable as GameSummary[], null)?.id).toBe('genLobby');
  });
});
