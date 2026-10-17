import { blitzOdds, describeOptions, fixedSetValue, getMap, visibleTerritories, type GameEvent, type GameView } from '@risk/engine';

/** The player whose capital this territory is (capitals the viewer can see), if any. */
function capitalOwnerOf(view: GameView, t: string): string | undefined {
  return Object.entries(view.capitals ?? {}).find(([, ct]) => ct === t)?.[0];
}

/**
 * One neighbour as listed next to a territory: `id(owner armies)`, `*` when the owner differs, and a
 * CAPITAL tag so a weakly held capital next door is never mistaken for an ordinary territory.
 */
function formatNeighbour(view: GameView, n: string, ownerOfT: string | null, name: (id: string | null | undefined) => string): string {
  const ns = view.territories[n];
  if (ns.hidden) return `${n}?(fog)`;
  if (view.blizzards?.includes(n)) return `${n}(blizzard)`;
  const cap = capitalOwnerOf(view, n);
  return `${n}${ns.owner === ownerOfT ? '' : '*'}(${short(name(ns.owner))} ${ns.armies}${cap ? `, CAPITAL of ${short(name(cap))}` : ''})`;
}

/** A compact, LLM-friendly text rendering of the game as seen by one player. */
export function formatState(view: GameView, gameName?: string): string {
  const name = (id: string | null | undefined) => view.players.find((p) => p.id === id)?.name ?? id ?? 'none';
  const me = view.players.find((p) => p.id === view.you);
  const map = getMap(view.options.map);
  const lines: string[] = [];

  lines.push(
    `Game ${view.id}${gameName ? ` "${gameName}"` : ''} · map: ${map.name} · phase: ${view.phase} · turn ${view.turnNumber} (round ${view.round}) · version ${view.version}`,
  );
  if (view.phase === 'lobby') {
    lines.push(
      `Players (${view.players.length}/${view.options.maxPlayers}): ${view.players
        .map((p) => `${p.name}${p.id === view.you ? ' (you)' : ''}${p.isBot ? ' [bot]' : ''}`)
        .join(', ')}`,
    );
    lines.push('Settings:', ...describeOptions(view.options, view.tradeCount).map((l) => `  ${l}`));
    lines.push('Waiting in lobby. The host must start the game.');
    return lines.join('\n');
  }
  if (view.phase === 'finished') lines.push(`GAME OVER — winner: ${name(view.winner)}`);
  else lines.push(`Current player: ${name(view.currentPlayer)}${view.currentPlayer === view.you ? ' (YOU)' : ''}`);

  lines.push('');
  lines.push('Players:');
  for (const p of view.players) {
    const tag = [p.id === view.you ? 'YOU' : null, p.isBot ? 'bot' : null, p.isNeutral ? 'neutral' : null, !p.alive ? 'ELIMINATED' : null]
      .filter(Boolean)
      .join(', ');
    const conts = p.continents.length ? ` holds ${p.continents.join(', ')}` : '';
    lines.push(`  ${p.name} (${p.id})${tag ? ` [${tag}]` : ''}: ${p.territoryCount ?? '?'} territories, ${p.armyCount ?? '?'} armies, ${p.cardCount ?? '?'} cards${p.armyCount === null ? ' (hidden by fog)' : ''}${p.income && p.alive ? `, +${p.income.total}/turn` : ''}${conts}`);
  }
  if (me) {
    lines.push('');
    if (me.cards && me.cards.length) {
      lines.push(`Your cards: ${me.cards.map((c) => `#${c.id} ${c.kind}${c.territory ? ` (${c.territory})` : ''}`).join(', ')}`);
    } else {
      lines.push('Your cards: none');
    }
    if (me.armiesToPlace > 0) lines.push(`Armies to place: ${me.armiesToPlace}`);
  }

  // Every viewer (players and spectators) gets the full rule set this game is played with.
  lines.push('');
  lines.push('Settings:', ...describeOptions(view.options, view.tradeCount).map((l) => `  ${l}`));
  if (view.blizzards?.length) lines.push(`  Frozen territories: ${view.blizzards.join(', ')} (cannot be attacked, entered or crossed)`);

  lines.push('');
  lines.push('Territories (owner armies) with neighbours:');
  for (const c of map.continents) {
    const owner = view.continentOwners[c.id];
    lines.push(`${c.name.toUpperCase()} (+${c.bonus})${owner ? ` — controlled by ${name(owner)}` : ''}`);
    for (const t of c.territories) {
      const ts = view.territories[t];
      if (ts.hidden) {
        lines.push(`  ${t}: ? (fog)`);
        continue;
      }
      if (view.blizzards?.includes(t)) {
        lines.push(`  ${t}: BLIZZARD (impassable)`);
        continue;
      }
      const cap = capitalOwnerOf(view, t);
      const nbrs = map.adjacency[t].map((n) => formatNeighbour(view, n, ts.owner, name));
      lines.push(`  ${t}: ${short(name(ts.owner))} ${ts.armies}${cap ? ` [CAPITAL of ${short(name(cap))}]` : ''} — ${nbrs.join(', ')}`);
    }
  }
  lines.push('(* marks a neighbour with a different owner)');

  const lm = view.legal;
  lines.push('');
  if (!lm || !lm.yourTurn) {
    lines.push(view.phase === 'finished' ? '' : 'Not your turn. Use wait_for_turn.');
  } else {
    lines.push('YOUR LEGAL MOVES:');
    if (lm.pendingConquest) {
      const pc = lm.pendingConquest;
      lines.push(`  You conquered ${pc.to} from ${pc.from}. You MUST occupy: {"type":"occupy","armies":N} with ${pc.minArmies} <= N <= ${pc.maxArmies}`);
      if (view.options.fogOfWar) lines.push(`  (The board above already shows what ${pc.to} lets you see. Check its neighbours, capitals included, before you choose N: move in more if you will attack on from there.)`);
    } else {
      if (lm.mustTrade) lines.push('  You MUST trade a card set now: {"type":"trade","cardIds":[a,b,c]}');
      if (lm.tradeableSets.length) {
        const cardsById = new Map((me?.cards ?? []).map((c) => [c.id, c]));
        const label = (set: number[]) =>
          view.options.cardValues === 'fixed' ? `[${set.join(',')}]=${fixedSetValue(set.map((id) => cardsById.get(id)!).filter(Boolean))}` : `[${set.join(',')}]`;
        lines.push(`  Tradeable sets (card ids): ${lm.tradeableSets.map(label).join(' ')}`);
      }
      if (lm.capitalChoices?.length) {
        lines.push(`  Choose your capital (it gets +3 armies now, defends with 3 dice and pays +2 a turn): {"type":"choose_capital","territory":"<id>"}, one of: ${lm.capitalChoices.join(', ')}`);
      }
      if (lm.canPlaceOn.length && !lm.mustTrade) {
        const unclaimed = lm.canPlaceOn.some((t) => view.territories[t].owner === null);
        lines.push(
          unclaimed
            ? `  Claim one unclaimed territory: {"type":"place","placements":{"<territory>":1}} — unclaimed: ${lm.canPlaceOn.join(', ')}`
            : `  Place up to ${lm.placeLimit} armies on your territories: {"type":"place","placements":{"<territory>":n,...}} (total <= ${lm.placeLimit})`,
        );
      }
      if (lm.attacks.length) {
        // The chance an all-in blitz takes each target, in the mode this game rolls (balanced or random).
        const balanced = !!view.options.balancedBlitz;
        const chance = (from: string, to: string) => {
          const limit = view.options.capitals && Object.values(view.capitals ?? {}).includes(to) ? 3 : 2;
          const o = blitzOdds(view.territories[from].armies, view.territories[to].armies, limit);
          const p = balanced ? o.balancedWin : o.win;
          return p >= 0.995 ? '99%+' : p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`;
        };
        lines.push(
          `  Attacks available (from -> to, max dice, chance an all-in blitz takes it${balanced ? ', balanced' : ''}): ${lm.attacks
            .map((a) => `${a.from}->${a.to} (${a.maxDice}, ${chance(a.from, a.to)})`)
            .join('; ')}`,
        );
        if (view.options.fogOfWar)
          lines.push('    Blitz by default: {"type":"attack","from":"..","to":"..","blitz":true} fights the whole battle in ONE call. Fog of war is ON, so leave out "occupy": a conquest reveals the territories beyond it, and you then choose how many armies to move in knowing what is there (a weak capital next door, a big stack about to hit back).');
        else
          lines.push('    Blitz by default: {"type":"attack","from":"..","to":"..","blitz":true,"occupy":"max"} fights the whole battle in ONE call (rolls until the territory falls or you run down to 1 army).');
        lines.push('    To risk only part of a stack, add "stopAt":N (blitz implied): it rolls in ONE call but stops once the attacking stack is down to N, so N always stay home. Use it instead of single rolls; rolling one at a time is slow for everyone watching and costs you a call per roll. "occupy" may be a number, "min" or "max" ("max" with stopAt moves in everything above N).');
        if (view.options.balancedBlitz)
          lines.push('    Balanced blitz is ON: a blitz lands near the expected odds (a strong attack almost never collapses), while single rolls are pure luck. Blitz when you have the numbers.');
      }
      if (lm.canEndAttack) lines.push('  {"type":"end_attack"} to move to fortify phase');
      if (lm.fortifies.length) {
        const byFrom = new Map<string, string[]>();
        for (const f of lm.fortifies) byFrom.set(f.from, [...(byFrom.get(f.from) ?? []), `${f.to}`]);
        const summary = [...byFrom.entries()]
          .map(([from, tos]) => `${from} (max ${lm.fortifies.find((f) => f.from === from)!.maxArmies}) -> ${tos.join('/')}`)
          .join('; ');
        lines.push(`  Fortify options: ${summary}`);
        lines.push('    {"type":"fortify","from":"..","to":"..","armies":n}  (ends your turn)');
      }
      if (lm.canEndTurn) lines.push('  {"type":"end_turn"}');
    }
  }
  return lines.join('\n').replace(/\n\n\n+/g, '\n\n');
}

function short(n: string): string {
  return n.length > 14 ? n.slice(0, 13) + '…' : n;
}

export function formatEvents(events: GameEvent[], view: GameView): string {
  const name = (id: string | null) => view.players.find((p) => p.id === id)?.name ?? id ?? '?';
  const byId = getMap(view.options.map).territoryById;
  const t = (id: string) => byId[id]?.name ?? id;
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'game_started':
        out.push(`Game started. Turn order: ${e.turnOrder.map(name).join(' -> ')}`);
        break;
      case 'turn_started':
        if (e.reinforcements.hidden) {
          out.push(`Turn ${e.turnNumber}: ${name(e.player)}'s turn (reinforcements hidden by fog)`);
          break;
        }
        out.push(`Turn ${e.turnNumber}: ${name(e.player)} gets ${e.reinforcements.total} armies${e.reinforcements.fromTurnOrder ? ` (incl. ${e.reinforcements.fromTurnOrder} round-1 late-turn bonus)` : ''}`);
        break;
      case 'placed':
        out.push(`${name(e.player)} placed ${e.armies} on ${t(e.territory)}`);
        break;
      case 'traded':
        out.push(`${name(e.player)} ${e.auto ? 'auto-traded (5+ cards)' : 'traded cards'} for ${e.armies} armies${e.bonusTerritory ? ` (+2 on ${t(e.bonusTerritory)})` : ''}`);
        break;
      case 'battle':
        out.push(
          `${name(e.attacker)} ${t(e.from)} [${e.attackerDice.join(',')}] vs ${name(e.defender)} ${t(e.to)} [${e.defenderDice.join(',')}]: attacker -${e.attackerLosses}, defender -${e.defenderLosses} (now ${e.fromArmies} vs ${e.toArmies})`,
        );
        break;
      case 'conquered':
        out.push(`${name(e.player)} conquered ${t(e.to)} from ${name(e.previousOwner)}`);
        break;
      case 'moved':
        out.push(`${name(e.player)} moved ${e.armies} armies ${t(e.from)} -> ${t(e.to)}`);
        break;
      case 'card_drawn':
        out.push(`${name(e.player)} drew a card`);
        break;
      case 'cards_taken':
        out.push(`${name(e.player)} took ${e.count} cards from ${name(e.from)}`);
        break;
      case 'eliminated':
        out.push(e.by ? `${name(e.player)} was eliminated by ${name(e.by)}` : `${name(e.player)} surrendered`);
        break;
      case 'blizzards':
        out.push(`Blizzards froze ${e.territories.map(t).join(', ')} (impassable all game)`);
        break;
      case 'capital_chosen':
        out.push(e.auto ? `${name(e.player)}'s capital is ${t(e.territory)} (+${e.armies} armies there)` : `${name(e.player)} chose ${t(e.territory)} as their capital (+${e.armies} armies there)`);
        break;
      case 'capitals_assigned':
        out.push(`Capitals: ${Object.entries(e.capitals).map(([p, t]) => `${name(p)} -> ${t}`).join(', ')}`);
        break;
      case 'capital_captured':
        out.push(`${name(e.player)} captured the capital ${t(e.territory)} from ${name(e.previousOwner)}`);
        break;
      case 'fogged':
        out.push(`(something happened in the fog: ${e.kind})`);
        break;
      case 'turn_ended':
        out.push(`${name(e.player)} ended their turn`);
        break;
      case 'phase':
        break;
      case 'game_over':
        out.push(`GAME OVER: ${name(e.winner)} wins${e.reason === 'capitals' ? ' by holding every capital' : ''}`);
        break;
    }
  }
  return out.join('\n');
}

/**
 * Under fog of war: territories the viewer can see only because of a conquest in these events, i.e. that
 * were fogged before. Recomputed from the view by handing the conquered territories back to their
 * previous owners, so it needs no earlier snapshot.
 */
export function revealedByConquests(events: GameEvent[], view: GameView): string[] {
  if (!view.options.fogOfWar || !view.you) return [];
  const conquests = events.filter((e): e is Extract<GameEvent, { type: 'conquered' }> => e.type === 'conquered' && e.player === view.you);
  if (conquests.length === 0) return [];
  const map = getMap(view.options.map);
  const now = visibleTerritories(view.territories, view.you, map);
  const before: Record<string, { owner: string | null }> = { ...view.territories };
  for (const c of conquests) before[c.to] = { owner: c.previousOwner };
  const was = visibleTerritories(before, view.you, map);
  // Blizzards are public under fog, so a conquest never reveals one.
  return map.territoryIds.filter((t) => now.has(t) && !was.has(t) && !view.blizzards?.includes(t));
}

/** Territories an event touches (placements, battles, conquests, moves, capitals). */
function touchedTerritories(events: GameEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === 'placed' || e.type === 'capital_chosen' || e.type === 'capital_captured') out.add(e.territory);
    else if (e.type === 'battle' || e.type === 'conquered' || e.type === 'moved') (out.add(e.from), out.add(e.to));
    else if (e.type === 'traded' && e.bonusTerritory) out.add(e.bonusTerritory);
  }
  return [...out];
}

