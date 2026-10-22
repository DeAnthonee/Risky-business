import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EntrantResult } from './tournament-seat.js';

/**
 * The Delove seat pool (`npm run delove-pool`): a daemon that fills tournaments' Delove seats on request
 * (docs/tournaments.md "Delove seats on request", the server's seat-requests.ts). Every ~30 s it polls the server with
 * its free capacity, claims open requests it has room for, joins each claimed seat ("Delove 7", ...) with the request
 * id and its key, reports `done` (or `failed` with the seats it could not join, which go back to the request), and
 * plays the seats like `delove-seat --tournament` does, spread over child processes (ChildPool, pool-cli.ts).
 *
 * Seats: the best network (the newest delove@N, or `model`), bare; a claim's search seats (fog off only) play
 * `<model>+search`. Under fog every seat is bare, and only a fog-trained network takes fog seats: a pool whose network
 * has no fog inputs leaves fog requests for later rather than seat a fog-blind player.
 *
 * The key (RISK_SEAT_POOL_KEY) goes only in the `x-seat-pool-key` header; it is never logged or written to disk.
 */

/** One open request as the server lists it (GET /api/seat-requests). */
export interface PoolRequest {
  id: string;
  kind: string;
  tournamentId: string;
  n: number;
  claimed: number;
  fog: boolean;
  searchAllowed: boolean;
  status: string;
}

/** A claim (POST /api/seat-requests/:id/claim). */
export interface PoolClaim {
  requestId: string;
  tournamentId: string;
  n: number;
  search: number;
  labelPrefix: string;
  firstLabel: number;
}

/** A seat the pool joined and plays: everything needed to play it again after a restart. */
export interface PoolEntrant {
  tournamentId: string;
  requestId: string;
  name: string;
  /** Entrant token (a secret: kept in the state file, never logged). */
  token: string;
  /** The player: `delove@N` or `delove@N+search`. */
  agentId: string;
  search: boolean;
}

export interface PoolOptions {
  server: string;
  key: string;
  /** The network the seats play (delove@N). */
  model: string;
  /** Whether that network reads fog inputs (fog-trained): only then does the pool take fog seats. */
  modelFog: boolean;
  /** Seats in play at most (default 40) and search seats in play at most (default 20). */
  maxSeats: number;
  maxSearch: number;
  /** Plays a seat to the end of its tournament (child processes in the daemon, in-process in tests). */
  play: (e: PoolEntrant) => Promise<EntrantResult>;
  /** Seats in play are kept here, so a restarted pool plays them on. */
  stateFile?: string | null;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export class PoolHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const key = (e: PoolEntrant) => `${e.tournamentId}/${e.name}`;

export class SeatPool {
  private readonly inPlay = new Map<string, PoolEntrant>();
  private stopping = false;
  private readonly skipped = new Set<string>();
  private readonly log: (line: string) => void;
  private readonly http: typeof fetch;
  /** The last poll's outcome, for the CLI and the tests. */
  lastError: PoolHttpError | Error | null = null;

  constructor(private readonly o: PoolOptions) {
    this.log = o.log ?? (() => {});
    this.http = o.fetch ?? fetch;
  }

  get seats(): PoolEntrant[] {
    return [...this.inPlay.values()];
  }

  get free(): { free: number; freeSearch: number } {
    const search = this.seats.filter((e) => e.search).length;
    return { free: Math.max(0, this.o.maxSeats - this.inPlay.size), freeSearch: Math.max(0, this.o.maxSearch - search) };
  }

  /** Plays on the seats a previous run left in the state file (their tournaments say where each one stands). */
  resume(): number {
    const f = this.o.stateFile;
    if (!f || !existsSync(f)) return 0;
    let saved: PoolEntrant[] = [];
    try {
      saved = (JSON.parse(readFileSync(f, 'utf8')) as { entrants?: PoolEntrant[] }).entrants ?? [];
    } catch (e) {
      this.log(`state file ${f} unreadable (${(e as Error).message}); starting empty`);
    }
    for (const e of saved) this.start(e);
    if (saved.length) this.log(`resumed ${saved.length} seat(s) from ${f}`);
    return saved.length;
  }

