#!/usr/bin/env node
/**
 * Map status tracker: one row per board, derived only from the code, so it cannot drift from it.
 *
 *   npm run maps:status                      # readable table
 *   npm run maps:status -- --markdown        # GitHub-flavoured table (CI writes it to the job summary)
 *   npm run maps:status -- --json            # machine-readable
 *   npm run maps:status -- --github          # also print ::warning lines for maps not GPU-verified (CI)
 *   npm run maps:status -- --strict          # exit 1 when any map or rule file is not GPU-verified
 *
 * Per map: id, name, territories, players; registered (offered in MAP_IDS, or legacy); generated JSON present;
 * listed in the GPU mirror's RULE_FILES (packages/delove-gpu/delove_gpu/fingerprint.py) and its rules matrix
 * (packages/delove-gpu/tests/matrix.py); GPU-verified (the JSON's hash equals its entry in
 * packages/delove-gpu/engine-fingerprint.json, hashed exactly as fingerprint.py does: SHA-256 of the bytes with CRLF
 * read as LF); in the training rotation (the runner's rotationMaps, packages/runner/src/presets.ts, which the Gen 5
 * league games use). It also lists every other RULE_FILES entry that changed since the last verification: any stale
 * file means the next verify.py run is needed.
 *
 * Reads the built engine and runner (packages/{engine,runner}/dist): run `npm run build` (or `npm test`) first.
 * Node only, no dependencies. The derivation is pure (`mapStatus`) and tested in packages/runner/test.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FINGERPRINT_PY = 'packages/delove-gpu/delove_gpu/fingerprint.py';
const MATRIX_PY = 'packages/delove-gpu/tests/matrix.py';
const FINGERPRINT_JSON = 'packages/delove-gpu/engine-fingerprint.json';
export const generatedPath = (id) => `packages/engine/src/generated/${id}.json`;

/** fingerprint.py's file_hash: SHA-256 of the bytes with CRLF read as LF; a missing file hashes as "missing". */
export function fileHash(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path)) return 'missing';
  const data = readFileSync(path);
  const lf = Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(lf).digest('hex');
}

/** The quoted paths in fingerprint.py's RULE_FILES list. */
export function parseRuleFiles(py) {
  const m = py.match(/^RULE_FILES\s*=\s*\[([\s\S]*?)^\]/m);
  if (!m) throw new Error(`${FINGERPRINT_PY}: RULE_FILES not found`);
  return [...m[1].matchAll(/^\s*"([^"]+)"/gm)].map((x) => x[1]);
}

