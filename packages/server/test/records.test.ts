import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  assembleRecord,
  chooseBotAction,
  createGame,
  createRng,
  nextFloat,
  recordHeader,
  recordStep,
  recordTurnStart,
  startGame,
  type GameRecord,
  type RecordEntry,
} from '@risk/engine';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { narrate, noteLine, playByPlayText } from '../src/playbyplay.js';

const KEY = 'records-test-key';
const ADMIN = 'records-admin';

/** A seeded 3-bot game on skirmish, recorded the way the archive records one (fixed times, so the record is stable). */
function scriptedRecord(): GameRecord {
  let s = createGame('SNAP01', { map: 'skirmish', maxPlayers: 3, autoSetup: true }, 7);
  for (const [id, name] of [['p_a', 'Ann'], ['p_b', 'Bob'], ['p_c', 'Cat']]) s = addPlayer(s, id, name, true);
  const started = startGame(s);
  s = started.state;
  const header = recordHeader('SNAP01-test', { id: 'SNAP01', name: 'Snapshot' }, s, started.events);
  const entries: RecordEntry[] = [];
  const first = recordTurnStart(header, s, started.events, 0);
  if (first) entries.push(first);
  const rng = createRng(11);
  for (let n = 0; n < 20_000 && s.phase !== 'finished'; n++) {
    const me = s.currentPlayer!;
    const action = chooseBotAction(s, me, () => nextFloat(rng))!;
    const r = applyAction(s, me, action);
    entries.push(recordStep(header, s, me, action, r.events, n + 1));
    const turn = recordTurnStart(header, r.state, r.events, n + 1);
    if (turn) entries.push(turn);
    s = r.state;
  }
  const record = assembleRecord(header, entries, s, 1);
  // A G1 decision note on the first attack (the shape is tolerant until G1 fixes it).
  const attack = record.steps.find((x) => x.action.type === 'attack')!;
  (attack as typeof attack & { note: unknown }).note = { chose: 'this attack', score: 0.62, alternatives: [{ label: 'hold', score: 0.58 }], value: 0.41 };
  return record;
}

describe('narrate (play-by-play)', () => {
  const record = scriptedRecord();
  const text = playByPlayText(narrate(record));

  it('tells the game turn by turn: header, reinforcements, attacks, knockouts, the end', () => {
    expect(text.startsWith('Snapshot (SNAP01): ')).toBe(true);
    expect(text).toContain('Players: Ann, Bob, Cat');
    expect(text).toMatch(/Winner: (Ann|Bob|Cat) \(domination\) after \d+ turns/);
    expect(text).toMatch(/\nt1 \(round 1\) (Ann|Bob|Cat): \+\d+ armies/);
    expect(text).toMatch(/attacks .+ \(.+\) from .+, \d+ vs \d+: \d+ rolls?, loses \d+, kills \d+/);
    expect(text).toMatch(/✖ (Ann|Bob|Cat) is knocked out by (Ann|Bob|Cat)/);
    expect(text).toMatch(/Game over: (Ann|Bob|Cat) wins by domination/);
    expect(text).toContain('↳ ');
  });

  it('renders a decision note inline under its step', () => {
    expect(text).toContain('↳ ');
    expect(text).toMatch(/↳ (Ann|Bob|Cat) chose this attack \(\.62\) over hold \(\.58\), value \.41/);
    expect(noteLine('Delove', { chose: 'Peru', score: 0.62, alternatives: [{ label: 'Chile', score: 0.58 }], value: 0.41 })).toBe('  ↳ Delove chose Peru (.62) over Chile (.58), value .41');
    expect(noteLine('Delove', 'a plain note')).toBe('  ↳ a plain note');
    expect(noteLine('Delove', { odd: 1 })).toBe('  ↳ {"odd":1}');
    expect(noteLine('Delove', 7)).toBe('  ↳ 7');
    // Delove's shape: chosen + top candidates (the chosen one among them) + value, tagged with model and preset.
    const delove = { chosen: 'X', top: [{ label: 'X', score: 0.62 }, { label: 'Y', score: 0.58 }, { move: 'Z', p: 0.51 }], value: 0.41, model: 'delove@11', preset: 'js2-range', fog: 'fallback' };
    expect(noteLine('Delove', delove)).toBe('  ↳ Delove (delove@11, js2-range) chose X (.62) over Y (.58), Z (.51), value .41 {"fog":"fallback"}');
  });

  it('is stable: the same record always reads the same (snapshot of the opening)', () => {
    expect(playByPlayText(narrate(scriptedRecord()))).toBe(text);
    expect(text.split('\n').slice(0, 30).join('\n')).toMatchSnapshot();
  });

  it('takes extra header lines (the hook for the Zerg summary)', () => {
    const p = narrate(record, { summary: () => ['Swarm: 0 alarms'] });
    expect(p.header).toContain('Swarm: 0 alarms');
  });
});