  /** One round: report capacity, claim what fits, join, report, start playing. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const { free, freeSearch } = this.free;
    let list: { requests: PoolRequest[] };
    try {
      list = await this.call('GET', `/seat-requests?kind=delove&free=${free}&freeSearch=${freeSearch}`);
      this.lastError = null;
    } catch (e) {
      this.lastError = e as Error;
      const s = (e as PoolHttpError).status;
      this.log(
        s === 404
          ? 'seat requests are off on this server (it needs RISK_SEAT_POOL_KEY) or the route is missing'
          : s === 401 || s === 403
            ? 'the server refused the pool key (RISK_SEAT_POOL_KEY)'
            : s === 429
              ? 'the server locked the pool key out for a while (too many wrong keys)'
              : `poll failed: ${(e as Error).message}`,
      );
      return;
    }
    let room = free;
    let searchRoom = freeSearch;
    for (const r of list.requests) {
      if (this.stopping || room <= 0) break;
      if (r.kind !== 'delove' || r.n - r.claimed <= 0 || (r.status !== 'open' && r.status !== 'claimed')) continue;
      if (r.fog && !this.o.modelFog) {
        if (!this.skipped.has(r.id)) this.log(`request ${r.id} (${r.tournamentId}) plays with fog: ${this.o.model} is not fog-trained, left for another pool`);
        this.skipped.add(r.id);
        continue;
      }
      const joined = await this.fill(r, Math.min(r.n - r.claimed, room), searchRoom);
      room -= joined.length;
      searchRoom -= joined.filter((e) => e.search).length;
    }
  }

  /** Claims `n` seats of request `r`, joins them, reports, and starts playing those that joined. */
  private async fill(r: PoolRequest, n: number, searchRoom: number): Promise<PoolEntrant[]> {
    let c: PoolClaim;
    try {
      c = await this.call('POST', `/seat-requests/${r.id}/claim`, { n });
    } catch (e) {
      this.log(`claim of request ${r.id} failed: ${(e as Error).message}`);
      return [];
    }
    const searchSeats = r.fog ? 0 : Math.max(0, Math.min(c.search, searchRoom));
    const joined: PoolEntrant[] = [];
    let reason = '';
    for (let k = 0; k < c.n; k++) {
      if (this.stopping) {
        reason = 'the pool is stopping';
        break;
      }
      const search = k < searchSeats;
      const name = `${c.labelPrefix} ${c.firstLabel + k}`;
      const agentId = search ? `${this.o.model}+search` : this.o.model;
      try {
        const res = await this.call<{ token: string }>('POST', `/tournaments/${c.tournamentId}/join`, {
          playerName: name,
          agent: search ? `${this.o.model} + search` : this.o.model,
          seatRequestId: c.requestId,
        });
        const e: PoolEntrant = { tournamentId: c.tournamentId, requestId: c.requestId, name, token: res.token, agentId, search };
        joined.push(e);
        this.start(e);
      } catch (err) {
        reason = `${name}: ${(err as Error).message}`;
        break;
      }
    }
    try {
      if (joined.length === c.n) await this.call('POST', `/seat-requests/${c.requestId}/done`, { joined: joined.length });
      else await this.call('POST', `/seat-requests/${c.requestId}/failed`, { joined: joined.length, reason });
    } catch (e) {
      this.log(`report for request ${c.requestId} failed: ${(e as Error).message}`);
    }
    this.log(`request ${c.requestId} (${c.tournamentId}): ${joined.length}/${c.n} seats joined${searchSeats ? `, ${Math.min(searchSeats, joined.length)} with search` : ''}${reason ? ` (stopped: ${reason})` : ''}`);
    return joined;
  }

  private start(e: PoolEntrant) {
    this.inPlay.set(key(e), e);
    this.save();
    this.o
      .play(e)
      .then((r) => this.log(`${e.name} (${e.tournamentId}): ${r.status} after ${r.tables} table(s)`))
      .catch((err) => this.log(`${e.name} (${e.tournamentId}) stopped: ${(err as Error).message}`))
      .finally(() => {
        if (this.stopping) return; // kept in the state file: a restarted pool plays it on
        this.inPlay.delete(key(e));
        this.save();
      });
  }

