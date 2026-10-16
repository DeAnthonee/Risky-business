import { useMemo } from 'react';
import { getMap, type GameView, type MapDef } from '@risk/engine';

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

/** Region colours (used for unowned land, region outlines and labels). */
const CONTINENT_PALETTE = ['#e8b84a', '#e06377', '#5b9dff', '#f58e4f', '#36c9b5', '#b48cf2', '#8fd14f', '#ff9f1c', '#4cc9f0', '#f72585', '#a3b18a', '#ffd166', '#06d6a0', '#c77dff'];

export function continentColor(map: MapDef, continentId: string): string {
  const i = map.continents.findIndex((c) => c.id === continentId);
  return CONTINENT_PALETTE[(i < 0 ? 0 : i) % CONTINENT_PALETTE.length];
}

export function territoryName(map: MapDef, id: string): string {
  return map.territoryById[id]?.name ?? id;
}

/** Short label for the badge: drop filler words so long names fit. */
function shortLabel(name: string): string {
  return name
    .replace('United States', 'US')
    .replace('Northwest Territory', 'NW Territory')
    .replace(' & ', ' & ')
    .replace('Territory', 'Terr.');
}

export function GameMap(props: MapProps) {
  const { view, highlights, pendingPlacements, attackArrow, flashes, moves, floats, onTerritoryClick, dimOthers } = props;
  const map = getMap(view.options.map);
  const [W, H] = map.viewBox;
  const colorOf = (pid: string | null) => view.players.find((p) => p.id === pid)?.color ?? null;
  const anchor = (id: string) => map.territoryById[id];
  const now = Date.now();
  const dense = map.territories.length > 50;

  const continentLabels = useMemo(
    () =>
      map.continents.map((c) => {
        if (c.labelX !== undefined && c.labelY !== undefined) return { id: c.id, name: c.name, bonus: c.bonus, x: c.labelX, y: c.labelY };
        const pts = c.territories.map((t) => map.territoryById[t]);
        const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const y = Math.min(...pts.map((p) => p.y)) - 22;
        return { id: c.id, name: c.name, bonus: c.bonus, x, y: Math.max(12, y) };
      }),
    [map],
  );

  return (
    <svg className={`map ${dense ? 'dense' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
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
        <filter id="land-shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000" floodOpacity="0.45" />
        </filter>
        <pattern id="ocean-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1" />
        </pattern>
      </defs>

      {/* Ocean */}
      <rect width={W} height={H} className="ocean" />
      <rect width={W} height={H} fill="url(#ocean-grid)" />

      {/* Continent outlines give the board its regions */}
      <g className="continents" filter="url(#land-shadow)">
        {map.continents.map((c) => {
          const owner = view.continentOwners[c.id];
          const col = owner ? colorOf(owner) ?? continentColor(map, c.id) : continentColor(map, c.id);
          return <path key={c.id} d={c.outline} className={`continent-outline ${owner ? 'owned' : ''}`} stroke={col} />;
        })}
      </g>

      {/* Sea links between adjacent territories that do not touch */}
      <g className="sea-links">
        {map.seaLinks.map((l) => {
          const A = anchor(l.a);
          const B = anchor(l.b);
          if (l.wrap) {
            const left = A.x < B.x ? A : B;
            const right = A.x < B.x ? B : A;
            return (
              <g key={`${l.a}-${l.b}`}>
                <line x1={left.x} y1={left.y} x2={0} y2={left.y} />
                <line x1={right.x} y1={right.y} x2={W} y2={right.y} />
              </g>
            );
          }
          return <line key={`${l.a}-${l.b}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} />;
        })}
      </g>

      {/* Territories */}
      <g className="territories">
        {map.territories.map((t) => {
          const ts = view.territories[t.id];
          const hl = highlights[t.id];
          const owner = colorOf(ts?.owner ?? null);
          const flashing = flashes[t.id] && now - flashes[t.id] < 1200;
          const dim = dimOthers && !hl;
          const cls = ['territory', hl ? `hl-${hl}` : '', flashing ? 'flash' : '', dim ? 'dim' : '', hl ? 'clickable' : '', owner ? '' : 'unowned'].filter(Boolean).join(' ');
          return (
            <path
              key={t.id}
              d={t.path}
              className={cls}
              fill={owner ?? continentColor(map, t.continent)}
              onClick={(e) => onTerritoryClick(t.id, e.shiftKey)}
            >
              <title>
                {t.name} — {view.players.find((p) => p.id === ts?.owner)?.name ?? 'unowned'}, {ts?.armies ?? 0} armies
              </title>
            </path>
          );
        })}
      </g>

      {/* Continent labels */}
      {continentLabels.map((c) => (
        <text key={c.id} x={c.x} y={c.y} textAnchor="middle" className="continent-label" fill={continentColor(map, c.id)}>
          {c.name.toUpperCase()} +{c.bonus}
        </text>
      ))}

      {/* Attack arrow */}
      {attackArrow && (
        <line
          className="attack-arrow"
          x1={anchor(attackArrow.from).x}
          y1={anchor(attackArrow.from).y}
          x2={anchor(attackArrow.to).x}
          y2={anchor(attackArrow.to).y}
          markerEnd="url(#arrowhead)"
        />
      )}

      {/* Army badges + names (drawn above the shapes so they are always legible) */}
      <g className="badges">
        {map.territories.map((t) => {
          const ts = view.territories[t.id];
          const hl = highlights[t.id];
          const pending = pendingPlacements[t.id] ?? 0;
          const owner = colorOf(ts?.owner ?? null) ?? '#555';
          const dim = dimOthers && !hl;
          const cls = ['badge', hl ? `hl-${hl}` : '', dim ? 'dim' : '', hl ? 'clickable' : ''].filter(Boolean).join(' ');
          return (
            <g key={t.id} className={cls} transform={`translate(${t.x},${t.y})`} onClick={(e) => onTerritoryClick(t.id, e.shiftKey)}>
              <circle className="ring" r={dense ? 15 : 19} />
              <circle className="body" r={dense ? 11 : 14} fill={owner} />
              <text key={(ts?.armies ?? 0) + pending} className="armies" textAnchor="middle" dominantBaseline="central">
                {(ts?.armies ?? 0) + pending}
              </text>
              {pending > 0 && (
                <text className="pending" x={dense ? 14 : 18} y={-10} textAnchor="middle">
                  +{pending}
                </text>
              )}
              <text className="label" y={dense ? 22 : 26} textAnchor="middle">
                {shortLabel(t.name)}
              </text>
            </g>
          );
        })}
      </g>

      {/* Troop movement tokens */}
      {moves.map((m) => {
        const A = anchor(m.from);
        const B = anchor(m.to);
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

      {/* Floating labels (+3 ...) */}
      {floats.map((f) => {
        const T = anchor(f.territory);
        return (
          <text key={f.id} className="float" x={T.x} y={T.y - 22} textAnchor="middle" fill={f.color}>
            {f.text}
          </text>
        );
      })}
    </svg>
  );
}
