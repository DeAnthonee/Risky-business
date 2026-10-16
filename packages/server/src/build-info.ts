import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  commit: string;
  branch: string;
  builtAt: string;
  /** Unique per build: "<commit>.<timestamp>" */
  build: string;
  node: string;
}

let cached: BuildInfo | null = null;

/** Build metadata written by scripts/write-build-info.mjs next to the compiled server. */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const fallback: BuildInfo = {
    version: '0.0.0-dev',
    commit: 'unknown',
    branch: 'unknown',
    builtAt: new Date(0).toISOString(),
    build: `dev.${process.pid}.${Date.now()}`,
    node: process.version,
  };
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, 'build-info.json'), 'utf8');
    cached = { ...fallback, ...(JSON.parse(raw) as Partial<BuildInfo>) };
  } catch {
    cached = fallback;
  }
  return cached;
}