  /** Stop claiming; the seats in play stay in the state file for the next run. */
  stop(): void {
    this.stopping = true;
    this.save();
  }

  private save() {
    const f = this.o.stateFile;
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, JSON.stringify({ entrants: this.seats }, null, 1), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.o.server.replace(/\/+$/, '')}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-seat-pool-key': this.o.key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new PoolHttpError(`${res.status} ${(json as { error?: string } | null)?.error ?? res.statusText}`, res.status);
    return json as T;
  }
}

/** A child process as ChildPool sees it (node's ChildProcess, or a fake in tests). */
export interface ChildLike {
  pid?: number;
  send(message: unknown): unknown;
  on(event: 'message', fn: (m: unknown) => void): unknown;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Messages to a pool child: play a seat; and from it: a seat's end. */
export type ToChild = { type: 'play'; entrant: PoolEntrant; server: string; pace: number };
export type FromChild = { type: 'end'; key: string; result: EntrantResult } | { type: 'error'; key: string; message: string };

/**
 * Plays the pool's seats on `procs` child processes, the seats spread over them (search seats first, they are the
 * expensive ones). A child that dies is replaced, and its seats are handed to the new one: each seat re-reads its
 * tournament with its token and plays on.
 */
export class ChildPool {
  private readonly children: { child: ChildLike; seats: Map<string, PoolEntrant> }[] = [];
  private readonly waiting = new Map<string, { resolve: (r: EntrantResult) => void; reject: (e: Error) => void }>();
  private stopped = false;

  constructor(
    private readonly procs: number,
    private readonly forkChild: () => ChildLike,
    private readonly server: string,
    private readonly pace: number,
    private readonly log: (line: string) => void = () => {},
  ) {}

  play(e: PoolEntrant): Promise<EntrantResult> {
    return new Promise((resolve, reject) => {
      this.waiting.set(key(e), { resolve, reject });
      const slot = this.pick();
      slot.seats.set(key(e), e);
      slot.child.send({ type: 'play', entrant: e, server: this.server, pace: this.pace } satisfies ToChild);
    });
  }

  /** Children alive now (for the tests and the status line). */
  get size(): number {
    return this.children.length;
  }

  /** The least loaded child (a search seat weighs 4, a bare one 1), spawning up to `procs` children first. */
  private pick() {
    while (this.children.length < this.procs) this.spawn();
    const load = (s: { seats: Map<string, PoolEntrant> }) => [...s.seats.values()].reduce((a, x) => a + (x.search ? 4 : 1), 0);
    return this.children.reduce((best, s) => (load(s) < load(best) ? s : best));
  }

  private spawn() {
    const slot = { child: this.forkChild(), seats: new Map<string, PoolEntrant>() };
    this.children.push(slot);
    slot.child.on('message', (m) => {
      const msg = m as FromChild;
      const w = this.waiting.get(msg.key);
      slot.seats.delete(msg.key);
      this.waiting.delete(msg.key);
      if (!w) return;
      if (msg.type === 'end') w.resolve(msg.result);
      else w.reject(new Error(msg.message));
    });
    slot.child.on('exit', (code) => {
      const i = this.children.indexOf(slot);
      if (i >= 0) this.children.splice(i, 1);
      if (this.stopped || slot.seats.size === 0) return;
      this.log(`child ${slot.child.pid ?? '?'} exited (${code}); its ${slot.seats.size} seat(s) go to a new one`);
      for (const e of slot.seats.values()) {
        const next = this.pick();
        next.seats.set(key(e), e);
        next.child.send({ type: 'play', entrant: e, server: this.server, pace: this.pace } satisfies ToChild);
      }
    });
    return slot;
  }

  /** Stop every child (SIGTERM); the seats stay with the pool's state file. */
  stop(): void {
    this.stopped = true;
    for (const s of this.children) s.child.kill('SIGTERM');
  }
}
