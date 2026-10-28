import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { addPlayer, createGame, getMap, startGame, type GameEvent, type GameState } from '@risk/engine';
import { BIG_MOVE } from '../src/excitement.js';
import { BigMoveTracker, ReactionPacer, bigMoveMessage, reactionsOn, seesWholeBoard, type BigMoveMessage } from '../src/reactions.js';
import { CHARACTER_LINES, linesFor } from '../src/reaction-lines.js';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';

const map = getMap('classic');
const ids = map.territoryIds;

/** A 3-player classic game with a hand-laid board: `held` territories per player (by index ranges). */
function game(held: Record<string, number>, opts: { fog?: boolean } = {}): GameState {
  let s = createGame('G', { map: 'classic', maxPlayers: 3, autoSetup: true, fogOfWar: !!opts.fog });
  for (const id of ['a', 'b', 'c']) s = addPlayer(s, id, id.toUpperCase());
  s = structuredClone(startGame(s).state);
  let i = 0;
  for (const [owner, n] of Object.entries(held)) for (let k = 0; k < n; k++) s.territories[ids[i++]] = { owner, armies: 2 };
  for (; i < ids.length; i++) s.territories[ids[i]] = { owner: 'c', armies: 2 };
  return s;
}

const start = (player: string): GameEvent => ({ type: 'turn_started', player, turnNumber: 1, round: 1, reinforcements: { territories: 3, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0, total: 3 } });
const take = (player: string, from: string, to: string): GameEvent => ({ type: 'conquered', player, from: ids[0], to, previousOwner: from });
const end = (player: string): GameEvent => ({ type: 'turn_ended', player });

describe('BigMoveTracker', () => {
  it('a sweep needs both 3 territories and 25% of what the victim held at the turn start', () => {
    const s = game({ a: 10, b: 12 });
    const t = new BigMoveTracker();
    t.observe(s, [start('a')]);
    // 3 of b's 12 = 25%: a sweep.
    expect(t.observe(s, [take('a', 'b', ids[10]), take('a', 'b', ids[11]), take('a', 'b', ids[12]), end('a')])).toEqual([{ kind: 'sweep', attacker: 'a', victim: 'b', taken: 3, anchor: ids[12] }]);
    // 2 of 12: not big. 3 of 13 (23%): not big.
    t.observe(s, [start('a')]);
    expect(t.observe(s, [take('a', 'b', ids[10]), take('a', 'b', ids[11]), end('a')])).toEqual([]);
    const s13 = game({ a: 9, b: 13 });
    t.observe(s13, [start('a')]);
    expect(t.observe(s13, [take('a', 'b', ids[9]), take('a', 'b', ids[10]), take('a', 'b', ids[11]), end('a')])).toEqual([]);
    expect(BIG_MOVE).toMatchObject({ minTerritories: 3, minShare: 0.25 });
  });

  it('a knockout or a capital is always big; one reaction per pair per turn, the most important first', () => {
    const s = game({ a: 10, b: 2 });
    const t = new BigMoveTracker();
    t.observe(s, [start('a')]);
    const out = t.observe(s, [
      take('a', 'c', ids[20]),
      { type: 'capital_captured', player: 'a', territory: ids[20], previousOwner: 'c' },
      take('a', 'b', ids[10]),
      take('a', 'b', ids[11]),
      { type: 'eliminated', player: 'b', by: 'a' },
      end('a'),
    ]);
    expect(out.map((m) => [m.kind, m.victim])).toEqual([['knockout', 'b'], ['capital', 'c']]);
    // Other players' conquests in someone else's turn never count, and nothing carries over to the next turn.
    t.observe(s, [start('b')]);
    expect(t.observe(s, [take('a', 'c', ids[21]), end('b')])).toEqual([]);
  });

  it('game_over closes the turn too', () => {
    const s = game({ a: 20, b: 3 });
    const t = new BigMoveTracker();
    t.observe(s, [start('a')]);
    expect(t.observe(s, [take('a', 'b', ids[20]), { type: 'eliminated', player: 'b', by: 'a' }, { type: 'game_over', winner: 'a' }])[0]).toMatchObject({ kind: 'knockout' });
  });
});

