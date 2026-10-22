import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RuleError, redactEvents, type Action } from '@risk/engine';
import { parseDecisionNote, type ChangeMessage, type ChatMessage, type GameRoom, type Store } from './store.js';
import { TournamentFeeds } from './tournament-feed.js';

/** A tournament-feed socket with more than this queued gets no more feed updates until it drains. */
const FEED_BACKLOG_BYTES = 1_000_000;

/**
 * Every spectator socket of a room gets the same state message for a commit, so it is built and stringified once
 * per (room, commit) and the same string is written to each of them. Player sockets keep their own view (fog, cards).
 */
const spectatorFrames = new WeakMap<GameRoom, { change: ChangeMessage; json: string }>();
export function spectatorFrame(room: GameRoom, m: ChangeMessage, commit: string): string {
  const cached = spectatorFrames.get(room);
  if (cached && cached.change === m) return cached.json;
  const json = JSON.stringify({ type: 'state', state: room.spectatorView(), events: redactEvents(m.state, null, m.events), version: m.version, host: room.hostId, name: room.name, you: null, commit });
  spectatorFrames.set(room, { change: m, json });
  return json;
}

interface ClientMsg {
  type: 'subscribe' | 'action' | 'chat' | 'ping' | 'subscribe_tournament' | 'unsubscribe_tournament';
  reqId?: string;
  gameId?: string;
  /** subscribe_tournament: the tournament code (`id` works too). */
  tournamentId?: string;
  id?: string;
  token?: string;
  action?: Action;
  message?: string;
  /** Display name for a spectator's chat message. */
  name?: string;
  /** Whisper recipient (player id or name). */
  to?: string;
  /** action: the seat's private decision note for this move. */
  note?: unknown;
}

let socketSeq = 0;

/**
 * WebSocket protocol (JSON):
 *  client -> {type:'subscribe', gameId, token?}
 *  server -> {type:'state', state, events, version}
 *  server -> {type:'chat', message}
 *  client -> {type:'action', reqId, action}  server -> {type:'ack', reqId, ok, error?}
 *  client -> {type:'chat', message, name?, to?}   (name: display name when chatting as a spectator;
 *                                              to: whisper to one player, from a seat or as a spectator)
 *  client -> {type:'subscribe_tournament', tournamentId (or id), reqId?}   (spectators only: an entrant token is refused)
 *  server -> {type:'tournament', tournamentId, tournament} (the bracket, also whenever it changes) and
 *            {type:'tournament_tables', tournamentId, version, full, round, tables, follow}: every table first
 *            (full: true), then only the tables that changed, each at most every 500 ms
 *  client -> {type:'unsubscribe_tournament'}
 */
/** Who is connected to each room over WebSocket: player ids and anonymous spectators. */
interface Presence {
  players: Map<string, number>;
  spectators: number;
}

