import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Lets one test make the archive rename fail.
const fail = { rename: false };
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return { ...fs, renameSync: (a: string, b: string) => { if (fail.rename && b.includes('.season-')) throw new Error('EBUSY'); return fs.renameSync(a, b); } };
});
const { Rankings } = await import('../src/rankings.js');

const dirs: string[] = [];
afterEach(() => { fail.rename = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const old = [{ gameId: 'g_old_1', seats: [{ key: 'league/jinx', name: 'Jinx', placement: 1, killed: [] }, { key: 'league/shaco', name: 'Shaco', placement: 2, killed: [] }] }];
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rankings-season-'));
  dirs.push(dir);
  const file = join(dir, 'rankings.json');
  writeFileSync(file, JSON.stringify(old), 'utf8');
  return { dir, file };
};

describe('rankings seasons', () => {
  it('keeps the old season when the archive fails, and retries on the next start', () => {
    const { dir, file } = setup();
    fail.rename = true;
    expect(new Rankings(file, 2).rows()).toHaveLength(2);
    expect(existsSync(`${file}.season`)).toBe(false);
    fail.rename = false;
    expect(new Rankings(file, 2).rows()).toEqual([]);
    expect(existsSync(join(dir, 'rankings.season-1.json'))).toBe(true);
    expect(readFileSync(`${file}.season`, 'utf8').trim()).toBe('2');
  });
  it('never overwrites an existing archive', () => {
    const { dir, file } = setup();
    writeFileSync(join(dir, 'rankings.season-1.json'), 'earlier', 'utf8');
    expect(new Rankings(file, 2).rows()).toEqual([]);
    expect(readFileSync(join(dir, 'rankings.season-1.json'), 'utf8')).toBe('earlier');
    expect(JSON.parse(readFileSync(join(dir, 'rankings.season-1-2.json'), 'utf8'))).toEqual(old);
  });
});
