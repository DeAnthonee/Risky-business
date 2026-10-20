import { commitForOdds, exponentialTradeBonus, getMap, nextTradeValue, type GameView, type PlayerId, type TerritoryId } from '@risk/engine';
import { planConquest, type Campaign, type CampaignOptions } from './campaigns.js';

export interface KillOptions extends CampaignOptions { targetOnly?: PlayerId | null }
export interface KillPlan extends Campaign { target: PlayerId; score: number }

interface AttackStep {
  from: TerritoryId;
  to: TerritoryId;
  cost: number;
}

/**
 * Calculates the effective value of a card in the current game context.
 * Progressive and Exponential modes share identical scaling EV logic in the mid-to-late game:
 * both escalate dramatically with game progression (scaling sets of 30-200+ armies),
 * making eliminations the decisive endgame mechanic in both modes.
 */
export function effectiveCardValue(view: GameView, me: PlayerId): number {
  const mode = view.options.cardValues;
  if (mode === 'fixed') return 3; // Fixed 4-10 armies per trade (~3.3 per card)
  const mine = view.players.find((p) => p.id === me);
  if (mode === 'progressive') {
    return Math.max(12, nextTradeValue('progressive', view.tradeCount, 0)) / 3;
  }
  // Exponential mode: personal sequence scaling.
  // In late-game exponential, set value reflects both personal trade progression and table round.
  const personalTrades = mine?.tradesMade ?? 0;
  const maxTableTrades = Math.max(...view.players.map((p) => p.tradesMade ?? 0), Math.floor(view.round / 3), personalTrades);
  const projectedTradeBonus = Math.max(
    exponentialTradeBonus(personalTrades),
    exponentialTradeBonus(Math.min(personalTrades + 1, 24)),
    exponentialTradeBonus(Math.min(maxTableTrades, 24)),
    12 + view.round * 2.5
  );
  return Math.max(12, projectedTradeBonus) / 3;
}

/**
 * Advanced multi-hop mathematical kill pathfinder.
 * Finds the minimum-cost attack tree connecting owned territories to all victim territories,
 * including punching through 3rd-party buffer/transit territories when EV is high.
 */
