import { getMap, type GameView, type PlayerId } from '@risk/engine';

/** Public geography only: fog hides armies and ownership, never the map's connections or blizzards. */
export function terrainTopology(view: GameView) {
  const map = getMap(view.options.map);
  const frozen = new Set(view.blizzards ?? []);
  const open = map.territoryIds.filter(t => !frozen.has(t));
  const adjacency = Object.fromEntries(open.map(t => [t, map.adjacency[t].filter(n => !frozen.has(n))]));
  const entered = new Map<string, number>();
  const low = new Map<string, number>();
  const bottlenecks = new Set<string>();
  const components: string[][] = [];
  let tick = 0;
  const visit = (t: string, parent: string | null, component: string[]) => {
    entered.set(t, ++tick); low.set(t, tick); component.push(t);
    let children = 0;
    for (const n of adjacency[t]) {
      if (!entered.has(n)) {
        children++; visit(n, t, component);
        low.set(t, Math.min(low.get(t)!, low.get(n)!));
        if (parent !== null && low.get(n)! >= entered.get(t)!) bottlenecks.add(t);
      } else if (n !== parent) low.set(t, Math.min(low.get(t)!, entered.get(n)!));
    }
    if (parent === null && children > 1) bottlenecks.add(t);
  };
  for (const t of open) if (!entered.has(t)) { const component: string[] = []; visit(t, null, component); components.push(component); }
  return { adjacency, components, bottlenecks: [...bottlenecks], deadEnds: open.filter(t => adjacency[t].length <= 1), frozen: [...frozen] };
}

/** Detailed opening map reconnaissance, then a shorter reminder on later turns. */
export function terrainBriefing(view: GameView, me: PlayerId, detailed = false): string {
  const map = getMap(view.options.map);
  const terrain = terrainTopology(view);
  const lines = [
    `Map reconnaissance: ${map.name}. ${Object.keys(terrain.adjacency).length} passable territories; ${terrain.components.length} geographic component(s).`,
    `Blizzards (impassable, removed from every route): ${terrain.frozen.join(', ') || 'none'}.`,
    'Geographic dead ends (territory -> only exit): ' + (terrain.deadEnds.map(t => `${t}->${terrain.adjacency[t][0] ?? 'NO EXIT'}`).join('; ') || 'none') + '.',
    'Geographic bottlenecks (removing one disconnects passable land): ' + (terrain.bottlenecks.join(', ') || 'none') + '.',
    'A geographic connection does not make a kill affordable. Budget defenders, casualties and separate stacks. Do not push the entire army into a dead end before another branch is finished. Owning connected territories does not teleport attack armies between them; sea routes exist only where an edge below connects them.',
  ];
  for (const p of view.players.filter(p => p.alive && !p.isNeutral && p.id !== me)) {
    const holdings = Object.keys(terrain.adjacency).filter(t => !view.territories[t]?.hidden && view.territories[t]?.owner === p.id);
    if (!holdings.length || holdings.length > 4 || p.territoryCount !== holdings.length) continue;
    const remaining = new Set(holdings);
    const reached = new Set(holdings.filter(t => terrain.adjacency[t].some(n => view.territories[n]?.owner === me && !view.territories[n]?.hidden)));
    const queue = [...reached];
    for (let i = 0; i < queue.length; i++) for (const n of terrain.adjacency[queue[i]]) if (remaining.has(n) && !reached.has(n)) { reached.add(n); queue.push(n); }
    const cutOff = holdings.filter(t => !reached.has(t));
    if (cutOff.length) lines.push(`Route warning for ${p.name}: ${cutOff.join(', ')} cannot currently be reached from your launch territories through only that player's holdings. A kill needs staging or crossing another player's land first; do not assume an uninterrupted elimination route.`);
  }
  if (detailed) {
    lines.push('Opening map connection graph (public terrain; frozen vertices and their edges already removed):');
    for (const c of map.continents) {
      lines.push(`${c.name} [${c.id}], bonus +${c.bonus}: ` + c.territories.filter(t => terrain.adjacency[t]).map(t => `${t}->${terrain.adjacency[t].join(',')}`).join('; '));
    }
    if (terrain.components.length > 1) lines.push('Disconnected components: ' + terrain.components.map(c => c.join(',')).join(' | '));
  }
  return lines.join('\n');
}
