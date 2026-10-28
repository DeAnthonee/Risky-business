import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, GameEvent, GameView } from '@risk/engine';
import { GameSocket, type ChatMessage, type PresenceMessage, type StateMessage, type TournamentTableRef } from './api';
import type { BigMoveMessage } from './api';

/** How long a big-move pop-up stays up. */
const REACTION_MS = 4_500;

export interface EventBatch {
  id: number;
  version: number;
  events: GameEvent[];
  /** Moves passed over without being played (broadcast delay skipping turns, or jumping to live): the log only, no animations. */
  skipped?: boolean;
}

/** A spectator's broadcast delay: how far behind live they watch, and what was skipped to stay near it. */
export interface BroadcastDelay {
  /** Seconds behind live the moves are played (0: live). */
  secs: number;
  /** How old the oldest move not played yet is, in seconds (0: nothing waiting). */
  behind: number;
  /** The latest notice that whole turns were skipped (cleared after a few seconds). */
  skipped: string | null;
}

export interface GameConnection {
  view: GameView | null;
  host: string | null;
  name: string;
  /** A tournament table: which tournament, round and table (null for any other game). */
  tournament: TournamentTableRef | null;
  you: string | null;
  connected: boolean;
  batches: EventBatch[];
  chat: ChatMessage[];
  act: (action: Action) => Promise<void>;
  sendChat: (msg: string, name?: string, to?: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
  /** True when the server is running a newer build than this page. */
  updateAvailable: boolean;
  /** Who is connected right now. */
  presence: PresenceMessage;
  /** The latest big-move reaction (null when none is showing). */
  reaction: BigMoveMessage | null;
  /** Whether the server sends big-move pop-ups at all (off unless RISK_REACTIONS=1): the client hides them and their toggle. */
  reactionsEnabled: boolean;
  /** Set when the room was closed (by the host, an admin, or for being idle). */
  closedReason: string | null;
  /** Spectator fast-forward: show every update the moment it arrives, no replay pacing (and no animations). */
  fastForward: boolean;
  setFastForward: (on: boolean) => void;
  /** Spectators: the broadcast delay (secs 0 = live). */
  delay: BroadcastDelay;
  /** Watch `secs` behind live (0: go live now, skipping what is waiting). */
  setDelay: (secs: number) => void;
}

/**
 * Spectator playback pacing. Seated players see every update the moment it happens; spectators get
 * updates replayed one at a time so a burst of attacks reads as a sequence: each conquest stays on screen
 * for a moment before the next. The queue speeds up when it falls behind so it never lags far.
 */
const PACE = {
  /** A commit that conquered a territory. */
  conquestMs: 900,
  /** A commit with dice but no conquest: base plus a little per roll (blitzes roll many times). */
  battleBaseMs: 450,
  battlePerRollMs: 120,
  battleMaxMs: 1400,
  /** A dice-only commit continuing the previous commit's attack (an AI rolling one die-set at a time). */
  continuedRollMs: 260,
  /** Placements, phase changes and other quiet commits. */
  quietMs: 140,
  /** Backlog size at which pacing starts speeding up (proportionally to the backlog). */
  hurryAt: 4,
  /** Floor for the hurried delay: even catching up, each conquest gets its own frame. */
  minConquestMs: 160,
  /** Backlog size at which everything queued is applied at once (only sane for a background tab). */
  flushAt: 400,
};

/**
 * Broadcast delay: at a big or fast table (a 100-seat mega table makes 20-40 moves a second) a spectator watches a
 * fixed time behind live. Each move is played once it is `secs` old, in order: a turn's quiet moves (placements,
 * trades, moves) together, an attack's rolls together up to its conquest, which holds a beat. Running late, it plays
 * faster; more than `capSecs` past the delay, it skips whole turns (to the log, without animations) and says so.
 */
export const DELAY = {
  /** The delays a spectator can pick, in seconds. */
  choices: [5, 10, 20, 30, 60],
  defaultSecs: 10,
  /** A spectator of a table with more seats than this starts delayed. */
  autoSeats: 8,
  /** Or once the table makes more than this many moves a second (over the last 10 s). */
  autoRate: 4,
  /** How far past the delay the replay may fall before it skips turns; it skips back to half this. */
  capSecs: 40,
  /** A beat between one player's turn and the next. */
  turnGapMs: 350,
  /** Floor for a conquest's hold when catching up. */
  minConquestMs: 300,
};

interface Queued {
  m: StateMessage;
  /** When it arrived (performance.now()). */
  at: number;
}

/** Whether a move's events can join a replay frame that already holds `group` (same turn checked by the caller). */
function joins(group: GameEvent[], next: GameEvent[]): boolean {
  if (group.some((e) => e.type === 'conquered')) return false;
  const attack = lastAttack(group);
  const nextAttack = lastAttack(next);
  if (attack) return nextAttack === attack;
  return !nextAttack;
}

const turnOf = (m: StateMessage) => m.state.turnNumber;

function hurriedWait(base: number, backlog: number, conquest: boolean): number {
  if (backlog < PACE.hurryAt) return base;
  const scaled = base * Math.max(0.12, PACE.hurryAt / backlog);
  return conquest ? Math.max(PACE.minConquestMs, scaled) : scaled;
}

function lastAttack(events: GameEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'battle') return `${e.attacker}:${e.from}>${e.to}`;
  }
  return null;
}

