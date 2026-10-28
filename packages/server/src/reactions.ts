import type { GameEvent, GameState, PlayerId, TerritoryId } from '@risk/engine';
import { BIG_MOVE } from './excitement.js';
import { linesFor, type BigMoveKind } from './reaction-lines.js';

/**
 * Big-move reactions (Phase A, G7 step 1): when a player takes a lot from another in one turn, the room tells its
 * watchers with a short pop-up, a canned line from the attacker and a canned reply from the victim (reaction-lines.ts).
 * Presentation only: it changes no move and no outcome, so it lives in the server, not the engine, and is never part
 * of the game state, its events or its record. The thresholds are BIG_MOVE in excitement.ts.
 */

export interface BigMove {
  kind: BigMoveKind;
  attacker: PlayerId;
  victim: PlayerId;
  /** Territories the attacker took from the victim this turn. */
  taken: number;
  /** Where to show the pop-up: the last territory taken from the victim. */
  anchor: TerritoryId;
}

/** The wire message (WebSocket `big_move`). */
export interface BigMoveMessage {
  type: 'big_move';
  gameId: string;
  version: number;
  kind: BigMoveKind;
  attacker: { id: PlayerId; name: string };
  victim: { id: PlayerId; name: string };
  taken: number;
  anchor: TerritoryId;
  line: string;
  reply: string;
}

/**
 * Follows one game's turns: what each attacker takes from each victim, from `turn_started` to `turn_ended` (or
 * `game_over`), and what counts as big. Pure apart from its own tally; feed it every commit in order.
 */
export class BigMoveTracker {
  /** Territories each player held when the current turn began. */
  private heldAtStart = new Map<PlayerId, number>();
  private attacker: PlayerId | null = null;
  private taken = new Map<PlayerId, { n: number; last: TerritoryId; capital: TerritoryId | null; out: boolean }>();

  /** Returns the big moves a commit completes (at the end of a turn or the game), most important first. */
  observe(state: GameState, events: readonly GameEvent[]): BigMove[] {
    const out: BigMove[] = [];
    for (const e of events) {
      if (e.type === 'turn_started') {
        this.attacker = e.player;
        this.taken.clear();
        this.heldAtStart.clear();
        for (const t of Object.values(state.territories)) if (t.owner) this.heldAtStart.set(t.owner, (this.heldAtStart.get(t.owner) ?? 0) + 1);
        // The turn's own events come after the turn start in the same commit; counts are as of this state.
      } else if (e.type === 'conquered' && e.player === this.attacker) {
        const v = this.tally(e.previousOwner);
        v.n++;
        v.last = e.to;
      } else if (e.type === 'capital_captured' && e.player === this.attacker) {
        this.tally(e.previousOwner).capital = e.territory;
      } else if (e.type === 'eliminated' && e.by && e.by === this.attacker) {
        this.tally(e.player).out = true;
      } else if (e.type === 'turn_ended' || e.type === 'game_over') {
        out.push(...this.close());
      }
    }
    return out;
  }

  private tally(victim: PlayerId) {
    let v = this.taken.get(victim);
    if (!v) this.taken.set(victim, (v = { n: 0, last: '', capital: null, out: false }));
    return v;
  }

  private close(): BigMove[] {
    const moves: BigMove[] = [];
    if (this.attacker) {
      for (const [victim, v] of this.taken) {
        const held = this.heldAtStart.get(victim) ?? 0;
        const sweep = v.n >= BIG_MOVE.minTerritories && held > 0 && v.n / held >= BIG_MOVE.minShare;
        const kind: BigMoveKind | null = v.out ? 'knockout' : v.capital ? 'capital' : sweep ? 'sweep' : null;
        if (kind) moves.push({ kind, attacker: this.attacker, victim, taken: v.n, anchor: v.last || v.capital || '' });
      }
    }
    this.taken.clear();
    this.attacker = null;
    const rank = { knockout: 0, capital: 1, sweep: 2 };
    return moves.filter((m) => m.anchor).sort((a, b) => rank[a.kind] - rank[b.kind] || b.taken - a.taken);
  }
}

/** The message for a big move, with the attacker's and victim's lines (their character's voice when bound). */
export function bigMoveMessage(gameId: string, state: GameState, characterIds: Record<string, string>, m: BigMove): BigMoveMessage {
  const name = (id: PlayerId) => state.players.find((p) => p.id === id)?.name ?? id;
  const { line, reply } = linesFor(
    m.kind,
    { name: name(m.attacker), characterId: characterIds[m.attacker] },
    { name: name(m.victim), characterId: characterIds[m.victim] },
    m.taken,
    `${gameId}:${state.version}:${m.victim}`,
  );
  return { type: 'big_move', gameId, version: state.version, kind: m.kind, attacker: { id: m.attacker, name: name(m.attacker) }, victim: { id: m.victim, name: name(m.victim) }, taken: m.taken, anchor: m.anchor, line, reply };
}

/**
 * Whether a viewer may get pop-ups: only one whose view already shows the whole board, so a pop-up never reveals a
 * conquest hidden by fog. That is any game without fog, a spectator, an eliminated player, or a finished game (the
 * engine's own fog rule in view.ts). Seated, living players in a fog game get none.
 */
export function seesWholeBoard(state: GameState, viewer: PlayerId | null): boolean {
  if (!state.options.fogOfWar || state.fogLifted || viewer === null || state.phase === 'finished') return true;
  const p = state.players.find((x) => x.id === viewer);
  return !p || !p.alive;
}

/**
 * At most one pop-up per BIG_MOVE.minGapMs per game; up to BIG_MOVE.queue more wait their turn, the rest are dropped
 * (a 10-player final must not spam). The clock is injectable for tests.
 */
export class ReactionPacer {
  private last = -Infinity;
  private queue: BigMoveMessage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private send: (m: BigMoveMessage) => void,
    private now: () => number = Date.now,
  ) {}

  push(m: BigMoveMessage) {
    if (this.queue.length >= BIG_MOVE.queue) return;
    this.queue.push(m);
    this.drain();
  }

  private drain() {
    if (this.timer || !this.queue.length) return;
    const wait = this.last + BIG_MOVE.minGapMs - this.now();
    if (wait <= 0) {
      this.last = this.now();
      this.send(this.queue.shift()!);
      this.drain();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}

/**
 * Big-move pop-ups are OFF unless RISK_REACTIONS=1 (owner, 2026-10-22: they popped up too often and blocked the UI;
 * they come back after a rework). Read on each use, so a test can switch it. Off: rooms emit no 'big_move', sockets
 * forward none, and the first state does not carry `reactions: true`, so the client hides the pop-up and its toggle.
 */
export function reactionsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RISK_REACTIONS === '1';
}
