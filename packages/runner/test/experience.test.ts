import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readExperience, updateExperience, describeExperience, type ExperienceInput } from '../src/experience.js';
import { addPersonalityMemory, readPersonalityMemory, withLearningLock } from '../src/shared-memory.js';

describe('persistent personality and rivalries',()=>{
  it('remembers betrayals, subjective styles, head-to-head outcomes and later reconciliation across reloads',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'personality-'));
    try {
      const input:ExperienceInput={dir,id:'league/shen',name:'Shen',gameId:'G1',note:'Ahri broke our accepted truce. I lost.',ownWon:false,myPlacement:2,opponents:[{key:'league/ahri',name:'Ahri'}],opponentResults:{'league/ahri':{won:true,placement:1}},
        deals:[{id:'S1',kind:'truce',parties:['Shen','Ahri'],status:'broken',accepted:true,proposedBy:'Shen',proposedRound:1,text:'truce',brokenBy:'Ahri'}],
        llm:{chat:async()=>JSON.stringify({playstyle:'Keep reserves and negotiate short truces.',observations:[{with:'league/ahri',text:'I suspect she prefers surprise attacks.'},{with:'league/absent',text:'invented'}]})},log:()=>{}};
      await withLearningLock(dir,()=>updateExperience(input));
      let state=await readExperience(dir,input.id);
      expect(state.relationships['league/ahri']).toMatchObject({meetings:1,rapport:-25,winsAgainst:0,lossesAgainst:1,behindFinishes:1});
      expect(state.relationships['league/ahri'].facts.some(f=>f.text.includes('broken by Ahri'))).toBe(true);
      expect(state.relationships['league/ahri'].impressions[0].text).toContain('suspect');
      expect(state.relationships['league/absent']).toBeUndefined();
      expect(describeExperience(state)).toContain('may be mistaken');
      await withLearningLock(dir,()=>updateExperience(input));
      expect((await readExperience(dir,input.id)).relationships['league/ahri'].meetings).toBe(1);
      await withLearningLock(dir,()=>updateExperience({...input,gameId:'G2',ownWon:true,myPlacement:1,opponentResults:{'league/ahri':{won:false,placement:2}},deals:[{...input.deals[0],id:'S2',status:'expired'}],llm:{chat:async()=>{throw Error('offline');}}}));
      state=await readExperience(dir,input.id);
      expect(state.relationships['league/ahri']).toMatchObject({meetings:2,rapport:-17,winsAgainst:1,lossesAgainst:1,aheadFinishes:1,behindFinishes:1});
      expect(state.playstyle).toContain('reserves');
      // An offer that timed out without acceptance must not build trust.
      await updateExperience({...input,gameId:'G3',deals:[{...input.deals[0],accepted:false,status:'expired'}],llm:null});
      expect((await readExperience(dir,input.id)).relationships['league/ahri'].rapport).toBe(-17);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it('serializes simultaneous read-modify-writes and keeps memory separated by character',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'shared-learning-'));
    try {
      let active=0,max=0;
      await Promise.all(Array.from({length:4},(_,i)=>withLearningLock(dir,async()=>{
        active++;max=Math.max(max,active);
        await new Promise(r=>setTimeout(r,15));
        await addPersonalityMemory(dir,'league/shen',`G${i}`,`Lesson ${i}`);
        active--;
      })));
      expect(max).toBe(1);
      const memory=await readPersonalityMemory(dir,'league/shen');
      for(let i=0;i<4;i++)expect(memory).toContain(`Lesson ${i}`);
      expect(await readPersonalityMemory(dir,'league/ahri')).toBe('');
      await expect(readFile(path.join(dir,'.learning.lock','owner.json'))).rejects.toThrow();
      await expect(readPersonalityMemory(dir,'../escape')).rejects.toThrow('Invalid character');
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
