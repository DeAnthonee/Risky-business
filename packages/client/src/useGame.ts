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
  sendChat: (msg: string, name?: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
  /** True when the server is running a newer build than this page. */
  updateAvailable: boolean;
  /** Who is connected right now. */
  presence: PresenceMessage;
  /** Set when the room was closed (by the host, an admin, or for being idle). */
  closedReason: string | null;
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

  useEffect(() => {
    if (!gameId) return;
    const sock = new GameSocket(gameId, token, {
      onState: (m: StateMessage) => {
        setView(m.state);
        setHost(m.host);
        setName(m.name);
        setYou(m.you);
        if (m.commit && m.commit !== 'unknown' && __COMMIT__ !== 'unknown' && m.commit !== __COMMIT__) setUpdateAvailable(true);
        if (m.events.length) setBatches((b) => [...b.slice(-200), { id: ++seq.current, version: m.version, events: m.events }]);
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

  const sendChat = useCallback(async (msg: string, name?: string) => {
    await sockRef.current?.chat(msg, name);
  }, []);

  return { view, host, name, you, connected, batches, chat, act, sendChat, error, clearError: () => setError(null), updateAvailable, presence, closedReason };
}
