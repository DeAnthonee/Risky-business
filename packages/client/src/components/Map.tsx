import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
  /** Bonuses view: paint every territory in its region's colour, hide armies and owners, show region bonuses big. */
  bonusView?: boolean;
  onToggleBonusView?: () => void;
}

/** Region colours (used for unowned land, region outlines and labels). */
// 22 colours, so every region on every board gets its own (the biggest board has 20 regions).
const CONTINENT_PALETTE = [
  '#e8b84a', '#e06377', '#5b9dff', '#f58e4f', '#36c9b5', '#b48cf2', '#8fd14f', '#ff9f1c', '#4cc9f0', '#f72585', '#a3b18a',
  '#ffd166', '#06d6a0', '#c77dff', '#d62828', '#2a9d8f', '#ff8fab', '#8d99ae', '#c5e063', '#9b5de5', '#e9d8a6', '#3a86ff',
];

/** Perceptual colour (OKLab) for comparing how different two palette colours look. */
function oklab(hex: string): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function colourDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * Region colours: regions that border each other (by land or sea link) get colours that look as different
 * as possible. Regions with the most neighbours pick first; each takes the colour farthest (perceptually)
 * from its already-coloured neighbours, with regions two steps away counting a little, and colours are not
 * reused while any are left, so every region is distinct and a yellow never sits next to an amber.
 */
const regionColorCache = new WeakMap<MapDef, Record<string, string>>();
function regionColors(map: MapDef): Record<string, string> {
  const cached = regionColorCache.get(map);
  if (cached) return cached;
  const regionOf: Record<string, string> = {};
  for (const c of map.continents) for (const t of c.territories) regionOf[t] = c.id;
  const neighbours: Record<string, Set<string>> = Object.fromEntries(map.continents.map((c) => [c.id, new Set<string>()]));
  for (const t of map.territoryIds)
    for (const n of map.adjacency[t] ?? []) if (regionOf[n] && regionOf[n] !== regionOf[t]) neighbours[regionOf[t]].add(regionOf[n]);
  const order = [...map.continents].sort((a, b) => neighbours[b.id].size - neighbours[a.id].size || map.continents.indexOf(a) - map.continents.indexOf(b));
  const out: Record<string, string> = {};
  const used = new Map<string, number>();
  for (const c of order) {
    const near = [...neighbours[c.id]].map((n) => out[n]).filter(Boolean);
    const twoAway = [...neighbours[c.id]].flatMap((n) => [...neighbours[n]]).filter((n) => n !== c.id && !neighbours[c.id].has(n)).map((n) => out[n]).filter(Boolean);
    let best = CONTINENT_PALETTE[0];
    let bestScore = -Infinity;
    for (const col of CONTINENT_PALETTE) {
      const dNear = near.length ? Math.min(...near.map((x) => colourDistance(col, x))) : 1;
      const dFar = twoAway.length ? Math.min(...twoAway.map((x) => colourDistance(col, x))) : 1;
      const score = dNear + 0.25 * dFar - 0.5 * (used.get(col) ?? 0);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = col;
      }
    }
    out[c.id] = best;
    used.set(best, (used.get(best) ?? 0) + 1);
  }
  regionColorCache.set(map, out);
  return out;
}

