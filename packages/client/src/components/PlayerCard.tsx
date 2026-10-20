import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { getMap, type GameView, type RankingRow } from '@risk/engine';
import { API } from '../api';
import { CharacterName, type Whisper } from './Profiles';

/** Where the card sits over the board and how big it is (remembered in this browser). */
interface Layout {
  x: number | null;
  y: number | null;
  w: number;
  h: number | null;
  collapsed: boolean;
}
const STORAGE_KEY = 'risk.playerCard';
const DEFAULT_LAYOUT: Layout = { x: null, y: null, w: 280, h: null, collapsed: false };
const MARGIN = 8;

function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_LAYOUT, ...saved };
  } catch {
    /* storage unavailable or corrupt: use the default spot */
  }
  return DEFAULT_LAYOUT;
}
function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable: keep it for this visit only */
  }
}

/** Ranking rows by player id for this game; refetched when the turn passes or the game ends. */
function useRanking(gameId: string, playerId: string | null, refreshKey: string) {
  const cache = useRef(new Map<string, RankingRow>());
  const [row, setRow] = useState<RankingRow | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!playerId) return setRow(null);
    let alive = true;
    setRow(cache.current.get(playerId) ?? null);
    setError(false);
    fetch(`${API}/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(playerId)}/profile`)
      .then((r) => (r.ok ? (r.json() as Promise<{ stats: RankingRow }>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        cache.current.set(playerId, d.stats);
        if (alive) setRow(d.stats);
      })
      .catch(() => alive && !cache.current.has(playerId) && setError(true));
    return () => {
      alive = false;
    };
  }, [gameId, playerId, refreshKey]);
  return { row, error };
}

/**
 * A floating card over the board for the player whose turn it is (the winner once the game ends):
 * this game's numbers plus their leaderboard standing. Drag it by its header, resize it from the
 * bottom-right corner, fold it down to the header; where it sits is remembered in this browser.
 */
