import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMap, type MapDef, type NestNode } from '@risk/engine';
import { continentColor } from './Map';
import { cameraFor, layoutNest, lerpCamera, pathTo } from '../inception';
import { hasGlobe, loadGlobe, preferFlat, setPreferFlat, webglAvailable, type GlobeData } from '../globeData';
import { liveDepth } from '../globeLayout';

// The Globe view (three.js, the globe's lazy chunk): the round in play tiled on a sphere (LiveGlobe), or a final on a
// hex-globe board (Hex Earth) as that globe with its portals (InceptionGlobe).
const InceptionGlobe = lazy(() => import('./GlobeMap').then((m) => ({ default: m.InceptionGlobe })));
const LiveGlobe = lazy(() => import('./GlobeMap').then((m) => ({ default: m.LiveGlobe })));

/** What the view knows about one table: who holds what, and how it stands. From the tournament feed (later) or a demo. */
export interface TableSnapshot {
  /** Owner of each territory as an index into `players` (null: nobody, e.g. a blizzard). Missing: not dealt yet. */
  owners?: Record<string, number | null>;
  /** Armies on each territory (null: hidden). Missing: not known (the live globe draws the land flat). */
  armies?: Record<string, number | null>;
  /** The table's latest battle (territory ids) and when it was fought (ms), for the live globe's attack arc. */
  lastAttack?: { from: string; to: string; at: number };
  players: { name: string; color: string; alive: boolean }[];
  status: 'waiting' | 'playing' | 'finished' | 'decided';
  /** The room to watch, once the table exists. */
  gameId?: string;
  /** Index into `players` of the winner (finished or decided) or the current leader. */
  leader?: number;
}

const ZOOM_MS = 600;
/** Board generation per slice of the main thread, so a big tree never blocks the page in one go. */
const SLICE_MS = 12;

/**
 * Boards appear as they are generated, outermost first (nodes are breadth-first, so a parent is always ready before its
 * children). Generated boards take a few ms each; 40+ of them at once would freeze the page for a second or two.
 */
function useReadyBoards(nodes: NestNode[]): number {
  const [ready, setReady] = useState(() => (nodes.length ? (getMap(nodes[0].map), 1) : 0));
  useEffect(() => {
    let i = 1;
    let timer = 0;
    setReady(Math.min(1, nodes.length));
    const work = () => {
      const until = performance.now() + SLICE_MS;
      while (i < nodes.length && performance.now() < until) getMap(nodes[i++].map);
      setReady(i);
      if (i < nodes.length) timer = window.setTimeout(work, 0);
    };
    if (nodes.length > 1) timer = window.setTimeout(work, 0);
    return () => window.clearTimeout(timer);
  }, [nodes]);
  return ready;
}

/**
 * The "Inception" view of a nested tournament: the outermost board, with each table's board drawn inside its portal
 * territory, and so on down. Click a portal to zoom into it, Esc or the breadcrumb to zoom out. At a table, "Watch
 * table" opens its game as a spectator. It never moves the viewer by itself (README hard rule 10).
 */
