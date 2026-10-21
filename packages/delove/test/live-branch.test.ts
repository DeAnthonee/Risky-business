import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_BRANCH_DEFAULTS, liveBranchEnv, newestBaseModel } from '../src/branch-env.js';

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
      const env = liveBranchEnv(dir, {});
      expect(env.DELOVE_BRANCH_RANKER).toBe('delove@10');
      expect(env.DELOVE_BRANCH_TEACHER).toBe(LIVE_BRANCH_DEFAULTS.teacher);
      expect(env.DELOVE_BRANCH_OPTIONS).toBe(String(LIVE_BRANCH_DEFAULTS.options));
      expect(env.DELOVE_BRANCH_SCORE).toBe('range');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every DELOVE_BRANCH_* variable already set', () => {
    const dir = folder(['delove@8.onnx']);
    try {
      const env = liveBranchEnv(dir, { DELOVE_BRANCH_RANKER: 'delove@6', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1', DELOVE_BRANCH_OPTIONS: '3', DELOVE_BRANCH_SCORE: 'share', OTHER: 'x' });
      expect(env).toMatchObject({ DELOVE_BRANCH_RANKER: 'delove@6', DELOVE_BRANCH_TEACHER: 'jacob-sensei@1', DELOVE_BRANCH_OPTIONS: '3', DELOVE_BRANCH_SCORE: 'share', OTHER: 'x' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the ranker unset when the folder has no base network', () => {
    expect(newestBaseModel(join(tmpdir(), 'no-such-delove-folder'))).toBeNull();
    expect(liveBranchEnv(join(tmpdir(), 'no-such-delove-folder'), {}).DELOVE_BRANCH_RANKER).toBeUndefined();
  });
});
