import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RuleError, redactEvents, type Action } from '@risk/engine';
import type { ChangeMessage, ChatMessage, GameRoom, Store } from './store.js';

interface ClientMsg {
  type: 'subscribe' | 'action' | 'chat' | 'ping';
  reqId?: string;
  gameId?: string;
  token?: string;
  action?: Action;
  message?: string;
}

/**
 * WebSocket protocol (JSON):
 *  client -> {type:'subscribe', gameId, token?}
 *  server -> {type:'state', state, events, version}
 *  server -> {type:'chat', message}
 *  client -> {type:'action', reqId, action}  server -> {type:'ack', reqId, ok, error?}
 *  client -> {type:'chat', message}
 */
/** Who is connected to each room over WebSocket: player ids and anonymous spectators. */
interface Presence {
  players: Map<string, number>;
  spectators: number;
}

export function attachWebSocket(server: Server, store: Store, commit: () => string = () => 'unknown') {
  const wss = new WebSocketServer({ server, path: '/ws' });
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
    const p = presenceOf(room.id);
    if (playerId) p.players.set(playerId, (p.players.get(playerId) ?? 0) + 1);
    else p.spectators++;
    broadcastPresence(room);
  };
  const exit = (room: GameRoom, playerId: string | null) => {
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
    let alive = true;

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const unsubscribe = () => {
      if (room && onChange) room.off('change', onChange);
      if (room && onChat) room.off('chat', onChat);
      if (room && onPresence) room.off('presence', onPresence);
      if (room) exit(room, playerId);
      room = null;
      onChange = null;
      onChat = null;
      onPresence = null;
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
          case 'subscribe': {
            unsubscribe();
            const r = store.get(String(msg.gameId ?? ''));
            if (!r) return send({ type: 'error', error: 'Game not found', reqId: msg.reqId });
            room = r;
            playerId = r.playerForToken(msg.token);
            onChange = (m) => send({ type: 'state', state: r.view(playerId), events: redactEvents(m.state, playerId, m.events), version: m.version, host: r.hostId, name: r.name, you: playerId, commit: commit() });
            onChat = (m) => send({ type: 'chat', message: m });
            onPresence = (m) => send({ type: 'presence', ...m });
            r.on('change', onChange);
            r.on('chat', onChat);
            r.on('presence', onPresence);
            enter(r, playerId);
            send({ type: 'state', state: r.view(playerId), events: [], version: r.state.version, host: r.hostId, name: r.name, you: playerId, commit: commit(), reqId: msg.reqId });
            send({ type: 'chat_history', messages: r.chat.slice(-100) });
            return;
          }
          case 'action': {
            if (!room || !playerId) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Not subscribed as a player' });
            if (!msg.action || typeof msg.action.type !== 'string') return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Missing action' });
            room.act(playerId, msg.action);
            return send({ type: 'ack', reqId: msg.reqId, ok: true });
          }
          case 'chat': {
            if (!room || !playerId) return send({ type: 'ack', reqId: msg.reqId, ok: false, error: 'Not subscribed as a player' });
            const text = String(msg.message ?? '').trim();
            if (!text) return;
            const p = room.state.players.find((x) => x.id === playerId);
            room.addChat(playerId, p?.name ?? 'Unknown', text);
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