describe('lines', () => {
  it('a bound character speaks in its own voice; anyone else gets a generic line; the same move picks the same line', () => {
    const shen = linesFor('sweep', { name: 'Shen', characterId: 'league/shen' }, { name: 'Bob' }, 4, 'g:1:b');
    expect(shen.line).toBe(CHARACTER_LINES['league/shen'].attacker);
    expect(shen.reply).not.toMatch(/\{/); // placeholders filled
    expect(linesFor('sweep', { name: 'Ann' }, { name: 'Bob' }, 4, 'g:1:b')).toEqual(linesFor('sweep', { name: 'Ann' }, { name: 'Bob' }, 4, 'g:1:b'));
    const jinx = linesFor('knockout', { name: 'Ann' }, { name: 'Jinx', characterId: 'league/jinx' }, 2, 'x');
    expect(jinx.reply).toBe(CHARACTER_LINES['league/jinx'].victim);
  });

  it('every character line names a real character file', async () => {
    const { existsSync } = await import('node:fs');
    for (const id of Object.keys(CHARACTER_LINES)) expect(existsSync(new URL(`../../../AI/characters/${id}.md`, import.meta.url))).toBe(true);
  });
});

describe('pacing and fog', () => {
  afterEach(() => vi.useRealTimers());

  it('at most one pop-up per 5 s per game: up to 3 wait, the rest are dropped', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sent: number[] = [];
    const pacer = new ReactionPacer((m) => sent.push(m.version), () => Date.now());
    for (let v = 1; v <= 6; v++) pacer.push({ version: v } as BigMoveMessage);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(BIG_MOVE.minGapMs);
    expect(sent).toEqual([1, 2]);
    vi.advanceTimersByTime(BIG_MOVE.minGapMs * 5);
    expect(sent).toEqual([1, 2, 3, 4]); // 5 and 6 were dropped (queue of 3)
    pacer.stop();
  });

  it('only views that already show the whole board get pop-ups', () => {
    const fog = game({ a: 10, b: 10 }, { fog: true });
    expect(seesWholeBoard(fog, null)).toBe(true); // spectator
    expect(seesWholeBoard(fog, 'a')).toBe(false); // seated and alive under fog
    expect(seesWholeBoard({ ...fog, players: fog.players.map((p) => (p.id === 'a' ? { ...p, alive: false } : p)) }, 'a')).toBe(true); // eliminated
    expect(seesWholeBoard({ ...fog, phase: 'finished' }, 'a')).toBe(true);
    expect(seesWholeBoard(game({ a: 10 }), 'a')).toBe(true); // no fog
  });

  it('the message carries names, the anchor and both lines', () => {
    const s = game({ a: 10, b: 4 });
    const m = bigMoveMessage('G', s, { a: 'league/darius' }, { kind: 'sweep', attacker: 'a', victim: 'b', taken: 3, anchor: ids[12] });
    expect(m).toMatchObject({ type: 'big_move', gameId: 'G', attacker: { id: 'a', name: 'A' }, victim: { id: 'b', name: 'B' }, taken: 3, anchor: ids[12], line: CHARACTER_LINES['league/darius'].attacker });
  });
});

/** Run with the pop-ups on (they are off by default: owner, 2026-10-22). */
function withReactions() {
  vi.stubEnv('RISK_REACTIONS', '1');
}

