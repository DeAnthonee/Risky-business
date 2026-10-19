import { getMap, nextTradeValue, exponentialTradeBonus, type GameEvent, type GameView } from '@risk/engine';
import type { ChatResult } from '@risk/mcp';
import type { Deal } from './deals.js';

export interface ObservedBatch { version: number; events: GameEvent[]; playerId?: string | null }
interface AttackRecord { attacks: number; armiesLost: number; lostTerritories: number; brokenBonuses: number }
interface Notice { player: string; round: number; receivedVersion: number; text: string }
export interface PlayerActivityRecord {
  startingArmies: number;
  cumulativeIncome: number;
  totalAttacks: number;
  totalConquests: number;
  lastTurnAttacks: number;
  lastTurnConquests: number;
  currentTurnAttacks: number;
  currentTurnConquests: number;
  cardTrades: number;
  cardsDrawn: number;
}

/** Estimates use only this seat's visible counts and public reinforcement income, never a spectator view. */
export function assessLeader(view: GameView, me: string) {
  const living = view.players.filter(p => p.alive && !p.isNeutral);
  const known = living.filter(p => p.territoryCount !== null);
  const armyKnown = living.filter(p => p.armyCount !== null);
  const incomeKnown = living.filter(p => p.income?.total !== undefined && p.income?.total !== null);
  const leader = [...known].sort((a,b) => b.territoryCount! - a.territoryCount! || (b.armyCount ?? 0) - (a.armyCount ?? 0) || (b.income?.total ?? 0) - (a.income?.total ?? 0))[0];
  const armyLeader = [...armyKnown].sort((a,b)=>(b.armyCount??0)-(a.armyCount??0) || (b.income?.total??0)-(a.income?.total??0))[0];
  const byIncome = [...incomeKnown].sort((a,b)=>(b.income?.total??0)-(a.income?.total??0) || (b.armyCount??0)-(a.armyCount??0) || (b.territoryCount??0)-(a.territoryCount??0));
  const incomeLeader = byIncome[0];
  const secondIncome = byIncome[1]?.income?.total ?? 0;
  const totalLand = known.reduce((n,p)=>n+(p.territoryCount??0),0);
  const totalArmy = armyKnown.reduce((n,p)=>n+(p.armyCount??0),0);
  const totalIncome = incomeKnown.reduce((n,p)=>n+(p.income?.total??0),0);
  const partial = known.length !== living.length || living.some(p=>p.armyCount===null);
  const armyDom = armyKnown.length >= 2 && !!armyLeader && (armyLeader.armyCount??0) / Math.max(1,totalArmy) >= 0.45;
  const landDom = known.length >= 2 && !!leader && (leader.territoryCount??0) / Math.max(1,totalLand) >= 0.4;
  const incomeDom = incomeKnown.length >= 2 && !!incomeLeader && (incomeLeader.income?.total??0) >= 5 &&
    ((incomeLeader.income?.total??0) / Math.max(1,totalIncome) >= 0.38 || (incomeLeader.income?.total??0) >= secondIncome + 3);
  const threat = armyDom ? armyLeader : landDom ? leader : incomeDom ? incomeLeader : known.length >= 2 ? leader : (incomeLeader ?? leader);
  const needsCoalition = !!threat && threat.id !== me && living.length >= 3 && (landDom || armyDom || incomeDom);
  return { leader, armyLeader, incomeLeader, threat, partial, needsCoalition, partners: living.filter(p=>p.id!==me && p.id!==threat?.id) };
}

/** One character's memory of one game. Private plans and other seats' hidden observations never enter it. */
export class GameMemory {
  private gameId: string | null = null;
  private seen = new Set<number>();
  private chatIds = new Set<number>();
  private attacks = new Map<string, AttackRecord>();
  private incidents: string[] = [];
  private notices: Notice[] = [];
  private playerStats = new Map<string, PlayerActivityRecord>();
  private currentTurnPlayer: string | null = null;
  constructor(
    private me: string,
    private deals: () => Deal[] = () => [],
    private onCommitment?: (attackerId: string, defenderId: string, armies: number) => void,
  ) {}

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

  getStats(pid: string, view?: GameView): PlayerActivityRecord {
    let s = this.playerStats.get(pid);
    if (!s) {
      const map = view ? getMap(view.options.map) : null;
      const count = view ? view.players.filter((p) => !p.isNeutral).length : 6;
      const starting = map ? map.startingArmies(count) : 20;
      s = {
        startingArmies: starting,
        cumulativeIncome: 0,
        totalAttacks: 0,
        totalConquests: 0,
        lastTurnAttacks: 0,
        lastTurnConquests: 0,
        currentTurnAttacks: 0,
        currentTurnConquests: 0,
        cardTrades: 0,
        cardsDrawn: 0,
      };
      this.playerStats.set(pid, s);
    }
    return s;
  }

