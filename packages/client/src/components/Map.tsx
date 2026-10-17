import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/** A conquest: the new owner's colour sweeps across the territory from the attacker's side. */
export interface SweepAnim {
  id: number;
  territory: string;
  from: string;
  color: string;
}

export interface MapProps {
  view: GameView;
  /** Territories to draw as fogged (spectator fog preview or a player's own fogged view). */
  hidden?: Set<string>;
  highlights: Record<string, Highlight>;
  pendingPlacements: Record<string, number>;
  attackArrow: { from: string; to: string } | null;
  flashes: Record<string, number>;
  moves: MoveAnim[];
  floats: FloatAnim[];
  sweeps: SweepAnim[];
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
  const { view, highlights, pendingPlacements, attackArrow, flashes, moves, floats, sweeps, onTerritoryClick, dimOthers, hidden } = props;
  const isHidden = (id: string) => !!(hidden?.has(id) || view.territories[id]?.hidden);
  const capitalOwner = (id: string) => Object.entries(view.capitals ?? {}).find(([, t]) => t === id)?.[0];
  const map = getMap(view.options.map);
  const [W, H] = map.viewBox;
  const colorOf = (pid: string | null) => view.players.find((p) => p.id === pid)?.color ?? null;
  const anchor = (id: string) => map.territoryById[id];
  const now = Date.now();
  const dense = map.territories.length > 50;

