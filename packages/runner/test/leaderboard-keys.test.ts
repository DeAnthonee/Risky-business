import { describe, expect, it } from 'vitest';
import { normalizeLeaderboardKey } from '../src/leaderboard-keys.js';
import { computeLeaderboard, type GameResult } from '../src/postgame.js';

describe('runner leaderboard keys', () => {
  it('merges player:, league/ and versioned names into one entry', () => {
    expect(normalizeLeaderboardKey('player:jinx')).toMatchObject({ key: 'league/jinx', name: 'Jinx', playerId: 'league/jinx' });
    expect(normalizeLeaderboardKey('Jinx')).toMatchObject({ key: 'league/jinx', name: 'Jinx' });
    expect(normalizeLeaderboardKey('league/jinx')).toMatchObject({ key: 'league/jinx' });
    expect(normalizeLeaderboardKey('player:delove@3')).toMatchObject({ key: 'Delove', playerId: 'delove' });
    expect(normalizeLeaderboardKey('player:sensei@2')).toMatchObject({ key: 'Sensei', playerId: 'sensei' });
    for (const name of ['Ronny', 'Joey', 'Hans', 'Demonte', 'Dejean', 'Demario', 'Kai', 'Lauren', 'Diane', 'Jason']) {
      expect(normalizeLeaderboardKey(`${name}@13`)).toMatchObject({ key: name, name, playerId: name.toLowerCase() });
    }
    expect(normalizeLeaderboardKey('Someone Else')).toMatchObject({ key: 'Someone Else' });
    expect(normalizeLeaderboardKey('')).toMatchObject({ key: 'unknown' });
  });

  it('counts one row per character across versions in the runner leaderboard', () => {
    const game = (gameId: string, ronny: string, winner: string): GameResult =>
      ({
        gameId,
        map: 'classic',
        winner,
        reason: 'domination',
        seats: [
          { name: 'Jinx', character: 'league/jinx', playerId: `${gameId}-a`, placement: winner === 'Jinx' ? 1 : 2, eliminatedBy: null },
          { name: ronny, character: null, playerId: `${gameId}-b`, placement: winner === ronny ? 1 : 2, eliminatedBy: winner === ronny ? null : 'Jinx' },
        ],
      }) as unknown as GameResult;
    const lb = computeLeaderboard([game('g1', 'Ronny@6', 'Jinx'), game('g2', 'Ronny@13', 'Ronny@13')]);
    const ronny = lb.byCharacter.find((r) => r.key === 'Ronny')!;
    expect(ronny).toMatchObject({ games: 2, wins: 1 });
    expect(ronny.playerIds?.sort()).toEqual(['g1-b', 'g2-b']);
    expect(lb.byCharacter.find((r) => r.key === 'league/jinx')).toMatchObject({ games: 2, wins: 1, kills: 1 });
  });
});
