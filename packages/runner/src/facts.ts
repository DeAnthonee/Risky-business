import { getMap, tradeBonus, nextTradeValue, blitzOdds, type GameView, type PlayerId } from '@risk/engine';

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

export function eliminationScouting(view: GameView, me: PlayerId, detailed = false): string[] {
  const map = getMap(view.options.map);
  const livingRivals = view.players.filter((p) => p.alive && !p.isNeutral && p.id !== me);
  if (!livingRivals.length) return [];

  const myTerrs = map.territoryIds.filter((t) => view.territories[t]?.owner === me);
  const myBiggestStack = Math.max(1, ...myTerrs.map((t) => view.territories[t]?.armies ?? 1));
  const myIncome = view.players.find((p) => p.id === me)?.income?.total ?? 0;
  const myStrikePool = myBiggestStack + (view.phase === 'reinforce' ? myIncome : 0) - 1;

  const cardValue = view.options.cardValues === 'fixed'
    ? 3
    : view.options.cardValues === 'exponential'
      ? (nextTradeValue('exponential', 0, view.players.find((p) => p.id === me)?.tradesMade ?? 0) / 3)
      : (tradeBonus(view.tradeCount) / 3);

  const lines: string[] = [];
  const header = detailed
    ? 'Kill potential & Blitz odds (formula for all-in elimination; kills award +1 kill point, steal cards, and jump placement):'
    : 'Elimination scouting (kills award +1 kill point, steal cards & boost placement):';
  lines.push(header);

  const mine = new Set(myTerrs);
  for (const victim of livingRivals) {
    const knownTerrs = map.territoryIds.filter((t) => !view.territories[t]?.hidden && view.territories[t]?.owner === victim.id);
    const knownArmies = knownTerrs.reduce((sum, t) => sum + (view.territories[t]?.armies ?? 0), 0);
    const hasFullVis = victim.territoryCount !== null && knownTerrs.length === victim.territoryCount;
    // Under fog a rival we cannot see at all used to come out as 0 territories and 0 armies, a "100% kill".
    if (knownTerrs.length === 0 && victim.territoryCount === null) {
      if (detailed) lines.push(`- ${victim.name}: ${victim.cardCount} cards; none of its territories are visible (fog): location and armies unknown, not a kill target this turn.`);
      continue;
    }
    const borders = knownTerrs.some((t) => (map.adjacency[t] ?? []).some((n) => mine.has(n)));

    const terrCount = victim.territoryCount ?? Math.max(knownTerrs.length, Math.min(11, Math.round(knownTerrs.length * 1.5)));
    const totalDefendingArmies = victim.armyCount ?? Math.max(knownArmies, knownArmies + Math.max(0, terrCount - knownTerrs.length) * 1.5);

    const isWeakOrHighCard = (victim.territoryCount !== null && victim.territoryCount <= 4) || totalDefendingArmies <= 8 || victim.cardCount >= 3;
    if (!detailed && !isWeakOrHighCard) continue;

    const effectiveAttacker = Math.max(1, myStrikePool - terrCount);
    const hasCap = view.options.capitals && view.capitals && Object.entries(view.capitals).some(([pid, t]) => pid === victim.id && view.territories[t]?.owner === victim.id);
    const defDice = hasCap ? 3 : 2;

    const odds = blitzOdds(effectiveAttacker, totalDefendingArmies, defDice);
    const winP = view.options.balancedBlitz ? odds.balancedWin : odds.win;
    const pct = Math.round(winP * 100);

    const stealText = `${victim.name}: ${victim.territoryCount !== null ? `${victim.territoryCount} territories, ` : ''}${victim.cardCount} cards to steal`;

    if (!detailed) {
      const holdings = knownTerrs.map((id) => `${id}:${view.territories[id]?.armies ?? 0}`).join(', ');
      const visText = hasFullVis ? `all holdings visible [${holdings}]` : `${knownTerrs.length} visible holdings`;
      lines.push(`- ${stealText}, ${visText} (Blitz kill chance: ${pct}%${hasFullVis ? '' : ', visible armies only'}${borders ? '' : '; no shared border, not a kill this turn'}).`);
      continue;
    }

    const myCards = view.players.find((p) => p.id === me)?.cardCount ?? 0;
    const guaranteedSet = (myCards + victim.cardCount) >= 5;
    const tradeArmies = guaranteedSet
      ? (view.options.cardValues === 'fixed' ? 7 : (view.options.cardValues === 'exponential' ? nextTradeValue('exponential', 0, view.players.find((p) => p.id === me)?.tradesMade ?? 0) : tradeBonus(view.tradeCount)))
      : (victim.cardCount >= 4 ? (view.options.cardValues === 'fixed' ? 6 : Math.round(tradeBonus(view.tradeCount) * 0.8)) : 0);

    const expectedSpend = Math.round(odds.expectedAttackerLosses + terrCount);
    const netArmiesAfterKill = Math.round(myStrikePool - expectedSpend + tradeArmies);

    let postKillStatus = '';
    if (netArmiesAfterKill >= 10) {
      postKillStatus = `strong recovery (~${netArmiesAfterKill} net armies after kill & trade)`;
    } else if (netArmiesAfterKill >= 5) {
      postKillStatus = `moderate (~${netArmiesAfterKill} net armies after kill)`;
    } else {
      postKillStatus = `CRIPPLING RISK (~${netArmiesAfterKill} net armies left; dangerous if rivals can sweep you)`;
    }

    let bountyBonus = 0;
    let cardNote = `${victim.cardCount} cards`;
    if (victim.cardCount >= 5) {
      bountyBonus = 35;
      cardNote = '5 CARDS (GUARANTEED IMMEDIATE SET TRADE!)';
    } else if (victim.cardCount >= 4) {
      bountyBonus = 18;
      cardNote = '4 cards (imminent/high trade chance)';
    } else if (victim.cardCount >= 3) {
      bountyBonus = 8;
      cardNote = '3 cards (can hold set)';
    }

    const killScore = Math.round(winP * (35 + bountyBonus + victim.cardCount * cardValue) - (1 - winP) * 45);

    let verdict = `Unviable (${pct}% odds) — avoid reckless suicide`;
    if (victim.cardCount >= 5 && winP >= 0.65) {
      verdict = netArmiesAfterKill >= 5
        ? `CRITICAL ALL-IN KILL: ${pct}% Blitz odds! ${myCards}+${victim.cardCount}=${myCards + victim.cardCount} cards GUARANTEES immediate set trade (+${tradeArmies} armies), leaving ~${netArmiesAfterKill} armies & leaping placement!`
        : `DANGEROUS KILL: ${pct}% Blitz odds for 5 cards, but leaves only ~${netArmiesAfterKill} armies — only do it if no rival can punish you.`;
    } else if (guaranteedSet && winP >= 0.70) {
      verdict = netArmiesAfterKill >= 5
        ? `PRIME COMEBACK KILL: ${pct}% Blitz odds! Stealing ${victim.cardCount} cards guarantees immediate set trade (+${tradeArmies} armies), refuels army to ~${netArmiesAfterKill} troops!`
        : `HIGH RISK KILL: guarantees trade (+${tradeArmies} armies), but expected losses leave only ~${netArmiesAfterKill} armies.`;
    } else if (victim.cardCount >= 4 && winP >= 0.70) {
      verdict = `PRIME KILL TARGET: ${pct}% Blitz odds to steal 4 cards (high trade chance) & leap placement!`;
    } else if (terrCount <= 2 && winP >= 0.80) {
      verdict = `EASY BOUNTY: ${pct}% Blitz odds to eliminate weak survivor (+1 kill point)`;
    } else if (winP >= 0.70) {
      verdict = `FAVORABLE KILL: ${pct}% Blitz odds; viable if route is clear`;
    }
    // Odds that count only visible armies, or a rival we do not border, are not a kill this turn.
    if (!borders) {
      verdict = `NO SHARED BORDER: not a kill this turn (you would have to conquer through other players first)`;
    } else if (!hasFullVis && winP >= 0.70) {
      verdict = `UNCERTAIN UNDER FOG: ${pct}% counts only the ${knownArmies} visible armies; hidden territories and armies make the real odds lower`;
    }

    const holdingsText = hasFullVis ? `all ${terrCount} terrs visible (${knownArmies} armies)` : `${knownTerrs.length}/${terrCount} terrs visible (${knownArmies} armies)`;
    lines.push(`- ${stealText} (${cardNote}) | Est. Defense: ${Math.round(totalDefendingArmies)} armies across ${terrCount} terrs (${holdingsText}) | Your strike stack: ${myStrikePool} armies -> Blitz win chance: ${pct}% (${view.options.balancedBlitz ? 'balanced' : 'true random'}) | Post-kill: ${postKillStatus} | Score: ${killScore} | Verdict: ${verdict}`);
  }

  if (!detailed && lines.length === 1) return [];
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

const MAX_COMMANDER_FACTS = 9000;

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
  const diceModeText = o.balancedBlitz
    ? 'BALANCED BLITZ (median of 5 runs: steep S-curve, high-odds >=80% attacks are near-certain locks, underdog attacks <40% almost always fail)'
    : 'TRUE RANDOM BLITZ (high variance: fat-tail losses, 80% attacks can fail, keep +3-5 extra army buffer)';
  lines.push(`Dice Mode: ${diceModeText}.`);
  if (living.length === 2) {
    lines.push(`1v1 HEADS-UP ENDGAME: Only 2 players remain! Restraint turns off — break every opponent continent bonus and strip their territories to crush their turn income!`);
  }

  // Cards.
  const next = o.cardValues === 'fixed' ? 'fixed 4-10 by set type' : o.cardValues === 'exponential' ? `${nextTradeValue('exponential', 0, view.players.find(p => p.id === me)?.tradesMade ?? 0)} armies (your personal exponential sequence)` : `${tradeBonus(view.tradeCount)} armies (progressive, ${view.tradeCount} sets traded so far)`;
  const sets = view.legal?.tradeableSets.length ?? 0;
  const oppCards = living
    .filter((p) => p.id !== me)
    .map((p) => `${p.name} ${p.cardCount}${p.cardCount >= 4 ? ' (forced trade soon)' : p.cardCount >= 3 ? ' (can hold a set)' : ''}`)
    .join(', ');
  lines.push(`Next card set is worth ${next}. You hold ${meP?.cardCount ?? 0} cards${sets ? ` (${sets} tradeable set${sets > 1 ? 's' : ''})` : ''}.${o.fogOfWar && oppCards ? ` Opponent card counts (public under fog): ${oppCards}.` : ''}`);
  lines.push(...cardMath(view, me), ...eliminationScouting(view, me, true));

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

  const dominantLeader = rivals.find(
    (r) =>
      (r.armyCount !== null && (meP?.armyCount ?? 0) > 0 && r.armyCount >= (meP?.armyCount ?? 0) * 1.8 && r.armyCount >= 30) ||
      ((r.income?.total ?? 0) >= (meP?.income?.total ?? 0) * 2 && (r.income?.total ?? 0) >= 10),
  );
  if (dominantLeader) {
    lines.push(
      `DOMINANT RUNAWAY LEADER: ${dominantLeader.name} is snowballing (${q(dominantLeader.armyCount)} armies, income ${q(dominantLeader.income?.total)}/turn). Solo attacks against them are suicidal! Use chat to organize multi-player coalitions or coordinate joint attacks. If a 1st-place win is currently unachievable, play for 2nd/3rd place placement points to protect your Elo rather than triggering a fatal counter-strike.`
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

    // Cap run feasibility: can our strike stack sweep all remaining enemy capitals this turn for an instant win?
    const enemyCaps = Object.entries(view.capitals ?? {}).filter(([pid, t]) => pid !== me && ts(t) && !ts(t).hidden && ts(t).owner !== me);
    const unheldCaps = total - (mine && ts(mine)?.owner === me ? 1 : 0);
    if (enemyCaps.length > 0 && enemyCaps.length === unheldCaps) {
      const totalCapArmies = enemyCaps.reduce((sum, [, t]) => sum + ts(t).armies, 0);
      const myTerrs = map.territoryIds.filter((t) => ts(t)?.owner === me);
      const myBiggestStack = Math.max(1, ...myTerrs.map((t) => ts(t)?.armies ?? 1));
      const myIncome = meP?.income?.total ?? 0;
      const myStrikePool = myBiggestStack + (view.phase === 'reinforce' ? myIncome : 0) - 1;
      const effectiveCapAttack = Math.max(1, myStrikePool - enemyCaps.length);
      const capOdds = blitzOdds(effectiveCapAttack, totalCapArmies, 3);
      const pCapRun = o.balancedBlitz ? capOdds.balancedWin : capOdds.win;
      const capPct = Math.round(pCapRun * 100);
      if (capPct >= 70) {
        lines.push(`CAP RUN AVAILABLE: Instant game victory viable! ${capPct}% Blitz odds to conquer all ${enemyCaps.length} remaining enemy capitals (${totalCapArmies} total armies defending with 3 dice) in one sweep! Route through all capitals now!`);
      } else {
        lines.push(`Cap run feasibility: only ${capPct}% Blitz odds to take all ${enemyCaps.length} remaining capitals (${totalCapArmies} armies defending with 3 dice). DO NOT pick capitals as your advantage path in early/mid game — hold your doorway choke point capital defensively (+2 armies/turn) and play bonuses or kills.`);
      }
    }
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

  // Geographic viability & attractive bonuses: evaluated by troop concentration, choke points, and early game ease.
  const viable = map.continents
    .map((c) => {
      const cells = c.territories.filter((t) => !blizzards.has(t));
      const inside = new Set(cells);
      const mineHere = cells.filter((t) => mineSet.has(t));
      const missing = cells.filter((t) => !mineSet.has(t));
      if (cells.length === 0 || missing.length === 0) return null;

      const entries = cells.filter((t) => map.adjacency[t].some((n) => !inside.has(n) && !blizzards.has(n))).length;

      const adjacentToCont = new Set<string>();
      for (const t of cells) {
        for (const n of map.adjacency[t]) {
          if (!inside.has(n) && mineSet.has(n) && !blizzards.has(n)) {
            adjacentToCont.add(n);
          }
        }
      }
      const myArmiesInside = mineHere.reduce((sum, t) => sum + (ts(t)?.armies ?? 0), 0);
      const myArmiesAdjacent = [...adjacentToCont].reduce((sum, t) => sum + (ts(t)?.armies ?? 0), 0);
      const localTroopStrength = myArmiesInside + myArmiesAdjacent;
      const enemyArmiesToClear = missing.reduce((sum, t) => sum + (visible(t) ? (ts(t)?.armies ?? 0) : 1), 0);

      const chokeScore = entries <= 1 ? 25 : entries === 2 ? 12 : entries === 3 ? 0 : -15 * (entries - 2);
      const isEarly = view.round <= 3;
      const sizeBonus = isEarly ? (cells.length <= 4 ? 20 : cells.length <= 6 ? 5 : -25) : 0;
      const completionRatio = mineHere.length / cells.length;
      const forceAdvantage = Math.min(25, (localTroopStrength - enemyArmiesToClear) * 2);

      const score = Math.round(
        completionRatio * 35 +
        forceAdvantage +
        chokeScore +
        sizeBonus -
        missing.length * 4 -
        enemyArmiesToClear * 1.5 +
        c.bonus * 3,
      );

      let verdict = 'MODERATE';
      if (entries <= 1 && missing.length <= 3) {
        verdict = 'PRIME EARLY TARGET (1 chokepoint defense, high ROI)';
      } else if (entries <= 2 && missing.length <= 3) {
        verdict = 'HIGHLY ATTRACTIVE (2 chokepoint defense, quick to secure)';
      } else if (entries >= 4 && isEarly) {
        verdict = 'EARLY GAME SPRAWL TRAP (too many open borders, do not pursue on turns 1-4)';
      } else if (score >= 40) {
        verdict = 'VIABLE ADVANTAGE TARGET';
      } else if (score < 0) {
        verdict = 'DIFFICULT / UNFAVORABLE';
      }

      return { c, cells, mineHere, missing, entries, localTroopStrength, enemyArmiesToClear, score, verdict };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (viable.length > 0) {
    lines.push('Geographic viability of bonuses (evaluated by starting troops, chokepoints, and holdability):');
    for (const v of viable) {
      lines.push(
        `- ${label(v.c.name, v.c.id)} bonus +${v.c.bonus}: hold ${v.mineHere.length}/${v.cells.length} (missing ${v.missing.length}, ~${v.enemyArmiesToClear} armies to clear) | Your local strength: ${v.localTroopStrength} armies | Chokepoints: ${v.entries} border${v.entries === 1 ? '' : 's'} | Viability Score: ${v.score} -> VERDICT: ${v.verdict}`,
      );
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
