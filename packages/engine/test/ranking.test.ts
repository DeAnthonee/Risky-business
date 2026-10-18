import { describe, expect, it } from 'vitest';
import { placementPoints, rankLeaderboard } from '../src/ranking.js';

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
    expect(rows.find(r=>r.key==='b')).toMatchObject({points:0,games:3,wins:1,losses:2});
  });
});
