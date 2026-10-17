import { useEffect, useRef } from 'react';
import type { GameEvent, GameView } from '@risk/engine';
import type { EventBatch } from '../useGame';
import { getMap } from '@risk/engine';
import { territoryName } from './Map';

export function describe(e: GameEvent, view: GameView): string | null {
  const name = (id: string | null) => view.players.find((p) => p.id === id)?.name ?? id ?? '?';
  const map = getMap(view.options.map);
  const shortName = (id: string) => territoryName(map, id);
  switch (e.type) {
    case 'game_started':
      return `Game started. Turn order: ${e.turnOrder.map(name).join(' → ')}`;
    case 'turn_started': {
      const r = e.reinforcements;
      const cont = r.continents.length ? ` + ${r.continents.map((c) => `${c.id.replace('_', ' ')} ${c.bonus}`).join(', ')}` : '';
      const caps = r.fromCapitals ? ` + ${r.fromCapitals} for ${r.capitals} capital${r.capitals === 1 ? '' : 's'}` : '';
      return `Turn ${e.turnNumber}: ${name(e.player)} receives ${r.total} armies (${r.fromTerritories} for ${r.territories} territories${cont}${caps})`;
    }
    case 'placed':
      return `${name(e.player)} placed ${e.armies} on ${shortName(e.territory)}`;
    case 'traded': {
      const cards = (e.cards ?? []).map((c) => (c.kind === 'wild' ? 'Wild' : `${c.kind} ${c.territory ? shortName(c.territory) : ''}`.trim())).join(', ');
      return `${name(e.player)} traded ${cards || 'a card set'} for ${e.armies} armies${e.bonusTerritory ? ` (+2 on ${shortName(e.bonusTerritory)})` : ''}`;
    }
    case 'blizzards':
      return `❄ Blizzards: ${e.territories.map(shortName).join(', ')} are impassable`;
    case 'capital_chosen':
      return `★ ${name(e.player)} chose ${shortName(e.territory)} as their capital (+${e.armies})`;
    case 'capitals_assigned':
      return `Capitals: ${Object.entries(e.capitals).map(([p, t]) => `${name(p)} → ${shortName(t)}`).join(', ')}`;
    case 'capital_captured':
      return `★ ${name(e.player)} captured the capital ${shortName(e.territory)} from ${name(e.previousOwner)}`;
    case 'fogged':
      return `… something happened in the fog (${e.kind.replace('_', ' ')})`;
    case 'battle':
      return `${name(e.attacker)} ${shortName(e.from)} [${e.attackerDice.join(' ')}] vs ${name(e.defender)} ${shortName(e.to)} [${e.defenderDice.join(' ')}] → att −${e.attackerLosses}, def −${e.defenderLosses}`;
    case 'conquered':
      return `⚑ ${name(e.player)} conquered ${shortName(e.to)} from ${name(e.previousOwner)}`;
    case 'moved':
      return `${name(e.player)} moved ${e.armies} from ${shortName(e.from)} to ${shortName(e.to)}`;
    case 'card_drawn':
      return `${name(e.player)} drew a card`;
    case 'cards_taken':
      return `${name(e.player)} took ${e.count} card(s) from ${name(e.from)}`;
    case 'eliminated':
      return e.by ? `☠ ${name(e.player)} was eliminated by ${name(e.by)}` : `☠ ${name(e.player)} surrendered`;
    case 'turn_ended':
      return null;
    case 'phase':
      return null;
    case 'game_over':
      return e.reason === 'capitals' ? `🏆 ${name(e.winner)} holds every capital and wins the game!` : `🏆 ${name(e.winner)} wins the game!`;
  }
}

export function Log({ batches, view }: { batches: EventBatch[]; view: GameView }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [batches.length]);
  const lines = batches.flatMap((b) => b.events.map((e, i) => ({ key: `${b.id}-${i}`, text: describe(e, view), e }))).filter((l) => l.text);
  return (
    <div className="log" ref={ref}>
      {lines.length === 0 && <div className="muted small">The log will appear here.</div>}
      {lines.map((l) => (
        <div key={l.key} className={`log-line ${l.e.type}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
