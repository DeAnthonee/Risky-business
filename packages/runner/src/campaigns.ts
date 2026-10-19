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
