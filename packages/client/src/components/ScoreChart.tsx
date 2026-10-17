import { useState } from 'react';
import type { GameView } from '@risk/engine';

/**
 * Who's winning, as a chart. Each living player's "power" is a weighted blend of their share of all
 * armies, territories and income on the board, so the bars add up to 100%.
 */
export const SCORE_WEIGHTS = { armies: 0.4, territories: 0.3, income: 0.3 } as const;
const PARTS = [
  { key: 'armies', label: 'Armies', opacity: 1 },
  { key: 'territories', label: 'Territories', opacity: 0.68 },
  { key: 'income', label: 'Income', opacity: 0.4 },
] as const;
type PartKey = (typeof PARTS)[number]['key'];

export interface PlayerScore {
  id: string;
  name: string;
  color: string;
  raw: Record<PartKey, number>;
  /** Weighted contribution of each part, in percentage points of the whole board. */
  points: Record<PartKey, number>;
  total: number;
  /** Fog of war hides this player's armies and income from the viewer. */
  hidden: boolean;
  /** Cards in hand: public even under fog of war. Not part of the power score. */
  cards: number;
}

/** True when fog of war hides other players' numbers from this viewer (a seated player in a fog game). */
export function scoresFogged(view: GameView): boolean {
  return view.players.some((p) => p.alive && !p.isNeutral && (p.armyCount === null || p.territoryCount === null));
}

/** Weights in use: under fog only territory counts are public, so they carry the whole score. */
export function activeWeights(view: GameView): Record<PartKey, number> {
  return scoresFogged(view) ? { armies: 0, territories: 1, income: 0 } : { ...SCORE_WEIGHTS };
}

export function playerScores(view: GameView): PlayerScore[] {
  const players = view.players.filter((p) => p.alive && !p.isNeutral);
  const weights = activeWeights(view);
  const raw = players.map((p) => ({ armies: p.armyCount ?? 0, territories: p.territoryCount ?? 0, income: p.income?.total ?? 0 }));
  const sum = (k: PartKey) => raw.reduce((n, r) => n + r[k], 0) || 1;
  const totals = { armies: sum('armies'), territories: sum('territories'), income: sum('income') };
  return players
    .map((p, i) => {
      const points = {
        armies: (raw[i].armies / totals.armies) * weights.armies * 100,
        territories: (raw[i].territories / totals.territories) * weights.territories * 100,
        income: (raw[i].income / totals.income) * weights.income * 100,
      };
      return { id: p.id, name: p.name, color: p.color, raw: raw[i], points, total: points.armies + points.territories + points.income, hidden: p.armyCount === null, cards: p.cardCount };
    })
    .sort((a, b) => b.total - a.total);
}

export function ScoreChart({ view }: { view: GameView }) {
  const [hover, setHover] = useState<string | null>(null);
  if (scoresFogged(view)) {
    // No ranking under fog, but card counts are public: list them in turn order.
    const order = view.turnOrder.length ? view.turnOrder : view.players.map((p) => p.id);
    const players = order.map((id) => view.players.find((p) => p.id === id)!).filter((p) => p && p.alive && !p.isNeutral);
    return (
      <div className="score-chart">
        <ul className="score-rows">
          {players.map((p) => (
            <li key={p.id} className={`score-row ${view.currentPlayer === p.id ? 'active' : ''}`}>
              <div className="score-label">
                <span className="swatch" style={{ background: p.color }} />
                <span className="score-name">{p.name}</span>
                <CardBadge count={p.cardCount} />
              </div>
            </li>
          ))}
        </ul>
        <div className="muted small score-note">
          Fog of war: you only know what you can see on the board, so there is no ranking while you play (card counts are
          public). Spectators see the full chart.
        </div>
      </div>
    );
  }
  const scores = playerScores(view);
  if (scores.length === 0) return <div className="muted small">No players yet.</div>;
  const max = Math.max(...scores.map((s) => s.total), 1);
  return (
    <div className="score-chart" role="figure" aria-label="Who is winning: weighted share of armies, territories and income">
      <div className="score-legend" aria-hidden="true">
        {PARTS.map((p) => (
          <span key={p.key} className="score-legend-item">
            <span className="score-swatch" style={{ opacity: p.opacity }} />
            {p.label} {Math.round(activeWeights(view)[p.key] * 100)}%
          </span>
        ))}
      </div>
      <ul className="score-rows">
        {scores.map((s, rank) => (
          <li
            key={s.id}
            className={`score-row ${view.currentPlayer === s.id ? 'active' : ''}`}
            onMouseEnter={() => setHover(s.id)}
            onMouseLeave={() => setHover((h) => (h === s.id ? null : h))}
            onFocus={() => setHover(s.id)}
            onBlur={() => setHover(null)}
            tabIndex={0}
          >
            <div className="score-label">
              <span className="score-rank">{rank + 1}</span>
              <span className="swatch" style={{ background: s.color }} />
              <span className="score-name">{s.name}</span>
              <CardBadge count={s.cards} />
              <span className="score-total">{Math.round(s.total)}%</span>
            </div>
            <div className="score-track">
              {PARTS.map((p) => (
                <span
                  key={p.key}
                  className="score-seg"
                  style={{ width: `${(s.points[p.key] / max) * 100}%`, background: s.color, opacity: p.opacity }}
                />
              ))}
            </div>
            {hover === s.id && (
              <div className="score-tip" role="tooltip">
                <strong>{s.name}</strong> · power {s.total.toFixed(1)}%
                <div>
                  {s.hidden
                    ? `${s.raw.territories} territories · armies and income hidden by fog`
                    : `${s.raw.armies} armies (${s.points.armies.toFixed(1)} pts) · ${s.raw.territories} territories (${s.points.territories.toFixed(1)} pts) · +${s.raw.income}/turn (${s.points.income.toFixed(1)} pts)`}
                </div>
                <div>
                  {s.cards} card{s.cards === 1 ? '' : 's'} in hand
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="muted small score-note">
        {scoresFogged(view)
          ? "Fog of war: other players' armies and income are hidden, so this ranks by share of territories only."
          : 'Power = 40% share of armies + 30% of territories + 30% of income. Bars add up to 100%.'}
      </div>
    </div>
  );
}

/** Cards in hand. Warms up at 3+ (a set is possible) and 4 (one more card forces a trade). */
function CardBadge({ count }: { count: number }) {
  const level = count >= 4 ? ' full' : count >= 3 ? ' ready' : '';
  return (
    <span className={`score-cards${level}`} title={`${count} card${count === 1 ? '' : 's'} in hand`} aria-label={`${count} cards`}>
      <span aria-hidden="true">🂠</span>
      {count}
    </span>
  );
}
