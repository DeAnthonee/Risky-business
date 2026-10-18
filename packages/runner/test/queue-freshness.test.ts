import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OllamaLlm } from '../src/llm.js';

describe('model queue freshness',()=>{
  it('prepares prompts only after queue admission, and skips cancelled context',async()=>{
    let release!:()=>void;
    let entered!:()=>void;
    const firstStarted=new Promise<void>(r=>{entered=r;});
    const firstHold=new Promise<void>(r=>{release=r;});
    const rounds:string[]=[];
    const server=createServer(async(req,res)=>{
      let text='';for await(const chunk of req)text+=chunk;
      rounds.push(JSON.parse(text).messages[0].content);
      if(rounds.length===1){entered();await firstHold;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({message:{content:'ok'}}));
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try{
      const llm=new OllamaLlm({baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,concurrency:1});
      const first=llm.chat([{role:'user',content:'occupy slot'}]);
      await firstStarted;
      let current=6,prepared=0;
      const second=llm.chat([{role:'user',content:'old round 6'}],{prepare:()=>{prepared++;return[{role:'user',content:`current round ${current}`}];}});
      const cancelled=llm.chat([{role:'user',content:'must not send'}],{prepare:()=>null}).catch(e=>e.message);
      expect(prepared).toBe(0);
      current=10;release();
      await Promise.all([first,second]);
      expect(await cancelled).toContain('cancelled');
      expect(rounds).toEqual(['occupy slot','current round 10']);
      expect(prepared).toBe(1);
    }finally{release();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
});
