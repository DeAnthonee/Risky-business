import { getMap } from '@risk/engine';
import type { GameRoom, Store } from './store.js';
import type { TournamentMatch, TournamentSnapshot } from './tournaments.js';
import { excitementScore, pickFollow, type Excitement, type FollowState } from './excitement.js';

/**
 * The tournament feed (orchestration PR 9): live summaries of a tournament's current tables for its watchers, over the
 * WebSocket, in the shape the client's tournament page draws (TableSnapshot in Inception.tsx). Each table is sent at
 * most every `FEED_TABLE_MS` (2 updates a second; the last change of a burst always arrives), with its excitement
 * score (excitement.ts) and the server's pick of the table to follow, so every watcher who turns "Follow the action"
 * on sees the same table.
 *
 * It is built from each table's public spectator view and carries names but no player-type labels. A socket that
 * sends an entrant token of the tournament is refused, but that check is cosmetic: an entrant can subscribe without
 * one and see every table, including their own fog table, as any spectator can (hardening #2). One hub per watched
 * tournament builds every message once and writes the same string to each of its sockets.
 */

export const FEED_TABLE_MS = 500;
/** How far back a table's events count for its excitement (the longest signal window is 30 s). */
const RECENT_MS = 30_000;

export interface FeedTable {
  /** Nested: the table's index in resolveNest(spec) order (the tournament view's nodes); null for a knockout. */
  node: number | null;
  gameId: string;
  version: number;
  round: number;
  status: 'waiting' | 'playing' | 'finished' | 'decided';
  /** Seat order; `owners` and `leader` index into it. */
  players: { name: string; color: string; alive: boolean }[];
  /** Owner of each territory, in getMap(map).territoryIds order, as an index into `players` (null: nobody or a blizzard). */
  owners: (number | null)[];
  /** Index into `players`: the winner once finished or decided, else the leader (territories, then armies). */
  leader: number | null;
  /** The tournament's last table. */
  final: boolean;
  excitement: { score: number; why: string | null; signals: Excitement['signals'] };
}

export interface FeedRound {
  /** The round number, 1-based. */
  n: number;
  /** When the round ends at the latest (absolute ms; nested only), else null. */
  deadline: number | null;
  /** Tables finished so far, and how many the round needs before the rest are decided on standing. */
  finished: number;
  needed: number;
}

export interface FeedFollow {
  node: number | null;
  gameId: string;
  caption: string;
}

/** Nested: [round][index] → node index, walking the plan breadth-first from the final like planToNest. */
export function nodeIndex(t: Pick<TournamentSnapshot, 'nested'>): Map<string, number> {
  const plan = t.nested?.plan;
  const out = new Map<string, number>();
  if (!plan?.rounds?.length) return out;
  const R = plan.rounds.length;
  const order: Array<[number, number]> = [[R - 1, 0]];
  for (let q = 0; q < order.length; q++) {
    const [round, index] = order[q];
    out.set(`${round}:${index}`, q);
    if (round > 0) for (const c of plan.rounds[round - 1].filter((x) => x.parent === index).sort((a, b) => a.portal! - b.portal!)) order.push([round - 1, c.index]);
  }
  return out;
}

function isFinal(t: TournamentSnapshot, round: number): boolean {
  const planned = t.nested?.plan?.rounds?.length;
  if (planned) return round === planned;
  // A knockout: a round with a single table is the final.
  return (t.rounds[round - 1]?.matches.filter((x) => x.gameId).length ?? 0) === 1;
}

