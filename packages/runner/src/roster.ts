import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RiskApi } from '@risk/mcp';
import type { RosterEntry } from './presets.js';

/** The universe the random lineups draw from. */
export const ROSTER_UNIVERSE = 'league';

/** "<universe>/<name>", lowercase kebab-case (the same shape the server accepts). */
const ID_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

/** A character's profile text and where it came from. */
export interface CharacterText {
  personalMemory?: string;
  experience?: string;
  markdown: string;
  /** Starting rapport (`<name>.relationships.md`), only read for local files. */
  relationships: string | null;
  source: 'server' | 'local';
}

/**
 * The repo's `AI/` folder: the override if given, else next to this package (`packages/runner/dist` or `src` is
 * two levels under `packages`, so `../../../AI`), else `../../AI`, else `./AI` from the working directory.
 * Null when none exists.
 */
export function findAiDir(override?: string): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [override, path.resolve(here, '../../../AI'), path.resolve(here, '../../AI'), path.resolve(process.cwd(), 'AI')].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(path.join(c, 'characters'))) return c;
  return null;
}

const titleOf = (markdown: string, id: string) => markdown.match(/^#\s+(.+)$/m)?.[1].trim() || id.split('/')[1];

/** Every `characters/<universe>/<name>.md` under the AI folder (relationship and diary files excluded). */
export async function localRoster(aiDir: string | null, universe = ROSTER_UNIVERSE): Promise<RosterEntry[]> {
  if (!aiDir) return [];
  const dir = path.join(aiDir, 'characters', universe);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RosterEntry[] = [];
  for (const f of files.sort()) {
    const m = /^([a-z0-9][a-z0-9_-]*)\.md$/.exec(f);
    if (!m) continue;
    const id = `${universe}/${m[1]}`;
    try {
      out.push({ id, name: titleOf(await readFile(path.join(dir, f), 'utf8'), id) });
    } catch {
      /* unreadable file: not on the roster */
    }
  }
  return out;
}

/**
 * Every `league/*` character the runner can use: the server's character list first, plus the local profile
 * files (profiles the server lacks are loaded from them later, see `loadCharacter`).
 */
export async function discoverRoster(api: RiskApi, aiDir: string | null, log: (line: string) => void, universe = ROSTER_UNIVERSE): Promise<RosterEntry[]> {
  const byId = new Map<string, RosterEntry>();
  let fromServer = 0;
  try {
    const { characters } = await api.listCharacters();
    for (const c of characters) {
      if (!c.id.startsWith(`${universe}/`) || !ID_RE.test(c.id)) continue;
      byId.set(c.id, { id: c.id, name: c.name || c.id.split('/')[1] });
      fromServer++;
    }
  } catch (e) {
    log(`Could not read the server's character list (${(e as Error).message}); using local profile files`);
  }
  let fromLocal = 0;
  for (const c of await localRoster(aiDir, universe)) {
    if (byId.has(c.id)) continue;
    byId.set(c.id, c);
    fromLocal++;
  }
  const roster = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  log(`Roster: ${roster.length} ${universe} characters (${fromServer} from the server, ${fromLocal} from local files${aiDir ? ` in ${aiDir}` : ', no AI folder found'})`);
  return roster;
}

/** Read a profile (and its relationships text) from the local AI folder; null when missing or the id is malformed. */
export async function readLocalCharacter(aiDir: string | null, id: string): Promise<CharacterText | null> {
  if (!aiDir || !ID_RE.test(id)) return null;
  const [universe, name] = id.split('/');
  const base = path.join(aiDir, 'characters', universe, name);
  try {
    const markdown = await readFile(`${base}.md`, 'utf8');
    let relationships: string | null = null;
    try {
      relationships = (await readFile(`${base}.relationships.md`, 'utf8')).trim() || null;
    } catch {
      /* optional */
    }
    return { markdown, relationships, source: 'local' };
  } catch {
    return null;
  }
}

/** The server's profile, or (when it has none, e.g. a 404 on a remote server) the local file. Null when neither exists. */
export async function loadCharacter(api: RiskApi, id: string, aiDir: string | null): Promise<CharacterText | null> {
  try {
    return { markdown: (await api.getCharacter(id)).markdown, relationships: null, source: 'server' };
  } catch {
    return readLocalCharacter(aiDir, id);
  }
}
