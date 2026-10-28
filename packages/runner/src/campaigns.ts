import { commitForOdds, getMap, type GameView, type PlayerId, type TerritoryId } from '@risk/engine';

export interface CampaignOptions {
  avoid: ReadonlySet<PlayerId>;
  noAttack: ReadonlySet<TerritoryId>;
  floor: (t: TerritoryId) => number;
  stationary?: ReadonlySet<TerritoryId>;
  reinforcements?: number;
  transfer?: { from: TerritoryId; to: TerritoryId; min: number; max: number };
}
export interface Campaign {
  cost: number;
  deficit: number;
  requirements: Record<TerritoryId, number>;
  attacks: { from: TerritoryId; to: TerritoryId; keep: number }[];
  placements: Record<TerritoryId, number>;
  occupy?: number;
}

/** Budget an entire visible objective, including branches and separate launch stacks. Bounded search;
 * conservative expected casualties and 90% odds for each battle, not a guarantee of campaign success.
 */
export function planConquest(view: GameView, me: PlayerId, targets: TerritoryId[], options: CampaignOptions): Campaign | null {
  const map = getMap(view.options.map);
  const own = (t: string) => view.territories[t]?.owner === me && !view.territories[t]?.hidden;
  const armies = (t: string) => view.territories[t]?.armies ?? 0;
  const ts = [...new Set(targets)];
  if (!ts.length || ts.length > 5 || ts.some(t => !view.territories[t] || view.territories[t].hidden || own(t) ||
      view.blizzards?.includes(t) || options.noAttack.has(t) || options.avoid.has(view.territories[t].owner!))) return null;
  if (ts.reduce((sum, t) => sum + armies(t), 0) > 80) return null;
  const set = new Set(ts);
  const choices = ts.map(t => map.adjacency[t].filter(n => set.has(n) || own(n))
    .sort((a, b) => Number(own(b)) - Number(own(a)) || armies(b) - armies(a)));
  if (choices.some(c => !c.length)) return null;
  const caps = new Set(view.options.capitals ? Object.values(view.capitals ?? {}) : []);
  const base = new Map(ts.map(t => [t, {
    losses: Math.ceil(armies(t) * (caps.has(t) ? 2 : 1.25)) + 2,
    minimum: commitForOdds(Math.max(24, armies(t) * 8 + 16), armies(t), caps.has(t) ? 3 : 2, 0.9, !!view.options.balancedBlitz) ?? Infinity,
  }]));
  const parents = new Map<string, string>();
  let best: Campaign | null = null;
  let attempts = 0;
  const evaluate = () => {
    const needed = new Map<string, number>();
    const visiting = new Set<string>();
    const branch = (t: string): number => {
      if (visiting.has(t)) return Infinity;
      if (needed.has(t)) return needed.get(t)!;
      visiting.add(t);
      const children = ts.filter(c => parents.get(c) === t);
      const n = Math.max(base.get(t)!.minimum, base.get(t)!.losses + 1 + children.reduce((s, c) => s + branch(c), 0));
      visiting.delete(t); needed.set(t, n); return n;
    };
    for (const t of ts) if (!Number.isFinite(branch(t))) return;
    if (ts.some(t => options.stationary?.has(parents.get(t)!) && ts.some(c => parents.get(c) === t))) return;
    const roots = [...new Set(ts.map(t => parents.get(t)!).filter(own))];
    if (!roots.length) return;
    const required = (r: string) => options.floor(r) + ts.filter(t => parents.get(t) === r).reduce((s, t) => s + needed.get(t)!, 0);
    const requirements = Object.fromEntries(roots.map(r => [r, required(r)]));
    const placements = Object.fromEntries(roots.map(r => [r, Math.max(0, required(r) - armies(r))]));
    let deficit = Object.values(placements).reduce((s, n) => s + n, 0);
    let occupy: number | undefined;
    const tr = options.transfer;
    if (tr) {
      const fromNeed = requirements[tr.from] ?? options.floor(tr.from);
      const toNeed = requirements[tr.to] ?? 1;
      const lower = Math.max(tr.min, toNeed);
      const upper = Math.min(tr.max, armies(tr.from) - fromNeed);
      if (lower > upper) return;
      occupy = requirements[tr.to] !== undefined || requirements[tr.from] === undefined ? upper : lower;
      deficit -= (placements[tr.from] ?? 0) + (placements[tr.to] ?? 0);
      delete placements[tr.from]; delete placements[tr.to];
    }
    if (deficit > (options.reinforcements ?? 0)) return;
    // Use existing troops efficiently; do not split just for appearances when one route is cheaper.
    if (best && (deficit > best.deficit || (deficit === best.deficit && roots.length >= Object.keys(best.requirements).length))) return;
    best = { cost: ts.reduce((s, t) => s + base.get(t)!.losses + 1, 0), deficit, requirements, placements, occupy,
      attacks: ts.filter(t => own(parents.get(t)!)).map(t => ({ from: parents.get(t)!, to: t, keep: required(parents.get(t)!) - needed.get(t)! })) };
  };
  const enumerate = (i: number) => {
    if (++attempts > 4096) return;
    if (i === ts.length) { evaluate(); return; }
    for (const p of choices[i]) { parents.set(ts[i], p); enumerate(i + 1); }
  };
  enumerate(0);
  return best;
}

