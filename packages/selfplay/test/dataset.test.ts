import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getMap } from '@risk/engine';
import {
  CANDIDATE_FEATURES,
  CANDIDATE_KINDS,
  encodeDecision,
  exportDataset,
  GLOBAL_FEATURES,
  NpyWriter,
  playGame,
  readNpy,
  riskyBot,
  runBatch,
  TERRITORY_FEATURES,
  type DecisionRecord,
} from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'risk-dataset-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TF = TERRITORY_FEATURES.length;
const CF = CANDIDATE_FEATURES.length;
const tcol = (name: (typeof TERRITORY_FEATURES)[number]) => TERRITORY_FEATURES.indexOf(name);
const ccol = (name: (typeof CANDIDATE_FEATURES)[number]) => CANDIDATE_FEATURES.indexOf(name);

const game = playGame({ seed: 12, seats: [{ agent: riskyBot }, { agent: riskyBot }, { agent: riskyBot }], record: true, options: { capitals: true } });
const recs = game.records!;

describe('encodeDecision', () => {
  it('produces fixed-size, finite features with one owner bucket per territory', () => {
    const T = getMap('classic').territoryIds.length;
    const ownerCols = TERRITORY_FEATURES.flatMap((f, i) => (f.startsWith('owner_') ? [i] : []));
    for (const rec of recs.filter((_, i) => i % 25 === 0)) {
      const f = encodeDecision(rec);
      expect(f.territory).toHaveLength(T * TF);
      expect(f.global).toHaveLength(GLOBAL_FEATURES.length);
      expect(f.cand).toHaveLength(rec.cands.length * CF);
      for (const arr of [f.territory, f.global, f.cand]) expect(arr.every(Number.isFinite)).toBe(true);
      for (let t = 0; t < T; t++) expect(ownerCols.reduce((a, c) => a + f.territory[t * TF + c], 0)).toBe(1);
      // Each candidate has exactly its kind set.
      rec.cands.forEach((c, i) => expect(f.cand[i * CF + CANDIDATE_KINDS.indexOf(c[0])]).toBe(1));
    }
  });

  it('sees the board from the decider: their territories are slot 0, the next player slot 1', () => {
    for (const seat of [0, 1, 2]) {
      const rec = recs.find((r) => r.seat === seat && r.phase === 4 /* attack */)!;
      const f = encodeDecision(rec);
      const order = rec.state.order;
      const next = order[(order.indexOf(seat) + 1) % order.length];
      rec.state.owner.forEach((o, t) => {
        if (o === seat) expect(f.territory[t * TF + tcol('owner_slot0')]).toBe(1);
        if (o === next) expect(f.territory[t * TF + tcol('owner_slot1')]).toBe(1);
      });
      expect(f.global[GLOBAL_FEATURES.indexOf('slot0_alive')]).toBe(1);
      expect(f.global[GLOBAL_FEATURES.indexOf('slot3_present')]).toBe(0);
    }
  });

  it('points candidates at their territories and marks the fortify source on the second step', () => {
    const attackRec = recs.find((r) => r.cands.some((c) => c[0] === 'attack'))!;
    const fa = encodeDecision(attackRec);
    attackRec.cands.forEach((c, i) => {
      if (c[0] !== 'attack') return;
      expect([fa.candFrom[i], fa.candTo[i]]).toEqual([c[1], c[2]]);
      expect(Math.abs(fa.cand[i * CF + ccol('attack_ratio_log')])).toBeLessThanOrEqual(3);
    });
    const second = recs.find((r) => r.state.fortifyFrom >= 0)!;
    const fs = encodeDecision(second);
    expect(fs.territory[second.state.fortifyFrom * TF + tcol('fortify_from')]).toBe(1);
    second.cands.forEach((c, i) => {
      expect(fs.candFrom[i]).toBe(second.state.fortifyFrom);
      expect(fs.candTo[i]).toBe(c[1]);
      expect(fs.cand[i * CF + ccol('amount_share')]).toBeGreaterThan(0);
      expect(fs.cand[i * CF + ccol('amount_share')]).toBeLessThanOrEqual(1);
    });
  });

  it('flags capitals and the capitals rule', () => {
    const rec = recs.find((r) => r.phase === 4 && r.state.capitals[r.seat] >= 0 && r.state.owner[r.state.capitals[r.seat]] === r.seat)!;
    const f = encodeDecision(rec);
    expect(f.global[GLOBAL_FEATURES.indexOf('rule_capitals')]).toBe(1);
    expect(f.territory[rec.state.capitals[rec.seat] * TF + tcol('my_capital')]).toBe(1);
    const theirs = rec.state.capitals.find((t, seat) => seat !== rec.seat && t >= 0)!;
    expect(f.territory[theirs * TF + tcol('enemy_capital')]).toBe(1);
  });
});