/** One table's summary from its room's spectator view. */
export function tableSummary(t: TournamentSnapshot, round: number, m: TournamentMatch, room: GameRoom, now = Date.now(), nodes = nodeIndex(t)): FeedTable {
  const view = room.view(null);
  const final = isFinal(t, round);
  const seats = view.players.filter((p) => !p.isNeutral);
  const at = new Map(seats.map((p, i) => [p.id, i]));
  const ids = getMap(view.options.map).territoryIds;
  const owners = ids.map((id) => { const o = view.territories[id]?.owner; return o != null && at.has(o) ? at.get(o)! : null; });
  const held = (i: number) => ids.filter((_, k) => owners[k] === i);
  const armies = (i: number) => held(i).reduce((n, id) => n + (view.territories[id]?.armies ?? 0), 0);
  const winnerSeat = m.winner ? m.seats[m.winner]?.playerId : null;
  let leader: number | null = winnerSeat && at.has(winnerSeat) ? at.get(winnerSeat)! : null;
  if (leader === null && m.status === 'decided' && m.standing?.order[0]) leader = at.get(m.seats[m.standing.order[0]]?.playerId ?? '') ?? null;
  if (leader === null && seats.length)
    leader = seats.map((_, i) => i).sort((a, b) => held(b).length - held(a).length || armies(b) - armies(a) || a - b)[0];
  const status: FeedTable['status'] = m.status === 'decided' ? 'decided' : m.status === 'finished' || m.status === 'abandoned' ? 'finished' : view.phase === 'lobby' ? 'waiting' : 'playing';
  // The last 30 s of history, walked back from the end (a long game's history is never scanned in full).
  const recent = [];
  for (let i = room.history.length - 1; i >= 0 && now - room.history[i].at <= RECENT_MS; i--) recent.push(room.history[i]);
  const ex = excitementScore(view, recent, now, { final });
  return {
    node: m.node ?? (m.table !== undefined ? (nodes.get(`${round - 1}:${m.table}`) ?? null) : null),
    gameId: room.id,
    version: view.version,
    round,
    status,
    players: seats.map((p) => ({ name: p.name, color: p.color, alive: p.alive })),
    owners,
    leader,
    final,
    excitement: { score: ex.score, why: ex.signals[0]?.label ?? null, signals: ex.signals },
  };
}

function roundClock(t: TournamentSnapshot): FeedRound | null {
  const r = t.rounds.at(-1);
  if (!r) return null;
  const tables = r.matches.filter((m) => m.gameId);
  const finished = r.matches.filter((m) => m.status === 'finished' || m.status === 'bye').length;
  const needed = t.nested ? Math.ceil(t.nested.finishShare * r.matches.length) : r.matches.length;
  return { n: r.round, deadline: r.deadline ?? null, finished: Math.min(finished, r.matches.length), needed: tables.length ? needed : 0 };
}

interface Socket {
  send(json: string): void;
}

interface Watched {
  room: GameRoom;
  m: TournamentMatch;
  round: number;
  off: () => void;
  last: number;
  timer: NodeJS.Timeout | null;
  summary: FeedTable;
}

/** The feed of one tournament: its current round's tables, watched while anyone subscribes. */
class TournamentHub {
  sockets = new Set<Socket>();
  private watched = new Map<string, Watched>();
  private version = 0;
  private follow: FollowState = { tableId: null, since: 0 };
  private onTournament = (id: string) => {
    if (id === this.id) this.refresh();
  };

  constructor(
    private store: Store,
    private id: string,
  ) {
    store.tournaments.on('change', this.onTournament);
    this.refresh(false);
  }

  private tournament(): TournamentSnapshot | undefined {
    return this.store.tournaments.get(this.id);
  }

  /** The table to follow, picked once for every watcher (pickFollow: stay 20 s, switch for +15 or when a table ends). */
  private followPick(now: number): FeedFollow | null {
    const candidates = [...this.watched.values()].map((w) => ({
      tableId: w.room.id,
      name: w.room.name,
      finished: w.summary.status === 'finished' || w.summary.status === 'decided',
      excitement: { score: w.summary.excitement.score, signals: w.summary.excitement.signals },
    }));
    const p = pickFollow(this.follow, candidates, now);
    this.follow = p.state;
    const w = p.tableId ? this.watched.get(p.tableId) : undefined;
    return w && p.caption ? { node: w.summary.node, gameId: w.room.id, caption: p.caption } : null;
  }

  private message(tables: FeedTable[], full: boolean, now = Date.now()): string {
    const t = this.tournament();
    if (!t) return JSON.stringify({ type: 'tournament_closed', tournamentId: this.id });
    this.version++;
    return JSON.stringify({ type: 'tournament_tables', tournamentId: t.id, version: this.version, full, round: roundClock(t), tables, follow: this.followPick(now) });
  }

  /** Everything a new watcher needs: the bracket, then every current table. */
  snapshot(): string[] {
    const t = this.tournament();
    if (!t) return [JSON.stringify({ type: 'tournament_closed', tournamentId: this.id })];
    return [
      JSON.stringify({ type: 'tournament', tournamentId: t.id, tournament: this.store.tournaments.view(t.id) }),
      this.message([...this.watched.values()].map((w) => w.summary), true),
    ];
  }