export function Inception({
  nodes,
  tables,
  onWatch,
  follow,
  onManualZoom,
}: {
  nodes: NestNode[];
  tables: Record<number, TableSnapshot>;
  onWatch?: (gameId: string) => void;
  /** Opt-in "Follow the action": the table to show and why. The view zooms there by itself only while this is set. */
  follow?: { node: number; caption: string } | null;
  /** The viewer zoomed by hand (click, Esc, breadcrumb): the page turns following off. */
  onManualZoom?: () => void;
}) {
  const ready = useReadyBoards(nodes);
  const shown = useMemo(() => nodes.slice(0, ready), [nodes, ready]);
  const maps = useMemo(() => shown.map((n) => getMap(n.map)), [shown]);
  const places = useMemo(() => layoutNest(shown, getMap), [shown]);
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
  // Following: go to the followed table once its board is drawn.
  const followNode = follow?.node;
  useEffect(() => {
    if (followNode !== undefined && followNode < places.length && followNode !== focus) zoomTo(followNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followNode, places.length]);
  const zoomByHand = (index: number) => {
    onManualZoom?.();
    zoomTo(index);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && nodes[focus].parent !== null) {
        onManualZoom?.();
        zoomTo(nodes[focus].parent!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, nodes, zoomTo, onManualZoom]);

  // Draw boards down to two levels below the focused one; deeper ones are too small to see.
  const depthLimit = nodes[focus].depth + 2;
  const trail = pathTo(nodes, focus);
  const label = (i: number) => (nodes[i].parent === null ? 'Final' : (maps[nodes[i].parent!]?.territoryById[nodes[i].portal!]?.name ?? nodes[i].portal!));
  const table = tables[focus];
  const strokeW = camera[2] / 900;

  // The Globe view (Flat / Globe to switch, remembered like the game view's choice; flat without WebGL). It shows the
  // round in play: every live table's board as a patch of the sphere in its holders' colours, click one to focus it.
  // When the round in play is a final on a hex-globe board (Hex Earth), that globe instead, its portals in gold.
  const webgl = webglAvailable();
  const [flat, setFlat] = useState(preferFlat);
  const chooseFlat = (toFlat: boolean) => {
    setFlat(toFlat);
    setPreferFlat(toFlat);
  };
  const depth = useMemo(() => liveDepth(nodes, (i) => tables[i]?.status), [nodes, tables]);
  const rootMap = nodes[0].map;
  const finalOnGlobe = depth === 0 && hasGlobe(rootMap);
  const [globe, setGlobe] = useState<GlobeData | null>(null);
  useEffect(() => {
    if (!webgl || flat || !finalOnGlobe || globe?.id === rootMap) return;
    let current = true;
    loadGlobe(rootMap)
      .then((g) => current && setGlobe(g))
      .catch(() => {
        // The globe chunk failed to load: keep the flat view.
      });
    return () => {
      current = false;
    };
  }, [rootMap, webgl, flat, finalOnGlobe, globe]);
  const colourIn = useCallback(
    (node: number, t: string) => {
      const board = getMap(nodes[node].map);
      const snap = tables[node];
      const owner = snap?.owners?.[t];
      if (owner === undefined) {
        // Not dealt yet: a portal shows the colour of the winner (or leader) of the table inside it, so a round's
        // winners are seen arriving at their starting territories on the next boards.
        const inside = children[node].find((c) => nodes[c].portal === t);
        const below = inside !== undefined ? tables[inside] : undefined;
        if (below?.leader !== undefined && (below.status === 'finished' || below.status === 'decided')) return below.players[below.leader]?.color ?? '#999';
        return continentColor(board, board.territoryById[t]?.continent ?? '');
      }
      return owner === null ? '#cfc6b8' : (snap!.players[owner]?.color ?? '#999');
    },
    [nodes, tables, children],
  );
  const rootFill = useCallback((t: string) => colourIn(0, t), [colourIn]);
  const mode = !webgl || flat ? 'flat' : finalOnGlobe ? (globe?.id === rootMap ? 'hexglobe' : 'flat') : ready === nodes.length ? 'live' : 'flat';

  return (
    <div className="inception">
      <nav className="inception-trail" aria-label="Where you are">
        {trail.map((i, k) => (
          <span key={i}>
            {k > 0 && ' › '}
            {i === focus ? <strong>{label(i)}</strong> : <button onClick={() => zoomByHand(i)}>{label(i)}</button>}
          </span>
        ))}
        {follow && <span className="inception-follow">{follow.caption}</span>}
        {webgl && (
          <button className="inception-out" onClick={() => chooseFlat(!flat)} title={flat ? 'Show the round in play on a globe' : 'Show the flat boards'}>
            {flat ? 'Globe' : 'Flat'}
          </button>
        )}
        {nodes[focus].parent !== null && (
          <button className="inception-out" onClick={() => zoomByHand(nodes[focus].parent!)} title="Zoom out (Esc)">
            Zoom out
          </button>
        )}
      </nav>
      <div className="inception-body">
        {mode === 'hexglobe' ? (
          <Suspense fallback={<div className="inception-globe" />}>
            <InceptionGlobe
              globe={globe!}
              fill={rootFill}
              portals={nodes[0].portals}
              labelOf={(t) => maps[0]?.territoryById[t]?.name ?? t}
              onPortal={(t) => {
                const child = children[0].find((i) => nodes[i].portal === t);
                if (child !== undefined) zoomByHand(child);
              }}
            />
          </Suspense>
        ) : mode === 'live' ? (
          <Suspense fallback={<div className="inception-globe" />}>
            <LiveGlobe
              nodes={nodes}
              depth={depth}
              mapOf={getMap}
              fill={colourIn}
              armiesOf={(node, t) => tables[node]?.armies?.[t] ?? null}
              attackOf={(node) => tables[node]?.lastAttack ?? null}
              focus={focus}
              labelOf={label}
              onPick={zoomByHand}
              version={tables}
            />
          </Suspense>
        ) : (
          <svg className="inception-svg" viewBox={camera.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Nested tournament, ${label(focus)}`}>
            {shown.map((n, i) =>
              n.depth > depthLimit ? null : (
                <g key={i} transform={`translate(${places[i].x} ${places[i].y}) scale(${places[i].scale})`}>
                  {n.parent !== null && <rect className="inception-frame" width={places[i].w} height={places[i].h} rx={places[i].w / 40} />}
                  <Board map={maps[i]} table={tables[i]} portals={n.portals} />
                  {i !== focus && n.parent !== null && (
                    <rect
                      className="inception-hit"
                      width={places[i].w}
                      height={places[i].h}
                      onClick={() => zoomByHand(i)}
                      style={{ strokeWidth: strokeW / places[i].scale }}
                    >
                      <title>Zoom into {label(i)}</title>
                    </rect>
                  )}
                </g>
              ),
            )}
          </svg>
        )}
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