/**
 * Multi-hop Capital Run Campaign:
 * Calculates a complete attack tree to capture all remaining unowned capitals in a single turn.
 * Uses multi-source Dijkstra from all owned launchpads across transit territories,
 * computes exact casualty requirements, tree branching and stack transfers.
 * Works even if the player currently holds 0 capitals!
 */
export function findCapRun(view: GameView, me: PlayerId, options: CampaignOptions): Campaign | null {
  if (!view.options.capitals) return null;
  const allCaps = Object.values(view.capitals ?? {});
  if (allCaps.length <= 1) return null;

  const unownedCapitals = allCaps.filter((t) => view.territories[t]?.owner !== me);
  if (unownedCapitals.length === 0) return null; // Already hold all capitals

  const map = getMap(view.options.map);
  const own = (t: string) => view.territories[t]?.owner === me && !view.territories[t]?.hidden;
  const armies = (t: string) => view.territories[t]?.armies ?? 0;
  const blizzards = new Set(view.blizzards ?? []);

  const initialNodes = map.territoryIds.filter((t) => own(t) && !blizzards.has(t));
  if (initialNodes.length === 0) return null;

  const activeNodes = new Set<string>(initialNodes);
  const uncovered = new Set<string>(unownedCapitals);
  const edgeList: { from: TerritoryId; to: TerritoryId }[] = [];

  // Expected losses are cheap and drive the path search; the safe stack (an odds table that can reach 250k cells for
  // big stacks) is needed only for the few territories on the chosen tree, so it is computed there, once each.
  const lossOf = (t: string) => Math.ceil(armies(t) * (allCaps.includes(t) ? 2.0 : 1.25)) + 2;
  const safeMemo = new Map<string, number>();
  const minSafeOf = (t: string) => {
    let n = safeMemo.get(t);
    if (n === undefined) {
      const arm = armies(t);
      n = commitForOdds(Math.max(24, arm * 8 + 16), arm, allCaps.includes(t) ? 3 : 2, 0.85, !!view.options.balancedBlitz) ?? (arm * 3 + 6);
      safeMemo.set(t, n);
    }
    return n;
  };

  // Repeatedly connect the closest uncovered capital to the growing active tree
  while (uncovered.size > 0) {
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const queue: string[] = [];

    for (const node of activeNodes) {
      dist.set(node, 0);
      queue.push(node);
    }

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
        if (view.territories[next]?.hidden) continue;

        const w = activeNodes.has(next) ? 0 : lossOf(next) + 1;
        const newDist = dCurr + w;
        if (newDist < (dist.get(next) ?? Infinity)) {
          dist.set(next, newDist);
          prev.set(next, curr);
          queue.push(next);
        }
      }
    }

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
      return null;
    }

    const path: string[] = [];
    let curr: string | undefined = bestTarget;
    while (curr && !activeNodes.has(curr)) {
      path.unshift(curr);
      curr = prev.get(curr);
    }
    if (!curr) return null;
    path.unshift(curr);

    for (let i = 0; i < path.length - 1; i++) {
      const u = path[i];
      const v = path[i + 1];
      edgeList.push({ from: u, to: v });
      activeNodes.add(v);
      uncovered.delete(v);
    }
  }

  const roots = [...new Set(edgeList.map((e) => e.from).filter(own))];
  if (roots.length === 0) return null;

  const childrenOf = new Map<string, string[]>();
  for (const { from, to } of edgeList) {
    const list = childrenOf.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    childrenOf.set(from, list);
  }

  const memo = new Map<string, number>();
  const computeNeeded = (node: string): number => {
    if (memo.has(node)) return memo.get(node)!;
    const children = childrenOf.get(node) ?? [];
    const childrenNeeded = children.reduce((sum, c) => sum + computeNeeded(c), 0);
    const needed = Math.max(minSafeOf(node), lossOf(node) + 1 + childrenNeeded);
    memo.set(node, needed);
    return needed;
  };

  const requirements: Record<TerritoryId, number> = {};
  const placements: Record<TerritoryId, number> = {};
  let totalDeficit = 0;

  for (const r of roots) {
    const children = childrenOf.get(r) ?? [];
    const neededFromRoot = children.reduce((sum, c) => sum + computeNeeded(c), 0);
    const req = options.floor(r) + neededFromRoot;
    requirements[r] = req;
    const def = Math.max(0, req - armies(r));
    if (def > 0) placements[r] = def;
    totalDeficit += def;
  }

  let occupy: number | undefined;
  const tr = options.transfer;
  if (tr) {
    const step = edgeList.find((e) => e.from === tr.from && e.to === tr.to);
    if (step) {
      const toNeed = computeNeeded(tr.to);
      const otherChildren = (childrenOf.get(tr.from) ?? []).filter((c) => c !== tr.to);
      const fromNeed = otherChildren.reduce((sum, c) => sum + computeNeeded(c), 0);
      const cap = options.floor(tr.from);
      const available = Math.max(0, armies(tr.from) - cap);

      if (fromNeed === 0) {
        occupy = Math.min(tr.max, Math.max(tr.min, available));
      } else {
        const surplus = Math.max(0, available - toNeed - fromNeed);
        const branchOccupy = Math.round(toNeed + surplus * 0.5);
        occupy = Math.min(tr.max, Math.max(tr.min, branchOccupy));
      }
      totalDeficit -= (placements[tr.from] ?? 0) + (placements[tr.to] ?? 0);
      delete placements[tr.from];
      delete placements[tr.to];
    }
  }

  if (totalDeficit > (options.reinforcements ?? 0)) {
    return null;
  }

  const attacks = edgeList.map((e) => {
    const otherChildren = (childrenOf.get(e.from) ?? []).filter((c) => c !== e.to);
    const otherNeed = otherChildren.reduce((sum, c) => sum + computeNeeded(c), 0);
    const baseFloor = own(e.from) ? options.floor(e.from) : 1;
    return {
      from: e.from,
      to: e.to,
      keep: baseFloor + otherNeed,
    };
  });

  const totalCost = edgeList.reduce((sum, e) => sum + lossOf(e.to) + 1, 0);

  return {
    cost: totalCost,
    deficit: totalDeficit,
    requirements,
    placements,
    attacks,
    occupy,
  };
}
