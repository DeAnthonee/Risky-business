import { ADJACENCY, CONTINENTS, TERRITORY_BY_ID, type GameEvent, type GameView } from '@risk/engine';

/** A compact, LLM-friendly text rendering of the game as seen by one player. */
export function formatState(view: GameView, gameName?: string): string {
  const name = (id: string | null | undefined) => view.players.find((p) => p.id === id)?.name ?? id ?? 'none';
  const me = view.players.find((p) => p.id === view.you);
  const lines: string[] = [];

  lines.push(
    `Game ${view.id}${gameName ? ` "${gameName}"` : ''} · phase: ${view.phase} · turn ${view.turnNumber} (round ${view.round}) · version ${view.version}`,
  );
  if (view.phase === 'lobby') {
    lines.push(`Players (${view.players.length}/${view.options.maxPlayers}): ${view.players.map((p) => `${p.name}${p.isBot ? ' [bot]' : ''}`).join(', ')}`);
    lines.push(`Options: ${JSON.stringify(view.options)}`);
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
    lines.push(`  ${p.name} (${p.id})${tag ? ` [${tag}]` : ''}: ${p.territoryCount} territories, ${p.armyCount} armies, ${p.cardCount} cards${conts}`);
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

  lines.push('');
  lines.push('Territories (owner armies) with neighbours:');
  for (const c of CONTINENTS) {
    const owner = view.continentOwners[c.id];
    lines.push(`${c.name.toUpperCase()} (+${c.bonus})${owner ? ` — controlled by ${name(owner)}` : ''}`);
    for (const t of c.territories) {
      const ts = view.territories[t];
      const nbrs = ADJACENCY[t].map((n) => {
        const ns = view.territories[n];
        const mark = ns.owner === ts.owner ? '' : '*';
        return `${n}${mark}(${short(name(ns.owner))} ${ns.armies})`;
      });
      lines.push(`  ${t}: ${short(name(ts.owner))} ${ts.armies} — ${nbrs.join(', ')}`);
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
    } else {
      if (lm.mustTrade) lines.push('  You MUST trade a card set now: {"type":"trade","cardIds":[a,b,c]}');
      if (lm.tradeableSets.length) lines.push(`  Tradeable sets (card ids): ${lm.tradeableSets.map((s) => `[${s.join(',')}]`).join(' ')}`);
      if (lm.canPlaceOn.length && !lm.mustTrade) {
        const unclaimed = lm.canPlaceOn.some((t) => view.territories[t].owner === null);
        lines.push(
          unclaimed
            ? `  Claim one unclaimed territory: {"type":"place","placements":{"<territory>":1}} — unclaimed: ${lm.canPlaceOn.join(', ')}`
            : `  Place up to ${lm.placeLimit} armies on your territories: {"type":"place","placements":{"<territory>":n,...}} (total <= ${lm.placeLimit})`,
        );
      }
      if (lm.attacks.length) {
        lines.push(`  Attacks available (from -> to, max dice): ${lm.attacks.map((a) => `${a.from}->${a.to} (${a.maxDice})`).join('; ')}`);
        lines.push('    {"type":"attack","from":"..","to":"..","blitz":true,"occupy":"max"}  (or "dice":1-3 for a single roll; "occupy" may be a number, "min" or "max")');
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
  const t = (id: string) => TERRITORY_BY_ID[id]?.name ?? id;
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'game_started':
        out.push(`Game started. Turn order: ${e.turnOrder.map(name).join(' -> ')}`);
        break;
      case 'turn_started':
        out.push(`Turn ${e.turnNumber}: ${name(e.player)} gets ${e.reinforcements.total} armies`);
        break;
      case 'placed':
        out.push(`${name(e.player)} placed ${e.armies} on ${t(e.territory)}`);
        break;
      case 'traded':
        out.push(`${name(e.player)} traded cards for ${e.armies} armies${e.bonusTerritory ? ` (+2 on ${t(e.bonusTerritory)})` : ''}`);
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
      case 'turn_ended':
        out.push(`${name(e.player)} ended their turn`);
        break;
      case 'phase':
        break;
      case 'game_over':
        out.push(`GAME OVER: ${name(e.winner)} wins`);
        break;
    }
  }
  return out.join('\n');
}
