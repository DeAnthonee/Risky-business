import { useMemo } from 'react';
import { CONTINENTS, EDGE_LIST, TERRITORIES, TERRITORY_BY_ID, type ContinentId, type GameView } from '@risk/engine';
import { convexHull } from '../hull';

export type Highlight = 'source' | 'target' | 'place' | 'selected' | 'pending-target';

export interface MoveAnim {
  id: number;
  from: string;
  to: string;
  armies: number;
  color: string;
}

export interface FloatAnim {
  id: number;
  territory: string;
  text: string;
  color: string;
}

export interface MapProps {
  view: GameView;
  highlights: Record<string, Highlight>;
  pendingPlacements: Record<string, number>;
  attackArrow: { from: string; to: string } | null;
  flashes: Record<string, number>;
  moves: MoveAnim[];
  floats: FloatAnim[];
  onTerritoryClick: (id: string, shift: boolean) => void;
  dimOthers: boolean;
}

export const CONTINENT_COLORS: Record<ContinentId, string> = {
  north_america: '#e8b84a',
  south_america: '#e06377',
  europe: '#5b9dff',
  africa: '#f58e4f',
  asia: '#36c9b5',
  australia: '#b48cf2',
};

const CONTINENT_LABELS: Record<ContinentId, { x: number; y: number; anchor: 'start' | 'middle' | 'end' }> = {
  north_america: { x: 20, y: 345, anchor: 'start' },
  south_america: { x: 345, y: 520, anchor: 'start' },
  europe: { x: 596, y: 44, anchor: 'start' },
  africa: { x: 640, y: 440, anchor: 'start' },
  asia: { x: 985, y: 285, anchor: 'end' },
  australia: { x: 985, y: 548, anchor: 'end' },
};

const SHORT_NAMES: Record<string, string> = {
  northwest_territory: 'NW Territory',
  western_united_states: 'Western US',
  eastern_united_states: 'Eastern US',
  central_america: 'C. America',
  great_britain: 'Britain',
  northern_europe: 'N. Europe',
  western_europe: 'W. Europe',
  southern_europe: 'S. Europe',
  north_africa: 'N. Africa',
  east_africa: 'E. Africa',
  south_africa: 'S. Africa',
  middle_east: 'Mid. East',
  western_australia: 'W. Australia',
  eastern_australia: 'E. Australia',
};

export function shortName(id: string): string {
  return SHORT_NAMES[id] ?? TERRITORY_BY_ID[id]?.name ?? id;
}