  getUpcomingTradeValue(pid: string, view: GameView): number {
    const stats = this.getStats(pid, view);
    const mode = view.options.cardValues ?? 'progressive';
    return nextTradeValue(mode, view.tradeCount, stats.cardTrades);
  }

  getEffectivePower(pid: string, view: GameView): { estimatedArmies: number; upcomingTrade: number; effectivePower: number } {
    const p = view.players.find((x) => x.id === pid);
    const est = this.getEstimatedArmies(pid, view);
    if (!p) return { estimatedArmies: est, upcomingTrade: 0, effectivePower: est };
    const upcomingTrade = this.getUpcomingTradeValue(pid, view);
    // 5 cards = 100% forced trade; 4 cards = ~85% probability; 3 cards = ~40% probability
    const prob = p.cardCount >= 5 ? 1.0 : p.cardCount === 4 ? 0.85 : p.cardCount === 3 ? 0.40 : 0.0;
    const effectivePower = Math.round(est + prob * upcomingTrade);
    return { estimatedArmies: est, upcomingTrade, effectivePower };
  }

  getEstimatedArmies(pid: string, view: GameView): number {
    const p = view.players.find((x) => x.id === pid);
    if (!p) return 0;
    if (p.armyCount !== null && p.armyCount !== undefined) return p.armyCount;
    const stats = this.getStats(pid, view);
    const visibleArmies = Object.values(view.territories).filter((t) => !t.hidden && t.owner === pid).reduce((s, t) => s + t.armies, 0);
    let tradeArmies = 0;
    if (view.options.cardValues === 'exponential') {
      for (let i = 0; i < stats.cardTrades; i++) tradeArmies += exponentialTradeBonus(i);
    } else if (view.options.cardValues === 'fixed') {
      tradeArmies = stats.cardTrades * 7;
    } else {
      tradeArmies = stats.cardTrades * (view.tradeCount * 2 + 4);
    }
    const attackCost = Math.round(stats.totalAttacks * 1.2 + stats.totalConquests * 1.0);
    const rawEst = stats.startingArmies + stats.cumulativeIncome + tradeArmies - attackCost;
    return Math.max(visibleArmies, Math.max(3, rawEst));
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
    const pendingOccupy = new Map<string, string>();
    for (const batch of ordered) {
      this.seen.add(batch.version);
      const battleOrders=new Set<string>();
      for (const event of batch.events) {
        if (event.type==='turn_started') {
          round=event.round;
          if (this.currentTurnPlayer && this.currentTurnPlayer !== event.player) {
            const prev = this.getStats(this.currentTurnPlayer, view);
            prev.lastTurnAttacks = prev.currentTurnAttacks;
            prev.lastTurnConquests = prev.currentTurnConquests;
            prev.currentTurnAttacks = 0;
            prev.currentTurnConquests = 0;
          }
          this.currentTurnPlayer = event.player;
          const curr = this.getStats(event.player, view);
          curr.cumulativeIncome += event.reinforcements.total;
        }
        const active = this.currentTurnPlayer;
        if (active) {
          const act = this.getStats(active, view);
          if (event.type === 'battle' || (event.type === 'fogged' && event.kind === 'battle')) {
            act.currentTurnAttacks++;
            act.totalAttacks++;
          } else if (event.type === 'conquered' || (event.type === 'fogged' && event.kind === 'conquered')) {
            act.currentTurnConquests++;
            act.totalConquests++;
          } else if (event.type === 'traded' || (event.type === 'fogged' && event.kind === 'traded')) {
            act.cardTrades++;
          } else if (event.type === 'card_drawn') {
            act.cardsDrawn++;
          }
        }
        if (event.type === 'turn_ended' && this.currentTurnPlayer === event.player) {
          const act = this.getStats(event.player, view);
          act.lastTurnAttacks = act.currentTurnAttacks;
          act.lastTurnConquests = act.currentTurnConquests;
          act.currentTurnAttacks = 0;
          act.currentTurnConquests = 0;
        }
        const observed=round ?? view.round;
        const when=round===undefined ? `Observed by round ${observed}` : `Round ${observed}`;
        if (event.type==='battle') {
          this.onCommitment?.(event.attacker, event.defender, event.attackerLosses + event.defenderLosses);
        }
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
          pendingOccupy.set(`${event.player}:${event.from}:${event.to}`, event.previousOwner);
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
        if (event.type==='moved') {
          const prevOwner = pendingOccupy.get(`${event.player}:${event.from}:${event.to}`);
          if (prevOwner) {
            pendingOccupy.delete(`${event.player}:${event.from}:${event.to}`);
            this.onCommitment?.(event.player, prevOwner, event.armies);
          }
        }
      }
    }
    this.incidents=this.incidents.slice(-200);
    return breaches;
  }