function findMultiHopKill(view: GameView, me: PlayerId, victimId: PlayerId, options: KillOptions): KillPlan | null {
  if (options.avoid.has(victimId)) return null;
  const map = getMap(view.options.map);
  const victim = view.players.find((p) => p.id === victimId);
  const mine = view.players.find((p) => p.id === me);
  if (!victim || !victim.alive || victim.isNeutral) return null;

  const victimTerritories = map.territoryIds.filter((t) => !view.territories[t]?.hidden && view.territories[t]?.owner === victimId);
  if (victimTerritories.length === 0 || victimTerritories.length > 25) return null;

  // Verify all victim territories are visible (unless fog allows partial)
  if (victim.territoryCount !== undefined && victim.territoryCount !== victimTerritories.length) {
    // If victim has unrevealed territories in fog of war, we cannot guarantee elimination
    return null;
  }

  const own = (t: string) => view.territories[t]?.owner === me && !view.territories[t]?.hidden;
  const armies = (t: string) => view.territories[t]?.armies ?? 0;
  const caps = new Set(view.options.capitals ? Object.values(view.capitals ?? {}) : []);
  const blizzards = new Set(view.blizzards ?? []);

  // Quick total victim army check
  const totalVictimArmies = victimTerritories.reduce((sum, t) => sum + armies(t), 0);
  const myTotalMovableArmies = map.territoryIds
    .filter(own)
    .reduce((sum, t) => sum + Math.max(0, armies(t) - options.floor(t)), 0) + (options.reinforcements ?? 0);

  if (totalVictimArmies > myTotalMovableArmies * 0.95 && (options.reinforcements ?? 0) === 0) {
    return null;
  }

  // Calculate EV metrics shared across Progressive and Exponential
  const isScaling = view.options.cardValues === 'progressive' || view.options.cardValues === 'exponential';
  const cardVal = effectiveCardValue(view, me);
  const myCards = mine?.cardCount ?? 0;
  const victimCards = victim.cardCount ?? 0;
  const setsMe = (myCards + victimCards) >= 5;
  const isHighEV = setsMe || (isScaling && (victimCards >= 3 || (victimCards >= 2 && cardVal >= 8))) || (victimCards * cardVal >= 25);

  const expectedLoss = (t: string): number => {
    const d = armies(t);
    const isCap = caps.has(t);
    return Math.ceil(d * (isCap ? 2 : 1.25)) + 2;
  };

  const transitWeight = (to: string): number => {
    if (own(to)) return 0;
    if (blizzards.has(to) || options.noAttack.has(to)) return Infinity;
    const toOwner = view.territories[to]?.owner;

    // Avoidance check on 3rd parties:
    // If EV is very high (setsMe, victim holds 3+ cards, or scaling bounty), do NOT be afraid to punch through!
    if (toOwner && options.avoid.has(toOwner)) {
      if (!isHighEV) return Infinity;
    }

    const d = armies(to);
    const base = expectedLoss(to);

    // Punching through 3rd-party buffer territories:
    // Realistic casualty cost with gentle preference for thinner garrisons (d * 0.25).
    // Never impose artificial prohibitive penalties that scare the bot away from taking the path.
    if (toOwner !== victimId) {
      const avoidPenalty = toOwner && options.avoid.has(toOwner) ? 4 : 0;
      return base + 1 + d * 0.25 + avoidPenalty;
    }
    return base;
  };

  // Find directed attack paths from our owned territories that cover all victimTerritories
  const activeOwned = new Set(map.territoryIds.filter(own));
  const activeNodes = new Set<string>(activeOwned);
  const uncovered = new Set<string>(victimTerritories);
  const attacks: AttackStep[] = [];

  // Repeatedly find the cheapest path from any node in activeNodes to an uncovered victim territory
  while (uncovered.size > 0) {
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const queue: string[] = [];

    for (const node of activeNodes) {
      dist.set(node, 0);
      queue.push(node);
    }

    // Dijkstra from activeNodes
    const visited = new Set<string>();
    while (queue.length > 0) {
      queue.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);

      const dCurr = dist.get(curr) ?? Infinity;
      if (!Number.isFinite(dCurr)) break;

      const neighbours = map.adjacency[curr] ?? [];
      for (const next of neighbours) {
        if (blizzards.has(next) || options.noAttack.has(next)) continue;
        const w = transitWeight(next);
        if (!Number.isFinite(w)) continue;
        const newDist = dCurr + w;
        if (newDist < (dist.get(next) ?? Infinity)) {
          dist.set(next, newDist);
          prev.set(next, curr);
          queue.push(next);
        }
      }
    }

    // Find the closest uncovered target
    let bestTarget: string | null = null;
    let bestDist = Infinity;
    for (const target of uncovered) {
      const d = dist.get(target) ?? Infinity;
      if (d < bestDist) {
        bestDist = d;
        bestTarget = target;
      }
    }

    if (!bestTarget || !Number.isFinite(bestDist)) {
      // Cannot reach all victim territories
      return null;
    }

    // Reconstruct the path backwards from bestTarget to activeNodes
    const path: string[] = [];
    let curr: string | undefined = bestTarget;
    while (curr && !activeNodes.has(curr)) {
      path.unshift(curr);
      curr = prev.get(curr);
    }
    if (!curr) return null; // Broken path
    path.unshift(curr);

    // Add path segments to attacks and activeNodes
    for (let i = 0; i < path.length - 1; i++) {
      const u = path[i];
      const v = path[i + 1];
      attacks.push({ from: u, to: v, cost: expectedLoss(v) + 1 });
      activeNodes.add(v);
      uncovered.delete(v);
    }
  }

  // Roots of the attack tree in our territory
  const roots = [...new Set(attacks.map((a) => a.from).filter(own))];
  if (roots.length === 0) return null;

  // Build tree hierarchy for subtree cost calculation and stack siphoning
  const childrenOf = new Map<string, string[]>();
  for (const a of attacks) {
    const list = childrenOf.get(a.from) ?? [];
    if (!list.includes(a.to)) list.push(a.to);
    childrenOf.set(a.from, list);
  }

  const subtreeCostCache = new Map<string, number>();
  const computeSubtreeCost = (node: string): number => {
    if (subtreeCostCache.has(node)) return subtreeCostCache.get(node)!;
    const directLoss = own(node) ? 0 : expectedLoss(node) + 1;
    const children = childrenOf.get(node) ?? [];
    const childrenCost = children.reduce((sum, c) => sum + computeSubtreeCost(c), 0);
    const total = directLoss + childrenCost;
    subtreeCostCache.set(node, total);
    return total;
  };

  const requirements: Record<TerritoryId, number> = {};
  const placements: Record<TerritoryId, number> = {};
  let totalDeficit = 0;

  for (const r of roots) {
    const neededFromRoot = (childrenOf.get(r) ?? []).reduce((sum, c) => sum + computeSubtreeCost(c), 0);
    const req = options.floor(r) + neededFromRoot + 1;
    requirements[r] = req;
    const def = Math.max(0, req - armies(r));
    if (def > 0) placements[r] = def;
    totalDeficit += def;
  }

  if (totalDeficit > (options.reinforcements ?? 0)) {
    return null;
  }

  // Handle in-attack transfer / stack siphoning at junctions
  let occupy: number | undefined;
  const tr = options.transfer;
  if (tr) {
    const step = attacks.find((a) => a.from === tr.from && a.to === tr.to);
    if (step) {
      const toNeed = computeSubtreeCost(tr.to);
      const otherChildren = (childrenOf.get(tr.from) ?? []).filter((c) => c !== tr.to);
      const fromNeed = otherChildren.reduce((sum, c) => sum + computeSubtreeCost(c), 0);
      const cap = options.floor(tr.from);
      const available = Math.max(0, armies(tr.from) - cap);

      if (fromNeed === 0) {
        // `from` has finished all its planned attacks; whole stack carries forward
        occupy = Math.min(tr.max, Math.max(tr.min, available));
      } else {
        // Multi-branch junction! Siphon what `to` needs + share of surplus, leaving enough on `from`
        const surplus = Math.max(0, available - toNeed - fromNeed);
        const branchOccupy = Math.round(toNeed + surplus * 0.5);
        occupy = Math.min(tr.max, Math.max(tr.min, branchOccupy));
      }
    }
  }

  const totalCost = attacks.reduce((sum, a) => sum + a.cost, 0);

  let score = 40 + victimCards * cardVal;
  if (setsMe) score += 350; // Guaranteed mid-turn trade in Progressive or Exponential is game-winning!
  if (victimCards >= 3) score += isScaling ? 80 : 40;
  if (victimTerritories.length <= 3) score += 40;
  score -= totalCost * 0.35 + totalDeficit * 0.2;

  return {
    target: victimId,
    score,
    cost: totalCost,
    deficit: totalDeficit,
    requirements,
    placements,
    attacks: attacks.map((a) => ({ from: a.from, to: a.to, keep: 1 })),
    occupy,
  };
}

