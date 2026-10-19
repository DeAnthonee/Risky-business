import { getMap, nextTradeValue, type GameView, type PlayerId } from '@risk/engine';
import { planConquest, type Campaign, type CampaignOptions } from './campaigns.js';

export interface KillOptions extends CampaignOptions { targetOnly?: PlayerId | null }
export interface KillPlan extends Campaign { target: PlayerId; score: number }

/** Fully visible weak victims only; the shared campaign planner budgets every route before attacking. */
export function planElimination(view: GameView, me: PlayerId, options: KillOptions): KillPlan | null {
  const map = getMap(view.options.map);
  const mine = view.players.find(p => p.id === me);
  const cardValue = view.options.cardValues === 'fixed' ? 3 : nextTradeValue(view.options.cardValues, view.tradeCount, mine?.tradesMade ?? 0) / 3;
  let best: KillPlan | null = null;
  for (const victim of view.players) {
    if (!victim.alive || victim.isNeutral || victim.id === me || options.avoid.has(victim.id) ||
        (options.targetOnly && victim.id !== options.targetOnly)) continue;
    const ts = map.territoryIds.filter(t => !view.territories[t]?.hidden && view.territories[t]?.owner === victim.id);
    if (!ts.length || ts.length > 4 || victim.territoryCount !== ts.length) continue;
    const campaign = planConquest(view, me, ts, options);
    if (!campaign) continue;
    const score = 35 + victim.cardCount * cardValue + (victim.cardCount >= 3 ? 8 : 0) +
      ((mine?.cardCount ?? 0) + victim.cardCount >= 5 ? cardValue * 1.5 : 0) - campaign.cost - campaign.deficit * 0.25;
    if (score > 0 && (!best || score > best.score)) best = { ...campaign, target: victim.id, score };
  }
  return best;
}
