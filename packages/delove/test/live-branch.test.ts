import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_BRANCH_DEFAULT_PRESET, LIVE_BRANCH_PRESETS, liveBranchEnv, newestBaseModel } from '../src/branch-env.js';

describe('live seat search defaults', () => {
  const folder = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'delove-live-'));
    for (const f of files) writeFileSync(join(dir, f), '');
    return dir;
  };

  it('ranks with the newest base network, ignoring specialists, value heads and teachers', () => {
    const dir = folder(['delove@2.onnx', 'delove@10.onnx', 'delove@9.onnx', 'delove@11.value.onnx', 'delove-long-range@12.onnx', 'delove-teacher@3.json']);
    try {
      expect(newestBaseModel(dir)).toBe('delove@10');
      expect(liveBranchEnv(dir, {}).DELOVE_BRANCH_RANKER).toBe('delove@10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to js2-range, the winner of the preset ladder: Jacob Sensei 2, 5 options, range score, horizon 2, margin 0.02", () => {
    expect(LIVE_BRANCH_DEFAULT_PRESET).toBe('js2-range');
    expect(liveBranchEnv(join(tmpdir(), 'no-such-delove-folder'), {})).toMatchObject({
      DELOVE_BRANCH_TEACHER: 'jacob-sensei@2',
      DELOVE_BRANCH_OPTIONS: '5',
      DELOVE_BRANCH_SCORE: 'range',
      DELOVE_BRANCH_HORIZON: '2',
      DELOVE_BRANCH_MARGIN: '0.02',
    });
  });

  it('the js2-range preset is Jacob Sensei 2, the range score, horizon 2 and margin 0.02', () => {
    expect(liveBranchEnv(join(tmpdir(), 'no-such-delove-folder'), {}, 'js2-range')).toMatchObject({
      DELOVE_BRANCH_TEACHER: 'jacob-sensei@2',
      DELOVE_BRANCH_OPTIONS: '5',
      DELOVE_BRANCH_SCORE: 'range',
      DELOVE_BRANCH_HORIZON: '2',
      DELOVE_BRANCH_MARGIN: '0.02',
    });
    expect(Object.keys(LIVE_BRANCH_PRESETS)).toEqual(['measured', 'js2-range']);
  });

  it('keeps every DELOVE_BRANCH_* variable already set, whatever the preset', () => {
    const dir = folder(['delove@8.onnx']);
    try {
      const set = { DELOVE_BRANCH_RANKER: 'delove@6', DELOVE_BRANCH_TEACHER: 'jacob-sensei@2', DELOVE_BRANCH_OPTIONS: '3', DELOVE_BRANCH_SCORE: 'range', DELOVE_BRANCH_HORIZON: '2', DELOVE_BRANCH_MARGIN: '0.05', OTHER: 'x' };
      expect(liveBranchEnv(dir, set)).toMatchObject(set);
      expect(liveBranchEnv(dir, set, 'js2-range')).toMatchObject(set);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the ranker unset when the folder has no base network, and refuses an unknown preset', () => {
    expect(newestBaseModel(join(tmpdir(), 'no-such-delove-folder'))).toBeNull();
    expect(liveBranchEnv(join(tmpdir(), 'no-such-delove-folder'), {}).DELOVE_BRANCH_RANKER).toBeUndefined();
    expect(() => liveBranchEnv(join(tmpdir(), 'no-such-delove-folder'), {}, 'nope' as never)).toThrow(/unknown live search preset/);
  });
});
