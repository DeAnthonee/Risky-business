// Live table summaries for a nested tournament's page: the server's tournament feed over the WebSocket (one compact
// message per changed table, throttled; docs/http-api.md), or, on a server without it, a slow poll of the live tables.
import { useEffect, useRef, useState } from 'react';
import { PLAYER_COLORS, getMap, type GameView } from '@risk/engine';
import { api, WS_URL, type TournamentView } from './api';
import type { TableSnapshot } from './components/Inception';

/** One table in the feed (`tournament_tables` messages). */
export interface FeedTable {
  /** Index into the tournament's `nested.nodes`. */
  node: number;
  gameId: string | null;
  version: number;
  status: TableSnapshot['status'];
  players: { name: string; color: string; alive: boolean }[];
  /** Owner of each territory, in `getMap(node.map).territoryIds` order, as an index into `players` (null: nobody). */
  owners: (number | null)[] | null;
  /** The server sends null for "no leader yet" and "no reason". */
  leader?: number | null;
  excitement?: { score: number; why?: string | null };
}

export interface TournamentFeed {
  tables: Record<number, FeedTable>;
  /** The server's pick for "Follow the action" (the same for every watcher), when the live feed is on. */
  follow: { node: number; caption: string } | null;
  /** True when the server's live feed is running (follow needs it); false while polling. */
  live: boolean;
}

const POLL_MS = 5000;
const MAX_POLLED = 40;
/** How long to wait for the live feed before polling instead. */
const FEED_WAIT_MS = 4000;
/** Reconnect backoff after the socket drops (a deploy restart, a network blip): 1 s, 2 s, 4 s ... up to 30 s. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function useTournamentFeed(t: TournamentView | null): TournamentFeed {
  const [feed, setFeed] = useState<TournamentFeed>({ tables: {}, follow: null, live: false });
  const view = useRef(t);
  view.current = t;
  const id = t?.id;
  const nested = t?.format === 'nested' && t.status !== 'registering';

  useEffect(() => {
    if (!id || !nested) return;
    let alive = true;
    let live = false;
    let pollTimer = 0;
    let retryTimer = 0;
    let retryMs = RECONNECT_MIN_MS;
    let ws: WebSocket | null = null;
    // The tournament is gone: no feed to wait for, no reconnecting; the bracket's long-poll says what happened.
    let closed = false;

    const startPolling = (delay: number) => {
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(poll, delay);
    };
    const connect = () => {
      const socket = new WebSocket(WS_URL);
      ws = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe_tournament', id }));
      socket.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; full?: boolean; tables?: FeedTable[]; follow?: TournamentFeed['follow'] };
        if (!alive) return;
        if (m.type === 'tournament_closed') {
          closed = true;
          live = false;
          setFeed((f) => ({ ...f, follow: null, live: false }));
          socket.close();
          return;
        }
        if (m.type !== 'tournament_tables') return;
        live = true;
        retryMs = RECONNECT_MIN_MS;
        window.clearTimeout(pollTimer);
        setFeed((f) => {
          // The first message (and any resync) has every table; later ones only the tables that changed.
          const tables = m.full ? {} : { ...f.tables };
          for (const x of m.tables ?? []) if (x.node !== null && x.node !== undefined) tables[x.node] = x;
          return { tables, follow: m.follow ?? null, live: true };
        });
      };
      // The socket dropped: stop trusting the feed (follow off), poll meanwhile, and reconnect with backoff.
      socket.onclose = () => {
        if (!alive || ws !== socket) return;
        live = false;
        setFeed((f) => ({ ...f, follow: null, live: false }));
        if (closed) return;
        startPolling(0);
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
      };
    };
    connect();

    // No live feed on this server: poll the tables being played, a few at a time.
    const poll = async () => {
      if (!alive || live) return;
      const tv = view.current;
      const round = tv?.rounds.at(-1);
      const tables: Record<number, FeedTable> = {};
      for (const r of tv?.rounds ?? []) for (const m of r.matches) if (m.node !== undefined) tables[m.node] = fromMatch(m);
      const playing = (round?.matches ?? []).filter((m) => m.status === 'playing' && m.gameId && m.node !== undefined).slice(0, MAX_POLLED);
      for (const m of playing) {
        try {
          const g = await api.getGame(m.gameId!);
          tables[m.node!] = fromState(m.node!, m.gameId!, g.state);
        } catch {
          // The room may have just closed; the bracket says how it ended.
        }
        if (!alive || live) return;
      }
      setFeed({ tables, follow: null, live: false });
      if (!closed) pollTimer = window.setTimeout(poll, POLL_MS);
    };
    startPolling(FEED_WAIT_MS);

    return () => {
      alive = false;
      window.clearTimeout(pollTimer);
      window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [id, nested]);

  return feed;
}

type Match = TournamentView['rounds'][number]['matches'][number];

/** A table known only from the bracket: its seats and how it ended. */
function fromMatch(m: Match): FeedTable {
  const status: TableSnapshot['status'] = m.status === 'decided' ? 'decided' : m.status === 'finished' || m.status === 'bye' ? 'finished' : m.status === 'playing' ? 'playing' : 'waiting';
  const leader = m.winner ? m.players.findIndex((p) => p.entrantId === m.winner) : -1;
  return {
    node: m.node!,
    gameId: m.gameId,
    version: 0,
    status,
    players: m.players.map((p, k) => ({ name: p.name, color: PLAYER_COLORS[k % PLAYER_COLORS.length], alive: !m.winner || p.entrantId === m.winner })),
    owners: null,
    ...(leader >= 0 ? { leader } : {}),
  };
}

/** A live table from its spectator view. */
function fromState(node: number, gameId: string, s: GameView): FeedTable {
  const seats = s.players.filter((p) => !p.isNeutral);
  const index = new Map(seats.map((p, k) => [p.id, k]));
  const owners = getMap(s.options.map).territories.map((t) => {
    const o = s.territories[t.id]?.owner;
    return o === null || o === undefined ? null : (index.get(o) ?? null);
  });
  const counts = seats.map((_, k) => owners.filter((o) => o === k).length);
  const leader = s.winner ? (index.get(s.winner) ?? 0) : counts.indexOf(Math.max(...counts));
  return {
    node,
    gameId,
    version: s.version,
    status: s.phase === 'finished' ? 'finished' : 'playing',
    players: seats.map((p) => ({ name: p.name, color: p.color, alive: p.alive })),
    owners,
    leader,
  };
}

/** The feed's compact table as the Inception view's snapshot (owners keyed by territory id). */
export function toSnapshot(table: FeedTable, mapId: string): TableSnapshot {
  const territories = getMap(mapId).territories;
  const owners = table.owners ? Object.fromEntries(territories.map((t, i) => [t.id, table.owners![i] ?? null])) : undefined;
  return {
    players: table.players,
    status: table.status,
    ...(owners ? { owners } : {}),
    ...(table.gameId ? { gameId: table.gameId } : {}),
    ...(table.leader !== undefined && table.leader !== null ? { leader: table.leader } : {}),
  };
}
