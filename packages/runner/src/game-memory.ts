import { getMap, type GameEvent, type GameView } from '@risk/engine';
import type { ChatResult } from '@risk/mcp';
import type { Deal } from './deals.js';

export interface ObservedBatch { version: number; events: GameEvent[]; playerId?: string | null }
interface AttackRecord { attacks: number; armiesLost: number; lostTerritories: number; brokenBonuses: number }
interface Notice { player: string; round: number; receivedVersion: number; text: string }

/** Estimates use only this seat's visible counts, never a spectator view. */
export function assessLeader(view: GameView, me: string) {
  const living = view.players.filter(p => p.alive && !p.isNeutral);
  const known = living.filter(p => p.territoryCount !== null);
  const leader = [...known].sort((a,b) => b.territoryCount! - a.territoryCount! || (b.armyCount ?? 0) - (a.armyCount ?? 0))[0];
  const armyLeader = [...living.filter(p=>p.armyCount!==null)].sort((a,b)=>(b.armyCount??0)-(a.armyCount??0))[0];
  const totalLand = known.reduce((n,p)=>n+(p.territoryCount??0),0);
  const totalArmy = living.reduce((n,p)=>n+(p.armyCount??0),0);
  const partial = known.length !== living.length || living.some(p=>p.armyCount===null);
  const threat = armyLeader && (armyLeader.armyCount??0) / Math.max(1,totalArmy) >= 0.45 ? armyLeader : leader;
  const needsCoalition = !!threat && threat.id !== me && living.length >= 3 &&
    ((threat.territoryCount??0) / Math.max(1,totalLand) >= 0.4 || (threat.armyCount??0) / Math.max(1,totalArmy) >= 0.45);
  return { leader, armyLeader, threat, partial, needsCoalition, partners: living.filter(p=>p.id!==me && p.id!==threat?.id) };
}

/** One character's memory of one game. Private plans and other seats' hidden observations never enter it. */
export class GameMemory {
  private gameId: string | null = null;
  private seen = new Set<number>();
  private chatIds = new Set<number>();
  private attacks = new Map<string, AttackRecord>();
  private incidents: string[] = [];
  private notices: Notice[] = [];
  constructor(private me: string, private deals: () => Deal[] = () => []) {}

  onMessages(messages: ChatResult['messages'], view: GameView) {
    for (const message of messages) {
      if (this.chatIds.has(message.id)) continue;
      this.chatIds.add(message.id);
      if (message.spectator || (message.to !== undefined && message.to !== this.me)) continue;
      const sender = view.players.find(p=>p.id!==this.me && p.name.toLowerCase()===message.name.toLowerCase());
      if (!sender || !/\b(?:passing through|pass through|crossing your|cross your|moving through your)\b/i.test(message.message)) continue;
      this.notices.push({player:sender.id,round:view.round,receivedVersion:view.version,text:message.message.slice(0,220)});
    }
    this.notices=this.notices.filter(n=>view.round-n.round<=1).slice(-30);
  }

