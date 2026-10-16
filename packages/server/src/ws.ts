import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RuleError, type Action } from '@risk/engine';
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
export function attachWebSocket(server: Server, store: Store, commit: () => string = () => 'unknown') {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    let room: GameRoom | null = null;
    let playerId: string | null = null;
    let onChange: ((m: ChangeMessage) => void) | null = null;
    let onChat: ((m: ChatMessage) => void) | null = null;
    let alive = true;

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const unsubscribe = () => {
      if (room && onChange) room.off('change', onChange);
      if (room && onChat) room.off('chat', onChat);
      room = null;
      onChange = null;
      onChat = null;
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
            onChange = (m) => send({ type: 'state', state: r.view(playerId), events: m.events, version: m.version, host: r.hostId, name: r.name, you: playerId, commit: commit() });
            onChat = (m) => send({ type: 'chat', message: m });
            r.on('change', onChange);
            r.on('chat', onChat);
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
