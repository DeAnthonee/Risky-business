import type { Card } from '@risk/engine';
import { getMap } from '@risk/engine';
import { territoryName } from './Map';

export const CARD_ICON: Record<Card['kind'], string> = { infantry: '🪖', cavalry: '🐎', artillery: '💣', wild: '🃏' };

/** One card animation, shown in a panel over the bottom of the board. */
export type CardFx =
  | { id: number; kind: 'draw'; player: string; color: string; card: Card | null }
  | { id: number; kind: 'trade'; player: string; color: string; cards: Card[]; armies: number; bonusTerritory: string | null; auto?: boolean }
  | { id: number; kind: 'taken'; player: string; from: string; color: string; fromColor: string; count: number };

/** How long each animation stays up, in ms (the CSS keyframes are timed to fit). */
export const CARD_FX_MS: Record<CardFx['kind'], number> = { draw: 1700, trade: 2600, taken: 1900 };

function MiniCard({ card, color, className, style }: { card: Card | null; color: string; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`fx-card ${card ? card.kind : 'back'} ${className ?? ''}`} style={{ ...style, borderColor: color }}>
      {card ? (
        <>
          <div className="fx-card-icon">{CARD_ICON[card.kind]}</div>
          <div className="fx-card-kind">{card.kind}</div>
        </>
      ) : (
        <div className="fx-card-backmark">★</div>
      )}
    </div>
  );
}

export function CardFxPanel({ fx, names, mapId }: { fx: CardFx; names: Record<string, string>; mapId: string }) {
  const map = getMap(mapId);
  const shortName = (id: string) => territoryName(map, id);
  const who = (id: string) => names[id] ?? id;

  if (fx.kind === 'draw') {
    return (
      <div className="card-fx draw" key={fx.id} style={{ borderColor: fx.color }}>
        <div className="fx-stage">
          <MiniCard card={fx.card} color={fx.color} className="fx-deal" />
        </div>
        <div className="fx-caption">
          <strong style={{ color: fx.color }}>{who(fx.player)}</strong> earned a card
          {fx.card?.territory && <span className="muted"> · {shortName(fx.card.territory)}</span>}
        </div>
      </div>
    );
  }

  if (fx.kind === 'trade') {
    return (
      <div className="card-fx trade" key={fx.id} style={{ borderColor: fx.color }}>
        <div className="fx-stage">
          {fx.cards.map((c, i) => (
            <MiniCard key={c.id} card={c} color={fx.color} className={`fx-fan fx-fan-${i}`} />
          ))}
          <div className="fx-burst" style={{ color: fx.color }}>
            +{fx.armies}
          </div>
        </div>
        <div className="fx-caption">
          <strong style={{ color: fx.color }}>{who(fx.player)}</strong> {fx.auto ? 'auto-traded (5+ cards)' : 'traded in a set'} for <strong>{fx.armies}</strong> armies
          {fx.bonusTerritory && <span className="muted"> · +2 on {shortName(fx.bonusTerritory)}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="card-fx taken" key={fx.id} style={{ borderColor: fx.color }}>
      <div className="fx-stage">
        {Array.from({ length: Math.min(fx.count, 6) }, (_, i) => (
          <MiniCard key={i} card={null} color={fx.fromColor} className="fx-steal" style={{ animationDelay: `${i * 90}ms`, left: `calc(50% - 22px + ${(i - (Math.min(fx.count, 6) - 1) / 2) * 14}px)` }} />
        ))}
      </div>
      <div className="fx-caption">
        <strong style={{ color: fx.color }}>{who(fx.player)}</strong> took {fx.count} card{fx.count === 1 ? '' : 's'} from{' '}
        <strong style={{ color: fx.fromColor }}>{who(fx.from)}</strong>
      </div>
    </div>
  );
}