export function attachWebSocket(server: Server, store: Store, commit: () => string = () => 'unknown') {
  const wss = new WebSocketServer({ server, path: '/ws' });
  // The tournament feed: spectators of a tournament get its live table summaries (tournament-feed.ts).
  const feeds = new TournamentFeeds(store);
  wss.on('close', () => feeds.close());
  const presence = new Map<string, Presence>();
  const presenceOf = (gameId: string): Presence => {
    let p = presence.get(gameId);
    if (!p) presence.set(gameId, (p = { players: new Map(), spectators: 0 }));
    return p;
  };
  const broadcastPresence = (room: GameRoom) => {
    const p = presenceOf(room.id);
    room.emit('presence', { spectators: p.spectators, online: [...p.players.keys()] });
  };
  const enter = (room: GameRoom, playerId: string | null) => {
    room.connections++;
    if (playerId) {
      room.touch();
      room.seatSocket(playerId, 1);
    }
    const p = presenceOf(room.id);
    if (playerId) p.players.set(playerId, (p.players.get(playerId) ?? 0) + 1);
    else p.spectators++;
    broadcastPresence(room);
  };
  const exit = (room: GameRoom, playerId: string | null) => {
    room.connections = Math.max(0, room.connections - 1);
    if (playerId) room.seatSocket(playerId, -1);
    const p = presenceOf(room.id);
    if (playerId) {
      const n = (p.players.get(playerId) ?? 1) - 1;
      if (n <= 0) p.players.delete(playerId);
      else p.players.set(playerId, n);
    } else p.spectators = Math.max(0, p.spectators - 1);
    broadcastPresence(room);
    if (p.spectators === 0 && p.players.size === 0) presence.delete(room.id);
  };

  wss.on('connection', (ws: WebSocket) => {
    let room: GameRoom | null = null;
    let playerId: string | null = null;
    let onChange: ((m: ChangeMessage) => void) | null = null;
    let onChat: ((m: ChatMessage) => void) | null = null;
    let onPresence: ((m: { spectators: number; online: string[] }) => void) | null = null;
    let onClosed: ((reason: string) => void) | null = null;
    let alive = true;
    const socketKey = `ws:${++socketSeq}`;

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    const sendRaw = (json: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    };

    let feedId: string | null = null;
    // A backed-up socket skips feed updates rather than buffering them without end; the feed then resends it the whole
    // picture once it has drained (tournament-feed.ts).
    const feedSocket = {
      send: (json: string) => {
        if (ws.readyState !== WebSocket.OPEN) return true;
        if (ws.bufferedAmount >= FEED_BACKLOG_BYTES) return false;
        ws.send(json);
        return true;
      },
    };
    const leaveFeed = () => {
      if (feedId) feeds.unsubscribe(feedId, feedSocket);
      feedId = null;
    };

    const unsubscribe = () => {
      if (room && onChange) room.off('change', onChange);
      if (room && onChat) room.off('chat', onChat);
      if (room && onPresence) room.off('presence', onPresence);
      if (room && onClosed) room.off('closed', onClosed);
      if (room) exit(room, playerId);
      room = null;
      onChange = null;
      onChat = null;
      onPresence = null;
      onClosed = null;
    };

    ws.on('pong', () => (alive = true));

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ type: 'error', error: 'Invalid JSON' });
      }
      try {
        switch (msg.type) {
          case 'ping':
            return send({ type: 'pong' });
          case 'subscribe_tournament': {
            // One tournament feed per socket, alongside (or instead of) one game subscription.
            leaveFeed();
            const tid = String(msg.tournamentId ?? msg.id ?? '').toUpperCase();
            const r = feeds.subscribe(tid, feedSocket, msg.token);
            if (!r.ok) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: r.error });
            feedId = tid;
            send({ type: 'ack', reqId: msg.reqId, ok: true });
            for (const json of r.first) feedSocket.send(json);
            return;
          }
          case 'unsubscribe_tournament':
            leaveFeed();
            return send({ type: 'ack', reqId: msg.reqId, ok: true });
          case 'subscribe': {
            unsubscribe();
            const r = store.get(String(msg.gameId ?? ''));
            if (!r || r.closed) return send({ type: 'closed', reason: 'gone', reqId: msg.reqId });
            room = r;
            playerId = r.playerForToken(msg.token);
            onChange = (m) =>
              playerId
                ? send({ type: 'state', state: r.view(playerId), events: redactEvents(m.state, playerId, m.events), version: m.version, host: r.hostId, name: r.name, you: playerId, commit: commit() })
                : sendRaw(spectatorFrame(r, m, commit()));
            onChat = (m) => {
              if (r.canReadChat(m, playerId)) send({ type: 'chat', message: m });
            };
            onPresence = (m) => send({ type: 'presence', ...m });
            r.on('change', onChange);
            r.on('chat', onChat);
            r.on('presence', onPresence);
            onClosed = (reason) => {
              send({ type: 'closed', reason });
              unsubscribe();
            };
            r.on('closed', onClosed);
            enter(r, playerId);
            send({ type: 'state', state: playerId ? r.view(playerId) : r.spectatorView(), events: [], version: r.state.version, host: r.hostId, name: r.name, you: playerId, commit: commit(), reqId: msg.reqId });
            send({ type: 'chat_history', messages: r.chatFor(playerId).slice(-100) });
            return;
          }
          case 'action': {
            if (!room || !playerId) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Not subscribed as a player' });
            if (!msg.action || typeof msg.action.type !== 'string') return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Missing action' });
            room.act(playerId, msg.action, parseDecisionNote(msg.note));
            return send({ type: 'ack', reqId: msg.reqId, ok: true });
          }
          case 'chat': {
            if (!room) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Not subscribed to a game' });
            const text = String(msg.message ?? '').trim();
            if (!text) return;
            if (!playerId) {
              room.addSpectatorChat(socketKey, msg.name, text, msg.to);
              return send({ type: 'ack', reqId: msg.reqId, ok: true });
            }
            const p = room.state.players.find((x) => x.id === playerId);
            room.addChat(playerId, p?.name ?? 'Unknown', text, msg.to);
            return send({ type: 'ack', reqId: msg.reqId, ok: true });
          }
          default:
            return send({ type: 'error', error: `Unknown message type ${(msg as { type: string }).type}` });
        }
      } catch (err) {
        if (err instanceof RuleError) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: err.message });
        console.error(err);
        return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Internal error' });
      }
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
    ws.on('close', leaveFeed);
    ws.on('error', leaveFeed);

    const interval = setInterval(() => {
      if (!alive) {
        clearInterval(interval);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('close', () => clearInterval(interval));
  });

  return wss;
}