/** The map ids of matrix.py's rules suite (`maps = {"classic": 6, ...}`). */
export function parseMatrixMaps(py) {
  const m = py.match(/def rules_suite[\s\S]*?maps\s*=\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error(`${MATRIX_PY}: the rules suite's maps dict not found`);
  return [...m[1].matchAll(/"(\w+)"\s*:/g)].map((x) => x[1]);
}

/**
 * Pure derivation. `maps`: [{ id, name, territories, maxPlayers }] for every registered board; `offered`/`legacy`:
 * MAP_IDS and LEGACY_MAP_IDS; `rotation`: ids in the training rotation; `ruleFiles`, `matrixMaps`: parsed lists;
 * `recorded`: engine-fingerprint.json's `files`; `hash(rel)`: current hash; `exists(rel)`: is the file there.
 */
export function mapStatus({ maps, offered, legacy, rotation, ruleFiles, matrixMaps, recorded, hash, exists }) {
  const rules = new Set(ruleFiles);
  const rows = maps.map((m) => {
    const rel = generatedPath(m.id);
    const inRules = rules.has(rel);
    const gpuVerified = inRules && recorded[rel] !== undefined && recorded[rel] === hash(rel);
    return {
      id: m.id,
      name: m.name,
      territories: m.territories,
      maxPlayers: m.maxPlayers,
      registered: offered.includes(m.id) ? 'offered' : legacy.includes(m.id) ? 'legacy' : 'no',
      generated: exists(rel),
      ruleFiles: inRules,
      matrix: matrixMaps.includes(m.id),
      gpuVerified,
      rotation: rotation.includes(m.id),
    };
  });
  const mapFiles = new Set(maps.map((m) => generatedPath(m.id)));
  const staleRuleFiles = ruleFiles.filter((rel) => !mapFiles.has(rel) && recorded[rel] !== hash(rel));
  // Every offered map must be in RULE_FILES and verified; a legacy map is never trained on, so it needs neither.
  const unverified = rows.filter((r) => r.registered === 'offered' && !r.gpuVerified).map((r) => r.id);
  return { rows, staleRuleFiles, unverified, verifyNeeded: unverified.length > 0 || staleRuleFiles.length > 0 };
}

/** Reads the checkout (built engine and runner, the GPU mirror's files) and derives the status. */
export async function gather(root = ROOT) {
  const load = async (rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) throw new Error(`${rel} is missing: run \`npm run build\` first`);
    return import(pathToFileURL(path).href);
  };
  const engine = await load('packages/engine/dist/index.js');
  const presets = await load('packages/runner/dist/presets.js');
  const ids = [...engine.MAP_IDS, ...engine.LEGACY_MAP_IDS, ...Object.keys(engine.MAPS).filter((id) => !engine.MAP_IDS.includes(id) && !engine.LEGACY_MAP_IDS.includes(id))];
  const maps = ids.map((id) => {
    const m = engine.MAPS[id];
    return { id, name: m.name, territories: m.territories.length, maxPlayers: m.maxPlayers };
  });
  const fp = existsSync(join(root, FINGERPRINT_JSON)) ? JSON.parse(readFileSync(join(root, FINGERPRINT_JSON), 'utf8')) : {};
  return {
    ...mapStatus({
      maps,
      offered: engine.MAP_IDS,
      legacy: engine.LEGACY_MAP_IDS,
      rotation: presets.rotationMaps(presets.RANDOM_MIN_PLAYERS),
      ruleFiles: parseRuleFiles(readFileSync(join(root, FINGERPRINT_PY), 'utf8')),
      matrixMaps: parseMatrixMaps(readFileSync(join(root, MATRIX_PY), 'utf8')),
      recorded: fp.files ?? {},
      hash: (rel) => fileHash(root, rel),
      exists: (rel) => existsSync(join(root, rel)),
    }),
    lastVerified: fp.verified?.at ?? null,
  };
}

const COLUMNS = [
  ['map', (r) => r.id],
  ['name', (r) => r.name],
  ['terr.', (r) => String(r.territories)],
  ['players', (r) => `2-${r.maxPlayers}`],
  ['registered', (r) => r.registered],
  ['JSON', (r) => yn(r.generated)],
  ['RULE_FILES', (r) => yn(r.ruleFiles)],
  ['matrix', (r) => yn(r.matrix)],
  ['GPU-verified', (r) => yn(r.gpuVerified)],
  ['rotation', (r) => yn(r.rotation)],
];
const yn = (b) => (b ? 'yes' : 'no');

function footer(s) {
  const lines = [`Last GPU verification: ${s.lastVerified ?? 'never'}.`];
  if (s.unverified.length) lines.push(`Not GPU-verified: ${s.unverified.join(', ')}.`);
  if (s.staleRuleFiles.length) lines.push(`Other rule files changed since then: ${s.staleRuleFiles.join(', ')}.`);
  lines.push(
    s.verifyNeeded
      ? 'The next `python packages/delove-gpu/verify.py` run on the training PC is needed (not while the GPU is training).'
      : 'The GPU mirror is verified against every map and rule file.',
  );
  return lines;
}

export function toText(s) {
  const cells = [COLUMNS.map(([h]) => h), ...s.rows.map((r) => COLUMNS.map(([, f]) => f(r)))];
  const widths = COLUMNS.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(cells[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line), '', ...footer(s)].join('\n');
}

export function toMarkdown(s) {
  return [
    '### Map status',
    '',
    `| ${COLUMNS.map(([h]) => h).join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
    ...s.rows.map((r) => `| ${COLUMNS.map(([, f], i) => (i === 0 ? `\`${f(r)}\`` : f(r))).join(' | ')} |`),
    '',
    ...footer(s).map((l) => `${l}  `),
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = new Set(process.argv.slice(2));
  const s = await gather();
  if (flags.has('--json')) console.log(JSON.stringify(s, null, 2));
  else if (flags.has('--markdown')) console.log(toMarkdown(s));
  else console.log(toText(s));
  if (flags.has('--github')) {
    for (const id of s.unverified)
      console.log(`::warning title=Map not GPU-verified::${id} is offered for play but the GPU mirror has not been verified on it. Not a problem for this PR; the next verify.py run on the training PC covers it.`);
  }
  process.exit(flags.has('--strict') && s.verifyNeeded ? 1 : 0);
}
