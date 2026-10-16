#!/usr/bin/env node
/**
 * Writes packages/server/dist/build-info.json: version, git commit and a build id
 * that is unique per build. Run as part of `npm run build` (server package).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const commit = process.env.GIT_COMMIT || process.env.SOURCE_COMMIT || git('rev-parse --short=12 HEAD') || 'unknown';
const branch = process.env.GIT_BRANCH || git('rev-parse --abbrev-ref HEAD') || 'unknown';
const builtAt = new Date().toISOString();
const build = `${commit}.${builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;

const info = { version: pkg.version, commit, branch, builtAt, build, node: process.version };
const out = join(root, 'packages/server/dist/build-info.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${info.version} ${info.build}`);