function paceFor(events: GameEvent[], previous: GameEvent[] | null): number {
  if (events.some((e) => e.type === 'conquered')) return PACE.conquestMs;
  const rolls = events.filter((e) => e.type === 'battle').length;
  // Slow-rolled attacks (one roll per commit on the same border) replay like a blitz.
  if (rolls && previous && lastAttack(events) === lastAttack(previous)) return PACE.continuedRollMs;
  if (rolls) return Math.min(PACE.battleMaxMs, PACE.battleBaseMs + rolls * PACE.battlePerRollMs);
  return events.length ? PACE.quietMs : 0;
}

/** `coachKey`: watch as the coach of the seat this player key owns (quick play): that seat's view, read-only. */
export function useGame(gameId: string | null, token: string | undefined, coachKey?: string): GameConnection {
  const [view, setView] = useState<GameView | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [name, setName] = useState('');
  // A tournament table: which tournament, round and table (sent with the first state; it never changes).
  const [tournament, setTournament] = useState<TournamentTableRef | null>(null);
  // Big-move pop-ups: only when the server says so in its reply to subscribe (owner: off for now).
  const [reactionsEnabled, setReactionsEnabled] = useState(false);
  const [you, setYou] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [batches, setBatches] = useState<EventBatch[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [presence, setPresence] = useState<PresenceMessage>({ spectators: 0, online: [] });
  // The latest big-move reaction, shown for a few seconds (the server already paces them: one per 5 s per game).
  const [reaction, setReaction] = useState<BigMoveMessage | null>(null);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const sockRef = useRef<GameSocket | null>(null);
  const seq = useRef(0);
  const playback = useRef<{
    queue: Queued[];
    timer: ReturnType<typeof setTimeout> | null;
    previous: GameEvent[] | null;
    fast: boolean;
    /** Show what is waiting at once (to the log only) and go on from the live board. */
    flush: (() => void) | null;
    /** Restart the pump (the delay changed). */
    kick: (() => void) | null;
    /** Broadcast delay in ms (0: off), and whether the spectator picked it (then it is never switched on for them). */
    delayMs: number;
    chosen: boolean;
    /** Arrival times of the last moves, for switching the delay on at a fast table. */
    arrivals: number[];
  }>({ queue: [], timer: null, previous: null, fast: false, flush: null, kick: null, delayMs: 0, chosen: false, arrivals: [] });
  const [fastForward, setFastForwardState] = useState(false);
  const [delay, setDelayState] = useState<BroadcastDelay>({ secs: 0, behind: 0, skipped: null });
  const skippedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteSkipped = useCallback((text: string) => {
    setDelayState((d) => ({ ...d, skipped: text }));
    if (skippedTimer.current) clearTimeout(skippedTimer.current);
    skippedTimer.current = setTimeout(() => setDelayState((d) => ({ ...d, skipped: null })), 8_000);
  }, []);
  const setDelay = useCallback((secs: number) => {
    const pb = playback.current;
    pb.chosen = true;
    pb.delayMs = secs * 1000;
    setDelayState((d) => ({ ...d, secs, behind: secs ? d.behind : 0 }));
    if (secs) {
      pb.fast = false;
      setFastForwardState(false);
      pb.kick?.();
    } else pb.flush?.();
  }, []);
  const setFastForward = useCallback((on: boolean) => {
    const pb = playback.current;
    pb.fast = on;
    setFastForwardState(on);
    if (!on) return;
    // Jump straight to the live board, and stay live.
    pb.delayMs = 0;
    pb.chosen = true;
    setDelayState((d) => ({ ...d, secs: 0, behind: 0 }));
    pb.flush?.();
  }, []);

  // The "x s behind" badge: the age of the oldest move still waiting.
  useEffect(() => {
    if (!delay.secs) return;
    const tick = setInterval(() => {
      const head = playback.current.queue[0];
      const behind = head ? Math.round((performance.now() - head.at) / 1000) : 0;
      setDelayState((d) => (d.behind === behind ? d : { ...d, behind }));
    }, 500);
    return () => clearInterval(tick);
  }, [delay.secs]);

  useEffect(() => {
    if (!gameId) return;
    // A new connection (another game, or a spectator taking a seat) starts at normal speed.
    playback.current.fast = false;
    setFastForwardState(false);
    playback.current.delayMs = 0;
    playback.current.chosen = false;
    playback.current.arrivals = [];
    setDelayState({ secs: 0, behind: 0, skipped: null });
    setTournament(null);
    setReactionsEnabled(false);
    const apply = (m: StateMessage, skipped = false) => {
      setView(m.state);
      setHost(m.host);
      setName(m.name);
      if (m.tournament) setTournament(m.tournament);
      if (m.reqId !== undefined) setReactionsEnabled(m.reactions === true);
      setYou(m.you);
      if (m.events.length) setBatches((b) => [...b.slice(-200), { id: ++seq.current, version: m.version, events: m.events, ...(skipped ? { skipped } : {}) }]);
    };
    /** Several queued moves as one: the last one's board, every one's events (in order). */
    const merged = (items: Queued[]): StateMessage => ({ ...items[items.length - 1].m, events: items.flatMap((q) => q.m.events) });
    const pb = playback.current;
    pb.flush = () => {
      if (pb.timer) clearTimeout(pb.timer);
      pb.timer = null;
      const all = pb.queue.splice(0);
      // Never dropped: what was waiting goes to the log in one batch, without animations.
      if (all.length) apply(merged(all), true);
    };
    pb.kick = () => {
      if (pb.timer) clearTimeout(pb.timer);
      pb.timer = null;
      if (pb.queue.length) pump();
    };
    /** Broadcast delay: play the oldest moves once they are old enough, skipping whole turns when far behind. */
    const pumpDelayed = () => {
      const now = performance.now();
      const q = pb.queue;
      if (now - q[0].at > pb.delayMs + DELAY.capSecs * 1000) {
        // Too far behind: skip to the end of the turn that is (cap / 2) past the delay.
        const limit = now - (pb.delayMs + (DELAY.capSecs * 1000) / 2);
        let j = 0;
        while (j < q.length && q[j].at < limit) j++;
        const turn = turnOf(q[j - 1].m);
        while (j < q.length && turnOf(q[j].m) === turn) j++;
        const first = turnOf(q[0].m);
        apply(merged(q.splice(0, j)), true);
        pb.previous = null;
        noteSkipped(first === turn ? `Skipped the rest of turn ${first}` : `Skipped turns ${first}–${turn}`);
        if (!q.length) return;
      }
      const due = q[0].at + pb.delayMs - now;
      if (due > 0) {
        pb.timer = setTimeout(pump, due);
        return;
      }
      // One replay frame: the oldest move, and the due moves after it in the same turn that read as one step.
      let n = 1;
      const events = [...q[0].m.events];
      while (n < q.length && q[n].at + pb.delayMs <= now && turnOf(q[n].m) === turnOf(q[0].m) && joins(events, q[n].m.events)) events.push(...q[n++].m.events);
      const frame = q.splice(0, n);
      apply(merged(frame));
      const conquest = events.some((e) => e.type === 'conquered');
      // Running late (past the delay): play faster, down to a third of the pace.
      const late = now - frame[0].at;
      const speed = Math.max(0.33, Math.min(1, pb.delayMs / Math.max(1, late)));
      let wait = paceFor(events, pb.previous) * speed;
      if (conquest) wait = Math.max(DELAY.minConquestMs, wait);
      if (q.length && turnOf(q[0].m) !== turnOf(frame[0].m)) wait += DELAY.turnGapMs * speed;
      if (events.length) pb.previous = events;
      pb.timer = setTimeout(pump, wait);
    };
    const pump = () => {
      pb.timer = null;
      if (!pb.queue.length) return;
      if (pb.delayMs) return pumpDelayed();
      if (pb.queue.length >= PACE.flushAt || (typeof document !== 'undefined' && document.hidden && pb.queue.length > PACE.hurryAt)) {
        // Hopelessly behind (e.g. the tab was in the background): catch up in one go.
        const all = pb.queue.splice(0);
        for (const { m } of all) apply(m);
        return;
      }
      const next = pb.queue.shift()!.m;
      apply(next);
      const wait = hurriedWait(paceFor(next.events, pb.previous), pb.queue.length, next.events.some((e) => e.type === 'conquered'));
      if (next.events.length) pb.previous = next.events;
      if (pb.queue.length) pb.timer = setTimeout(pump, wait);
      else if (wait) pb.timer = setTimeout(pump, wait); // hold the last frame before the next arrival
    };
    const sock = new GameSocket(
      gameId,
      token,
      {
      onState: (m: StateMessage) => {
        if (m.commit && m.commit !== 'unknown' && __COMMIT__ !== 'unknown' && m.commit !== __COMMIT__) setUpdateAvailable(true);
        const now = performance.now();
        // A spectator of a big or fast table watches on a broadcast delay, unless they chose otherwise.
        if (!m.you && !coachKey && !pb.chosen && !pb.delayMs && m.state.phase !== 'lobby' && m.state.phase !== 'finished') {
          if (m.events.length) pb.arrivals = [...pb.arrivals.filter((t) => now - t < 10_000), now];
          const seats = m.state.players.filter((p) => !p.isNeutral).length;
          if (seats > DELAY.autoSeats || pb.arrivals.length > DELAY.autoRate * 10) {
            pb.delayMs = DELAY.defaultSecs * 1000;
            setDelayState((d) => ({ ...d, secs: DELAY.defaultSecs }));
          }
        }
        // Fast-forward: no replay at all.
        if (pb.fast && !m.you && pb.queue.length === 0 && !pb.timer) return apply(m);
        // Seated players, and the initial snapshot, apply at once; spectators replay in sequence.
        if (m.you || m.events.length === 0) {
          if (pb.queue.length === 0 && !pb.timer) return apply(m);
          if (m.you) {
            // Just took a seat: drop the replay and show the live board.
            pb.queue.length = 0;
            if (pb.timer) clearTimeout(pb.timer);
            pb.timer = null;
            pb.delayMs = 0;
            setDelayState({ secs: 0, behind: 0, skipped: null });
            return apply(m);
          }
        }
        pb.queue.push({ m, at: now });
        if (!pb.timer) pump();
      },
      onChat: (m) => setChat((c) => [...c.slice(-200), m]),
      onChatHistory: (ms) => setChat(ms),
      onPresence: setPresence,
      onBigMove: (m) => {
        setReaction(m);
        if (reactionTimer.current) clearTimeout(reactionTimer.current);
        reactionTimer.current = setTimeout(() => setReaction(null), REACTION_MS);
      },
      onClosed: setClosedReason,
      onStatus: setConnected,
    }, coachKey);
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
      if (pb.timer) clearTimeout(pb.timer);
      pb.timer = null;
      pb.queue.length = 0;
      pb.previous = null;
      pb.flush = null;
      pb.kick = null;
    };
  }, [gameId, token, coachKey]);

  const act = useCallback(async (action: Action) => {
    if (!sockRef.current) throw new Error('Not connected');
    try {
      await sockRef.current.act(action);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  const sendChat = useCallback(async (msg: string, name?: string, to?: string) => {
    await sockRef.current?.chat(msg, name, to);
  }, []);

  return { view, host, name, tournament, you, connected, batches, chat, act, sendChat, error, clearError: () => setError(null), updateAvailable, presence, closedReason, fastForward, setFastForward, delay, setDelay, reaction, reactionsEnabled };
}
