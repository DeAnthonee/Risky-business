import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  assembleRecord,
  chooseBotAction,
  createGame,
  getMap,
  recordHeader,
  recordStep,
  startGame,
  type GameOptions,
  type GameRecord,
  type RecordEntry,
} from '@risk/engine';
import {
  aliveCount,
  gameSeed,
  playGame,
  positionsFromRecord,
  readPositions,
  riskyBot,
  runBatch,
  seededRandom,
  stageSeats,
  startState,
  type Agent,
  type DecisionRecord,
} from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'risk-stage-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** risky@1's moves under another id, so the logs show who played. */
const as = (id: string): Agent => ({ id, choose: riskyBot.choose });
const lead = (n: number) => Array.from({ length: n }, () => ({ agent: as('lead@1') }));
const stageAgents = [as('a@1'), as('b@1'), as('c@1')];

/** A built-in bot game written as the server records it (record.ts). */
function botRecord(id: string, seats: number, options: Partial<GameOptions>, seed: number): GameRecord {
  let state = createGame(id, { ...options, maxPlayers: seats }, seed);
  for (let s = 0; s < seats; s++) state = addPlayer(state, `p_${id}_${s}`, `Bot ${s}`, true);
  const started = startGame(state);
  state = started.state;
  const header = recordHeader(id, { id, name: id }, state, started.events);
  const random = seededRandom(seed ^ 0x51);
  const entries: RecordEntry[] = [];
  while (state.phase !== 'finished' && state.turnNumber < 300) {
    const me = state.currentPlayer!;
    const action = chooseBotAction(state, me, random) ?? { type: 'surrender' as const };
    const r = applyAction(state, me, action);
    entries.push(recordStep(header, state, me, action, r.events, 0));
    state = r.state;
  }
  return assembleRecord(header, entries, state, 0);
}

describe('stage games: a lead-in, then the stage agents', () => {
  const cfg = { seed: 21, seats: lead(6), options: { map: 'world' } as Partial<GameOptions>, record: true, stage: { alive: 3, agents: stageAgents, rotate: 1 } };

  it('records only from the moment 3 players are left, played by the stage agents', () => {
    const r = playGame(cfg);
    expect(r.stage).toBeTruthy();
    expect(r.stage!.alive).toBe(3);
    const recs = r.records!;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].i).toBe(r.stage!.step);
    expect(recs.at(-1)!.i).toBe(r.steps - 1);
    for (const rec of recs) {
      expect(['a@1', 'b@1', 'c@1']).toContain(rec.agent);
      expect(rec.state.seats.filter((s) => s[0]).length).toBeLessThanOrEqual(3);
    }
    // the three survivors each got a different stage agent; the dead seats kept their lead-in agent
    const assigned = r.stage!.agents.filter((a) => a !== 'lead@1');
    expect([...assigned].sort()).toEqual(['a@1', 'b@1', 'c@1']);
    // ... and the full game is the same game as without a stage (same agents' moves), only the log differs
    const whole = playGame({ ...cfg, stage: undefined });
    expect(r.winner).toBe(whole.winner);
    expect(r.turns).toBe(whole.turns);
    expect(whole.records!.slice(r.stage!.step).map((x) => x.state)).toEqual(recs.map((x) => x.state));
  });

  it('replays exactly, and rotate moves the roles round the survivors', () => {
    expect(playGame(cfg)).toEqual(playGame(cfg));
    const a = playGame(cfg).stage!.agents;
    const b = playGame({ ...cfg, stage: { ...cfg.stage, rotate: 2 } }).stage!.agents;
    expect(b).not.toEqual(a);
  });

  it('a table already at the stage records the whole game', () => {
    const r = playGame({ seed: 3, seats: lead(2), record: true, stage: { alive: 2, agents: [as('x@1'), as('y@1')], rotate: 0 } });
    expect(r.stage).toMatchObject({ turn: 0, step: 0 });
    expect(r.records![0].i).toBe(0);
    expect(r.records!.length).toBe(r.steps);
  });

  it('stageSeats: survivors in turn order from the player to move, rotated', () => {
    const r = playGame({ ...cfg, record: false, maxTurns: 1 });
    expect(r.stage).toBeNull(); // never reached
    let state = startGame([0, 1, 2, 3].reduce((s, i) => addPlayer(s, `s${i}`, `s${i}`, true), createGame('t', { maxPlayers: 4 }, 9))).state;
    state = { ...state, players: state.players.map((p) => (p.id === 's1' ? { ...p, alive: false } : p)) };
    const ids = ['s0', 's1', 's2', 's3'];
    const from = state.turnOrder.indexOf(state.currentPlayer!);
    const alive = [...state.turnOrder.slice(from), ...state.turnOrder.slice(0, from)].filter((p) => p !== 's1');
    const m = stageSeats(state, ids, 3, 1);
    expect(alive.map((p) => m.get(ids.indexOf(p)))).toEqual([1, 2, 0]);
    expect(m.has(1)).toBe(false);
  });
});