describe('over the WebSocket', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a fog game: the spectator gets the pop-up, the seated players do not', async () => {
    withReactions();
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${(risk.server.address() as AddressInfo).port}/ws`;
    try {
      const { room, token: ta, playerId: a } = store.create('Fog', { map: 'classic', maxPlayers: 3, autoSetup: true, fogOfWar: true }, 'Ann');
      const b = room.join('Bob');
      room.join('Cat');
      room.start();
      const listen = (token?: string) =>
        new Promise<{ got: any[]; ws: WebSocket }>((resolve) => {
          const got: any[] = [];
          const ws = new WebSocket(url);
          ws.on('message', (d) => got.push(JSON.parse(String(d))));
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'subscribe', gameId: room.id, ...(token ? { token } : {}), reqId: 's' }));
            setTimeout(() => resolve({ got, ws }), 150);
          });
        });
      const watcher = await listen();
      const ann = await listen(ta);
      const bob = await listen(b.token);
      // A big move, as the room emits it after a commit (the detector itself is tested above).
      room.emit('big_move', bigMoveMessage(room.id, room.state, room.characterIds, { kind: 'sweep', attacker: a, victim: b.playerId, taken: 3, anchor: ids[0] }));
      await new Promise((r) => setTimeout(r, 200));
      expect(watcher.got.some((m) => m.type === 'big_move')).toBe(true);
      expect(ann.got.some((m) => m.type === 'big_move')).toBe(false);
      expect(bob.got.some((m) => m.type === 'big_move')).toBe(false);
      for (const l of [watcher, ann, bob]) l.ws.close();
    } finally {
      await risk.shutdown('test');
    }
  });

  it('a room emits big_move from its own commits (no fog: every socket may get it)', () => {
    withReactions();
    const store = new Store(null);
    const { room, playerId: a } = store.create('Live', { map: 'classic', maxPlayers: 2, autoSetup: true }, 'Ann');
    const b = room.join('Bob').playerId;
    room.start();
    room.stopBot();
    const seen: BigMoveMessage[] = [];
    room.on('big_move', (m: BigMoveMessage) => seen.push(m));
    // Lay out a sure sweep: Ann on a big stack next to 3 of Bob's 4 single-army territories.
    const s = room.state;
    for (const t of ids) s.territories[t] = { owner: a, armies: 2 };
    const front = ids.find((t) => map.adjacency[t].filter((n) => n !== t).length >= 3)!;
    const targets = map.adjacency[front].slice(0, 3);
    const spare = ids.find((t) => t !== front && !targets.includes(t))!;
    for (const t of [...targets, spare]) s.territories[t] = { owner: b, armies: 1 };
    s.territories[front] = { owner: a, armies: 60 };
    s.currentPlayer = a;
    s.phase = 'attack';
    for (const p of s.players) p.armiesToPlace = 0;
    // The tracker saw the turn start before this layout; restart its tally on this board.
    (room as unknown as { bigMoves: BigMoveTracker }).bigMoves.observe(s, [start(a)]);
    for (const t of targets) room.act(a, { type: 'attack', from: front, to: t, blitz: true, occupy: 'min' });
    room.act(a, { type: 'end_attack' });
    room.act(a, { type: 'end_turn' });
    room.stopBot();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'sweep', attacker: { id: a }, victim: { id: b }, taken: 3 });
    room.close('admin');
  });
});

describe('off by default (owner: they popped up too often)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('only RISK_REACTIONS=1 turns them on', () => {
    expect(reactionsOn({})).toBe(false);
    expect(reactionsOn({ RISK_REACTIONS: '0' })).toBe(false);
    expect(reactionsOn({ RISK_REACTIONS: 'true' })).toBe(false);
    expect(reactionsOn({ RISK_REACTIONS: '1' })).toBe(true);
  });

  it('no big_move goes out: the room emits none, a socket forwards none, and the first state has no reactions flag', async () => {
    vi.stubEnv('RISK_REACTIONS', '');
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${(risk.server.address() as AddressInfo).port}/ws`;
    try {
      const { room, playerId: a } = store.create('Quiet', { map: 'classic', maxPlayers: 2, autoSetup: true }, 'Ann');
      const b = room.join('Bob').playerId;
      room.start();
      room.stopBot();
      const got: any[] = [];
      const ws = new WebSocket(url);
      ws.on('message', (d) => got.push(JSON.parse(String(d))));
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      ws.send(JSON.stringify({ type: 'subscribe', gameId: room.id, reqId: 's' }));
      await new Promise((r) => setTimeout(r, 150));
      const first = got.find((m) => m.type === 'state' && m.reqId === 's');
      expect(first).toBeDefined();
      expect(first).not.toHaveProperty('reactions');

      const seen: BigMoveMessage[] = [];
      room.on('big_move', (m: BigMoveMessage) => seen.push(m));
      // The same sure sweep as above: no pop-up is made.
      const s = room.state;
      for (const t of ids) s.territories[t] = { owner: a, armies: 2 };
      const front = ids.find((t) => map.adjacency[t].filter((n) => n !== t).length >= 3)!;
      const targets = map.adjacency[front].slice(0, 3);
      const spare = ids.find((t) => t !== front && !targets.includes(t))!;
      for (const t of [...targets, spare]) s.territories[t] = { owner: b, armies: 1 };
      s.territories[front] = { owner: a, armies: 60 };
      s.currentPlayer = a;
      s.phase = 'attack';
      for (const p of s.players) p.armiesToPlace = 0;
      (room as unknown as { bigMoves: BigMoveTracker }).bigMoves.observe(s, [start(a)]);
      for (const t of targets) room.act(a, { type: 'attack', from: front, to: t, blitz: true, occupy: 'min' });
      room.act(a, { type: 'end_attack' });
      room.act(a, { type: 'end_turn' });
      room.stopBot();
      expect(seen).toHaveLength(0);
      // Even a big_move emitted by hand is not forwarded to the socket.
      room.emit('big_move', bigMoveMessage(room.id, room.state, room.characterIds, { kind: 'sweep', attacker: a, victim: b, taken: 3, anchor: ids[0] }));
      await new Promise((r) => setTimeout(r, 150));
      expect(got.some((m) => m.type === 'big_move')).toBe(false);
      ws.close();
    } finally {
      await risk.shutdown('test');
    }
  });

  it('switched on, the first state says so (the client shows the pop-ups and their toggle)', async () => {
    withReactions();
    const store = new Store(null);
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    try {
      const { room } = store.create('Loud', { map: 'classic', maxPlayers: 2 }, 'Ann');
      const ws = new WebSocket(`ws://127.0.0.1:${(risk.server.address() as AddressInfo).port}/ws`);
      const first = await new Promise<any>((resolve) => {
        ws.on('message', (d) => {
          const m = JSON.parse(String(d));
          if (m.type === 'state' && m.reqId === 's') resolve(m);
        });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: room.id, reqId: 's' })));
      });
      expect(first.reactions).toBe(true);
      ws.close();
    } finally {
      await risk.shutdown('test');
    }
  });
});