  private broadcast(json: string) {
    for (const s of this.sockets) s.send(json);
  }

  /** The bracket changed (a table settled, a round began): watch the current round's tables and send the news. */
  private refresh(send = true) {
    const t = this.tournament();
    if (!t) {
      if (send) this.broadcast(JSON.stringify({ type: 'tournament_closed', tournamentId: this.id }));
      return this.unwatchAll();
    }
    const round = t.rounds.length;
    const nodes = nodeIndex(t);
    const current = new Map((t.rounds.at(-1)?.matches ?? []).filter((m) => m.gameId).map((m) => [m.gameId!, m]));
    for (const [gameId, w] of this.watched) if (!current.has(gameId) || w.round !== round) this.unwatch(gameId, w);
    const now = Date.now();
    for (const [gameId, m] of current) {
      const room = this.store.get(gameId);
      const w = this.watched.get(gameId);
      if (w) {
        w.m = m;
        w.summary = tableSummary(t, round, m, w.room, now, nodes); // its status may have changed
        continue;
      }
      if (!room || room.closed) continue;
      const entry: Watched = { room, m, round, off: () => {}, last: 0, timer: null, summary: tableSummary(t, round, m, room, now, nodes) };
      const onChange = () => this.tableChanged(gameId);
      room.on('change', onChange);
      entry.off = () => room.off('change', onChange);
      this.watched.set(gameId, entry);
    }
    if (!send) return;
    this.broadcast(JSON.stringify({ type: 'tournament', tournamentId: t.id, tournament: this.store.tournaments.view(t.id) }));
    this.broadcast(this.message([...this.watched.values()].map((x) => x.summary), true, now));
  }

  /** A table moved: send it now, or once FEED_TABLE_MS has passed since its last update (coalescing a burst). */
  private tableChanged(gameId: string) {
    const w = this.watched.get(gameId);
    if (!w || w.timer) return;
    const send = () => {
      w.timer = null;
      const t = this.tournament();
      if (!t || !this.watched.has(gameId)) return;
      w.last = Date.now();
      w.summary = tableSummary(t, w.round, w.m, w.room, w.last);
      this.broadcast(this.message([w.summary], false, w.last));
    };
    const wait = w.last + FEED_TABLE_MS - Date.now();
    if (wait <= 0) send();
    else w.timer = setTimeout(send, wait);
  }

  private unwatch(gameId: string, w: Watched) {
    w.off();
    if (w.timer) clearTimeout(w.timer);
    this.watched.delete(gameId);
  }

  private unwatchAll() {
    for (const [gameId, w] of this.watched) this.unwatch(gameId, w);
  }

  dispose() {
    this.store.tournaments.off('change', this.onTournament);
    this.unwatchAll();
  }
}

/** Every watched tournament's hub; a hub lives while it has a socket. */
export class TournamentFeeds {
  private hubs = new Map<string, TournamentHub>();

  constructor(private store: Store) {}

  /**
   * Subscribe a spectator socket. Returns the first messages to send (the bracket and every table), or an error:
   * unknown tournament, or a token belonging to one of its entrants (the feed is for spectators only).
   */
  subscribe(tournamentId: string, socket: Socket, token?: string): { ok: true; first: string[] } | { ok: false; error: string } {
    const t = this.store.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: 'Tournament not found' };
    if (token && t.entrants.some((e) => e.token === token)) return { ok: false, error: 'The tournament feed is for spectators: entrants follow their own table (wait_for_match)' };
    let hub = this.hubs.get(t.id);
    if (!hub) this.hubs.set(t.id, (hub = new TournamentHub(this.store, t.id)));
    hub.sockets.add(socket);
    return { ok: true, first: hub.snapshot() };
  }

  unsubscribe(tournamentId: string, socket: Socket) {
    const id = tournamentId.toUpperCase();
    const hub = this.hubs.get(id);
    if (!hub) return;
    hub.sockets.delete(socket);
    if (!hub.sockets.size) {
      hub.dispose();
      this.hubs.delete(id);
    }
  }

  get size(): number {
    return this.hubs.size;
  }

  close() {
    for (const hub of this.hubs.values()) hub.dispose();
    this.hubs.clear();
  }
}