describe('the records key (GET /api/records/*)', () => {
  let dir: string;
  let id: string;
  const servers: { risk: ReturnType<typeof createRiskServer>; base: string; store: InstanceType<typeof Store> }[] = [];

  async function start(recordsKey: string | null) {
    const store = new Store(join(dir, 'games.json'));
    const risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, recordsKey, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const s = { risk, store, base: `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}` };
    servers.push(s);
    return s;
  }
  const get = async (base: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api${path}`, { headers });
    return { status: res.status, text: await res.text(), type: res.headers.get('content-type') ?? '' };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'risk-records-'));
    // One finished, archived game: two seats played out by a seeded bot (as in archive.test.ts).
    const store = new Store(join(dir, 'games.json'));
    const { room } = store.create('Keyed', {}, 'Alice');
    room.join('Bob');
    room.start();
    const rng = createRng(3);
    for (let n = 0; n < 20_000 && room.state.phase !== 'finished'; n++) {
      const me = room.state.currentPlayer!;
      room.act(me, chooseBotAction(room.state, me, () => nextFloat(rng))!);
    }
    id = store.archive.list()[0].id;
    store.save();
    store.stopTimers();
  });
  afterAll(async () => {
    for (const s of servers) await s.risk.shutdown('test');
    rmSync(dir, { recursive: true, force: true });
  });

  it('no key set on the server: the routes are off (403), whatever is sent', async () => {
    const { base } = await start(null);
    for (const headers of [{}, { 'x-records-key': KEY }]) {
      const r = await get(base, `/records/${id}`, headers);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain('"steps"');
      expect((await get(base, `/records/${id}/playbyplay`, headers)).status).toBe(403);
    }
  });

  it('a key set: no key or a wrong one is 403 and leaks nothing; the key or the admin token reads the record', async () => {
    const { base } = await start(KEY);
    for (const headers of [{}, { 'x-records-key': 'wrong' }, { 'x-records-key': `${KEY}x` }, { authorization: 'Bearer nope' }]) {
      for (const path of [`/records/${id}`, `/records/${id}/playbyplay`, `/records/${id}/playbyplay?format=json`]) {
        const r = await get(base, path, headers);
        expect(r.status).toBe(403);
        expect(JSON.parse(r.text)).toEqual({ error: expect.any(String) });
        expect(r.text).not.toContain(KEY);
      }
    }
    const full = await get(base, `/records/${id}`, { 'x-records-key': KEY });
    expect(full.status).toBe(200);
    const record = JSON.parse(full.text) as GameRecord;
    expect(record.steps.length).toBeGreaterThan(0);
    expect(record.steps[0]).toHaveProperty('hand');
    expect((await get(base, `/records/${id}`, { authorization: `Bearer ${ADMIN}` })).status).toBe(200);

    const play = await get(base, `/records/${id}/playbyplay`, { 'x-records-key': KEY });
    expect(play.status).toBe(200);
    expect(play.type).toContain('text/plain');
    expect(play.text).toContain('Players: Alice, Bob');
    const json = await get(base, `/records/${id}/playbyplay?format=json`, { 'x-records-key': KEY });
    expect(JSON.parse(json.text).turns.length).toBeGreaterThan(0);
    expect((await get(base, '/records/NOPE00-xx', { 'x-records-key': KEY })).status).toBe(404);
  });

  it('the public routes never carry a full record (no hands, no boards)', async () => {
    const { base } = await start(KEY);
    const history = await get(base, '/history');
    expect(history.status).toBe(200);
    expect(history.text).not.toContain('"hand"');
    expect(history.text).not.toContain('"board"');
  });

  // The CLI imports the built server (npm run build); npm test alone builds only the engine, so it runs when built.
  const built = existsSync(join(__dirname, '..', 'dist', 'playbyplay.js'));
  it.skipIf(!built)('the CLI narrates a local record file', () => {
    const file = join(dir, 'one.json');
    writeFileSync(file, JSON.stringify(scriptedRecord()));
    const script = join(__dirname, '..', '..', '..', 'scripts', 'records-playbyplay.mjs');
    const out = execFileSync(process.execPath, [script, file], { encoding: 'utf8' });
    expect(out.startsWith('Snapshot (SNAP01): ')).toBe(true);
    expect(out).toMatch(/Game over: (Ann|Bob|Cat) wins by domination/);
  });
});
