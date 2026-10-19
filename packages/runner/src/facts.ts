import { getMap, tradeBonus, nextTradeValue, type GameView, type PlayerId } from '@risk/engine';

/**
 * The card set math, every turn: under progressive cards the next set's value (the engine's tradeBonus), what one
 * card is worth, how many cards each hand holds and whether this seat already took a card (conquered) this turn.
 * Empty for fixed cards.
 */
export function cardMath(view: GameView, me: PlayerId): string[] {
  if (view.options.cardValues === 'exponential') {
    const p = view.players.find(p => p.id === me);
    const count = p?.tradesMade ?? 0;
    return [
      'Card math: exponential PER PLAYER. Your next sets: ' + [0, 1, 2].map(i => nextTradeValue('exponential', 0, count + i)).join(', ') + ' armies. You have traded ' + count + ' sets. Each next value is ceil(previous × 1.3) through personal trade 25, then +1000. Other players trading never advances your sequence; stolen cards use your sequence, not the victim’s.',
      'You hold ' + (p?.cardCount ?? 0) + ' cards and ' + (p?.conqueredThisTurn ? 'have already' : 'have not yet') + ' taken a card this turn. Opponents: ' + view.players.filter(p => p.alive && !p.isNeutral && p.id !== me).map(p => p.name + ': ' + p.cardCount + ' cards, next personal set ' + nextTradeValue('exponential', 0, p.tradesMade ?? 0)).join('; '),
    ];
  }
  if (view.options.cardValues !== 'progressive') return [];
  const value = tradeBonus(view.tradeCount);
  const meP = view.players.find((p) => p.id === me);
  const lines = [`Card math: the next set is worth ${value} armies, so a card is worth about ${Math.round((value / 3) * 10) / 10} armies now, and the set grows with every trade (then ${tradeBonus(view.tradeCount + 1)}, ${tradeBonus(view.tradeCount + 2)}).`];
  const others = view.players.filter((p) => p.alive && !p.isNeutral && p.id !== me).map((p) => `${p.name} ${p.cardCount}`);
  lines.push(`You hold ${meP?.cardCount ?? 0} cards and ${meP?.conqueredThisTurn ? 'have already' : 'have not yet'} taken a card this turn. Opponents' cards: ${others.join(', ') || 'none'}.`);
  return lines;
}

export function eliminationScouting(view: GameView, me: PlayerId): string[] {
  const lines: string[] = [];
  const weak = view.players.filter(p => p.alive && !p.isNeutral && p.id !== me && p.territoryCount !== null && p.territoryCount <= 4);
  if (weak.length) lines.push('Elimination scouting (verify all routes before committing): ' + weak.map(p => {
    const known = Object.entries(view.territories).filter(([, t]) => !t.hidden && t.owner === p.id);
    const holdings = known.map(([id, t]) => id + ':' + t.armies).join(', ');
    return p.name + ': ' + p.territoryCount + ' territories, ' + p.cardCount + ' cards to steal, ' + (known.length === p.territoryCount ? 'all holdings visible [' + holdings + ']' : 'incomplete visibility; no confirmed kill route');
  }).join('; ') + '. Remove them before they can trade; split at forks only when both routes have enough troops.');
  return lines;
}

const MAX_FACTS = 1600;