  // ---- zoom & pan (viewBox manipulation; wheel, drag, pinch, buttons) ----
  const [vb, setVb] = useState({ x: 0, y: 0, w: W, h: H });
  useEffect(() => setVb({ x: 0, y: 0, w: W, h: H }), [W, H]);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; last: { x: number; y: number } | null; pinch: number | null }>({ moved: false, last: null, pinch: null });
  const scale = W / vb.w;
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;

  const clampVb = useCallback(
    (v: { x: number; y: number; w: number; h: number }) => {
      const w = Math.min(W, Math.max(W / MAX_SCALE, v.w));
      const h = (w * H) / W;
      return { x: Math.min(Math.max(v.x, 0), W - w), y: Math.min(Math.max(v.y, 0), H - h), w, h };
    },
    [W, H],
  );

  /** Convert a client point to viewBox coordinates. */
  const toMap = useCallback(
    (cx: number, cy: number) => {
      const el = svgRef.current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      // preserveAspectRatio meet: the viewBox is letterboxed inside the element.
      const s = Math.min(r.width / vb.w, r.height / vb.h);
      const ox = (r.width - vb.w * s) / 2;
      const oy = (r.height - vb.h * s) / 2;
      return { x: vb.x + (cx - r.left - ox) / s, y: vb.y + (cy - r.top - oy) / s, s };
    },
    [vb],
  );

  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setVb((v) => {
        const el = svgRef.current;
        const r = el?.getBoundingClientRect();
        const px = cx !== undefined && r ? toMap(cx, cy!).x : v.x + v.w / 2;
        const py = cy !== undefined && r ? toMap(cx!, cy).y : v.y + v.h / 2;
        const w = Math.min(W, Math.max(W / MAX_SCALE, v.w / factor));
        const h = (w * H) / W;
        // keep the point under the cursor fixed
        const nx = px - ((px - v.x) * w) / v.w;
        const ny = py - ((py - v.y) * h) / v.h;
        return clampVb({ x: nx, y: ny, w, h });
      });
    },
    [W, H, clampVb, toMap],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.moved = false;
    gesture.current.last = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current.pinch) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(d - gesture.current.pinch) > 4) {
        zoomAt(d / gesture.current.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        gesture.current.pinch = d;
        gesture.current.moved = true;
      }
      return;
    }
    const last = gesture.current.last;
    if (!last || pointers.current.size !== 1) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (!gesture.current.moved && Math.hypot(dx, dy) < 4) return;
    gesture.current.moved = true;
    gesture.current.last = { x: e.clientX, y: e.clientY };
    const { s } = toMap(e.clientX, e.clientY) as { s?: number };
    const k = s ?? 1;
    setVb((v) => clampVb({ ...v, x: v.x - dx / k, y: v.y - dy / k }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (pointers.current.size === 0) gesture.current.last = null;
  };
  /** Territory clicks are ignored when the pointer was dragged. */
  const click = (id: string, shift: boolean) => {
    if (gesture.current.moved) return;
    onTerritoryClick(id, shift);
  };
  const resetView = () => setVb({ x: 0, y: 0, w: W, h: H });
  const zoomed = scale > 1.05;
  const showNames = !dense || scale >= 1.7;

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
    <div className="map-wrap">
    <svg
      ref={svgRef}
      className={`map ${dense ? 'dense' : ''} ${zoomed ? 'zoomed' : ''} ${showNames ? 'show-names' : ''}`}
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => zoomAt(1.6, e.clientX, e.clientY)}
    >
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

      {/* Ocean (oversized so panning never shows the page background) */}
      <rect x={-W} y={-H} width={3 * W} height={3 * H} className="ocean" />
      <rect x={-W} y={-H} width={3 * W} height={3 * H} fill="url(#ocean-grid)" />

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
          const fog = isHidden(t.id);
          const owner = fog ? null : colorOf(ts?.owner ?? null);
          const flashing = !fog && flashes[t.id] && now - flashes[t.id] < 1200;
          const dim = dimOthers && !hl;
          const cls = ['territory', hl ? `hl-${hl}` : '', flashing ? 'flash' : '', dim ? 'dim' : '', hl ? 'clickable' : '', owner ? '' : 'unowned', fog ? 'fog' : ''].filter(Boolean).join(' ');
          return (
            <path
              key={t.id}
              d={t.path}
              className={cls}
              fill={fog ? '#2a3140' : (owner ?? continentColor(map, t.continent))}
              onClick={(e) => click(t.id, e.shiftKey)}
            >
              <title>
                {fog ? `${t.name} — hidden by fog` : `${t.name} — ${view.players.find((p) => p.id === ts?.owner)?.name ?? 'unowned'}, ${ts?.armies ?? 0} armies`}
              </title>
            </path>
          );
        })}
      </g>

      {/* Capture sweeps: a clipped band of the new owner's colour wipes across the shape */}
      <g className="sweeps">
        {sweeps.map((sw) => {
          const t = map.territoryById[sw.territory];
          const f = map.territoryById[sw.from];
          if (!t || !f) return null;
          const [bx, by, bw, bh] = t.bbox;
          const pad = 6;
          const dx = t.x - f.x;
          const dy = t.y - f.y;
          const horizontal = Math.abs(dx) >= Math.abs(dy);
          // The band starts fully outside the shape on the attacker's side and grows across it.
          const rect = horizontal
            ? { x: dx >= 0 ? bx - pad : bx + bw + pad, y: by - pad, w: 0, h: bh + 2 * pad, attr: 'width', to: bw + 2 * pad, anchorRight: dx < 0 }
            : { x: bx - pad, y: dy >= 0 ? by - pad : by + bh + pad, w: bw + 2 * pad, h: 0, attr: 'height', to: bh + 2 * pad, anchorRight: dy < 0 };
          const clipId = `sweep-${sw.id}`;
          return (
            <g key={sw.id} className="sweep">
              <clipPath id={clipId}>
                {rect.anchorRight ? (
                  // grow towards the left/top: animate both position and size
                  <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h}>
                    <animate attributeName={rect.attr} from="0" to={String(rect.to)} dur="0.55s" fill="freeze" calcMode="spline" keySplines="0.2 0.7 0.3 1" />
                    <animate attributeName={horizontal ? 'x' : 'y'} from={String(horizontal ? rect.x : rect.y)} to={String((horizontal ? rect.x : rect.y) - rect.to)} dur="0.55s" fill="freeze" calcMode="spline" keySplines="0.2 0.7 0.3 1" />
                  </rect>
                ) : (
                  <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h}>
                    <animate attributeName={rect.attr} from="0" to={String(rect.to)} dur="0.55s" fill="freeze" calcMode="spline" keySplines="0.2 0.7 0.3 1" />
                  </rect>
                )}
              </clipPath>
              <path d={t.path} fill={sw.color} className="sweep-fill" clipPath={`url(#${clipId})`} />
              <path d={t.path} className="sweep-edge" stroke={sw.color} />
            </g>
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
          const fog = isHidden(t.id);
          const owner = fog ? '#3a4152' : (colorOf(ts?.owner ?? null) ?? '#555');
          const dim = dimOthers && !hl;
          const cap = capitalOwner(t.id);
          const cls = ['badge', hl ? `hl-${hl}` : '', dim ? 'dim' : '', hl ? 'clickable' : '', fog ? 'fog' : '', cap ? 'capital' : ''].filter(Boolean).join(' ');
          return (
            <g key={t.id} className={cls} transform={`translate(${t.x},${t.y})`} onClick={(e) => click(t.id, e.shiftKey)}>
              <circle className="ring" r={dense ? 15 : 19} />
              <circle className="body" r={dense ? 11 : 14} fill={owner} />
              {cap && !fog && (
                <text className="capital-star" y={dense ? -13 : -16} textAnchor="middle" fill={colorOf(cap) ?? '#ffd166'}>
                  ★
                </text>
              )}
              <text key={(ts?.armies ?? 0) + pending} className="armies" textAnchor="middle" dominantBaseline="central">
                {fog ? '?' : (ts?.armies ?? 0) + pending}
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
    <div className="map-controls">
      <button title="Zoom in" onClick={() => zoomAt(1.4)}>
        +
      </button>
      <button title="Zoom out" onClick={() => zoomAt(1 / 1.4)}>
        −
      </button>
      <button title="Reset view" onClick={resetView} disabled={!zoomed}>
        ⟲
      </button>
      {dense && !showNames && <span className="map-hint">zoom in or hover for names</span>}
    </div>
    </div>
  );
}