describe('npy files', () => {
  it('round-trips rows written in several appends', () => {
    const path = join(tmp, 'x.npy');
    const w = new NpyWriter(path, '<f4', [2]);
    w.append(new Float32Array([1, 2, 3, 4]));
    w.append(new Float32Array([5, 6]));
    w.close();
    const r = readNpy(path);
    expect(r.shape).toEqual([3, 2]);
    expect([...r.data]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readFileSync(path).length).toBe(256 + 6 * 4);
    expect(() => new NpyWriter(join(tmp, 'y.npy'), '<i4', [3]).append(new Int32Array([1, 2]))).toThrow(/whole number of rows/);
  });
});

describe('exportDataset', () => {
  it('writes aligned arrays a trainer can index decision by decision', async () => {
    const logDir = join(tmp, 'log');
    const out = join(tmp, 'out');
    const games = await runBatch({ games: 2, seed: 5, seats: () => [{ agent: riskyBot }, { agent: riskyBot }], logDir });
    const [result] = await exportDataset([logDir], out);
    const N = games.reduce((a, g) => a + g.steps, 0);
    expect(result).toMatchObject({ map: 'classic', decisions: N, games: 2, skipped: 0 });

    const load = (name: string) => readNpy(join(out, 'classic', `${name}.npy`));
    const T = getMap('classic').territoryIds.length;
    expect(load('territory').shape).toEqual([N, T, TF]);
    expect(load('global').shape).toEqual([N, GLOBAL_FEATURES.length]);
    const offsets = [...(load('cand_offset').data as BigInt64Array)].map(Number);
    expect(offsets).toHaveLength(N + 1);
    expect(offsets[N]).toBe(result.candidates);
    expect(load('cand').shape).toEqual([result.candidates, CF]);
    const choice = load('choice').data as Int32Array;
    choice.forEach((c, k) => {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(offsets[k + 1] - offsets[k]);
    });
    expect(new Set(load('game').data as Int32Array)).toEqual(new Set([0, 1]));
    const z = [...(load('z').data as Float32Array)];
    expect(z.every((v) => v === 0 || v === 1)).toBe(true);

    // Row k is exactly the encoding of the k-th logged step.
    const lines = (await import('node:zlib')).gunzipSync(readFileSync(join(logDir, 'decisions-0-1.jsonl.gz'))).toString().trim().split('\n');
    const k = Math.floor(N / 2);
    const rec = JSON.parse(lines[k]) as DecisionRecord;
    const f = encodeDecision(rec);
    expect([...(load('global').data as Float32Array).subarray(k * GLOBAL_FEATURES.length, (k + 1) * GLOBAL_FEATURES.length)]).toEqual([...f.global]);
    expect([...(load('cand').data as Float32Array).subarray(offsets[k] * CF, offsets[k + 1] * CF)]).toEqual([...f.cand]);

    const info = JSON.parse(readFileSync(join(out, 'classic', 'features.json'), 'utf8'));
    expect(info).toMatchObject({ encoderVersion: 2, logVersion: 2, decisions: N });
    expect(info.territoryFeatures).toEqual([...TERRITORY_FEATURES]);
  });

  it('refuses logs in the old format', async () => {
    const old = join(tmp, 'v1');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'meta.json'), JSON.stringify({ v: 1 }));
    await expect(exportDataset([old], join(tmp, 'out-v1'))).rejects.toThrow(/format v1/);
  });

  it('refuses an old record next to a new meta.json, and a non-empty output folder', async () => {
    const mixed = join(tmp, 'mixed');
    mkdirSync(mixed, { recursive: true });
    writeFileSync(join(mixed, 'meta.json'), JSON.stringify({ v: 2 }));
    writeFileSync(join(mixed, 'decisions-0-1.jsonl'), JSON.stringify({ v: 1, map: 'classic', choice: 0 }) + '\n');
    await expect(exportDataset([mixed], join(tmp, 'out-mixed'))).rejects.toThrow(/record in log format v1/);
    const full = join(tmp, 'out-full');
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'old.txt'), 'x');
    await expect(exportDataset([mixed], full)).rejects.toThrow(/not empty/);
  });

  it('leaves fog-of-war games out (the encoder sees the whole board)', async () => {
    const logDir = join(tmp, 'log-fog');
    await runBatch({ games: 1, seed: 7, seats: () => [{ agent: riskyBot }, { agent: riskyBot }], logDir, options: { fogOfWar: true } });
    const [result] = await exportDataset([logDir], join(tmp, 'out-fog'));
    expect(result.decisions).toBe(0);
    expect(result.fogSkipped).toBeGreaterThan(0);
  });
});
