import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMap, type MapDef, type NestNode } from '@risk/engine';
import { continentColor } from './Map';
import { cameraFor, layoutNest, lerpCamera, pathTo } from '../inception';

/** What the view knows about one table: who holds what, and how it stands. From the tournament feed (later) or a demo. */
export interface TableSnapshot {
  /** Owner of each territory as an index into `players` (null: nobody, e.g. a blizzard). Missing: not dealt yet. */
  owners?: Record<string, number | null>;
  players: { name: string; color: string; alive: boolean }[];
  status: 'waiting' | 'playing' | 'finished' | 'decided';
  /** The room to watch, once the table exists. */
  gameId?: string;
  /** Index into `players` of the winner (finished or decided) or the current leader. */
  leader?: number;
}

const ZOOM_MS = 600;

/**
 * The "Inception" view of a nested tournament: the outermost board, with each table's board drawn inside its portal
 * territory, and so on down. Click a portal to zoom into it, Esc or the breadcrumb to zoom out. At a table, "Watch
 * table" opens its game as a spectator. It never moves the viewer by itself (README hard rule 10).
 */
export function Inception({ nodes, tables, onWatch }: { nodes: NestNode[]; tables: Record<number, TableSnapshot>; onWatch?: (gameId: string) => void }) {
  const maps = useMemo(() => nodes.map((n) => getMap(n.map)), [nodes]);
  const places = useMemo(() => layoutNest(nodes, getMap), [nodes]);
  const children = useMemo(() => {
    const by: number[][] = nodes.map(() => []);
    nodes.forEach((n, i) => n.parent !== null && by[n.parent].push(i));
    return by;
  }, [nodes]);
  const [focus, setFocus] = useState(0);
  const [camera, setCamera] = useState(() => cameraFor(places[0]));
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const anim = useRef<number | null>(null);

  const zoomTo = useCallback(
    (index: number) => {
      setFocus(index);
      const from = cameraRef.current;
      const to = cameraFor(places[index]);
      if (anim.current !== null) cancelAnimationFrame(anim.current);
      anim.current = null;
      // A hidden page gets no animation frames: go straight there.
      if (document.hidden) return setCamera(to);
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ZOOM_MS);
        setCamera(lerpCamera(from, to, t));
        anim.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      anim.current = requestAnimationFrame(step);
    },
    [places],
  );
  useEffect(() => () => void (anim.current !== null && cancelAnimationFrame(anim.current)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && nodes[focus].parent !== null) zoomTo(nodes[focus].parent!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, nodes, zoomTo]);

  // Draw boards down to two levels below the focused one; deeper ones are too small to see.
  const depthLimit = nodes[focus].depth + 2;
  const trail = pathTo(nodes, focus);
  const label = (i: number) => (nodes[i].parent === null ? 'Final' : maps[nodes[i].parent!].territoryById[nodes[i].portal!]?.name ?? nodes[i].portal!);
  const table = tables[focus];
  const strokeW = camera[2] / 900;

  return (
    <div className="inception">
      <nav className="inception-trail" aria-label="Where you are">
        {trail.map((i, k) => (
          <span key={i}>
            {k > 0 && ' › '}
            {i === focus ? <strong>{label(i)}</strong> : <button onClick={() => zoomTo(i)}>{label(i)}</button>}
          </span>
        ))}
        {nodes[focus].parent !== null && (
          <button className="inception-out" onClick={() => zoomTo(nodes[focus].parent!)} title="Zoom out (Esc)">
            Zoom out
          </button>
        )}
      </nav>
      <div className="inception-body">
        <svg className="inception-svg" viewBox={camera.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Nested tournament, ${label(focus)}`}>
          {nodes.map((n, i) =>
            n.depth > depthLimit ? null : (
              <g key={i} transform={`translate(${places[i].x} ${places[i].y}) scale(${places[i].scale})`}>
                {n.parent !== null && <rect className="inception-frame" width={places[i].w} height={places[i].h} rx={places[i].w / 40} />}
                <Board map={maps[i]} table={tables[i]} portals={n.portals} />
                {i !== focus && n.parent !== null && (
                  <rect
                    className="inception-hit"
                    width={places[i].w}
                    height={places[i].h}
                    onClick={() => zoomTo(i)}
                    style={{ strokeWidth: strokeW / places[i].scale }}
                  >
                    <title>Zoom into {label(i)}</title>
                  </rect>
                )}
              </g>
            ),
          )}
        </svg>
        <aside className="inception-side">
          <h3>{label(focus)}</h3>
          <p className="muted">
            {nodes[focus].seats} seats · {children[focus].length ? `${children[focus].length} tables inside` : 'a first-round table'} · {table ? statusText(table) : 'not started'}
          </p>
          {table && (
            <ul className="inception-players">
              {table.players.map((p, k) => (
                <li key={k} className={p.alive ? '' : 'dead'}>
                  <span className="swatch" style={{ background: p.color }} /> {p.name}
                  {table.leader === k && (table.status === 'finished' || table.status === 'decided' ? ' 🏆' : ' ▲')}
                </li>
              ))}
            </ul>
          )}
          {table?.gameId && onWatch && <button onClick={() => onWatch(table.gameId!)}>Watch table</button>}
          {children[focus].length > 0 && <p className="muted">Click a board inside a territory to zoom in.</p>}
        </aside>
      </div>
    </div>
  );
}

function statusText(t: TableSnapshot): string {
  if (t.status === 'decided') return 'decided on standing';
  return t.status;
}

/** One board: territories in their holder's colour (or their region's before the deal), portals outlined. */
const Board = memo(function Board({ map, table, portals }: { map: MapDef; table?: TableSnapshot; portals: string[] }) {
  const portalSet = new Set(portals);
  return (
    <g className="inception-board">
      <rect width={map.viewBox[0]} height={map.viewBox[1]} className="ocean" />
      {map.territories.map((t) => {
        const owner = table?.owners?.[t.id];
        const fill = owner === undefined ? continentColor(map, t.continent) : owner === null ? '#cfc6b8' : (table!.players[owner]?.color ?? '#999');
        return <path key={t.id} d={t.path} fill={fill} className={portalSet.has(t.id) ? 'inception-portal' : 'inception-territory'} />;
      })}
    </g>
  );
});

