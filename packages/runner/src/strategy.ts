import { getMap, type GameView, type PlayerId, type TerritoryId } from '@risk/engine';

/**
 * Board reads shared by the commander's facts and the move chooser (docs: packages/runner/README.md, "Strategy
 * reads"). Pure functions of the seat's own view plus its game memory: nothing here sees what the seat cannot.
 */

/** What the seat's game memory knows beyond the current view (filled by GameMemory, read by facts and chooser). */
export interface SeatIntel {
  /** Rivals that took one of our territories this round or last, newest first. */
  recentAttackers?: { id: PlayerId; round: number; territories: TerritoryId[]; brokeBonus: string | null }[];
  /** Estimated total armies of a rival (public income, trades, losses), for fogged rivals. */
  estimateArmies?: (pid: PlayerId) => number;
  /** Territories last seen owned by `pid` that are hidden now, with the round they were seen. */
  lastSeen?: (pid: PlayerId) => { territory: TerritoryId; round: number; armies: number }[];
}

export interface NaturalEnemy {
  id: PlayerId;
  name: string;
  /** Visible foreign borders of theirs that are ours, and all their visible foreign borders. */
  ours: number;
  total: number;
}

/**
 * A rival whose every way out leads into us (at least 80% of the territories bordering theirs are ours): whatever it
 * builds ends up hitting us, so it is the enemy to break before spending troops on other fronts.
 */
export function naturalEnemies(view: GameView, me: PlayerId): NaturalEnemy[] {
  const map = getMap(view.options.map);
  const blizzards = new Set(view.blizzards ?? []);
  const out: NaturalEnemy[] = [];
  for (const p of view.players) {
    if (!p.alive || p.isNeutral || p.id === me) continue;
    const theirs = map.territoryIds.filter((t) => !view.territories[t]?.hidden && view.territories[t]?.owner === p.id);
    if (theirs.length < 2) continue;
    const foreign = new Set<TerritoryId>();
    for (const t of theirs) for (const n of map.adjacency[t] ?? []) {
      const s = view.territories[n];
      if (!s || s.hidden || blizzards.has(n) || s.owner === p.id) continue;
      foreign.add(n);
    }
    const ours = [...foreign].filter((n) => view.territories[n]?.owner === me).length;
    if (ours >= 1 && foreign.size > 0 && ours / foreign.size >= 0.8) out.push({ id: p.id, name: p.name, ours, total: foreign.size });
  }
  return out;
}

export interface Sweep {
  owner: PlayerId;
  ownerName: string;
  continent: string;
  continentName: string;
  bonus: number;
  territories: TerritoryId[];
  /** Territories on 2 armies or fewer. */
  thin: number;
  /** Rough armies it costs to take every territory (losses plus one to occupy each). */
  cost: number;
  /** Our armies next to the region (all but one per stack) plus two turns of income. */
  capacity: number;
}

/**
 * A region one rival holds alone (no other owner visible in it) with most of it on 1-2 armies, next to us, that we
 * can take whole within about two turns. The models tend to spread into 1-army carpets: sweeping them breaks their
 * income and grows ours.
 */
export function sweepOpportunities(view: GameView, me: PlayerId): Sweep[] {
  const map = getMap(view.options.map);
  const blizzards = new Set(view.blizzards ?? []);
  const income = view.players.find((p) => p.id === me)?.income?.total ?? 3;
  const out: Sweep[] = [];
  for (const c of map.continents) {
    const terrs = c.territories.filter((t) => !blizzards.has(t));
    if (terrs.length < 2) continue;
    const seen = terrs.filter((t) => !view.territories[t]?.hidden);
    if (seen.length < Math.ceil(terrs.length * 0.8)) continue;
    const owners = new Set(seen.map((t) => view.territories[t]?.owner));
    if (owners.size !== 1) continue;
    const owner = [...owners][0];
    if (!owner || owner === me) continue;
    const rival = view.players.find((p) => p.id === owner);
    if (!rival || !rival.alive || rival.isNeutral) continue;
    const thin = seen.filter((t) => (view.territories[t]?.armies ?? 0) <= 2).length;
    if (thin < Math.ceil(seen.length * 0.6)) continue;
    const launch = map.territoryIds.filter((t) => view.territories[t]?.owner === me && (map.adjacency[t] ?? []).some((n) => terrs.includes(n)));
    if (!launch.length) continue;
    const cost = Math.ceil(seen.reduce((s, t) => s + (view.territories[t]?.armies ?? 1) * 1.2 + 1, 0));
    const capacity = launch.reduce((s, t) => s + Math.max(0, (view.territories[t]?.armies ?? 1) - 1), 0) + income * 2;
    if (cost > capacity) continue;
    out.push({ owner, ownerName: rival.name, continent: c.id, continentName: c.name, bonus: c.bonus, territories: terrs, thin, cost, capacity });
  }
  return out.sort((a, b) => b.bonus - a.bonus || a.cost - b.cost);
}

/** The continent holding most of `territories` (ties: the first seen), or null. */
export function likelyRegion(view: GameView, territories: TerritoryId[]): string | null {
  const map = getMap(view.options.map);
  const counts = new Map<string, number>();
  for (const t of territories) {
    const c = map.territoryById[t]?.continent;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [c, k] of counts) if (k > n) ((best = c), (n = k));
  return best;
}

/**
 * Why holding back from `rival` can be a real decision: the seat is fighting on another front. True when the plan's
 * target is someone else, or its focus region is not `rival`'s, and `rival` is not a natural enemy (whose border is
 * the seat's only real front). Geography only: troop counts are unreliable under fog.
 */
export function otherFront(view: GameView, me: PlayerId, rival: PlayerId, plan: { target?: PlayerId | null; focus?: string | null }): string | null {
  if (naturalEnemies(view, me).some((e) => e.id === rival)) return null;
  const name = (id: PlayerId) => view.players.find((p) => p.id === id)?.name ?? id;
  if (plan.target && plan.target !== rival && view.players.some((p) => p.id === plan.target && p.alive)) return `the front with ${name(plan.target)}`;
  if (plan.focus) {
    const map = getMap(view.options.map);
    const terrs = map.continentById[plan.focus]?.territories ?? (map.isTerritory(plan.focus) ? [plan.focus] : []);
    const owners = terrs.map((t) => view.territories[t]).filter((s) => s && !s.hidden && s.owner && s.owner !== me).map((s) => s!.owner);
    if (terrs.length && owners.filter((o) => o === rival).length * 2 <= owners.length) {
      return `the ${map.continentById[plan.focus]?.name ?? map.territoryById[plan.focus]?.name ?? plan.focus} front`;
    }
  }
  return null;
}
