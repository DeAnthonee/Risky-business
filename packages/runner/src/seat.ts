import type { GameView, PlayerId } from '@risk/engine';
import { RiskHttpError, type RiskApi, type WaitResult } from '@risk/mcp';
import { GameMemory, type ObservedBatch } from './game-memory.js';
import type { Commander } from './commander.js';
import { cleanChat, type ChatMsg, type Diplomat, type Outgoing } from './diplomat.js';
import { choosePlannedAction, StallTracker } from './planned-bot.js';
import { backoffMs, isTransient } from './resilient.js';
import { chooseMove } from './view-state.js';

export interface SeatOptions {
  api: RiskApi;
  gameId: string;
  playerId: PlayerId;
  /** This seat's secret; never logged. */
  token: string;
  name: string;
  diplomat: Diplomat | null;
  /** Sets a plan at the start of each own turn (and picks the capital). Null = the plan-less planned bot. */
  commander?: Commander | null;
  /** Which move chooser plays: the plan-aware bot (default) or the engine's built-in bot. */
  chooser?: 'planned' | 'engine';
  /** Every view this seat sees (after waits and its own actions). */
  onView?: (view: GameView) => void;
  /** Pause after each action so spectators can follow. */
  paceMs: number;
  log: (line: string) => void;
  random?: () => number;
}

const WAIT_MS = 25_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One seat: waits for its turn, plays the engine bot's moves, and lets the diplomat talk on the side. */
export class SeatRunner {
  private memory: GameMemory;
  private stopped = false;
  private latestView: GameView | null = null;
  private lastGreeted = -1;
  private chatSince = 0;
  private pending = new Set<Promise<void>>();
  private random: () => number;
  private lastPlanned = -1;
  private chatSeen: ChatMsg[] = [];
  private stall = new StallTracker();
  private wake: () => void = () => {};
  private woken = new Promise<'stop'>((resolve) => (this.wake = () => resolve('stop')));

