import { useState } from 'react';
import { fixedSetValue, isValidSet, tradeBonus, type Card } from '@risk/engine';
import { getMap } from '@risk/engine';
import { territoryName } from './Map';

const ICON: Record<Card['kind'], string> = { infantry: '🪖', cavalry: '🐎', artillery: '💣', wild: '🃏' };

export function CardsPanel({
  cards,
  tradeCount,
  canTrade,
  mustTrade,
  onTrade,
  onClose,
  mapId,
  cardValues = 'progressive',
}: {
  mapId: string;
  cardValues?: 'progressive' | 'fixed';
  cards: Card[];
  tradeCount: number;
  canTrade: boolean;
  mustTrade: boolean;
  onTrade: (ids: number[]) => Promise<void>;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const map = getMap(mapId);
  const shortName = (id: string) => territoryName(map, id);
  const chosen = cards.filter((c) => sel.includes(c.id));
  const valid = chosen.length === 3 && isValidSet(chosen);
  const toggle = (id: number) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? [...s.slice(1), id] : [...s, id]));

  return (
    <div className="modal-backdrop" onClick={mustTrade ? undefined : onClose}>
      <div className="modal cards-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Your cards</h2>
        {mustTrade && <p className="error">You must trade a set before continuing.</p>}
        <p className="muted small">
          Sets: three of a kind, one of each, or two + wild.{' '}
          {cardValues === 'fixed' ? (
            <>
              Fixed values: 🪖🪖🪖 4 · 🐎🐎🐎 6 · 💣💣💣 8 · one of each 10.
              {valid && (
                <>
                  {' '}
                  Selected set: <strong>{fixedSetValue(chosen)}</strong> armies.
                </>
              )}
            </>
          ) : (
            <>
              Next set is worth <strong>{tradeBonus(tradeCount)}</strong> armies.
            </>
          )}
        </p>
        {cards.length === 0 && <p className="muted">No cards yet. Conquer a territory to earn one at the end of your turn.</p>}
        <div className="card-grid">
          {cards.map((c) => (
            <button key={c.id} className={`risk-card ${c.kind} ${sel.includes(c.id) ? 'selected' : ''}`} onClick={() => toggle(c.id)}>
              <div className="card-icon">{ICON[c.kind]}</div>
              <div className="card-kind">{c.kind}</div>
              <div className="card-territory">{c.territory ? shortName(c.territory) : 'Wild'}</div>
            </button>
          ))}
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={!valid || !canTrade}
            onClick={() =>
              onTrade(sel).then(() => {
                setSel([]);
              })
            }
          >
            Trade set
          </button>
          {!mustTrade && <button onClick={onClose}>Close</button>}
          {!canTrade && cards.length >= 3 && <span className="muted small">You can only trade during your reinforce phase.</span>}
        </div>
      </div>
    </div>
  );
}
