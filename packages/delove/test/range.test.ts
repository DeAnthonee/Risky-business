import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { playGame, riskyBot, stepAgent } from '@risk/selfplay';
import { discoverNetAgents, rangeAgent, rangeOf, type Range } from '../src/index.js';

const TINY = fileURLToPath(new URL('./fixtures/tiny.onnx', import.meta.url));

describe('Delove Range (range specialists routed by players alive)', () => {
  it('routes by players still alive: long for 4+, mid for 3, close for 2', () => {
    const seen = new Map<number, Set<Range>>();
    const spy = stepAgent('spy@1', (ctx) => {
      const alive = ctx.state.players.filter((p) => p.alive).length;
      const r = rangeOf(ctx.state);
      seen.set(alive, (seen.get(alive) ?? new Set()).add(r));
      return 0;
    });
    // risky@1 knocks players out, so one 6-player game passes through every range.
    for (const seed of [1, 2, 3]) playGame({ seed, seats: [{ agent: spy }, ...Array.from({ length: 5 }, () => ({ agent: riskyBot }))], maxTurns: 400 });
    for (const [alive, ranges] of seen) {
      expect([...ranges]).toEqual([alive <= 2 ? 'close' : alive === 3 ? 'mid' : 'long']);
    }
    expect(seen.has(6)).toBe(true);
  });

  it('plays whole games legally, deterministically, on several maps and table sizes', () => {
    const agent = rangeAgent('delove-range@0', { close: TINY, mid: TINY, long: TINY });
    for (const [players, options] of [[2, {}], [4, {}], [6, { map: 'world' as const }]] as const) {
      const seats = Array.from({ length: players }, (_, i) => ({ agent: i % 2 === 0 ? agent : riskyBot }));
      const a = playGame({ seed: 5, seats, options, record: true, onIllegal: 'throw', maxTurns: 60 });
      const b = playGame({ seed: 5, seats, options, record: true, onIllegal: 'throw', maxTurns: 60 });
      expect(a.records!.map((r) => r.choice)).toEqual(b.records!.map((r) => r.choice));
    }
  });

  it('is discovered from delove-range@N.json next to its models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delove-range-'));
    for (const m of ['delove-long@1', 'delove-mid@1', 'delove-close@1']) copyFileSync(TINY, join(dir, `${m}.onnx`));
    writeFileSync(join(dir, 'delove-range@1.json'), JSON.stringify({ close: 'delove-close@1', mid: 'delove-mid@1', long: 'delove-long@1' }));
    const ids = discoverNetAgents(dir).map((a) => a.id);
    expect(ids).toContain('delove-range@1');
    expect(ids).toContain('delove-long@1');
    // A route to a missing model is skipped rather than failing every game later.
    writeFileSync(join(dir, 'delove-range@2.json'), JSON.stringify({ close: 'nope', mid: 'delove-mid@1', long: 'delove-long@1' }));
    expect(discoverNetAgents(dir).map((a) => a.id)).not.toContain('delove-range@2');
  });
});