/**
 * The reply to one of your own actions: what happened, only the territories it touched (with their
 * neighbours, so you can keep attacking from a fresh conquest), your armies/cards and your next legal
 * moves. Other players do not act during your turn (except that someone may surrender), so the rest of the
 * board is not resent; the full board comes with get_state / wait_for_turn (or act with full:true).
 */
export function formatActResult(events: GameEvent[], view: GameView): string {
  const full = formatState(view);
  const lines: string[] = [];
  const ev = formatEvents(events, view);
  lines.push(`OK.${ev ? `\nEvents:\n${ev}` : ''}`);
  if (view.phase === 'finished' || view.currentPlayer !== view.you) {
    // Turn over (or game over): hand back the whole picture, the next decision needs it.
    lines.push('', full);
    return lines.join('\n');
  }
  const name = (id: string | null | undefined) => view.players.find((p) => p.id === id)?.name ?? id ?? 'none';
  const map = getMap(view.options.map);
  const touched = touchedTerritories(events);
  const me = view.players.find((p) => p.id === view.you);
  lines.push('');
  lines.push(`Phase: ${view.phase} · version ${view.version}${me ? ` · you hold ${me.territoryCount} territories, ${me.armyCount} armies, ${me.cardCount} cards, +${me.income?.total ?? 0}/turn` : ''}`);
  if (me?.continents.length) lines.push(`Your continents: ${me.continents.join(', ')}`);
  // Cards change on conquests, trades and eliminations; the ids alone are not enough to pick a set.
  if (me?.cards?.length) lines.push(`Your cards: ${me.cards.map((c) => `#${c.id} ${c.kind}${c.territory ? ` (${c.territory})` : ''}`).join(', ')}`);
  if (me?.armiesToPlace) lines.push(`Armies to place: ${me.armiesToPlace}`);
  if (touched.length) {
    lines.push('Changed territories (owner armies) with neighbours:');
    for (const t of touched) {
      const ts = view.territories[t];
      if (!ts || ts.hidden) continue;
      const cap = capitalOwnerOf(view, t);
      const nbrs = map.adjacency[t].map((n) => formatNeighbour(view, n, ts.owner, name));
      lines.push(`  ${t}: ${short(name(ts.owner))} ${ts.armies}${cap ? ` [CAPITAL of ${short(name(cap))}]` : ''} — ${nbrs.join(', ')}`);
    }
  }
  const revealed = revealedByConquests(events, view);
  if (revealed.length) {
    lines.push(`Revealed by your conquest (was fogged): ${revealed.map((n) => formatNeighbour(view, n, view.you, name)).join(', ')}`);
  }
  const legal = full.indexOf('\nYOUR LEGAL MOVES:');
  if (legal >= 0) lines.push(full.slice(legal));
  lines.push('', '(Only what your action changed is shown; the rest of the board is as in your last get_state unless someone surrendered. Pass "full":true to act, or call get_state, for the whole board.)');
  return lines.join('\n');
}
