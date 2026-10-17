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
}

export function playerScores(view: GameView): PlayerScore[] {
  const players = view.players.filter((p) => p.alive && !p.isNeutral);
  const raw = players.map((p) => ({ armies: p.armyCount, territories: p.territoryCount, income: p.income?.total ?? 0 }));
  const sum = (k: PartKey) => raw.reduce((n, r) => n + r[k], 0) || 1;
  const totals = { armies: sum('armies'), territories: sum('territories'), income: sum('income') };
  return players
    .map((p, i) => {
      const points = {
        armies: (raw[i].armies / totals.armies) * SCORE_WEIGHTS.armies * 100,
        territories: (raw[i].territories / totals.territories) * SCORE_WEIGHTS.territories * 100,
        income: (raw[i].income / totals.income) * SCORE_WEIGHTS.income * 100,
      };
      return { id: p.id, name: p.name, color: p.color, raw: raw[i], points, total: points.armies + points.territories + points.income };
    })
    .sort((a, b) => b.total - a.total);
}

export function ScoreChart({ view }: { view: GameView }) {
  const [hover, setHover] = useState<string | null>(null);
  const scores = playerScores(view);
  if (scores.length === 0) return <div className="muted small">No players yet.</div>;
  const max = Math.max(...scores.map((s) => s.total), 1);
  return (
    <div className="score-chart" role="figure" aria-label="Who is winning: weighted share of armies, territories and income">
      <div className="score-legend" aria-hidden="true">
        {PARTS.map((p) => (
          <span key={p.key} className="score-legend-item">
            <span className="score-swatch" style={{ opacity: p.opacity }} />
            {p.label} {Math.round(SCORE_WEIGHTS[p.key] * 100)}%
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
                  {s.raw.armies} armies ({s.points.armies.toFixed(1)} pts) · {s.raw.territories} territories ({s.points.territories.toFixed(1)} pts) · +{s.raw.income}/turn (
                  {s.points.income.toFixed(1)} pts)
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="muted small score-note">Power = 40% share of armies + 30% of territories + 30% of income. Bars add up to 100%.</div>
    </div>
  );
}