  constructor(private o: SeatOptions) {
    this.random = o.random ?? Math.random;
    const ledger = o.commander?.ledger ?? o.diplomat?.ledger;
    this.memory = new GameMemory(
      o.playerId,
      () => ledger?.all() ?? [],
      (attackerId, defenderId, armies) => {
        const v = this.latestView;
        if (!v || !ledger) return;
        const attacker = v.players.find((p) => p.id === attackerId)?.name;
        const defender = v.players.find((p) => p.id === defenderId)?.name;
        if (attacker && defender) ledger.noteCommitment(attacker, defender, armies);
      },
    );
    o.commander?.setGameMemory((view) => this.memory.summary(view));
    o.commander?.setStall(() => this.stall.stall);
    o.diplomat?.setGameMemory((view) => this.memory.summary(view));
    o.diplomat?.setStall(() => this.stall.stall);
    o.diplomat?.setViewRefresher(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await Promise.race([
          o.api.getGame(o.gameId, o.token),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('chat freshness check timed out')), 5000); }),
        ]);
        this.seen(info.state);
        return this.latestView ?? info.state;
      } finally { clearTimeout(timer); }
    }, line => o.log(`${o.name}: ${line}`));
  }

  stop() {
    this.stopped = true;
    this.wake();
  }

  /** Chat this seat could read during the game (for the post-game write-up). */
  memoryText(): string { return this.latestView ? this.memory.summary(this.latestView) : 'No game observations yet.'; }

  chatLines(): ChatMsg[] {
    return this.chatSeen;
  }

  /** Plays until the game is finished (or stop() is called); resolves with the last view seen. */
  async run(): Promise<GameView | null> {
    const { api, gameId, token } = this.o;
    let since: number | undefined;
    let view: GameView | null = null;
    let failures = 0;
    while (!this.stopped) {
      let w: WaitResult;
      const started = Date.now();
      try {
        const polled = api.wait(gameId, token, since, WAIT_MS);
        polled.catch(() => {});
        const got = await Promise.race([polled, this.woken]);
        if (got === 'stop') break;
        w = got;
        failures = 0;
      } catch (e) {
        if (e instanceof RiskHttpError && (e.status === 404 || e.status === 401)) {
          this.o.log(`${this.o.name}: game is gone (${e.message})`);
          return view;
        }
        // Back off (1 s, 2 s, 4 s ... up to 30 s) instead of hammering a struggling server.
        const pause = backoffMs(Math.min(failures++, 5), 1000, 30_000, this.random);
        this.o.log(`${this.o.name}: wait failed: ${errText(e)}; retrying in ${(pause / 1000).toFixed(1)} s`);
        await sleep(pause);
        continue;
      }
      const unchanged = since !== undefined && w.state.version === since;
      view = w.state;
      since = view.version;
      this.seen(view, w.events);
      this.fetchChat(view);
      if (view.phase === 'finished') break;
      if (w.yourTurn) {
        const before = view.version;
        view = await this.playTurn(view);
        since = view.version;
        this.seen(view);
        if (view.phase === 'finished') break;
        // Nothing moved (act refused and no end_turn): do not spin on an immediate 'turn' answer.
        if (view.version === before) await sleep(500);
      } else if (unchanged && Date.now() - started < 1000) {
        // The server answered at once with nothing new: never spin on it.
        await sleep(1000);
      }
    }
    return view;
  }

  private seen(view: GameView, batches: ObservedBatch[] = []) {
    const breaches=this.memory.observe(view,batches); // Late event batches still matter after a newer board arrives.
    const ledger=this.o.commander?.ledger ?? this.o.diplomat?.ledger;
    for(const breach of breaches) {
      const attacker=view.players.find(p=>p.id===breach.player)?.name;
      if(attacker) ledger?.noteHit(attacker,new Set([breach.agreementId]));
    }
    if (this.latestView && view.version < this.latestView.version) return;
    this.latestView = view;
    this.o.diplomat?.observe(view);
    this.o.commander?.observe(view);
    this.stall.observe(view, this.o.playerId);
    this.o.onView?.(view);
  }

  /** Waits (bounded by the commander's own timeout) for this turn's plan, or the capital pick. */
  private async consult(view: GameView) {
    const c = this.o.commander;
    if (!c) return;
    try {
      if (view.phase === 'capitals' && (view.legal?.capitalChoices.length ?? 0) > 0) await c.chooseCapital(view);
      else if (view.phase === 'reinforce' && view.turnNumber !== this.lastPlanned) {
        this.lastPlanned = view.turnNumber;
        await c.planFor(view);
      }
    } catch (e) {
      this.o.log(`${this.o.name}: commander failed: ${errText(e)}`);
    }
  }

  /** Acts until the turn passes or the game ends; returns the latest view. */
  private async playTurn(first: GameView): Promise<GameView> {
    const { api, gameId, token, playerId, name, paceMs } = this.o;
    let view = first;
    await this.consult(view);
    if (this.o.diplomat && view.phase === 'reinforce' && view.turnNumber !== this.lastGreeted) {
      this.lastGreeted = view.turnNumber;
      this.fire(this.o.diplomat.onTurnStart(view));
    }
    while (!this.stopped && view.phase !== 'finished' && view.legal?.yourTurn) {
      if (view.phase === 'reinforce' && view.turnNumber !== this.lastPlanned) await this.consult(view);
      const action =
        this.o.chooser === 'engine' ? chooseMove(view, playerId, this.random) : choosePlannedAction(view, playerId, this.o.commander?.currentPlan() ?? null, this.random, this.stall.stall);
      if (!action) {
        this.o.log(`${name}: no move available in phase ${view.phase}`);
        break;
      }
      let actionEvents: import('@risk/engine').GameEvent[] = [];
      try {
        const result = await api.act(gameId, token, action);
        view = result.state;
        actionEvents = result.events;
      } catch (e) {
        if (!(e instanceof RiskHttpError) || isTransient(e)) {
          // Network trouble or a server error: the move may or may not have landed. Pause, then let the wait loop
          // re-read the state rather than guessing (no end_turn).
          this.o.log(`${name}: ${action.type} failed: ${errText(e)}; re-reading the state shortly`);
          await sleep(2000);
          break;
        }
        this.o.log(`${name}: ${action.type} refused: ${e.message}`);
        if (action.type !== 'end_turn' && view.legal?.canEndTurn) {
          try {
            const ended = await api.act(gameId, token, { type: 'end_turn' });
            view = ended.state;
            actionEvents = ended.events;
          } catch (e2) {
            this.o.log(`${name}: end_turn refused: ${errText(e2)}`);
            break;
          }
        } else break;
      }
      this.seen(view, actionEvents.length ? [{ version:view.version, events:actionEvents }] : []);
      if (paceMs > 0) await sleep(paceMs);
    }
    return view;
  }

  /** Read what this seat may see (its own token) and hand it to the diplomat without blocking play. */
  private fetchChat(view: GameView) {
    const d = this.o.diplomat;
    const c = this.o.commander;
    if (!d && !c) return;
    this.fire(
      (async () => {
        const { messages } = await this.o.api.chat(this.o.gameId, this.chatSince, this.o.token);
        if (messages.length === 0) return;
        this.chatSince = Math.max(this.chatSince, ...messages.map((m) => m.id));
        this.chatSeen.push(...messages);
        if (this.chatSeen.length > 600) this.chatSeen.splice(0, this.chatSeen.length - 600);
        this.memory.onMessages(messages, this.latestView ?? view);
        c?.onMessages(messages);
        return d ? d.onMessages(messages, this.latestView ?? view) : null;
      })(),
    );
  }

  /** Run a diplomat call in the background: failures are logged, results posted, the move loop never waits. */
  private fire(p: Promise<Outgoing | null | void>) {
    const job = p
      .then(async (out) => {
        if (!out || this.stopped) return;
        const message = cleanChat(out.message);
        if (!message) return;
        await this.o.api.sendChat(this.o.gameId, this.o.token, message, out.to);
        const context = this.o.diplomat?.contextFor(out);
        this.o.log(`${this.o.name}${out.to ? ` -> ${out.to}` : ''}${context ? ` [round ${context.round}, turn ${context.turn}]` : ''}: ${message}`);
      })
      .catch((e) => this.o.log(`${this.o.name}: chat skipped: ${errText(e)}`))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