/** Compact plain-text board summary for the LLM prompt. Null counts (fog) print as "?". */
export function boardFacts(view: GameView, me: PlayerId): string {
  const map = getMap(view.options.map);
  const terrName = new Map(map.territories.map((t) => [t.id, t.name]));
  const contName = new Map(map.continents.map((c) => [c.id, c.name]));
  const nameOf = (id: PlayerId | null) => view.players.find((p) => p.id === id)?.name ?? '?';
  const q = (n: number | null | undefined) => (n === null || n === undefined ? '?' : String(n));
  const living = view.players.filter((p) => p.alive && !p.isNeutral);

  const lines: string[] = [];
  const turnOf = view.currentPlayer ? ` ${nameOf(view.currentPlayer)} to move.` : '';
  lines.push(`Round ${view.round}, turn ${view.turnNumber}, phase ${view.phase}.${turnOf}`);

  for (const p of living) {
    const conts = p.continents.map((c) => contName.get(c) ?? c).join(', ') || 'none';
    lines.push(
      `${p.name}${p.id === me ? ' (you)' : ''}: ${q(p.territoryCount)} territories, ${q(p.armyCount)} armies, income ${q(p.income?.total)}, ${p.cardCount} cards, continents: ${conts}`,
    );
  }

  // Opponents on my borders and the armies they hold there; my biggest stack by name.
  const border = new Map<PlayerId, number>();
  const seen = new Set<string>();
  let biggest: { id: string; armies: number } | null = null;
  for (const t of map.territoryIds) {
    const mineHere = view.territories[t];
    if (mineHere?.owner !== me) continue;
    if (!biggest || mineHere.armies > biggest.armies) biggest = { id: t, armies: mineHere.armies };
    for (const n of map.adjacency[t]) {
      const ts = view.territories[n];
      if (!ts || ts.hidden || !ts.owner || ts.owner === me || seen.has(n)) continue;
      seen.add(n);
      border.set(ts.owner, (border.get(ts.owner) ?? 0) + ts.armies);
    }
  }

  const allCountsVisible = living.length > 0 && living.every((p) => p.territoryCount !== null && p.armyCount !== null);
  const whoLabel = (p: (typeof living)[number]) => `${p.name}${p.id === me ? ' (you)' : ''}`;
  const rivals = living.filter((p) => p.id !== me);
  if (allCountsVisible) {
    const top = [...living].sort(
      (a, b) =>
        b.territoryCount! - a.territoryCount! ||
        (b.armyCount ?? 0) - (a.armyCount ?? 0) ||
        (b.income?.total ?? 0) - (a.income?.total ?? 0),
    )[0];
    const topRival = [...rivals].sort(
      (a, b) =>
        b.territoryCount! - a.territoryCount! ||
        (b.armyCount ?? 0) - (a.armyCount ?? 0) ||
        (b.income?.total ?? 0) - (a.income?.total ?? 0),
    )[0];
    const armyTop = [...living].sort((a, b) => (b.armyCount ?? 0) - (a.armyCount ?? 0) || (b.income?.total ?? 0) - (a.income?.total ?? 0))[0];
    const incTop = [...living].sort((a, b) => (b.income?.total ?? 0) - (a.income?.total ?? 0) || (b.armyCount ?? 0) - (a.armyCount ?? 0))[0];
    const extras = [
      top.id === me && topRival ? `leading rival: ${topRival.name} (${topRival.territoryCount} territories, ${topRival.armyCount} armies, +${q(topRival.income?.total)}/turn)` : null,
      armyTop && armyTop.id !== top.id ? `most troops: ${whoLabel(armyTop)} (${armyTop.armyCount} armies, +${q(armyTop.income?.total)}/turn)` : null,
      incTop && incTop.id !== top.id && incTop.id !== armyTop?.id ? `highest income: ${whoLabel(incTop)} (+${q(incTop.income?.total)}/turn, ${incTop.armyCount} armies)` : null,
    ].filter(Boolean);
    lines.push(`Leader: ${whoLabel(top)} (${top.territoryCount} territories, ${top.armyCount} armies, +${q(top.income?.total)}/turn)${extras.length ? `; ${extras.join('; ')}` : ''}.`);
  } else if (living.length > 0) {
    const top = [...living].sort(
      (a, b) =>
        (b.income?.total ?? 0) - (a.income?.total ?? 0) ||
        (border.get(b.id) ?? b.armyCount ?? 0) - (border.get(a.id) ?? a.armyCount ?? 0) ||
        b.cardCount - a.cardCount,
    )[0];
    const borderTop = [...border.entries()].sort((a, b) => b[1] - a[1])[0];
    const cardWatch = [...living]
      .filter((p) => p.id !== me && p.cardCount >= 3)
      .sort((a, b) => b.cardCount - a.cardCount)
      .map((p) => `${p.name} (${p.cardCount} cards)`);
    lines.push(
      `Leader (by income under fog): ${whoLabel(top)} (+${q(top.income?.total)}/turn, ${top.cardCount} cards)${borderTop ? `; biggest border threat: ${nameOf(borderTop[0])} (${borderTop[1]} visible armies, +${q(living.find((p) => p.id === borderTop[0])?.income?.total)}/turn)` : ''}${cardWatch.length ? `; card trade watch: ${cardWatch.join(', ')}` : ''}.`,
    );
  }

  if (border.size > 0) {
    lines.push(`Borders you: ${[...border].map(([id, armies]) => `${nameOf(id)} (${armies} armies)`).join(', ')}.`);
  }
  if (biggest) lines.push(`Your biggest stack: ${terrName.get(biggest.id) ?? biggest.id} (${biggest.armies}).`);

  const mine = view.players.find((p) => p.id === me);
  lines.push(...cardMath(view, me), ...eliminationScouting(view, me));
  if (mine && mine.continents.length > 0) lines.push(`Your continents: ${mine.continents.map((c) => contName.get(c) ?? c).join(', ')}.`);
  if (view.phase === 'finished' && view.winner) lines.push(`Winner: ${nameOf(view.winner)}.`);

  return lines.join('\n').slice(0, MAX_FACTS);
}

