import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createRiskServer, DEFAULT_AI_DIR, type RiskServer } from '../src/app.js';
import { CharacterStore } from '../src/characters.js';
import { Rankings, RANKINGS_SEASON } from '../src/rankings.js';
import { HttpRiskApi } from '@risk/mcp';
import type { GameState } from '@risk/engine';

let risk: RiskServer | undefined;
const dirs: string[]=[];
afterEach(async()=>{if(risk) await risk.shutdown('test'); risk=undefined; for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('persistent character rankings API',()=>{
  it('tracks the same characters across rooms, protects seat binding, and survives reload/deletion',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'rankings-'));dirs.push(dir);
    const file=join(dir,'games.json');
    const store=new Store(file);
    risk=createRiskServer(store,{clientDir:null,sweepIntervalMs:0,characters:new CharacterStore(DEFAULT_AI_DIR,null,['league-key'])});
    await new Promise<void>(r=>risk!.server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const api=new HttpRiskApi(base,'league-key');
    expect((await api.rankings()).rankings).toEqual([]);
    const a=await api.createGame('Shen',undefined,{map:'classic',autoSetup:true,maxPlayers:2});
    const b=await api.joinGame(a.gameId,'Ahri');
    await expect(api.setCharacter(a.gameId,'invalid','league/shen')).rejects.toMatchObject({status:401});
    // Binding credits the character on the public leaderboard, so it needs the characters write key.
    const anon=new HttpRiskApi(base);
    await expect(anon.setCharacter(a.gameId,a.token,'league/shen')).rejects.toMatchObject({status:401});
    await expect(anon.setCharacter(a.gameId,a.token,'league/shen','wrong')).rejects.toMatchObject({status:403});
    await api.setCharacter(a.gameId,a.token,'league/shen');
    await expect(api.setCharacter(a.gameId,b.token,'league/shen')).rejects.toMatchObject({status:400});
    await api.setCharacter(a.gameId,b.token,'league/ahri');
    const before=await fetch(`${base}/api/games/${a.gameId}/players/${a.playerId}/profile`).then(r=>r.json());
    expect(before.stats).toMatchObject({key:'league/shen',games:0,rank:0,points:0});
    expect(before.profile).toContain('Shen');
    // The same identities may take seats in another lobby while the first is still open.
    const c=await api.createGame('Shen',undefined,{map:'classic',autoSetup:true,maxPlayers:2});
    const d=await api.joinGame(c.gameId,'Ahri');
    await api.setCharacter(c.gameId,c.token,'league/shen');
    await api.setCharacter(c.gameId,d.token,'league/ahri');
    await api.start(a.gameId,a.token);
    await expect(api.setCharacter(a.gameId,a.token,'league/ahri')).rejects.toMatchObject({status:400});
    await api.act(a.gameId,b.token,{type:'surrender'});
    expect((await api.rankedProfile('league/shen')).stats).toMatchObject({points:1,games:1,wins:1,losses:0,avgPlacement:1});
    await api.start(c.gameId,c.token);
    await api.act(c.gameId,c.token,{type:'surrender'});
    const rows=(await api.rankings()).rankings;
    expect(rows[0]).toMatchObject({key:'league/ahri',rank:1,points:1,games:2,wins:1,losses:1,avgPlacement:1.5});
    expect(rows[1]).toMatchObject({key:'league/shen',rank:2,points:0,games:2,wins:1,losses:1});
    store.delete(a.gameId,'host');
    store.save();
    await risk.shutdown('reload');risk=undefined;
    const restored=new Store(file);
    expect(restored.rankings.rows()).toEqual(rows);
    restored.get(c.gameId)?.close('host');
    restored.rankings.record(restored.get(c.gameId)!.state,restored.get(c.gameId)!.characterIds,[]);
    expect(restored.rankings.rows()).toEqual(rows);
    restored.stopTimers();
  });
  it('credits eliminations to the eliminator, but not surrenders or neutral armies',()=>{
    const player=(id:string,order:number,extra:object={})=>({id,name:id.toUpperCase(),order,isBot:false,isNeutral:false,alive:false,...extra});
    const state={id:'g1',phase:'finished',winner:'a',territories:{t1:{owner:'a',armies:5},t2:{owner:'b',armies:2}},players:[
      player('a',0,{alive:true}),player('b',1,{alive:true}),
      player('c',2,{eliminatedBy:'b'}),player('d',3,{eliminatedBy:'b'}),player('e',4,{eliminatedBy:'a'}),player('f',5),
      player('n',6,{isNeutral:true,eliminatedBy:'a'}),
    ]} as unknown as GameState;
    const rankings=new Rankings(null);
    rankings.record(state,{b:'league/shen'},['f','c','d','e']);
    const rows=rankings.rows();
    expect(rows.find(r=>r.key==='league/shen')).toMatchObject({points:2+2,kills:2,victims:{'player:c':1,'player:d':1}});
    expect(rows.find(r=>r.key==='player:a')).toMatchObject({points:3+1,kills:1,victims:{'player:e':1}});
    expect(rows.find(r=>r.key==='player:f')).toMatchObject({kills:0});
  });
  it('sets a corrupt rankings file aside instead of failing to start',()=>{
    const dir=mkdtempSync(join(tmpdir(),'rankings-'));dirs.push(dir);
    const file=join(dir,'rankings.json');
    writeFileSync(`${file}.season`,`${RANKINGS_SEASON}
`);
    writeFileSync(file,'{not json');
    expect(new Rankings(file).rows()).toEqual([]);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });
  it('archives an older season and starts the new one empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rankings-'));
    dirs.push(dir);
    const file = join(dir, 'rankings.json');
    const old = [{ gameId: 'g_old_1', seats: [{ key: 'league/jinx', name: 'Jinx', placement: 1, killed: [] }, { key: 'league/shaco', name: 'Shaco', placement: 2, killed: [] }] }];
    // A file from before seasons existed counts as season 1.
    writeFileSync(file, JSON.stringify(old), 'utf8');
    expect(new Rankings(file, 2).rows()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'rankings.season-1.json'), 'utf8'))).toEqual(old);
    expect(readFileSync(`${file}.season`, 'utf8').trim()).toBe('2');
    // Same season on the next start: results are kept.
    writeFileSync(file, JSON.stringify(old), 'utf8');
    expect(new Rankings(file, 2).rows()).toHaveLength(2);
    expect(existsSync(join(dir, 'rankings.season-2.json'))).toBe(false);
    // Bumping again archives season 2.
    expect(new Rankings(file, 3).rows()).toEqual([]);
    expect(existsSync(join(dir, 'rankings.season-2.json'))).toBe(true);
  });
  it('keeps a saved season newer than the code one, and archives in memory without a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rankings-'));
    dirs.push(dir);
    const file = join(dir, 'rankings.json');
    const old = [{ gameId: 'g_old_1', seats: [{ key: 'league/jinx', name: 'Jinx', placement: 1, killed: [] }, { key: 'league/shaco', name: 'Shaco', placement: 2, killed: [] }] }];
    writeFileSync(`${file}.season`, '5' + String.fromCharCode(10));
    writeFileSync(file, JSON.stringify(old), 'utf8');
    // An admin moved on to season 5; code still says 2, so nothing is archived.
    const r = new Rankings(file, 2);
    expect(r.season).toBe(5);
    expect(r.rows()).toHaveLength(2);
    expect(r.newSeason()).toEqual({ archived: 5, season: 6 });
    expect(r.rows()).toEqual([]);
    expect(r.seasonRows('5')).toHaveLength(2);
    expect(r.seasonRows('4')).toBeNull();
    expect(readFileSync(`${file}.season`, 'utf8').trim()).toBe('6');
    // An archived game is never counted again in the new season, even after a restart.
    const again = new Rankings(file, 2);
    expect(again.season).toBe(6);
    again.record({ id: 'g_old_1', phase: 'finished', winner: 'a', territories: {}, players: [] } as unknown as GameState, {}, []);
    expect(again.rows()).toEqual([]);
    const mem = new Rankings(null, 3);
    expect(mem.newSeason()).toEqual({ archived: 3, season: 4 });
    expect(mem.seasons()).toEqual([{ id: '4', season: 4, current: true, games: 0 }]);
  });
});