  observe(view: GameView, batches: ObservedBatch[] = []) {
    if (this.gameId && this.gameId !== view.id) throw new Error('Game memory cannot cross game boundaries');
    this.gameId=view.id;
    const breaches: { player: string; agreementId: string }[] = [];
    const map=getMap(view.options.map);
    const name=(id:string)=>view.players.find(p=>p.id===id)?.name ?? id;
    const mine=name(this.me).toLowerCase();
    const ordered=[...batches].sort((a,b)=>a.version-b.version).filter(b=>!this.seen.has(b.version));
    // Reconstruct ownership before this event window so the first conquest breaking a held bonus is attributed correctly.
    const owners=new Map(Object.entries(view.territories).filter(([,s])=>!s.hidden).map(([id,s])=>[id,s.owner]));
    for (const batch of [...ordered].reverse()) for (const event of [...batch.events].reverse()) {
      if (event.type==='conquered') owners.set(event.to,event.previousOwner);
    }
    let round:number|undefined;
    for (const batch of ordered) {
      this.seen.add(batch.version);
      const battleOrders=new Set<string>();
      for (const event of batch.events) {
        if (event.type==='turn_started') round=event.round;
        const observed=round ?? view.round;
        const when=round===undefined ? `Observed by round ${observed}` : `Round ${observed}`;
        if (event.type==='battle' && event.defender===this.me) {
          const stats=this.attacks.get(event.attacker) ?? {attacks:0,armiesLost:0,lostTerritories:0,brokenBonuses:0};
          const key=`${event.attacker}:${event.from}:${event.to}`;
          if (!battleOrders.has(key)) {
            battleOrders.add(key);stats.attacks++;
            const partner=name(event.attacker).toLowerCase();
            const agreement=this.deals().find(d=>d.accepted && d.parties.some(p=>p.toLowerCase()===mine) && d.parties.some(p=>p.toLowerCase()===partner) && (d.acceptedRound ?? d.proposedRound)<=observed && (d.acceptedVersion===undefined || d.acceptedVersion<batch.version) && !(d.status==='broken' && d.brokenBy?.toLowerCase()===mine) && (d.untilRound===undefined || d.untilRound>=observed) && ['active','broken','expired'].includes(d.status));
            if (agreement && ['truce','border'].includes(agreement.kind)) breaches.push({player:event.attacker,agreementId:agreement.id});
            const notice=this.notices.find(n=>n.player===event.attacker && n.receivedVersion<batch.version && observed-n.round>=0 && observed-n.round<=1);
            const context=agreement ? `accepted ${agreement.kind} ${agreement.id} was in effect; check breach` : 'no accepted alliance recorded';
            this.incidents.push(`${when}: ${name(event.attacker)} attacked ${map.territoryById[event.to]?.name ?? event.to}; ${context}; ${notice ? 'advance passage notice received (not permission or immunity)' : 'no advance passage notice received'}.`);
          }
          stats.armiesLost+=event.defenderLosses;
          this.attacks.set(event.attacker,stats);
        }
        if (event.type==='conquered') {
          const region=map.continentById[map.territoryById[event.to]?.continent];
          const brokeBonus=event.previousOwner===this.me && region && region.territories.filter(t=>!view.blizzards?.includes(t)).every(t=>owners.get(t)===this.me);
          owners.set(event.to,event.player);
          if (event.previousOwner===this.me) {
            const stats=this.attacks.get(event.player) ?? {attacks:0,armiesLost:0,lostTerritories:0,brokenBonuses:0};
            stats.lostTerritories++;
            if (brokeBonus) stats.brokenBonuses++;
            this.attacks.set(event.player,stats);
            this.incidents.push(`${when}: ${name(event.player)} took ${map.territoryById[event.to]?.name ?? event.to}${brokeBonus ? ` and broke my ${region.name} bonus (+${region.bonus}/turn)` : ''}.`);
          }
        }
      }
    }
    this.incidents=this.incidents.slice(-200);
    return breaches;
  }

  summary(view: GameView): string {
    const name=(id:string)=>view.players.find(p=>p.id===id)?.name ?? id;
    const assessment=assessLeader(view,this.me);
    const lines=[`THIS GAME ONLY — current round ${view.round}, individual turn ${view.turnNumber}.`];
    if (assessment.leader) lines.push(`${assessment.partial ? 'Largest observable territory holder (global leader uncertain under fog)' : 'Largest territory holder'}: ${assessment.leader.name}, ${assessment.leader.territoryCount} territories.`);
    if (assessment.armyLeader) lines.push(`Largest observable army: ${assessment.armyLeader.name}, ${assessment.armyLeader.armyCount} armies.`);
    if (assessment.needsCoalition) lines.push(`Coalition assessment: ${assessment.threat!.name} holds at least 40% of observable land or 45% of observable armies. Consider a time-limited coalition against them with ${assessment.partners.map(p=>p.name).join(', ') || 'available opponents'}. ${assessment.partial ? 'This is a visible-threat estimate, not proof of global dominance. ' : ''}Check borders, willingness and existing agreements; do not automatically ally or betray.`);
    else lines.push('Coalition assessment: no clear dominant rival at these thresholds. Reassess each turn; do not manufacture a coalition.');
    lines.push('Attacks against me this game (attempts include failed attacks; totals persist even if land is retaken):');
    for (const [id,s] of this.attacks) lines.push(`${name(id)}: ${s.attacks} observed attack orders, ${s.armiesLost} defending armies lost, ${s.lostTerritories} territories taken, ${s.brokenBonuses} bonuses broken.`);
    if (!this.attacks.size) lines.push('No attacks against me observed yet.');
    lines.push('Recent observed incidents:',...this.incidents.slice(-16));
    lines.push('Passing-through notices are claims, not consent. No notice received does not prove none was sent. An attack without an accepted alliance is aggression, not an alliance betrayal. Use only observed facts; unknown events remain unknown.');
    return lines.join('\n');
  }
}
