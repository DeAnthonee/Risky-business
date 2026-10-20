import { describe, expect, it } from 'vitest';
import { finalPlacements, gamePoints, normalizeLeaderboardKey, placementPoints, rankLeaderboard } from '../src/ranking.js';
import { addPlayer, createGame, startGame } from '../src/engine.js';
import type { GameState } from '../src/types.js';

describe('placement ratings', () => {
  it('matches six-player points and is zero sum for every supported lobby size', () => {
    expect(Array.from({length:6}, (_,i) => placementPoints(i+1,6))).toEqual([3,2,1,-1,-2,-3]);
    for (let n=2;n<=10;n++) expect(Array.from({length:n},(_,i)=>placementPoints(i+1,n)).reduce((a,b)=>a+b,0)).toBe(0);
    expect(Array.from({length:5},(_,i)=>placementPoints(i+1,5))).toEqual([2,1,0,-1,-2]);
    expect(() => placementPoints(0,6)).toThrow();
  });
  it('floors each rating at zero, deduplicates games, and records averages and wins', () => {
    const game = (gameId:string, winner:string) => ({gameId,seats:[{key:winner,name:winner,placement:1},{key:winner==='a'?'b':'a',name:'other',placement:2}]});
    const rows = rankLeaderboard([game('1','b'),game('2','a'),game('2','a'),game('3','a')]);
    expect(rows.find(r=>r.key==='a')).toMatchObject({rank:1,points:2,games:3,wins:2,losses:1,avgPlacement:1.33});
    expect(rows.find(r=>r.key==='b')).toMatchObject({points:0,games:3,wins:1,losses:2,kills:0,victims:{}});
  });
  it('adds a point per kill, so a runner-up with the most kills can outscore the winner', () => {
    const seats = [
      {key:'w',name:'W',placement:1,killed:['c']},
      {key:'r',name:'R',placement:2,killed:['d','e','f']},
      {key:'c',name:'C',placement:3},{key:'d',name:'D',placement:4},{key:'e',name:'E',placement:5},{key:'f',name:'F',placement:6,killed:[]},
    ];
    expect(gamePoints(seats[0]!,6)).toBe(4);
    expect(gamePoints(seats[1]!,6)).toBe(5);
    const rows = rankLeaderboard([{gameId:'1',seats},{gameId:'2',seats:[{key:'r',name:'R',placement:1,killed:['d']},{key:'d',name:'D',placement:2}]}]);
    expect(rows[0]).toMatchObject({key:'r',rank:1,points:7,kills:4,victims:{d:2,e:1,f:1}});
    expect(rows.find(r=>r.key==='w')).toMatchObject({points:4,kills:1,victims:{c:1}});
  });

  it('normalizes and merges duplicate listings across player:, league/, and versioned keys', () => {
    expect(normalizeLeaderboardKey('player:jinx')).toMatchObject({ key: 'league/jinx', name: 'Jinx', playerId: 'league/jinx' });
    expect(normalizeLeaderboardKey('Jinx')).toMatchObject({ key: 'league/jinx', name: 'Jinx', playerId: 'league/jinx' });
    expect(normalizeLeaderboardKey('player:delove@3')).toMatchObject({ key: 'Delove', name: 'Delove', playerId: 'delove' });
    expect(normalizeLeaderboardKey('Delove@1')).toMatchObject({ key: 'Delove', name: 'Delove', playerId: 'delove' });
    expect(normalizeLeaderboardKey('player:sensei@2')).toMatchObject({ key: 'Sensei', name: 'Sensei', playerId: 'sensei' });
    expect(normalizeLeaderboardKey('Ronny@3')).toMatchObject({ key: 'Ronny', name: 'Ronny', playerId: 'ronny' });
    expect(normalizeLeaderboardKey('Joey@3')).toMatchObject({ key: 'Joey', name: 'Joey', playerId: 'joey' });
    expect(normalizeLeaderboardKey('Hans@3')).toMatchObject({ key: 'Hans', name: 'Hans', playerId: 'hans' });
    expect(normalizeLeaderboardKey('Demonte@3')).toMatchObject({ key: 'Demonte', name: 'Demonte', playerId: 'demonte' });
    expect(normalizeLeaderboardKey('Dejean@3')).toMatchObject({ key: 'Dejean', name: 'Dejean', playerId: 'dejean' });
    expect(normalizeLeaderboardKey('Demario@3')).toMatchObject({ key: 'Demario', name: 'Demario', playerId: 'demario' });
    expect(normalizeLeaderboardKey('Kai@3')).toMatchObject({ key: 'Kai', name: 'Kai', playerId: 'kai' });
    expect(normalizeLeaderboardKey('Lauren@3')).toMatchObject({ key: 'Lauren', name: 'Lauren', playerId: 'lauren' });
    expect(normalizeLeaderboardKey('Diane@3')).toMatchObject({ key: 'Diane', name: 'Diane', playerId: 'diane' });
    expect(normalizeLeaderboardKey('Jason@3')).toMatchObject({ key: 'Jason', name: 'Jason', playerId: 'jason' });

    // Merging duplicate games in rankLeaderboard
    const games = [
      {
        gameId: 'g1',
        seats: [
          { key: 'player:jinx', name: 'Jinx', playerId: 'p_jinx1', placement: 1, killed: ['player:delove@3'] },
          { key: 'player:delove@3', name: 'Delove@3', playerId: 'p_delove1', placement: 2, killed: [] },
        ],
      },
      {
        gameId: 'g2',
        seats: [
          { key: 'league/jinx', name: 'Jinx', playerId: 'p_jinx2', placement: 2, killed: [] },
          { key: 'Delove', name: 'Delove', playerId: 'p_delove2', placement: 1, killed: ['league/jinx'] },
        ],
      },
    ];
    const rows = rankLeaderboard(games);
    expect(rows).toHaveLength(2);
    const jinxRow = rows.find(r => r.key === 'league/jinx');
    const deloveRow = rows.find(r => r.key === 'Delove');
    expect(jinxRow).toBeDefined();
    expect(deloveRow).toBeDefined();
    expect(jinxRow?.games).toBe(2);
    expect(jinxRow?.wins).toBe(1);
    expect(jinxRow?.kills).toBe(1);
    expect(jinxRow?.victims).toEqual({ Delove: 1 });
    expect(jinxRow?.playerIds).toContain('p_jinx1');
    expect(jinxRow?.playerIds).toContain('p_jinx2');

    expect(deloveRow?.games).toBe(2);
    expect(deloveRow?.wins).toBe(1);
    expect(deloveRow?.kills).toBe(1);
    expect(deloveRow?.victims).toEqual({ 'league/jinx': 1 });
    expect(deloveRow?.playerIds).toContain('p_delove1');
    expect(deloveRow?.playerIds).toContain('p_delove2');
  });
});

