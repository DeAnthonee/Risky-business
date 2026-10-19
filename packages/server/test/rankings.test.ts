import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createRiskServer, DEFAULT_AI_DIR, type RiskServer } from '../src/app.js';
import { CharacterStore } from '../src/characters.js';
import { Rankings } from '../src/rankings.js';
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
    writeFileSync(file,'{not json');
    expect(new Rankings(file).rows()).toEqual([]);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });
});
