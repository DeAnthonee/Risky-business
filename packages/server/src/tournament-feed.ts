import type { GameRoom, Store } from './store.js';
import type { TournamentMatch, TournamentSnapshot } from './tournaments.js';
import { excitementScore, type Excitement } from './excitement.js';

/**
 * The tournament feed (orchestration PR 9): live summaries of a tournament's current tables for its watchers, over the
 * WebSocket. Each table's summary is sent at most every `FEED_TABLE_MS` (2 updates a second), the last change of a
 * burst always arrives, and each carries the table's excitement score (excitement.ts) for "Follow the action".
 *
 * Spectators only: it is built from each table's public spectator view and carries no player-type labels, so a
 * socket holding an entrant token of the tournament is refused (seated players use wait_for_match and their table).
 * One hub per watched tournament builds every message once and writes the same string to each of its sockets.
 */

export const FEED_TABLE_MS = 500;
/** How far back a table's events count for its excitement (the longest signal window is 30 s). */
const RECENT_MS = 30_000;

export interface FeedPlayer {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  territories: number;
  armies: number;
}

export interface FeedTable {
  gameId: string;
  name: string;
  round: number;
  /** The table's status in the bracket ('playing', 'finished', 'decided', 'abandoned'). */
  status: TournamentMatch['status'];
  phase: string;
  turn: number;
  currentPlayer: string | null;
  players: FeedPlayer[];
  /** The tournament's last table (its excitement includes the final's bonus). */
  final: boolean;
  excitement: Excitement;
  version: number;
}

/** Whether `m` in round `r` (1-based) is the tournament's final table. */
function isFinal(t: TournamentSnapshot, round: number): boolean {
  const planned = (t.nested?.plan as { rounds?: unknown[] } | undefined)?.rounds?.length;
  if (planned) return round === planned;
  // A knockout: the round has a single table.
  return (t.rounds[round - 1]?.matches.filter((x) => x.gameId).length ?? 0) === 1;
}

/** One table's summary from its room's spectator view. */
export function tableSummary(t: TournamentSnapshot, round: number, m: TournamentMatch, room: GameRoom, now = Date.now()): FeedTable {
  const view = room.view(null);
  const final = isFinal(t, round);
  const recent = room.history.filter((h) => now - h.at <= RECENT_MS);
  const players = view.players
    .filter((p) => !p.isNeutral)
    .map((p) => {
      const held = Object.values(view.territories).filter((x) => x.owner === p.id);
      return { id: p.id, name: p.name, color: p.color, alive: p.alive, territories: held.length, armies: held.reduce((n, x) => n + x.armies, 0) };
    });
  return {
    gameId: room.id,
    name: room.name,
    round,
    status: m.status,
    phase: view.phase,
    turn: view.turnNumber,
    currentPlayer: view.currentPlayer,
    players,
    final,
    excitement: excitementScore(view, recent, now, { final }),
    version: view.version,
  };
}

interface Socket {
  send(json: string): void;
}

/** The feed of one tournament: its current round's tables, watched while anyone subscribes. */
class TournamentHub {
  sockets = new Set<Socket>();
  private watched = new Map<string, { room: GameRoom; off: () => void; last: number; timer: NodeJS.Timeout | null }>();
  private onTournament = (id: string) => {
    if (id === this.id) this.refresh();
  };

  constructor(
    private store: Store,
    private id: string,
  ) {
    store.tournaments.on('change', this.onTournament);
    this.refresh();
  }

  private tournament(): TournamentSnapshot | undefined {
    return this.store.tournaments.get(this.id);
  }

  /** Everything a new watcher needs: the bracket and every current table. */
  snapshot(): string {
    const t = this.tournament();
    if (!t) return JSON.stringify({ type: 'tournament_closed', tournamentId: this.id });
    return JSON.stringify({ type: 'tournament_feed', tournamentId: t.id, tournament: this.store.tournaments.view(t.id), tables: this.tables(t) });
  }

