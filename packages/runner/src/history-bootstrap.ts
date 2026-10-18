import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readResults, resultText } from './postgame.js';
import { readExperience, updateExperience } from './experience.js';
import { addPersonalityMemory, withLearningLock } from './shared-memory.js';

/** One startup transaction preserves old runner notes and head-to-head records without inventing historical deal facts. */
export async function bootstrapCharacterHistory(dir: string, ids: string[], log: (line:string)=>void) {
  const results=await readResults(dir);
  if (!results.length) return;
  await withLearningLock(dir,async()=>{
    for(const id of new Set(ids)) {
      const state=await readExperience(dir,id);
      const processed=new Set(state.processed);
      for(const result of results) {
        const own=result.seats.find(s=>s.character===id);
        if(!own || !result.winner || result.reason==='unfinished' || processed.has(result.gameId))continue;
        let note=resultText(result,own);
        const name=own.name.toLowerCase().replace(/[^a-z0-9_-]+/g,'-');
        try {note=await readFile(path.join(dir,'learnings',`${name}-${result.gameId}.md`),'utf8');} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await addPersonalityMemory(dir,id,result.gameId,note);
        const opponents=result.seats.filter(s=>s!==own);
        await updateExperience({dir,id,name:own.name,gameId:result.gameId,note,ownWon:own.placement===1,myPlacement:own.placement,
          opponents:opponents.map(s=>({key:s.character??'player:'+s.name.toLowerCase(),name:s.name})),
          opponentResults:Object.fromEntries(opponents.map(s=>[s.character??'player:'+s.name.toLowerCase(),{won:s.placement===1,placement:s.placement}])),
          deals:[],llm:null,log});
        processed.add(result.gameId);
        log(`${own.name}: restored personal notes and head-to-head results from ${result.gameId}`);
      }
    }
  });
}
