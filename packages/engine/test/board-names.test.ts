import { describe, expect, it } from 'vitest';
import { rankLeaderboard } from '../src/ranking.js';
import { uniqueBoardNames } from '../src/board-names.js';

describe('uniqueBoardNames', () => {
  it('keeps the name for the first identity and numbers the later ones', () => {
    const results = [
      { gameId: '1', seats: [{ key: 'league/darius', name: 'Darius', placement: 2 }, { key: 'player:darius2', name: 'Darius2', placement: 1 }] },
      { gameId: '2', seats: [{ key: 'bot:darius', name: 'darius', placement: 1 }, { key: 'player:darius', name: ' Darius ', placement: 2 }] },
      { gameId: '3', seats: [{ key: 'league/ahri', name: 'Ahri', placement: 1 }, { key: 'league/darius', name: 'Darius', placement: 2 }] },
    ];
    const rows = uniqueBoardNames(rankLeaderboard(results), results);
    const name = (key: string) => rows.find((r) => r.key === key)!.name;
    expect(name('league/darius')).toBe('Darius');
    expect(name('player:darius2')).toBe('Darius2');
    // "darius2" is taken (case-insensitive), so the next one skips to 3.
    expect(name('bot:darius')).toBe('darius3');
    expect(name('player:darius')).toBe('Darius4');
    expect(name('league/ahri')).toBe('Ahri');
    expect(new Set(rows.map((r) => r.name.toLowerCase())).size).toBe(rows.length);
    // Ranks and points are untouched.
    expect(rows.map((r) => [r.key, r.rank, r.points])).toEqual(rankLeaderboard(results).map((r) => [r.key, r.rank, r.points]));
  });
});
