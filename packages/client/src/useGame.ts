import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, GameEvent, GameView } from '@risk/engine';
import { GameSocket, type ChatMessage, type PresenceMessage, type StateMessage } from './api';

export interface EventBatch {
  id: number;
  version: number;
  events: GameEvent[];
}

export interface GameConnection {
  view: GameView | null;
  host: string | null;
  name: string;
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
  /** Set when the room was closed (by the host, an admin, or for being idle). */
  closedReason: string | null;
  /** Spectator fast-forward: show every update the moment it arrives, no replay pacing (and no animations). */
  fastForward: boolean;
  setFastForward: (on: boolean) => void;
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

export function useGame(gameId: string | null, token: string | undefined): GameConnection {
  const [view, setView] = useState<GameView | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [you, setYou] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [batches, setBatches] = useState<EventBatch[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [presence, setPresence] = useState<PresenceMessage>({ spectators: 0, online: [] });
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const sockRef = useRef<GameSocket | null>(null);
  const seq = useRef(0);
  const playback = useRef<{ queue: StateMessage[]; timer: ReturnType<typeof setTimeout> | null; previous: GameEvent[] | null; fast: boolean; flush: (() => void) | null }>({
    queue: [],
    timer: null,
    previous: null,
    fast: false,
    flush: null,
  });
  const [fastForward, setFastForwardState] = useState(false);
  const setFastForward = useCallback((on: boolean) => {
    playback.current.fast = on;
    setFastForwardState(on);
    // Jump straight to the live board.
    if (on) playback.current.flush?.();
  }, []);

  useEffect(() => {
    setView(null);
    setHost(null);
    setName('');
    setYou(null);
    setConnected(false);
    setBatches([]);
    setChat([]);
    setError(null);
    setClosedReason(null);
    if (!gameId) return;
    // A new connection (another game, or a spectator taking a seat) starts at normal speed.
    playback.current.fast = false;
    setFastForwardState(false);
    const apply = (m: StateMessage) => {
      setView(m.state);
      setHost(m.host);
      setName(m.name);
      setYou(m.you);
      if (m.events.length) setBatches((b) => [...b.slice(-200), { id: ++seq.current, version: m.version, events: m.events }]);
    };
    const pb = playback.current;
    pb.flush = () => {
      if (pb.timer) clearTimeout(pb.timer);
      pb.timer = null;
      const all = pb.queue.splice(0);
      for (const m of all) apply(m);
    };
    const pump = () => {
      pb.timer = null;
      if (pb.queue.length >= PACE.flushAt || (typeof document !== 'undefined' && document.hidden && pb.queue.length > PACE.hurryAt)) {
        // Hopelessly behind (e.g. the tab was in the background): catch up in one go.
        const all = pb.queue.splice(0);
        for (const m of all) apply(m);
        return;
      }
      const next = pb.queue.shift();
      if (!next) return;
      apply(next);
      const wait = hurriedWait(paceFor(next.events, pb.previous), pb.queue.length, next.events.some((e) => e.type === 'conquered'));
      if (next.events.length) pb.previous = next.events;
      if (pb.queue.length) pb.timer = setTimeout(pump, wait);
      else if (wait) pb.timer = setTimeout(pump, wait); // hold the last frame before the next arrival
    };
    const sock = new GameSocket(gameId, token, {
      onState: (m: StateMessage) => {
        if (m.commit && m.commit !== 'unknown' && __COMMIT__ !== 'unknown' && m.commit !== __COMMIT__) setUpdateAvailable(true);
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
            return apply(m);
          }
        }
        pb.queue.push(m);
        if (!pb.timer) pump();
      },
      onChat: (m) => setChat((c) => [...c.slice(-200), m]),
      onChatHistory: (ms) => setChat(ms),
      onPresence: setPresence,
      onClosed: setClosedReason,
      onStatus: setConnected,
    });
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
      if (pb.timer) clearTimeout(pb.timer);
      pb.timer = null;
      pb.queue.length = 0;
      pb.previous = null;
      pb.flush = null;
    };
  }, [gameId, token]);

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

  return { view, host, name, you, connected, batches, chat, act, sendChat, error, clearError: () => setError(null), updateAvailable, presence, closedReason, fastForward, setFastForward };
}