describe('positions from game records', () => {
  const records = [botRecord('r1', 4, {}, 5), botRecord('r2', 6, { map: 'world', fogOfWar: true }, 6), botRecord('r3', 5, { map: 'europe', capitals: true }, 7)];

  it('captures the moment each alive count is reached, with self-play seat ids', () => {
    const pos = records.flatMap((r) => positionsFromRecord(r, [3, 2]));
    expect(pos.length).toBeGreaterThanOrEqual(4);
    for (const p of pos) {
      expect(aliveCount(p.state)).toBe(p.alive);
      expect(p.state.options.fogOfWar).toBe(false);
      const ids = p.state.players.filter((x) => !x.isNeutral).map((x) => x.id);
      expect(ids).toEqual(Array.from({ length: p.seats }, (_, i) => `s${i}`));
      for (const t of Object.values(p.state.territories)) expect(t.owner === null || t.owner === 'neutral' || ids.includes(t.owner)).toBe(true);
      expect(p.eliminated.length).toBe(p.seats - p.alive);
      expect(p.source).toMatch(/^record:r\d@\d+$/);
    }
  });

  it('plays from a position: deterministic per seed, different dice per seed, earlier eliminations placed last', () => {
    const p = positionsFromRecord(records[0], [2])[0];
    const play = (seed: number) =>
      playGame({ seed, seats: lead(p.seats), record: true, start: { state: startState(p, seed, 'g'), eliminated: p.eliminated }, stage: { alive: 2, agents: [as('x@1'), as('y@1')], rotate: 0 } });
    const a = play(11);
    expect(play(11)).toEqual(a);
    expect(play(12).records).not.toEqual(a.records);
    expect(a.records![0].state.armies).toEqual(getMap(p.map).territoryIds.map((t) => p.state.territories[t].armies));
    const firstOut = Number(p.eliminated.filter((x) => x !== 'neutral')[0].slice(1));
    expect(a.placement[firstOut]).toBe(p.seats);
    expect(a.records!.every((r: DecisionRecord) => ['x@1', 'y@1'].includes(r.agent))).toBe(true);
  });

  it('runBatch plays a positions file round robin', async () => {
    const file = join(tmp, 'pos.jsonl');
    writeFileSync(file, records.flatMap((r) => positionsFromRecord(r, [3, 2])).map((p) => JSON.stringify(p) + '\n').join(''));
    const pos = readPositions(file, 2);
    expect(pos.every((p) => p.alive === 2)).toBe(true);
    const log = join(tmp, 'pos-log');
    const res = await runBatch({
      games: 4,
      seed: 3,
      seats: (i) => lead(pos[i % pos.length].seats),
      stage: { alive: 2, agents: [as('x@1'), as('y@1')] },
      start: (i, seed) => ({ state: startState(pos[i % pos.length], seed, `g${i}`), eliminated: pos[i % pos.length].eliminated }),
      logDir: log,
    });
    expect(res.map((r) => r.map)).toEqual([0, 1, 2, 3].map((i) => pos[i % pos.length].map));
    expect(res[1].seed).toBe(gameSeed(3, 1));
    const lines = gunzipSync(readFileSync(join(log, 'decisions-0-3.jsonl.gz'))).toString().trim().split('\n');
    expect(lines.length).toBe(res.reduce((a, r) => a + r.steps, 0));
  });
});