  private tables(t: TournamentSnapshot): FeedTable[] {
    const r = t.rounds.length;
    const out: FeedTable[] = [];
    for (const m of t.rounds.at(-1)?.matches ?? []) {
      const room = m.gameId ? this.store.get(m.gameId) : undefined;
      if (room && !room.closed) out.push(tableSummary(t, r, m, room));
    }
    return out;
  }

  private broadcast(json: string) {
    for (const s of this.sockets) s.send(json);
  }

  /** The bracket changed (a table settled, a round began): watch the current round's tables and send the bracket. */
  private refresh() {
    const t = this.tournament();
    if (!t) {
      this.broadcast(JSON.stringify({ type: 'tournament_closed', tournamentId: this.id }));
      return this.unwatchAll();
    }
    const round = t.rounds.length;
    const current = new Map((t.rounds.at(-1)?.matches ?? []).filter((m) => m.gameId).map((m) => [m.gameId!, m]));
    for (const [gameId, w] of this.watched) if (!current.has(gameId)) this.unwatch(gameId, w);
    for (const [gameId, m] of current) {
      if (this.watched.has(gameId)) continue;
      const room = this.store.get(gameId);
      if (!room || room.closed) continue;
      const entry = { room, off: () => {}, last: 0, timer: null as NodeJS.Timeout | null };
      const onChange = () => this.tableChanged(gameId, round, m);
      room.on('change', onChange);
      entry.off = () => room.off('change', onChange);
      this.watched.set(gameId, entry);
    }
    this.broadcast(JSON.stringify({ type: 'tournament', tournamentId: t.id, tournament: this.store.tournaments.view(t.id) }));
  }

  /** A table moved: send its summary now, or once FEED_TABLE_MS has passed since the last one (coalescing a burst). */
  private tableChanged(gameId: string, round: number, m: TournamentMatch) {
    const w = this.watched.get(gameId);
    if (!w || w.timer) return;
    const send = () => {
      w.timer = null;
      w.last = Date.now();
      const t = this.tournament();
      if (!t || w.room.closed) return;
      this.broadcast(JSON.stringify({ type: 'tournament_table', tournamentId: t.id, table: tableSummary(t, round, m, w.room, w.last) }));
    };
    const wait = w.last + FEED_TABLE_MS - Date.now();
    if (wait <= 0) send();
    else w.timer = setTimeout(send, wait);
  }

  private unwatch(gameId: string, w: { off: () => void; timer: NodeJS.Timeout | null }) {
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
   * Subscribe a spectator socket. Returns the first message to send (the whole feed), or an error: unknown tournament,
   * or a token belonging to one of its entrants (the feed is for spectators only).
   */
  subscribe(tournamentId: string, socket: Socket, token?: string): { ok: true; first: string } | { ok: false; error: string } {
    const t = this.store.tournaments.get(tournamentId);
    if (!t) return { ok: false, error: 'Tournament not found' };
    if (token && t.entrants.some((e) => e.token === token)) return { ok: false, error: 'The tournament feed is for spectators: entrants follow their own table (wait_for_match)' };
    let hub = this.hubs.get(t.id);
    if (!hub) this.hubs.set(t.id, (hub = new TournamentHub(this.store, t.id)));
    hub.sockets.add(socket);
    return { ok: true, first: hub.snapshot() };
  }

  unsubscribe(tournamentId: string, socket: Socket) {
    const hub = this.hubs.get(tournamentId.toUpperCase());
    if (!hub) return;
    hub.sockets.delete(socket);
    if (!hub.sockets.size) {
      hub.dispose();
      this.hubs.delete(tournamentId.toUpperCase());
    }
  }

  /** Hubs being watched (tests, healthz-style checks). */
  get size(): number {
    return this.hubs.size;
  }

  close() {
    for (const hub of this.hubs.values()) hub.dispose();
    this.hubs.clear();
  }
}