describe('leaderboard seasons API', () => {
  it('archives the board on an admin call, keeps old seasons readable, and loses no game finished meanwhile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rankings-'));
    dirs.push(dir);
    const store = new Store(join(dir, 'games.json'));
    risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0, adminToken: 'admin-secret' });
    await new Promise<void>(r => risk!.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    const api = new HttpRiskApi(base);
    const season = store.rankings.season;
    // Two-seat games that end when the second seat surrenders.
    const table = async (a: string, b: string) => {
      const g = await api.createGame(a, undefined, { map: 'classic', autoSetup: true, maxPlayers: 2 });
      const j = await api.joinGame(g.gameId, b);
      await api.start(g.gameId, g.token);
      return { id: g.gameId, finish: () => api.act(g.gameId, j.token, { type: 'surrender' }) };
    };
    await (await table('Shen', 'Ahri')).finish();
    const before = await api.rankings();
    expect(before).toMatchObject({ season: String(season), current: true });
    expect(before.rankings.map(r => r.key)).toEqual(['player:shen', 'player:ahri']);

    const post = (token?: string) => fetch(`${base}/api/admin/rankings/new-season`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await post()).status).toBe(401);
    expect((await post('wrong')).status).toBe(401);
    expect((await api.rankings()).rankings).toHaveLength(2);

    // Games finishing while the archive happens land wholly in one season or the other.
    const tables = await Promise.all(['Garen', 'Lux', 'Jinx', 'Vi'].map((n, i) => table(n, `Foe${i}`)));
    const [res] = await Promise.all([post('admin-secret'), ...tables.map(t => t.finish())]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: season, season: season + 1 });
    expect(existsSync(join(dir, `rankings.season-${season}.json`))).toBe(true);
    const archivedIds = JSON.parse(readFileSync(join(dir, `rankings.season-${season}.json`), 'utf8')).map((g: { gameId: string }) => g.gameId);
    const currentIds = JSON.parse(readFileSync(join(dir, 'rankings.json'), 'utf8')).map((g: { gameId: string }) => g.gameId);
    expect([...archivedIds, ...currentIds].sort()).toEqual(expect.arrayContaining(tables.map(t => t.id)));
    expect(archivedIds.length + currentIds.length).toBe(5);
    expect(archivedIds.filter((id: string) => currentIds.includes(id))).toEqual([]);

    // A second archive never overwrites the first; the new season starts empty.
    expect((await (await post('admin-secret')).json()).season).toBe(season + 2);
    const now = await api.rankings();
    expect(now).toMatchObject({ season: String(season + 2), current: true, rankings: [] });
    const list = await api.rankingSeasons();
    expect(list.current).toBe(season + 2);
    expect(list.seasons.map(s => [s.id, s.current, s.games])).toEqual([[String(season + 2), true, 0], [String(season + 1), false, currentIds.length], [String(season), false, archivedIds.length]]);
    const old = await api.rankings(String(season));
    expect(old).toMatchObject({ season: String(season), current: false });
    expect(old.rankings.find(r => r.key === 'player:shen')).toMatchObject({ wins: 1, points: 1 });
    const profile = await fetch(`${base}/api/rankings/profile?key=player:shen&season=${season}`).then(r => r.json());
    expect(profile.stats).toMatchObject({ key: 'player:shen', wins: 1 });
    expect((await fetch(`${base}/api/rankings/profile?key=player:shen`).then(r => r.json())).stats).toMatchObject({ games: 0 });
    await expect(api.rankings('99')).rejects.toMatchObject({ status: 404 });
    await expect(api.rankings('../games')).rejects.toMatchObject({ status: 404 });

    // The admin season survives a restart with the code season unchanged.
    await risk.shutdown('reload'); risk = undefined;
    const restored = new Store(join(dir, 'games.json'));
    expect(restored.rankings.season).toBe(season + 2);
    expect(restored.rankings.rows()).toEqual([]);
    restored.stopTimers();
  });
  it('answers 404 for the admin route when no admin token is configured', async () => {
    const store = new Store(null);
    risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>(r => risk!.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/admin/rankings/new-season`, { method: 'POST' })).status).toBe(404);
    expect(await fetch(`${base}/api/rankings/seasons`).then(r => r.json())).toEqual({ current: RANKINGS_SEASON, seasons: [{ id: String(RANKINGS_SEASON), season: RANKINGS_SEASON, current: true, games: 0 }] });
  });
});
