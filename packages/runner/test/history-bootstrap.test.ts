import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapCharacterHistory } from '../src/history-bootstrap.js';
import { readExperience } from '../src/experience.js';
import { readPersonalityMemory } from '../src/shared-memory.js';

describe('startup memory continuity',()=>{
  it('restores old notes and head-to-head outcomes exactly once without inventing historical betrayals',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'history-bootstrap-'));
    try {
      await mkdir(path.join(dir,'learnings'));
      await writeFile(path.join(dir,'learnings','shen-OLD.md'),'Keep a reserve after Ahri took Indonesia.');
      const seat=(name:string,character:string,placement:number)=>({name,character,placement,alive:placement===1,territories:placement===1?42:0,armies:placement===1?50:0,capitals:0,heldBonus:false,bonuses:[],eliminatedRound:placement===1?null:8,eliminatedBy:placement===1?null:'Ahri'});
      const result={gameId:'OLD',date:'2026-10-18T20:00:00Z',map:'classic',winner:'Ahri',winnerCharacter:'league/ahri',reason:'domination',rounds:8,turns:16,seats:[seat('Ahri','league/ahri',1),seat('Shen','league/shen',2)]};
      await writeFile(path.join(dir,'results.jsonl'),[JSON.stringify(result),JSON.stringify(result),''].join('\n'));
      await bootstrapCharacterHistory(dir,['league/shen','league/ahri'],()=>{});
      await bootstrapCharacterHistory(dir,['league/shen','league/ahri'],()=>{});
      const memory=await readPersonalityMemory(dir,'league/shen');
      expect(memory).toContain('Keep a reserve');
      expect(memory.match(/<!-- game:OLD -->/g)).toHaveLength(1);
      const state=await readExperience(dir,'league/shen');
      expect(state.processed).toEqual(['OLD']);
      expect(state.relationships['league/ahri']).toMatchObject({meetings:1,lossesAgainst:1,rapport:0});
      expect(state.relationships['league/ahri'].facts.every(f=>!f.text.includes('broken'))).toBe(true);
      expect((await readExperience(dir,'league/ahri')).relationships['league/shen'].winsAgainst).toBe(1);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
