import { mkdtempSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, startGame, viewFor, type Action, type GameState } from '@risk/engine';
import { HttpRiskApi, RiskHttpError, type RiskApi } from '@risk/mcp';
import { seededRandom, type Agent } from '@risk/selfplay';
import type { RiskServer } from '../../server/src/app.js';

// branch.ts reads DELOVE_BRANCH_TRACE when it loads: set it first, then load Delove (vitest gives each test file its
// own modules).
const dir = mkdtempSync(join(tmpdir(), 'delove-notes-'));
process.env.DELOVE_BRANCH_TRACE = join(dir, 'trace.jsonl');
process.env.DELOVE_NOTES_TRACE_OWNED = '1';
const D = await import('../src/index.js');
const { Noter, capNote, shortMove, MAX_NOTE_BYTES } = await import('../src/notes.js');
const { chooseFromView, playSeat } = await import('../src/seat.js');

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const TINY = join(FIXTURES, 'tiny.onnx');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function game(players: number, options: Record<string, unknown> = {}, seed = 3): GameState {
  let s = createGame('notes', { maxPlayers: players, ...options }, seed);
  for (let i = 0; i < players; i++) s = addPlayer(s, `p${i}`, `p${i}`, true);
  return startGame(s).state;
}

/** Plays `moves` moves of the game with `agent` in every seat, noting each one; returns the notes. */
function play(agent: Agent, noter: InstanceType<typeof Noter>, state: GameState, moves: number): Record<string, unknown>[] {
  const notes: Record<string, unknown>[] = [];
  for (let k = 0; k < moves && state.phase !== 'finished'; k++) {
    const me = state.currentPlayer!;
    const view = viewFor(state, me);
    noter.begin(agent);
    const action = chooseFromView(agent, view, me, seededRandom(k + 1))!;
    const seat = view.players.filter((p) => !p.isNeutral).findIndex((p) => p.id === me);
    const note = noter.note(agent, view, seat);
    expect(note).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(note))).toBeLessThanOrEqual(MAX_NOTE_BYTES);
    notes.push(note!);
    state = applyAction(state, me, action).state;
  }
  return notes;
}