/**
 * Fully visible weak victims and high-EV scaling bounty targets.
 * Evaluates both direct conquest campaigns and multi-hop transit paths.
 */
export function planElimination(view: GameView, me: PlayerId, options: KillOptions): KillPlan | null {
  const map = getMap(view.options.map);
  const mine = view.players.find((p) => p.id === me);
  const cardVal = effectiveCardValue(view, me);
  const isScaling = view.options.cardValues === 'progressive' || view.options.cardValues === 'exponential';

  let best: KillPlan | null = null;

  for (const victim of view.players) {
    if (!victim.alive || victim.isNeutral || victim.id === me || (options.targetOnly && victim.id !== options.targetOnly)) continue;

    if (options.avoid.has(victim.id)) continue;

    const setsMe = ((mine?.cardCount ?? 0) + victim.cardCount) >= 5;
    const ts = map.territoryIds.filter((t) => !view.territories[t]?.hidden && view.territories[t]?.owner === victim.id);
    if (!ts.length) continue;

    // Try multi-hop mathematical kill pathfinder first
    const multiHop = findMultiHopKill(view, me, victim.id, options);
    if (multiHop && multiHop.score > 0) {
      if (!best || multiHop.score > best.score) {
        best = multiHop;
      }
      continue;
    }

    // Fall back to classic planConquest for small direct enclaves (<= 5 territories)
    if (ts.length <= 5 && victim.territoryCount === ts.length) {
      const campaign = planConquest(view, me, ts, options);
      if (campaign) {
        const score = 35 + victim.cardCount * cardVal + (victim.cardCount >= 3 ? (isScaling ? 20 : 8) : 0) +
          (setsMe ? cardVal * 2.5 : 0) - campaign.cost - campaign.deficit * 0.25;
        if (score > 0 && (!best || score > best.score)) {
          best = { ...campaign, target: victim.id, score };
        }
      }
    }
  }

  return best;
}