export function GameMap(props: MapProps) {
  const { view, highlights, pendingPlacements, attackArrow, flashes, moves, floats, onTerritoryClick, dimOthers } = props;
  const colorOf = (pid: string | null) => view.players.find((p) => p.id === pid)?.color ?? '#555';

  const hulls = useMemo(
    () =>
      CONTINENTS.map((c) => {
        const pts = c.territories.map((t) => ({ x: TERRITORY_BY_ID[t].x, y: TERRITORY_BY_ID[t].y }));
        return { id: c.id, name: c.name, bonus: c.bonus, points: convexHull(pts).map((p) => `${p.x},${p.y}`).join(' ') };
      }),
    [],
  );

  const now = Date.now();

  return (
    <svg className="map" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#ff5a5a" />
        </marker>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Continent regions */}
      {hulls.map((h) => {
        const owner = view.continentOwners[h.id];
        const color = CONTINENT_COLORS[h.id];
        const label = CONTINENT_LABELS[h.id];
        return (
          <g key={h.id} className="continent">
            <polygon
              points={h.points}
              fill={owner ? colorOf(owner) : color}
              fillOpacity={owner ? 0.22 : 0.13}
              stroke={owner ? colorOf(owner) : color}
              strokeOpacity={owner ? 0.3 : 0.16}
              strokeWidth={70}
              strokeLinejoin="round"
              style={{ transition: 'fill .6s, stroke .6s' }}
            />
            <text x={label.x} y={label.y} textAnchor={label.anchor} className="continent-label" fill={color}>
              {h.name.toUpperCase()} +{h.bonus}
            </text>
          </g>
        );
      })}

      {/* Edges */}
      <g className="edges">
        {EDGE_LIST.map(([a, b]) => {
          if ((a === 'alaska' && b === 'kamchatka') || (a === 'kamchatka' && b === 'alaska')) return null;
          const A = TERRITORY_BY_ID[a];
          const B = TERRITORY_BY_ID[b];
          return <line key={`${a}-${b}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} />;
        })}
        {/* Alaska <-> Kamchatka wraps around the map */}
        <line x1={TERRITORY_BY_ID.alaska.x} y1={TERRITORY_BY_ID.alaska.y} x2={0} y2={TERRITORY_BY_ID.alaska.y} strokeDasharray="6 5" />
        <line x1={TERRITORY_BY_ID.kamchatka.x} y1={TERRITORY_BY_ID.kamchatka.y} x2={1000} y2={TERRITORY_BY_ID.kamchatka.y} strokeDasharray="6 5" />
      </g>

      {/* Attack arrow */}
      {attackArrow && (
        <line
          className="attack-arrow"
          x1={TERRITORY_BY_ID[attackArrow.from].x}
          y1={TERRITORY_BY_ID[attackArrow.from].y}
          x2={TERRITORY_BY_ID[attackArrow.to].x}
          y2={TERRITORY_BY_ID[attackArrow.to].y}
          markerEnd="url(#arrowhead)"
        />
      )}

      {/* Territories */}
      {TERRITORIES.map((t) => {
        const ts = view.territories[t.id];
        const hl = highlights[t.id];
        const pending = pendingPlacements[t.id] ?? 0;
        const flashing = flashes[t.id] && now - flashes[t.id] < 1200;
        const dim = dimOthers && !hl;
        const cls = ['territory', hl ? `hl-${hl}` : '', flashing ? 'flash' : '', dim ? 'dim' : '', hl ? 'clickable' : ''].filter(Boolean).join(' ');
        return (
          <g
            key={t.id}
            className={cls}
            transform={`translate(${t.x},${t.y})`}
            onClick={(e) => onTerritoryClick(t.id, e.shiftKey)}
            role="button"
          >
            <title>
              {t.name} — {view.players.find((p) => p.id === ts.owner)?.name ?? 'unowned'}, {ts.armies} armies
            </title>
            <circle className="ring" r={27} />
            <circle className="body" r={21} fill={colorOf(ts.owner)} />
            <text key={ts.armies + pending} className="armies" textAnchor="middle" dominantBaseline="central">
              {ts.armies + pending}
            </text>
            {pending > 0 && (
              <text className="pending" x={22} y={-16} textAnchor="middle">
                +{pending}
              </text>
            )}
            <text className="label" y={36} textAnchor="middle">
              {shortName(t.id)}
            </text>
          </g>
        );
      })}

      {/* Troop movement tokens */}
      {moves.map((m) => {
        const A = TERRITORY_BY_ID[m.from];
        const B = TERRITORY_BY_ID[m.to];
        return (
          <g key={m.id} className="move-token">
            <circle r={9} fill={m.color} stroke="#fff" strokeWidth={2}>
              <animateMotion dur="0.7s" fill="freeze" path={`M${A.x},${A.y} L${B.x},${B.y}`} />
            </circle>
            <text textAnchor="middle" dominantBaseline="central" className="move-text">
              {m.armies}
              <animateMotion dur="0.7s" fill="freeze" path={`M${A.x},${A.y} L${B.x},${B.y}`} />
            </text>
          </g>
        );
      })}

      {/* Floating labels (+3, -1 ...) */}
      {floats.map((f) => {
        const T = TERRITORY_BY_ID[f.territory];
        return (
          <text key={f.id} className="float" x={T.x} y={T.y - 26} textAnchor="middle" fill={f.color}>
            {f.text}
          </text>
        );
      })}
    </svg>
  );
}
