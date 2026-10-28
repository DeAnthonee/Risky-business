import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_MAP_IDS, MAP_IDS, TOURNAMENT_MAP_IDS } from '@risk/engine';
import { RANDOM_MIN_PLAYERS, rotationMaps } from '../src/presets.js';
// The map status tracker (npm run maps:status) lives in scripts/; it is plain JS with no types.
// @ts-expect-error untyped .mjs module
import { fileHash, gather, generatedPath, mapStatus, parseMatrixMaps, parseRuleFiles, toMarkdown } from '../../../scripts/map-status.mjs';

describe('map status tracker', () => {
  const g = generatedPath;
  const base = {
    maps: [
      { id: 'old', name: 'Old', territories: 42, maxPlayers: 6 },
      { id: 'fresh', name: 'Fresh', territories: 58, maxPlayers: 8 },
      { id: 'edited', name: 'Edited', territories: 30, maxPlayers: 6 },
      { id: 'legacy', name: 'Legacy', territories: 99, maxPlayers: 6 },
    ],
    offered: ['old', 'fresh', 'edited'],
    legacy: ['legacy'],
    rotation: ['old', 'fresh'],
    ruleFiles: ['packages/engine/src/engine.ts', g('old'), g('fresh'), g('edited')],
    matrixMaps: ['old', 'edited'],
    recorded: { 'packages/engine/src/engine.ts': 'e1', [g('old')]: 'h-old', [g('edited')]: 'h-edited-before' },
    hash: (rel: string) => ({ 'packages/engine/src/engine.ts': 'e1', [g('old')]: 'h-old', [g('fresh')]: 'h-fresh', [g('edited')]: 'h-edited-after' })[rel] ?? 'missing',
    exists: (rel: string) => rel !== g('legacy'),
  };

  it('marks a map verified only when its JSON is a rule file whose hash matches the fingerprint', () => {
    const s = mapStatus(base);
    const row = (id: string) => s.rows.find((r: { id: string }) => r.id === id);
    expect(row('old')).toMatchObject({ registered: 'offered', generated: true, ruleFiles: true, matrix: true, gpuVerified: true, rotation: true });
    // in RULE_FILES but never recorded (a new map before verify.py): not verified
    expect(row('fresh')).toMatchObject({ ruleFiles: true, matrix: false, gpuVerified: false, rotation: true });
    // regenerated since the last verification: not verified
    expect(row('edited')).toMatchObject({ gpuVerified: false, rotation: false });
    // legacy boards are never trained on, so they need no verification
    expect(row('legacy')).toMatchObject({ registered: 'legacy', generated: false, ruleFiles: false, gpuVerified: false });
    expect(s.unverified).toEqual(['fresh', 'edited']);
    expect(s.staleRuleFiles).toEqual([]);
    expect(s.verifyNeeded).toBe(true);
  });

  it('reports other changed rule files, and needs no verification when everything matches', () => {
    const allOld = { ...base, maps: base.maps.slice(0, 1), offered: ['old'], ruleFiles: ['packages/engine/src/engine.ts', g('old')] };
    expect(mapStatus(allOld)).toMatchObject({ unverified: [], staleRuleFiles: [], verifyNeeded: false });
    const engineEdited = { ...allOld, hash: (rel: string) => (rel === g('old') ? 'h-old' : 'e2') };
    expect(mapStatus(engineEdited)).toMatchObject({ unverified: [], staleRuleFiles: ['packages/engine/src/engine.ts'], verifyNeeded: true });
  });

  it('hashes like fingerprint.py: SHA-256 with CRLF read as LF, "missing" for an absent file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-status-'));
    writeFileSync(join(dir, 'lf.json'), '{"a":1}\n{"b":2}\n');
    writeFileSync(join(dir, 'crlf.json'), '{"a":1}\r\n{"b":2}\r\n');
    expect(fileHash(dir, 'crlf.json')).toBe(fileHash(dir, 'lf.json'));
    // the same digest as Python's hashlib.sha256 of the LF file's bytes
    expect(fileHash(dir, 'lf.json')).toBe('3881dc2ee848fe04d776737c86afbc783e482e7c5be6431d3aab36fa8fa2c928');
    expect(fileHash(dir, 'nope.json')).toBe('missing');
  });

  it('parses RULE_FILES and the rules matrix from the Python sources', () => {
    const py = 'X = 1\nRULE_FILES = [\n    "a.ts",\n    # a comment\n    "packages/engine/src/generated/m.json",\n]\n';
    expect(parseRuleFiles(py)).toEqual(['a.ts', 'packages/engine/src/generated/m.json']);
    const matrix = 'def rules_suite(scale):\n    maps = {"classic": 6, "world": 10,\n            "bohemia": 6}\n';
    expect(parseMatrixMaps(matrix)).toEqual(['classic', 'world', 'bohemia']);
  });

  it('reads this checkout: every registered board, the runner rotation, the GPU mirror files', async () => {
    const s = await gather();
    expect(s.rows.map((r: { id: string }) => r.id)).toEqual([...MAP_IDS, ...LEGACY_MAP_IDS, ...TOURNAMENT_MAP_IDS]);
    expect(s.rows.find((r: { id: string }) => r.id === 'mega_earth')).toMatchObject({ registered: 'tournament' });
    const rotation = rotationMaps(RANDOM_MIN_PLAYERS);
    for (const r of s.rows) {
      expect(r.generated).toBe(true);
      expect(r.rotation).toBe(rotation.includes(r.id));
      // every offered board is wired into the GPU mirror's RULE_FILES and rules matrix
      if (r.registered === 'offered') expect([r.id, r.ruleFiles, r.matrix]).toEqual([r.id, true, true]);
    }
    expect(toMarkdown(s)).toContain('| `classic` |');
  });
});
