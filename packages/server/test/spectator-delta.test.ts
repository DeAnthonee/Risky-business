import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { chooseBotAction, type GameView } from '@risk/engine';
import { Store, type GameRoom } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { KEYFRAME_EVERY } from '../src/spectator-delta.js';
import { applyViewPatch } from '../../client/src/spectatorDelta.js';

let risk: RiskServer;
let store: Store;
let url: string;

beforeEach(async () => {
  store = new Store(null);
  risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(risk.server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  await risk.shutdown('test');
});

/** A started 4-seat classic game the test moves by hand (no bot timers). */
function table(): GameRoom {
  const { room } = store.create('Delta', { map: 'classic', maxPlayers: 4, autoSetup: true }, 'Ann');
  for (const n of ['Bob', 'Cat', 'Dan']) room.join(n);
  room.start();
  room.stopBot();
  return room;
}

function move(room: GameRoom) {
  const cur = room.state.currentPlayer!;
  room.act(cur, chooseBotAction(room.state, cur) ?? { type: 'end_turn' });
  room.stopBot();
}

/** A spectator socket that keeps every message and its size. */
async function watch(gameId: string, frames?: 'delta') {
  const ws = new WebSocket(url);
  const got: { msg: any; bytes: number }[] = [];
  ws.on('message', (raw) => got.push({ msg: JSON.parse(String(raw)), bytes: String(raw).length }));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe', gameId, ...(frames ? { frames } : {}) }));
  const states = () => got.filter((g) => g.msg.type === 'state' || g.msg.type === 'state_delta');
  return { ws, got, states };
}

const settle = async (pred: () => boolean) => {
  const end = Date.now() + 5_000;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};

/** What a client does with the frames: rebuild every view, checking each delta applies on the frame before it. */
function rebuild(frames: { msg: any }[]): GameView[] {
  const out: GameView[] = [];
  let view: GameView | null = null;
  let at: number | null = null;
  for (const { msg } of frames) {
    if (msg.type === 'state') {
      view = msg.state;
      at = msg.frame;
    } else {
      expect(msg.base).toBe(at);
      view = msg.state ?? applyViewPatch(view!, msg.patch);
      at = msg.frame;
    }
    out.push(view!);
  }
  return out;
}

describe('compact spectator frames (subscribe frames: delta)', () => {
  it('rebuild exactly the full spectator view after every move, at a fraction of the bytes', async () => {
    const room = table();
    const full = await watch(room.id);
    const delta = await watch(room.id, 'delta');
    await settle(() => full.states().length === 1 && delta.states().length === 1);
    expect(delta.states()[0].msg).toMatchObject({ type: 'state', frame: expect.any(Number) });
    for (let i = 0; i < 40; i++) move(room);
    await settle(() => full.states().length === 41 && delta.states().length === 41);
    // An old client (no frames field) never sees a delta.
    expect(full.got.some((g) => g.msg.type === 'state_delta')).toBe(false);
    const views = rebuild(delta.states());
    full.states().forEach((f, i) => {
      expect(views[i]).toEqual(f.msg.state);
      if (i) expect(delta.states()[i].msg).toMatchObject({ version: f.msg.version, events: f.msg.events, you: null });
    });
    const bytes = (s: { bytes: number }[]) => s.slice(1).reduce((a, g) => a + g.bytes, 0);
    expect(bytes(delta.states())).toBeLessThan(bytes(full.states()) / 3);
    full.ws.close();
    delta.ws.close();
  });

  it('a late subscriber joins the chain where it stands, and a keyframe carries the whole view', async () => {
    const room = table();
    const early = await watch(room.id, 'delta');
    await settle(() => early.states().length === 1);
    for (let i = 0; i < 5; i++) move(room);
    await settle(() => early.states().length === 6);
    const late = await watch(room.id, 'delta');
    await settle(() => late.states().length === 1);
    expect(late.states()[0].msg.frame).toBe(early.states()[5].msg.frame);
    const before = early.states()[5].msg.frame;
    const toKey = KEYFRAME_EVERY - (before % KEYFRAME_EVERY);
    for (let i = 0; i < toKey; i++) move(room);
    await settle(() => late.states().length === 1 + toKey);
    const last = late.states().at(-1)!.msg;
    expect(last.frame % KEYFRAME_EVERY).toBe(0);
    expect(last.state).toBeTruthy();
    expect(last.patch).toBeUndefined();
    const a = rebuild(early.states()).at(-1);
    const b = rebuild(late.states()).at(-1);
    expect(b).toEqual(a);
    expect(b).toEqual(JSON.parse(JSON.stringify(room.spectatorView())));
    early.ws.close();
    late.ws.close();
  });
});