  summary(view: GameView): string {
    const name=(id:string)=>view.players.find(p=>p.id===id)?.name ?? id;
    const who=(p:{id:string;name:string})=>`${p.name}${p.id===this.me ? ' (you)' : ''}`;
    const living=view.players.filter(p=>p.alive && !p.isNeutral);
    const assessment=assessLeader(view,this.me);
    const lines=[`THIS GAME ONLY — current round ${view.round}, individual turn ${view.turnNumber}.`];
    if (assessment.leader) lines.push(`${assessment.partial ? 'Largest observable territory holder (global leader uncertain under fog)' : 'Largest territory holder'}: ${who(assessment.leader)}, ${assessment.leader.territoryCount} territories${assessment.leader.income ? `, +${assessment.leader.income.total}/turn` : ''}.`);
    if (assessment.armyLeader) lines.push(`Largest observable army: ${who(assessment.armyLeader)}, ${assessment.armyLeader.armyCount} armies.`);
    if (assessment.incomeLeader) lines.push(`Highest reinforcement income${assessment.partial ? ' (public under fog; primary way to gauge who is ahead alongside visible border stacks)' : ''}: ${who(assessment.incomeLeader)}, +${assessment.incomeLeader.income?.total ?? 0}/turn (${living.map(p=>`${who(p)} +${p.income?.total ?? 0}`).join(', ')}).`);
    const cardHolders = living.filter(p => p.id !== this.me && p.cardCount >= 3).sort((a, b) => b.cardCount - a.cardCount);
    if (cardHolders.length) {
      lines.push(`Card watch (card counts and trade values are public even under fog): ${cardHolders.map(p => {
        const nextVal = this.getUpcomingTradeValue(p.id, view);
        return `${p.name} holds ${p.cardCount} cards (${view.options.cardValues} next trade: +${nextVal} armies; ${p.cardCount >= 5 ? 'FORCED trade surge next turn!' : p.cardCount >= 4 ? 'imminent trade threat' : 'trade possible'})`;
      }).join('; ')}.`);
    }
    const fogRivals = living.filter((p) => p.id !== this.me);
    if (fogRivals.length > 0) {
      lines.push('Opponent activity & estimated strength (tracked through starting troops, income, and attacks/conquests made even behind fog):');
      for (const r of fogRivals) {
        const stats = this.getStats(r.id, view);
        const { estimatedArmies: est, upcomingTrade, effectivePower } = this.getEffectivePower(r.id, view);
        const visTerrs = Object.values(view.territories).filter((t) => !t.hidden && t.owner === r.id).length;
        const visArmies = Object.values(view.territories).filter((t) => !t.hidden && t.owner === r.id).reduce((s, t) => s + t.armies, 0);
        const lastActivity = stats.lastTurnAttacks > 0
          ? `${stats.lastTurnAttacks} attacks (${stats.lastTurnConquests} conquests) last turn`
          : '0 attacks last turn (turtling/holding)';
        const tradeAlert = r.cardCount >= 4
          ? ` | SURGE THREAT: +${upcomingTrade} armies trade -> Effective Power: ~${effectivePower}`
          : r.cardCount === 3
            ? ` | Card trade possible (+${upcomingTrade} armies)`
            : '';
        lines.push(`- ${r.name}: ${stats.totalAttacks} total attacks (${stats.totalConquests} conquests) | ${lastActivity} | Est. standing armies: ~${est} (+${r.income?.total ?? 3}/turn, ${r.cardCount} cards)${tradeAlert} | Visible holdings: ${visTerrs} terrs (${visArmies} armies).`);
      }
    }
    if (assessment.needsCoalition) lines.push(`Coalition assessment: ${assessment.threat!.name} holds at least 40% of observable land, 45% of observable armies, or a dominant reinforcement income (+${assessment.threat!.income?.total ?? '?'}/turn). Consider a time-limited coalition or concrete troop-commitment joint_attack deal against them with ${assessment.partners.map(p=>p.name).join(', ') || 'available opponents'}. ${assessment.partial ? 'This is a visible-threat estimate, not proof of global dominance. ' : ''}Check borders, willingness and existing agreements; do not automatically ally or betray.`);
    else lines.push('Coalition assessment: no clear dominant rival at these thresholds. Reassess each turn; do not manufacture a coalition.');
    lines.push('Attacks against me this game (attempts include failed attacks; totals persist even if land is retaken):');
    for (const [id,s] of this.attacks) lines.push(`${name(id)}: ${s.attacks} observed attack orders, ${s.armiesLost} defending armies lost, ${s.lostTerritories} territories taken, ${s.brokenBonuses} bonuses broken.`);
    if (!this.attacks.size) lines.push('No attacks against me observed yet.');
    lines.push('Recent observed incidents:',...this.incidents.slice(-16));
    lines.push('Passing-through notices are claims, not consent. No notice received does not prove none was sent. An attack without an accepted alliance is aggression, not an alliance betrayal. Use only observed facts; unknown events remain unknown.');
    return lines.join('\n');
  }
}