export function continentColor(map: MapDef, continentId: string): string {
  return regionColors(map)[continentId] ?? CONTINENT_PALETTE[0];
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
  const { view, highlights, pendingPlacements, attackArrow, flashes, moves, floats, sweeps, onTerritoryClick, dimOthers, hidden, bonusView, onToggleBonusView } = props;
  // The bonuses view shows regions only: no fog, owners or armies.
  const isHidden = (id: string) => !bonusView && !!(hidden?.has(id) || view.territories[id]?.hidden);
  const isFrozen = (id: string) => !!view.blizzards?.includes(id);
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

  // Bonuses view: one big label per region, at the territory nearest the middle of the region.
  const regionCentres = useMemo(
    () =>
      map.continents.map((c) => {
        const pts = c.territories.map((t) => map.territoryById[t]);
        const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const best = pts.reduce((a, p) => (Math.hypot(p.x - mx, p.y - my) < Math.hypot(a.x - mx, a.y - my) ? p : a), pts[0]);
        return { id: c.id, name: c.name, bonus: c.bonus, size: c.territories.length, x: best.x, y: best.y };
      }),
    [map],
  );

  return (
    <div className="map-wrap" style={{ '--map-aspect': `${W} / ${H}` } as CSSProperties}>
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
        <pattern id="blizzard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" fill="#dfe8f2" />
          <line x1="0" y1="0" x2="0" y2="10" stroke="#b3c4d6" strokeWidth="4" />
        </pattern>
      </defs>

      {/* Ocean (oversized so panning never shows the page background) */}
      <rect x={-W} y={-H} width={3 * W} height={3 * H} className="ocean" />
      <rect x={-W} y={-H} width={3 * W} height={3 * H} fill="url(#ocean-grid)" />

      {/* Continent outlines give the board its regions */}
      <g className="continents" filter="url(#land-shadow)">
        {map.continents.map((c) => {
          const owner = bonusView ? null : view.continentOwners[c.id];
          const col = owner ? colorOf(owner) ?? continentColor(map, c.id) : continentColor(map, c.id);
          return <path key={c.id} d={c.outline} className={`continent-outline ${owner ? 'owned' : ''} ${bonusView ? 'bonus' : ''}`} stroke={col} />;
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
          const frozen = isFrozen(t.id);
          const cls = ['territory', hl ? `hl-${hl}` : '', flashing ? 'flash' : '', dim ? 'dim' : '', hl ? 'clickable' : '', owner ? '' : 'unowned', fog ? 'fog' : '', frozen ? 'blizzard' : ''].filter(Boolean).join(' ');
          if (frozen)
            return (
              <path key={t.id} d={t.path} className="territory blizzard" fill="url(#blizzard)">
                <title>{`${t.name} — blizzard: impassable`}</title>
              </path>
            );
          if (bonusView) {
            const region = map.continentById[t.continent];
            return (
              <path key={t.id} d={t.path} className="territory bonus-fill" fill={continentColor(map, t.continent)}>
                <title>{`${t.name} — ${region?.name ?? t.continent} (+${region?.bonus ?? 0})`}</title>
              </path>
            );
          }
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

      {/* Continent labels (the bonuses view puts a big label in the middle of each region instead) */}
      {!bonusView &&
        continentLabels.map((c) => (
          <text key={c.id} x={c.x} y={c.y} textAnchor="middle" className="continent-label" fill={continentColor(map, c.id)}>
            {c.name.toUpperCase()} +{c.bonus}
          </text>
        ))}
      {bonusView && (
        <g className="bonus-labels">
          {regionCentres.map((c) => (
            <g key={c.id} transform={`translate(${c.x},${c.y})`}>
              <text className="bonus-value" textAnchor="middle" dominantBaseline="central">
                +{c.bonus}
              </text>
              <text className="bonus-name" y={dense ? 17 : 22} textAnchor="middle">
                {c.name}
              </text>
              {!dense && (
                <text className="bonus-count" y={36} textAnchor="middle">
                  {c.size} territories
                </text>
              )}
            </g>
          ))}
        </g>
      )}

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
      <g className="badges" style={bonusView ? { display: 'none' } : undefined}>
        {map.territories.map((t) => {
          const ts = view.territories[t.id];
          const hl = highlights[t.id];
          const pending = pendingPlacements[t.id] ?? 0;
          const fog = isHidden(t.id);
          const owner = fog ? '#3a4152' : (colorOf(ts?.owner ?? null) ?? '#555');
          const dim = dimOthers && !hl;
          const cap = capitalOwner(t.id);
          if (isFrozen(t.id))
            return (
              <g key={t.id} className="badge blizzard" transform={`translate(${t.x},${t.y})`}>
                <g className="blizzard-icon">
                  {[0, 60, 120].map((a) => (
                    <line key={a} x1={0} y1={-9} x2={0} y2={9} transform={`rotate(${a})`} />
                  ))}
                </g>
                <text className="label" y={dense ? 22 : 26} textAnchor="middle">
                  {shortLabel(t.name)}
                </text>
              </g>
            );
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
      {onToggleBonusView && (
        <button className={`bonus-toggle ${bonusView ? 'active' : ''}`} aria-pressed={!!bonusView} title="Show region bonuses, colour-coded (shortcut: B)" onClick={onToggleBonusView}>
          {bonusView ? 'Back to board' : 'Bonuses'}
        </button>
      )}
      {dense && !showNames && <span className="map-hint">zoom in or hover for names</span>}
    </div>
    </div>
  );
}