const MAX_COMMANDER_FACTS = 6500;

/** "Name [id]" label used for territories and continents so the model can answer with an id. */
const label = (name: string | undefined, id: string) => (name && name !== id ? `${name} [${id}]` : `[${id}]`);

/**
 * Longer board summary for the commander prompt: my capital, capitals I can see, blizzards near me, each
 * continent's ownership, threats on my borders, the leader and the current card value. Ids appear in
 * square brackets so the model can name a focus. Fog-aware: hidden territories are never described.
 */
export function commanderFacts(view: GameView, me: PlayerId): string {
  const map = getMap(view.options.map);
  const tName = (id: string) => label(map.territoryById[id]?.name, id);
  const nameOf = (id: PlayerId | null) => view.players.find((p) => p.id === id)?.name ?? '?';
  const q = (n: number | null | undefined) => (n === null || n === undefined ? '?' : String(n));
  const blizzards = new Set(view.blizzards ?? []);
  const ts = (t: string) => view.territories[t];
  const visible = (t: string) => !!ts(t) && !ts(t).hidden;
  const mineList = map.territoryIds.filter((t) => ts(t)?.owner === me);
  const mineSet = new Set(mineList);
  const hostileNeighbours = (t: string) => map.adjacency[t].filter((n) => visible(n) && ts(n).owner && ts(n).owner !== me && !blizzards.has(n));
  const living = view.players.filter((p) => p.alive && !p.isNeutral);
  const meP = view.players.find((p) => p.id === me);

  const lines: string[] = [];
  lines.push(`Round ${view.round}, turn ${view.turnNumber}, phase ${view.phase}. ${living.length} players alive.`);
  const o = view.options;
  lines.push(`Settings: ${o.cardValues} cards, capitals ${o.capitals ? (o.chooseCapitals ? 'chosen' : 'assigned') : 'off'}, fog ${o.fogOfWar ? 'on' : 'off'}, ${o.fortifyMode} fortify, ${view.blizzards?.length ?? 0} blizzards.`);

  // Cards.
  const next = o.cardValues === 'fixed' ? 'fixed 4-10 by set type' : o.cardValues === 'exponential' ? `${nextTradeValue('exponential', 0, view.players.find(p => p.id === me)?.tradesMade ?? 0)} armies (your personal exponential sequence)` : `${tradeBonus(view.tradeCount)} armies (progressive, ${view.tradeCount} sets traded so far)`;
  const sets = view.legal?.tradeableSets.length ?? 0;
  const oppCards = living
    .filter((p) => p.id !== me)
    .map((p) => `${p.name} ${p.cardCount}${p.cardCount >= 4 ? ' (forced trade soon)' : p.cardCount >= 3 ? ' (can hold a set)' : ''}`)
    .join(', ');
  lines.push(`Next card set is worth ${next}. You hold ${meP?.cardCount ?? 0} cards${sets ? ` (${sets} tradeable set${sets > 1 ? 's' : ''})` : ''}.${o.fogOfWar && oppCards ? ` Opponent card counts (public under fog): ${oppCards}.` : ''}`);
  lines.push(...cardMath(view, me), ...eliminationScouting(view, me));

  // Players.
  for (const p of living) {
    const conts = p.continents.map((c) => map.continentById[c]?.name ?? c).join(', ') || 'none';
    lines.push(`${p.name}${p.id === me ? ' (you)' : ''}: ${q(p.territoryCount)} territories, ${q(p.armyCount)} armies, income ${q(p.income?.total)}, ${p.cardCount} cards, bonuses: ${conts}`);
  }
  const borderArmies = new Map<PlayerId, number>();
  const seenBorder = new Set<string>();
  for (const t of mineList) {
    for (const n of hostileNeighbours(t)) {
      if (seenBorder.has(n)) continue;
      seenBorder.add(n);
      const owner = ts(n).owner!;
      borderArmies.set(owner, (borderArmies.get(owner) ?? 0) + ts(n).armies);
    }
  }
  const rivals = living.filter((p) => p.id !== me);
  if (rivals.length > 0 && rivals.every((p) => p.territoryCount !== null && p.armyCount !== null)) {
    const top = [...rivals].sort(
      (a, b) =>
        b.territoryCount! - a.territoryCount! ||
        (b.income?.total ?? 0) - (a.income?.total ?? 0) ||
        (b.armyCount ?? 0) - (a.armyCount ?? 0),
    )[0];
    const armyTop = [...rivals].sort((a, b) => (b.armyCount ?? 0) - (a.armyCount ?? 0) || (b.income?.total ?? 0) - (a.income?.total ?? 0))[0];
    const incTop = [...rivals].sort((a, b) => (b.income?.total ?? 0) - (a.income?.total ?? 0) || (b.armyCount ?? 0) - (a.armyCount ?? 0))[0];
    const extras = [
      armyTop && armyTop.id !== top.id ? `most troops: ${armyTop.name} (${armyTop.armyCount} armies, income ${q(armyTop.income?.total)})` : null,
      incTop && incTop.id !== top.id && incTop.id !== armyTop?.id ? `highest income: ${incTop.name} (income ${q(incTop.income?.total)}, ${incTop.armyCount} armies)` : null,
    ].filter(Boolean);
    lines.push(
      `Leader among rivals: ${top.name}, ${top.territoryCount} territories, ${top.armyCount} armies, income ${q(top.income?.total)}, ${top.cardCount} cards${extras.length ? `; ${extras.join('; ')}` : ''}.`,
    );
  } else if (rivals.length > 0) {
    const top = [...rivals].sort(
      (a, b) =>
        (b.income?.total ?? 0) - (a.income?.total ?? 0) ||
        (borderArmies.get(b.id) ?? 0) - (borderArmies.get(a.id) ?? 0) ||
        b.cardCount - a.cardCount,
    )[0];
    const borderTop = [...borderArmies.entries()].sort((a, b) => b[1] - a[1])[0];
    lines.push(
      `Leader among rivals (by reinforcement income under fog): ${top.name}, income ${q(top.income?.total)}/turn, ${top.cardCount} cards, ${borderArmies.get(top.id) ?? 0} armies visible on your borders${borderTop && borderTop[0] !== top.id ? `; biggest visible border threat: ${nameOf(borderTop[0])} (${borderTop[1]} border armies, income ${q(rivals.find((r) => r.id === borderTop[0])?.income?.total)}/turn)` : ''}.`,
    );
  }

  // Capitals.
  if (o.capitals) {
    const mine = view.capitals?.[me];
    if (mine && ts(mine)) lines.push(`Your capital: ${tName(mine)} with ${ts(mine).armies} armies${ts(mine).owner === me ? '' : ' (LOST)'}; hostile neighbours hold ${hostileNeighbours(mine).reduce((n, t) => n + ts(t).armies, 0)} armies.`);
    const others = Object.entries(view.capitals ?? {}).filter(([pid, t]) => pid !== me && ts(t));
    if (others.length > 0) lines.push(`Capitals you can see: ${others.map(([pid, t]) => `${tName(t)} (${nameOf(pid)}'s, held by ${nameOf(ts(t).owner)}, ${ts(t).armies} armies)`).join('; ')}.`);
    const total = living.length + view.players.filter((p) => !p.alive && !p.isNeutral).length;
    const seen = Object.keys(view.capitals ?? {}).length;
    if (seen < total) lines.push(`${total - seen} capital${total - seen > 1 ? 's' : ''} not yet seen. Holding every capital wins.`);
  }
  if (view.legal && view.legal.capitalChoices.length > 0) {
    const opts = view.legal.capitalChoices.map((t) => {
      const adj = map.adjacency[t];
      const exits = adj.filter((n) => !mineSet.has(n) && !blizzards.has(n)).length;
      return `${tName(t)} (${ts(t).armies} armies, ${adj.length} neighbours, ${exits} not yours, bonus region ${map.continentById[map.territoryById[t].continent].name})`;
    });
    lines.push(`CAPITAL CHOICES: ${opts.join('; ')}.`);
  }

  // Blizzards near me: adjacent to my land or inside a continent I hold land in.
  const myConts = new Set(mineList.map((t) => map.territoryById[t].continent));
  const nearBlizz = [...blizzards].filter((b) => map.adjacency[b].some((n) => mineSet.has(n)) || myConts.has(map.territoryById[b].continent));
  if (nearBlizz.length > 0) lines.push(`Blizzards near you (impassable): ${nearBlizz.map(tName).join(', ')}.`);

  // Continents.
  for (const c of map.continents) {
    const cells = c.territories.filter((t) => !blizzards.has(t));
    const mineHere = cells.filter((t) => mineSet.has(t)).length;
    const hidden = cells.filter((t) => !visible(t)).length;
    const others = new Map<string, number>();
    for (const t of cells) if (visible(t) && ts(t).owner && ts(t).owner !== me) others.set(nameOf(ts(t).owner), (others.get(nameOf(ts(t).owner)) ?? 0) + 1);
    const holder = view.continentOwners[c.id];
    const rest = [...others].map(([n, k]) => `${n} ${k}`).join(', ');
    lines.push(`${label(c.name, c.id)} bonus ${c.bonus}: you ${mineHere}/${cells.length}${rest ? `; ${rest}` : ''}${hidden ? `; ${hidden} unseen` : ''}${holder ? `; held by ${nameOf(holder)}` : ''}`);
  }

  // The three cheapest bonuses for me: fewest territories still missing, then the biggest bonus.
  const cheap = map.continents
    .map((c) => {
      const cells = c.territories.filter((t) => !blizzards.has(t));
      const inside = new Set(cells);
      const missing = cells.filter((t) => !mineSet.has(t));
      const entries = cells.filter((t) => map.adjacency[t].some((n) => !inside.has(n) && !blizzards.has(n))).length;
      return { c, cells, missing, entries };
    })
    .filter((x) => x.cells.length > 0 && x.missing.length > 0)
    .sort((a, b) => a.missing.length - b.missing.length || b.c.bonus - a.c.bonus)
    .slice(0, 3);
  if (cheap.length > 0) {
    lines.push('Cheapest bonuses for you (territories still missing, owner and armies when visible; border points = ways into the continent after blizzards):');
    for (const x of cheap) {
      const shown = x.missing.slice(0, 6).map((t) => (visible(t) ? `${tName(t)} ${ts(t).owner ? `${nameOf(ts(t).owner)} (${ts(t).armies})` : 'empty'}` : `${tName(t)} unseen`));
      const more = x.missing.length > 6 ? `, +${x.missing.length - 6} more` : '';
      lines.push(`- ${label(x.c.name, x.c.id)} bonus ${x.c.bonus}: you hold ${x.cells.length - x.missing.length}/${x.cells.length}, missing ${x.missing.length}: ${shown.join(', ')}${more}; ${x.entries} border point${x.entries === 1 ? '' : 's'}`);
    }
  }

  // Threats on my borders.
  const threats = mineList
    .map((t) => ({ t, foes: hostileNeighbours(t) }))
    .filter((x) => x.foes.length > 0)
    .map((x) => ({ ...x, sum: x.foes.reduce((n, f) => n + ts(f).armies, 0) }))
    .sort((a, b) => b.sum - ts(b.t).armies - (a.sum - ts(a.t).armies))
    .slice(0, 8);
  if (threats.length > 0) {
    // Every enemy territory I can see next to each border, with owner and armies, so a target can be checked
    // against who really holds it.
    lines.push('Your most pressed borders (enemy territories next to each, with owner and armies):');
    for (const x of threats) {
      const foes = [...x.foes].sort((f, g) => ts(g).armies - ts(f).armies).slice(0, 5);
      lines.push(`- ${tName(x.t)} (${ts(x.t).armies}) next to ${foes.map((f) => `${tName(f)} held by ${nameOf(ts(f).owner)} (${ts(f).armies})`).join(', ')}`);
    }
  }
  if (view.phase === 'finished' && view.winner) lines.push(`Winner: ${nameOf(view.winner)}.`);

  return lines.join('\n').slice(0, MAX_COMMANDER_FACTS);
}
