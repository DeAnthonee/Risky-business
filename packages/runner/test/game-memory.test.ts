import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, viewFor, getMap, type GameEvent, type GameView } from '@risk/engine';
import { GameMemory, assessLeader } from '../src/game-memory.js';
import type { Deal } from '../src/deals.js';

function board(round=10):GameView {
  let state=createGame('MEM',{maxPlayers:3,map:'classic',autoSetup:true},7);
  for(const [id,name] of [['a','Shen'],['b','Ahri'],['c','Lux']])state=addPlayer(state,id,name,false);
  state=startGame(state).state;
  const view=viewFor(state,'a');
  return {...view,version:1,round,turnNumber:round*3,territories:Object.fromEntries(Object.entries(view.territories).map(([id,t])=>[id,{...t,owner:getMap('classic').continentById.australia.territories.includes(id)?'a':'c'}]))};
}
function battle(to:string):GameEvent {return {type:'battle',attacker:'b',defender:'a',from:'siam',to,attackerDice:[6],defenderDice:[1],attackerLosses:0,defenderLosses:1,fromArmies:5,toArmies:1};}
const loss=(to:string):GameEvent=>({type:'conquered',player:'b',from:'siam',to,previousOwner:'a'});
const taken=(view:GameView,to:string)=>({...view,version:2,territories:{...view.territories,[to]:{...view.territories[to],owner:'b'}}});
const notice=(extra={})=>({id:1,name:'Ahri',message:'Shen, I am passing through your territory.',at:Date.now(),to:'a',...extra});

describe('private game-local tactical memory',()=>{
  it('remembers failed attacks, conquests and who broke a bonus; deduplicates and retains totals after recapture',()=>{
    const view=board();const to='indonesia';const memory=new GameMemory('a');
    memory.observe(view);
    const after=taken(view,to);
    const events=[battle(to),loss(to)];
    memory.observe(after,[{version:2,events}]);
    memory.observe(after,[{version:2,events}]);
    let summary=memory.summary(after);
    expect(summary).toContain('Ahri: 1 observed attack orders, 1 defending armies lost, 1 territories taken, 1 bonuses broken');
    expect(summary).toContain('broke my Australia bonus');
    expect(summary).toContain('no accepted alliance recorded');
    expect(summary).toContain('no advance passage notice received');
    const retaken={...view,version:3};
    memory.observe(retaken,[{version:3,events:[{type:'conquered',player:'a',previousOwner:'b',from:'new_guinea',to}]}]);
    memory.observe({...retaken,version:4},[{version:4,events:[battle(to)]}]);
    summary=memory.summary(retaken);
    expect(summary).toContain('Ahri: 2 observed attack orders, 2 defending armies lost, 1 territories taken, 1 bonuses broken');
    expect(()=>memory.observe({...view,id:'OTHER'})).toThrow('cannot cross');
  });
  it('records only notices received before an incident, never treats spectators or retroactive claims as permission',()=>{
    const view=board(),after=taken(view,'indonesia');
    const announced=new GameMemory('a');
    announced.observe(view);announced.onMessages([notice()],view);
    announced.observe(after,[{version:2,events:[battle('indonesia')]}]);
    expect(announced.summary(after)).toContain('advance passage notice received (not permission or immunity)');
    const unannounced=new GameMemory('a');
    unannounced.observe(view);unannounced.onMessages([notice({spectator:true})],view);
    unannounced.observe(after,[{version:2,events:[battle('indonesia')]}]);
    unannounced.onMessages([notice({id:2})],after);
    expect(unannounced.summary(after)).toContain('no advance passage notice received');
    const expired=new GameMemory('a');expired.onMessages([notice()],board(7));
    expired.observe(after,[{version:2,events:[battle('indonesia')]}]);
    expect(expired.summary(after)).toContain('no advance passage notice received');
  });
  it('distinguishes an accepted alliance from aggression, keeps actual event rounds, and ignores unanswered offers',()=>{
    const view=board();
    const deal:Deal={id:'S1',kind:'truce',parties:['Shen','Ahri'],proposedBy:'Shen',proposedRound:5,untilRound:12,status:'active',accepted:true,text:'truce'};
    const memory=new GameMemory('a',()=>[deal]);
    const started:GameEvent={type:'turn_started',player:'b',turnNumber:27,round:9,reinforcements:{total:3,territories:3,continents:[],capitals:0}};
    const breaches=memory.observe(taken(view,'indonesia'),[{version:2,events:[started,battle('indonesia')]}]);
    expect(breaches).toEqual([{player:'b',agreementId:'S1'}]);
    expect(memory.observe(taken(view,'indonesia'),[{version:2,events:[started,battle('indonesia')]}])).toEqual([]);
    expect(memory.summary(view)).toContain('Round 9: Ahri attacked');
    expect(memory.summary(view)).toContain('accepted truce S1 was in effect');
    const pending=new GameMemory('a',()=>[{...deal,status:'proposed',accepted:false}]);
    pending.observe(view,[{version:2,events:[battle('indonesia')]}]);
    expect(pending.summary(view)).toContain('no accepted alliance recorded');
  });
  it('suggests coalition partners against a dominant rival using visible counts, with explicit fog uncertainty',()=>{
    const view=board();
    view.players=view.players.map(p=>({...p,territoryCount:p.id==='b'?25:5,armyCount:p.id==='b'?80:10}));
    const leader=assessLeader(view,'a');
    expect(leader.threat?.name).toBe('Ahri');expect(leader.needsCoalition).toBe(true);
    expect(leader.partners.map(p=>p.name)).toEqual(['Lux']);
    expect(assessLeader(view,'b').needsCoalition).toBe(false);
    view.players=view.players.map(p=>p.id==='c'?{...p,territoryCount:null,armyCount:null}:p);
    const summary=new GameMemory('a').summary(view);
    expect(summary).toContain('global leader uncertain under fog');
    expect(summary).toContain('not proof of global dominance');
    expect(summary).toContain('current round 10');

    // Under full fog of war where all rivals have hidden territory/army counts, public reinforcement income identifies who is ahead.
    const fogged: GameView = {
      ...view,
      players: view.players.map((p) =>
        p.id === 'a'
          ? { ...p, territoryCount: 6, armyCount: 14, income: { territories: 6, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0, total: 3 } }
          : p.id === 'b'
            ? { ...p, territoryCount: null, armyCount: null, income: { territories: 0, fromTerritories: 0, continents: [], capitals: 0, fromCapitals: 0, total: 10, hidden: true } }
            : { ...p, territoryCount: null, armyCount: null, income: { territories: 0, fromTerritories: 0, continents: [], capitals: 0, fromCapitals: 0, total: 3, hidden: true } },
      ),
    };
    const fogLeader = assessLeader(fogged, 'a');
    expect(fogLeader.incomeLeader?.name).toBe('Ahri');
    expect(fogLeader.threat?.name).toBe('Ahri');
    expect(fogLeader.needsCoalition).toBe(true);
    expect(new GameMemory('a').summary(fogged)).toContain('Highest reinforcement income (public under fog; primary way to gauge who is ahead alongside visible border stacks): Ahri, +10/turn');
  });
});