describe('finalPlacements', () => {
  const finished = (): GameState => {
    let s = createGame('fp', { maxPlayers: 4 }, 3);
    for (const id of ['a', 'b', 'c', 'd']) s = addPlayer(s, id, id, true);
    s = startGame(s).state;
    const ids = Object.keys(s.territories);
    // a wins with 30 territories; b survives with the rest; c went out first (to a), then d (to b).
    ids.forEach((t, i) => (s.territories[t] = { owner: i < 30 ? 'a' : 'b', armies: i < 30 ? 2 : 1 }));
    const p = (id: string) => s.players.find((x) => x.id === id)!;
    p('c').alive = false;
    p('c').eliminatedBy = 'a';
    p('d').alive = false;
    p('d').eliminatedBy = 'b';
    s.winner = 'a';
    s.phase = 'finished';
    return s;
  };

  it('ranks winner, survivors, then eliminated players by reverse elimination order, with kills', () => {
    const r = finalPlacements(finished(), ['c', 'd']);
    expect(r.map((x) => [x.id, x.placement])).toEqual([['a', 1], ['b', 2], ['d', 3], ['c', 4]]);
    expect(r.find((x) => x.id === 'a')!.killed).toEqual(['c']);
    expect(r.find((x) => x.id === 'b')!.killed).toEqual(['d']);
    expect(gamePoints({ key: 'a', name: 'a', placement: 1, killed: ['c'] }, 4)).toBe(3);
  });

  it('ranks surviving non-winners by territories, then armies', () => {
    const s = finished();
    s.players.find((x) => x.id === 'd')!.alive = true;
    const ids = Object.keys(s.territories);
    ids.slice(30, 34).forEach((t) => (s.territories[t] = { owner: 'd', armies: 9 }));
    const r = finalPlacements(s, ['c']);
    expect(r.map((x) => x.id)).toEqual(['a', 'b', 'd', 'c']);
  });
});
