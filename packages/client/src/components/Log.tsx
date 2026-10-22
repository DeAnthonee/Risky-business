import { useEffect, useRef } from 'react';
import type { GameEvent, GameView } from '@risk/engine';
import type { EventBatch } from '../useGame';
import { getMap } from '@risk/engine';
import { territoryName } from './Map';
import { logItems, type BattleSummary } from '../logLines';

export function describe(e: GameEvent, view: GameView): string | null {
  const name = (id: string | null) => view.players.find((p) => p.id === id)?.name ?? id ?? '?';
  const map = getMap(view.options.map);
  const shortName = (id: string) => territoryName(map, id);
  switch (e.type) {
    case 'game_started':
      return `Game started. Turn order: ${e.turnOrder.map(name).join(' → ')}`;
    case 'turn_started': {
      if (e.reinforcements.hidden) return `Turn ${e.turnNumber}: ${name(e.player)} receives ${e.reinforcements.total} armies (breakdown hidden by fog)`;
      const r = e.reinforcements;
      const cont = r.continents.length ? ` + ${r.continents.map((c) => `${c.id.replace('_', ' ')} ${c.bonus}`).join(', ')}` : '';
      const caps = r.fromCapitals ? ` + ${r.fromCapitals} for ${r.capitals} capital${r.capitals === 1 ? '' : 's'}` : '';
      const late = r.fromTurnOrder ? ` + ${r.fromTurnOrder} late-turn bonus` : '';
      return `Turn ${e.turnNumber}: ${name(e.player)} receives ${r.total} armies (${r.fromTerritories} for ${r.territories} territories${cont}${caps}${late})`;
    }
    case 'placed':
      return `${name(e.player)} placed ${e.armies} on ${shortName(e.territory)}`;
    case 'traded': {
      const cards = (e.cards ?? []).map((c) => (c.kind === 'wild' ? 'Wild' : `${c.kind} ${c.territory ? shortName(c.territory) : ''}`.trim())).join(', ');
      return `${name(e.player)} ${e.auto ? 'auto-traded' : 'traded'} ${cards || 'a card set'} for ${e.armies} armies${e.bonusTerritory ? ` (+2 on ${shortName(e.bonusTerritory)})` : ''}`;
    }
    case 'blizzards':
      return `❄ Blizzards: ${e.territories.map(shortName).join(', ')} are impassable`;
    case 'fog_lifted':
      return `🌫 The fog lifts: no battles for ${e.rounds} round${e.rounds === 1 ? '' : 's'}. Everyone sees the whole board now.`;
    case 'capital_chosen':
      return e.auto ? `★ ${name(e.player)}'s capital is ${shortName(e.territory)} (+${e.armies})` : `★ ${name(e.player)} chose ${shortName(e.territory)} as their capital (+${e.armies})`;
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
    case 'timeout':
      return `⏱ ${name(e.player)} skipped (timeout)`;
    case 'phase':
      return null;
    case 'game_over':
      return e.reason === 'capitals' ? `🏆 ${name(e.winner)} holds every capital and wins the game!` : `🏆 ${name(e.winner)} wins the game!`;
  }
}

function BattleLine({ b, view }: { b: BattleSummary; view: GameView }) {
  const name = (id: string | null) => view.players.find((p) => p.id === id)?.name ?? id ?? '?';
  const map = getMap(view.options.map);
  const t = (id: string) => territoryName(map, id);
  const head = b.conquered
    ? `⚑ ${name(b.attacker)} took ${t(b.to)} from ${name(b.defender)}${b.movedIn !== null ? `, moved ${b.movedIn} in` : ''}`
    : `⚔ ${name(b.attacker)} attacked ${t(b.to)} (${name(b.defender)})${b.fromEnd <= 1 ? ', ran out of armies' : ''}`;
  const side = (label: string, start: number, end: number, lost: number) => (
    <span className="battle-side">
      {label} <b>{start}</b> → <b>{end}</b> <span className="battle-loss">−{lost}</span>
    </span>
  );
  // Every roll stays available on hover.
  const rolls = b.battles.map((e) => `[${e.attackerDice.join(' ')}] vs [${e.defenderDice.join(' ')}] → att −${e.attackerLosses}, def −${e.defenderLosses}`).join('\n');
  return (
    <div className={`log-line battle-summary ${b.conquered ? 'conquered' : 'battle'}`} title={rolls}>
      <div>{head}</div>
      <div className="battle-stats">
        {side(t(b.from), b.fromStart, b.fromEnd, b.attackerLosses)}
        <span className="muted"> vs </span>
        {side(t(b.to), b.toStart, b.toEnd, b.defenderLosses)}
        <span className="muted"> · {b.rolls} roll{b.rolls === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

export function Log({ batches, view }: { batches: EventBatch[]; view: GameView }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = logItems(batches, (e) => describe(e, view) !== null);
  // Scroll on new lines and as a running battle's summary grows.
  const tail = batches.length ? batches[batches.length - 1].id : null;
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [items.length, tail]);
  return (
    <div className="log" ref={ref}>
      {items.length === 0 && <div className="muted small">The log will appear here.</div>}
      {items.map(({ key, e }) =>
        e.type === 'battle_summary' ? (
          <BattleLine key={key} b={e} view={view} />
        ) : e.type === 'fogged_run' ? (
          <div key={key} className="log-line fogged">
            … something happened in the fog ({e.kind.replace('_', ' ')}{e.count > 1 ? ` ×${e.count}` : ''})
          </div>
        ) : (
          <div key={key} className={`log-line ${e.type}`}>
            {describe(e, view)}
          </div>
        ),
      )}
    </div>
  );
}