export function PlayerCard({ view, gameId, you, whisperTo }: { view: GameView; gameId: string; you: string | null; whisperTo: (id: string) => Whisper | undefined }) {
  const finished = view.phase === 'finished';
  const subjectId = finished ? view.winner : view.currentPlayer;
  const p = view.players.find((x) => x.id === subjectId) ?? null;
  const { row, error } = useRanking(gameId, p && !p.isNeutral ? p.id : null, `${view.turnNumber}:${view.phase}`);

  const card = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const update = (patch: Partial<Layout>) => {
    const next = { ...layoutRef.current, ...patch };
    layoutRef.current = next;
    setLayout(next);
    saveLayout(next);
  };

  // Keep the card on the board, between the top bar and the action bar: on first show (default spot: top right) and when the window resizes.
  const bounds = () => {
    const el = card.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return null;
    const top = ((parent.querySelector('.topbar') as HTMLElement | null)?.offsetHeight ?? 0) + MARGIN;
    const bottom = ((parent.querySelector('.action-bar') as HTMLElement | null)?.offsetTop ?? parent.clientHeight) - MARGIN;
    return { el, parent, top, bottom };
  };
  const clamp = (x: number | null, y: number | null) => {
    const b = bounds();
    if (!b) return { x: x ?? MARGIN, y: y ?? MARGIN };
    const maxX = Math.max(MARGIN, b.parent.clientWidth - b.el.offsetWidth - MARGIN);
    const maxY = Math.max(b.top, b.bottom - b.el.offsetHeight);
    return {
      x: Math.min(Math.max(x ?? maxX, MARGIN), maxX),
      y: Math.min(Math.max(y ?? b.top, b.top), maxY),
    };
  };
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const place = () => {
      const b = bounds();
      if (b) setMaxHeight(Math.max(80, b.bottom - b.top));
      setPos(clamp(layoutRef.current.x, layoutRef.current.y));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [layout.x, layout.y, layout.collapsed, !!p, maxHeight]);

  // Resizing uses the browser's corner grip; remember the size it ends at.
  useEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The grip sets an inline height; until it is used the card keeps its natural height.
        const w = Math.round(el.offsetWidth);
        const cur = layoutRef.current;
        const h = cur.collapsed ? cur.h : el.style.height ? Math.round(el.offsetHeight) : null;
        if (w !== cur.w || h !== cur.h) update({ w, h });
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [!!p]);

  // Dragging by the header (buttons and the name link inside it still click normally).
  const drag = useRef<{ dx: number; dy: number; id: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input') || !pos) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    if (pos) update({ x: pos.x, y: pos.y });
  };
  // Arrow keys move the focused header, for anyone not using a mouse.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 40 : 10;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || !pos || (e.target as HTMLElement) !== e.currentTarget) return;
    e.preventDefault();
    const next = clamp(pos.x + d[0], pos.y + d[1]);
    setPos(next);
    update(next);
  };

  if (!p) return null;

  const map = getMap(view.options.map);
  const capitals = view.options.capitals ? Object.values(view.capitals ?? {}).filter((t) => view.territories[t]?.owner === p.id).length : null;
  const kills = view.players.filter((x) => x.eliminatedBy === p.id).length;
  const continents = p.continents.map((c) => map.continentById[c]?.name ?? c);
  const isYou = p.id === you;
  const known = (n: number | null) => (n === null ? '?' : n);

  return (
    <section
      ref={card}
      className={`player-card ${layout.collapsed ? 'collapsed' : ''}`}
      aria-label={`${finished ? 'Winner' : 'Current player'}: ${p.name}`}
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? undefined : 'hidden',
        width: layout.w,
        height: layout.collapsed ? undefined : (layout.h ?? undefined),
        maxHeight,
        ['--pc-color' as string]: p.color,
      }}
    >
      <header
        className="player-card-head"
        tabIndex={0}
        title="Drag to move (or focus and use the arrow keys). Double-click to put it back."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && update({ x: null, y: null, w: DEFAULT_LAYOUT.w, h: null })}
      >
        <span className="player-card-grip" aria-hidden="true">⠿</span>
        <span className="player-card-label">{finished ? '🏆 Winner' : isYou ? 'Your turn' : 'Now playing'}</span>
        <button
          className="small player-card-fold"
          onClick={() => update({ collapsed: !layout.collapsed })}
          aria-expanded={!layout.collapsed}
          aria-label={layout.collapsed ? 'Show player card' : 'Fold player card'}
          title={layout.collapsed ? 'Show' : 'Fold'}
        >
          {layout.collapsed ? '▾' : '▴'}
        </button>
      </header>

      <div className="player-card-name">
        <span className="swatch" style={{ background: p.color }} />
        <strong>
          <CharacterName name={p.name} gameId={gameId} playerId={p.id} whisper={whisperTo(p.id)} />
        </strong>
        {p.isBot && <span title="Computer player"> 🤖</span>}
        {isYou && <span className="muted"> (you)</span>}
      </div>

      {!layout.collapsed && (
        <div className="player-card-body">
          {!finished && (
            <p className="player-card-phase">
              <span className="phase-chip">{view.phase}</span>
              {p.armiesToPlace > 0 && <span> · {p.armiesToPlace} to place</span>}
              <span className="muted"> · round {view.round}</span>
            </p>
          )}

          <h3 className="player-card-section">This game</h3>
          <dl className="player-card-stats">
            <div><dt title="Territories">Lands</dt><dd>{known(p.territoryCount)}</dd></div>
            <div><dt>Armies</dt><dd>{known(p.armyCount)}</dd></div>
            <div><dt>Cards</dt><dd>{p.cardCount}</dd></div>
            <div><dt>Income</dt><dd className="income">{p.income ? `+${p.income.total}` : '—'}</dd></div>
            {capitals !== null && <div><dt>Capitals</dt><dd>{p.territoryCount === null ? '?' : `${capitals}★`}</dd></div>}
            <div><dt title="Card sets traded in">Sets in</dt><dd>{p.tradesMade ?? 0}</dd></div>
            <div><dt title="Players this one has eliminated in this game">KOs</dt><dd>{kills}</dd></div>
          </dl>
          {continents.length > 0 && (
            <p className="player-card-continents">
              <span className="muted">Holds </span>
              {continents.join(', ')}
            </p>
          )}

          <h3 className="player-card-section">Ranking</h3>
          {row ? (
            <dl className="player-card-stats">
              <div className="wide"><dt>Rank</dt><dd>{row.rank ? `#${row.rank}` : 'Unranked'}</dd></div>
              <div className="wide"><dt>Points</dt><dd className="points">{row.points}</dd></div>
              <div><dt>W / L</dt><dd>{row.wins} / {row.losses}</dd></div>
              <div><dt>Win rate</dt><dd>{row.games ? `${row.winRate}%` : '—'}</dd></div>
              <div><dt>Games</dt><dd>{row.games}</dd></div>
              <div><dt>Avg place</dt><dd>{row.games ? row.avgPlacement.toFixed(2) : '—'}</dd></div>
              <div><dt>Kills</dt><dd>{row.kills ?? 0}</dd></div>
            </dl>
          ) : (
            <p className="muted small" role="status">{error ? 'Ranking unavailable right now.' : 'Loading ranking…'}</p>
          )}
        </div>
      )}
    </section>
  );
}