describe('decision notes (notes.ts)', () => {
  it('short moves and the 2 KB cap', () => {
    const ids = ['a', 'b', 'c'];
    expect(shortMove(['attack', 0, 1], ids)).toBe('att a>b');
    expect(shortMove(['place', 2, 3], ids)).toBe('pl c 3');
    expect(shortMove(['fortify_to', 1, 4], ids)).toBe('ft b 4');
    expect(shortMove(['end_turn'], ids)).toBe('end');
    const big = { agent: 'x', top: Array.from({ length: 200 }, (_, i) => ({ m: `att territory-${i}>territory-${i + 1}`, s: 0.123, r: 6 })), chosen: 150 };
    const cut = capNote(big);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(MAX_NOTE_BYTES);
    expect((cut.top as unknown[]).length).toBeGreaterThan(5);
    expect(cut.chosen).toBeUndefined(); // the move played was cut off
    expect(cut.cut).toBe(1);
    const huge = capNote({ agent: 'y'.repeat(5000) });
    expect(huge).toEqual({ agent: 'y'.repeat(60), cut: 1 });
  });

  it('a network seat: its top 3 with probabilities and its win chance', () => {
    const net = D.netAgent('tiny@1', TINY);
    const noter = new Noter(new Map([[net, { label: 'tiny@1', model: 'tiny@1', preset: null }]]));
    const notes = play(net, noter, game(3, { map: 'classic', autoSetup: true }), 60);
    const n = notes.find((x) => x.phase === 'attack')!;
    expect(n).toMatchObject({ agent: 'tiny@1', model: 'tiny@1', preset: null, alive: 3, fog: false });
    const top = n.top as { m: string; p: number }[];
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(3);
    expect(top.every((t) => typeof t.m === 'string' && t.p >= 0 && t.p <= 1)).toBe(true);
    expect(top.reduce((a, t) => a + t.p, 0)).toBeLessThanOrEqual(1.001);
    expect(typeof n.value).toBe('number');
  });

  it('a search seat: the options it compared with their branch scores, the one played and the margin', () => {
    const search = D.branchFromEnv(FIXTURES, { DELOVE_BRANCH_RANKER: 'tiny', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1', DELOVE_BRANCH_ROLLOUTS: '2', DELOVE_BRANCH_OPTIONS: '3', DELOVE_BRANCH_HORIZON: '1', DELOVE_BRANCH_MARGIN: '0.01' });
    const noter = new Noter(new Map([[search, { label: 'tiny + search', model: 'tiny', preset: 'measured' }]]));
    const notes = play(search, noter, game(3, { map: 'skirmish' }), 80);
    const compared = notes.filter((n) => Array.isArray(n.top));
    expect(compared.length).toBeGreaterThan(0);
    const n = compared[0];
    expect(n).toMatchObject({ agent: 'tiny + search', model: 'tiny', preset: 'measured', margin: 0.01 });
    const top = n.top as { m: string; s: number; r: number }[];
    expect(top.length).toBeGreaterThanOrEqual(2);
    expect(top.every((t) => typeof t.m === 'string' && typeof t.s === 'number' && t.r === 2)).toBe(true);
    expect(n.chosen).toBeGreaterThanOrEqual(0);
    expect(n.chosen as number).toBeLessThan(top.length);
    expect(notes.some((x) => x.br === 0)).toBe(true); // setup / teacher-only moves: nothing compared
  });

  it('two search seats in one process, back to back: each note has its own decision, and the trace stays empty', () => {
    const env = { DELOVE_BRANCH_TEACHER: 'jacob-sensei@1', DELOVE_BRANCH_ROLLOUTS: '2', DELOVE_BRANCH_OPTIONS: '3', DELOVE_BRANCH_HORIZON: '1', DELOVE_BRANCH_MARGIN: '0.01' };
    const a = D.branchFromEnv(FIXTURES, { ...env, DELOVE_BRANCH_RANKER: 'tiny' });
    const b = D.branchFromEnv(FIXTURES, { ...env, DELOVE_BRANCH_RANKER: 'tiny-fog' });
    const noter = new Noter(new Map([[a, { label: 'A', model: 'tiny', preset: 'measured' }], [b, { label: 'B', model: 'tiny-fog', preset: 'measured' }]]));
    let state = game(2, { map: 'skirmish', autoSetup: true }, 7);
    let checked = 0;
    for (let k = 0; k < 120 && state.phase !== 'finished'; k++) {
      const me = state.currentPlayer!;
      const agent = me === 'p0' ? a : b; // the two seats take turns in the same process, as a --tournament child does
      const view = viewFor(state, me);
      noter.begin(agent);
      const action = chooseFromView(agent, view, me, seededRandom(k + 1))!;
      const seat = view.players.filter((p) => !p.isNeutral).findIndex((p) => p.id === me);
      const note = noter.note(agent, view, seat)!;
      expect(statSync(process.env.DELOVE_BRANCH_TRACE!).size).toBe(0); // read and emptied: no line left for the next move
      expect(note.agent).toBe(me === 'p0' ? 'A' : 'B');
      if (Array.isArray(note.top) && typeof note.chosen === 'number' && (action.type === 'attack' || action.type === 'place')) {
        // the option the note says was played is the move this seat sent
        const played = action.type === 'attack' ? `att ${action.from}>${action.to}` : `pl ${Object.keys(action.placements)[0]} ${Object.values(action.placements)[0]}`;
        expect((note.top as { m: string }[])[note.chosen].m).toBe(played);
        checked++;
      }
      state = applyAction(state, me, action).state;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('a search seat under fog plays its ranker (fb) and says so', () => {
    const search = D.branchFromEnv(FIXTURES, { DELOVE_BRANCH_RANKER: 'tiny', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1' });
    const noter = new Noter(new Map([[search, { label: 's', model: 'tiny', preset: 'js2-range' }]]));
    const notes = play(search, noter, game(3, { map: 'classic', fogOfWar: true, autoSetup: true }), 30);
    expect(notes.every((n) => n.fog === true && n.fb === 1 && n.br === undefined)).toBe(true);
    expect(notes.some((n) => Array.isArray(n.top) && (n.top as { p: number }[])[0].p >= 0)).toBe(true);
  });
});

describe('decision notes over the API (with #206 act notes)', () => {
  let risk: RiskServer;
  let base = '';
  beforeAll(async () => {
    process.env.RISK_BOT_DELAY_MS = '0';
    const { Store } = await import('../../server/src/store.js');
    const { createRiskServer } = await import('../../server/src/app.js');
    risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  });
  afterAll(() => risk.server.close());

  it('every move goes with a note the server accepts', async () => {
    const api = new HttpRiskApi(base);
    const sent: unknown[] = [];
    const recording: RiskApi = new Proxy(api, {
      get(t, k, r) {
        if (k === 'act') return (g: string, tok: string, a: Action, note?: unknown) => (sent.push(note), t.act(g, tok, a, note));
        // 30 moves are enough (a random network can take long to finish a game): then the game "is gone"
        if (k === 'wait' && sent.length >= 30) return async () => Promise.reject(new RiskHttpError('enough moves', 404));
        return Reflect.get(t, k, r);
      },
    });
    const net = D.netAgent('tiny@1', TINY);
    const host = await api.createGame('Delove', 'notes', { map: 'skirmish', maxPlayers: 2 });
    await api.addBot(host.gameId, host.token);
    await api.start(host.gameId, host.token);
    const logs: string[] = [];
    await playSeat({ api: recording, gameId: host.gameId, playerId: host.playerId, token: host.token, name: 'Delove', agent: net, paceMs: 0, log: (l) => logs.push(l),
      notes: new Noter(new Map([[net, { label: 'tiny@1', model: 'tiny@1', preset: null }]])) });
    expect(sent.length).toBeGreaterThanOrEqual(30);
    expect(sent.every((n) => n && (n as { agent: string }).agent === 'tiny@1')).toBe(true);
    expect(logs.some((l) => l.includes('refused'))).toBe(false);
  }, 60_000);
});
