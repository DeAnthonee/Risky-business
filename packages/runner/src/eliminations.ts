import { commitForOdds, getMap, nextTradeValue, type GameView, type PlayerId, type TerritoryId } from '@risk/engine';

export interface KillOptions {
  avoid: ReadonlySet<PlayerId>;
  noAttack: ReadonlySet<TerritoryId>;
  floor: (t: TerritoryId) => number;
  stationary?: ReadonlySet<TerritoryId>;
  targetOnly?: PlayerId | null;
  reinforcements?: number;
  transfer?: { from: TerritoryId; to: TerritoryId; min: number; max: number };
}
export interface KillPlan {
  target: PlayerId;
  score: number;
  attacks: { from: TerritoryId; to: TerritoryId; keep: number }[];
  placements: Record<TerritoryId, number>;
  occupy?: number;
}

/** Small, fully visible victims only. Enumerate attack forests, budgeting each branch before spending a stack.
 * Dice remain uncertain: each edge needs 90% battle odds and a conservative casualty reserve for its descendants.
 * Rebuilt after every action, so losses, new fog information and compulsory card trades cannot stale the route.
 */
export function planElimination(view: GameView, me: PlayerId, options: KillOptions): KillPlan | null {
  const map = getMap(view.options.map);
  const own = (t: string) => view.territories[t]?.owner === me && !view.territories[t]?.hidden;
  const armies = (t: string) => view.territories[t]?.armies ?? 0;
  const caps = new Set(view.options.capitals ? Object.values(view.capitals ?? {}) : []);
  const myCards = view.players.find(p => p.id === me)?.cardCount ?? 0;
  let best: KillPlan | null = null;
  for (const victim of view.players) {
    if (!victim.alive || victim.isNeutral || victim.id === me || options.avoid.has(victim.id) ||
        (options.targetOnly && victim.id !== options.targetOnly)) continue;
    const ts = map.territoryIds.filter(t => !view.territories[t]?.hidden && view.territories[t]?.owner === victim.id);
    if (!ts.length || ts.length > 4 || victim.territoryCount !== ts.length || ts.some(t => options.noAttack.has(t))) continue;
    // Keep this bounded tactical search cheap even in late games with enormous capital stacks.
    if (ts.reduce((sum, t) => sum + armies(t), 0) > 80) continue;
    const set = new Set(ts);
    const choices = ts.map(t => map.adjacency[t].filter(n => set.has(n) || own(n)));
    if (choices.some(c => !c.length)) continue;
    const branchBase = new Map<string, { minimum: number; losses: number }>();
    for (const t of ts) {
      const d = armies(t);
      const losses = Math.ceil(d * (caps.has(t) ? 2 : 1.25)) + 2;
      const minimum = commitForOdds(Math.max(24, d * 8 + 16), d, caps.has(t) ? 3 : 2, 0.9, !!view.options.balancedBlitz) ?? Infinity;
      branchBase.set(t, { minimum, losses });
    }
    const parents = new Map<string, string>();
    let attempts = 0;
    const evaluate = () => {
      const needed = new Map<string, number>();
      const visiting = new Set<string>();
      const branch = (t: string): number => {
        if (visiting.has(t)) return Infinity;
        if (needed.has(t)) return needed.get(t)!;
        visiting.add(t);
        const children = ts.filter(c => parents.get(c) === t);
        const base = branchBase.get(t)!;
        const n = Math.max(base.minimum, base.losses + 1 + children.reduce((s, c) => s + branch(c), 0));
        visiting.delete(t);
        needed.set(t, n);
        return n;
      };
      for (const t of ts) if (!Number.isFinite(branch(t))) return;
      if (ts.some(t => options.stationary?.has(parents.get(t)!) && ts.some(c => parents.get(c) === t))) return;
      const roots = [...new Set(ts.map(t => parents.get(t)!).filter(own))];
      if (!roots.length) return;
      const required = (r: string) => options.floor(r) + ts.filter(t => parents.get(t) === r).reduce((s, t) => s + needed.get(t)!, 0);
      const placements: Record<string, number> = {};
      let deficit = 0;
      for (const r of roots) {
        const n = Math.max(0, required(r) - armies(r));
        placements[r] = n;
        deficit += n;
      }
      let occupy: number | undefined;
      const tr = options.transfer;
      if (tr) {
        // These two territories share the surviving stack until occupation resolves.
        const fromNeed = roots.includes(tr.from) ? required(tr.from) : options.floor(tr.from);
        const toNeed = roots.includes(tr.to) ? required(tr.to) : 1;
        const lower = Math.max(tr.min, toNeed);
        const upper = Math.min(tr.max, armies(tr.from) - fromNeed);
        if (lower > upper) return;
        occupy = upper; // reserve the complete source branch; surplus follows the new front
        deficit -= (placements[tr.from] ?? 0) + (placements[tr.to] ?? 0);
        delete placements[tr.from]; delete placements[tr.to];
      }
      if (deficit > (options.reinforcements ?? 0)) return;
      const cost = ts.reduce((s, t) => s + branchBase.get(t)!.losses + 1, 0);
      const cardValue = view.options.cardValues === 'fixed' ? 3 : nextTradeValue(view.options.cardValues, view.tradeCount, view.players.find(p => p.id === me)?.tradesMade ?? 0) / 3;
      // Public hand size is a threat indicator, never a claim to know the opponent's actual set.
      const score = 20 + victim.cardCount * cardValue + (victim.cardCount >= 3 ? 6 : 0) +
        (myCards + victim.cardCount >= 5 ? cardValue : 0) - cost - deficit * 0.25;
      if (score <= 0 || (best && score <= best.score)) return;
      best = { target: victim.id, score, placements, occupy,
        attacks: ts.filter(t => own(parents.get(t)!)).map(t => {
          const from = parents.get(t)!;
          return { from, to: t, keep: required(from) - needed.get(t)! };
        }) };
    };
    const enumerate = (i: number) => {
      if (++attempts > 4096) return;
      if (i === ts.length) { evaluate(); return; }
      for (const p of choices[i]) { parents.set(ts[i], p); enumerate(i + 1); }
    };
    enumerate(0);
  }
  return best;
}
