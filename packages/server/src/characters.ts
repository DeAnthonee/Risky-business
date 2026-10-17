import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RiskHttpError, type CharacterProfile, type CharacterSummary, type CharacterUpdate, type CharacterVersion, type ModelInfoDoc } from '@risk/mcp';

/** "<universe>/<name>", both lowercase kebab-case, e.g. "marvel/iron-man". */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MARKDOWN = 32 * 1024;
const MAX_CHARACTERS = 500;
/** Older versions beyond this are dropped (oldest first). */
const MAX_VERSIONS = 50;

interface Saved {
  versions: CharacterVersion[];
  /** Markdown by version, in memory only when persistence is disabled. */
  bodies: Map<number, string>;
}

export function checkCharacterId(raw: string): string {
  const id = String(raw ?? '').trim().toLowerCase().replace(/\.md$/, '');
  if (!ID_RE.test(id)) throw new RiskHttpError(`Invalid character id "${raw}": use "<universe>/<name>" in lowercase kebab-case, e.g. "marvel/iron-man"`, 400);
  return id;
}

const titleOf = (markdown: string, id: string) => markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? id.split('/')[1];

/** Replace the body of one "## Heading" section (case-insensitive), or append the section if it is missing. */
export function replaceSection(markdown: string, heading: string, content: string): string {
  const want = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  if (!want) throw new RiskHttpError('section must name a "## " heading, e.g. "Grudges & rivals"', 400);
  const lines = markdown.replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === want);
  const body = content.replace(/\s+$/, '');
  if (start < 0) return `${lines.join('\n')}\n\n## ${heading.replace(/^#+\s*/, '').trim()}\n\n${body}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), '', body, ...(end < lines.length ? [''] : []), ...lines.slice(end)].join('\n').replace(/\s+$/, '') + '\n';
}

/**
 * Character profiles for AI players. The repo's AI/ folder holds the starting profiles (version 0);
 * every save is a new numbered version under <dataDir>/characters/<universe>/<name>/, so profiles survive
 * restarts and deploys, and a bad edit can be rolled back. With no dataDir, saves are kept in memory.
 */
export class CharacterStore {
  private saved = new Map<string, Saved>();

  constructor(
    /** The repo's AI/ folder (characters/ and general-model-info/), or null. */
    private aiDir: string | null,
    /** Where saved versions live (under RISK_DATA_DIR), or null for memory only. */
    private dataDir: string | null,
  ) {
    if (dataDir) this.load();
  }

  private load() {
    const root = this.dataDir!;
    for (const universe of safeDir(root)) {
      for (const name of safeDir(join(root, universe))) {
        const file = join(root, universe, name, 'history.json');
        try {
          const versions = JSON.parse(readFileSync(file, 'utf8')) as CharacterVersion[];
          if (Array.isArray(versions) && versions.length && ID_RE.test(`${universe}/${name}`)) this.saved.set(`${universe}/${name}`, { versions, bodies: new Map() });
        } catch {
          /* not a character folder */
        }
      }
    }
  }

  private seedPath(id: string) {
    return this.aiDir ? join(this.aiDir, 'characters', `${id}.md`) : null;
  }
  private seed(id: string): string | null {
    const p = this.seedPath(id);
    return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  private seedIds(): string[] {
    if (!this.aiDir) return [];
    const root = join(this.aiDir, 'characters');
    const ids: string[] = [];
    for (const universe of safeDir(root))
      for (const f of safeDir(join(root, universe))) if (f.endsWith('.md') && ID_RE.test(`${universe}/${f.slice(0, -3)}`)) ids.push(`${universe}/${f.slice(0, -3)}`);
    return ids;
  }

  private body(id: string, version: number): string | null {
    if (version === 0) return this.seed(id);
    const s = this.saved.get(id);
    if (!s?.versions.some((v) => v.version === version)) return null;
    if (s.bodies.has(version)) return s.bodies.get(version)!;
    return this.dataDir ? readFileSync(join(this.dataDir, id, `v${version}.md`), 'utf8') : null;
  }

  private latest(id: string): CharacterVersion | null {
    const v = this.saved.get(id)?.versions;
    return v?.length ? v[v.length - 1] : null;
  }

  private summary(id: string, markdown: string): CharacterSummary {
    const last = this.latest(id);
    return {
      id,
      universe: id.split('/')[0],
      name: titleOf(markdown, id),
      version: last?.version ?? 0,
      updatedAt: last?.at ?? null,
      source: last ? 'saved' : 'repo',
    };
  }

  list(): CharacterSummary[] {
    const ids = new Set([...this.seedIds(), ...this.saved.keys()]);
    return [...ids]
      .sort()
      .map((id) => this.summary(id, this.body(id, this.latest(id)?.version ?? 0) ?? ''));
  }

  get(rawId: string, version?: number): CharacterProfile {
    const id = checkCharacterId(rawId);
    if (version !== undefined && !(Number.isInteger(version) && version >= 0)) throw new RiskHttpError('version must be a whole number (0 = the repo\'s starting profile)', 400);
    const v = version ?? this.latest(id)?.version ?? 0;
    const markdown = this.body(id, v);
    if (markdown === null)
      throw new RiskHttpError(version === undefined ? `No character "${id}". list_characters shows them all; update_character with full markdown creates one.` : `Character "${id}" has no version ${version}`, 404);
    return { ...this.summary(id, markdown), version: v, markdown };
  }

  history(rawId: string): { id: string; versions: CharacterVersion[] } {
    const id = checkCharacterId(rawId);
    const saved = this.saved.get(id)?.versions ?? [];
    const repo = this.seed(id) !== null ? [{ version: 0, at: null, note: 'starting profile from the repo (AI/characters)' }] : [];
    if (!saved.length && !repo.length) throw new RiskHttpError(`No character "${id}"`, 404);
    return { id, versions: [...repo, ...saved] };
  }

  update(rawId: string, u: CharacterUpdate): CharacterProfile {
    const id = checkCharacterId(rawId);
    const last = this.latest(id);
    const current = this.body(id, last?.version ?? 0);
    const currentVersion = last?.version ?? 0;
    if (u.expectedVersion !== undefined && current !== null && u.expectedVersion !== currentVersion)
      throw new RiskHttpError(`Character "${id}" is at version ${currentVersion}, not ${u.expectedVersion}: someone saved it since you read it. get_character again and redo your change.`, 409);
    let markdown: string;
    if (typeof u.markdown === 'string') {
      if (u.section !== undefined || u.content !== undefined) throw new RiskHttpError('Pass either markdown (whole profile) or section + content, not both', 400);
      markdown = u.markdown;
    } else if (typeof u.section === 'string' && typeof u.content === 'string') {
      if (current === null) throw new RiskHttpError(`No character "${id}" yet: create it with the whole profile as markdown (start from the template in general instructions)`, 404);
      markdown = replaceSection(current, u.section, u.content);
    } else {
      throw new RiskHttpError('Pass markdown (the whole profile) or section + content (one "## " section)', 400);
    }
    markdown = markdown.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
    if (!/^#\s+\S/.test(markdown)) throw new RiskHttpError('A profile must start with "# <Character Name>"', 400);
    if (markdown.length > MAX_MARKDOWN) throw new RiskHttpError(`Profile too long (${markdown.length} characters, max ${MAX_MARKDOWN})`, 400);
    if (markdown === current) return this.get(id);
    if (current === null && this.list().length >= MAX_CHARACTERS) throw new RiskHttpError(`Too many characters (max ${MAX_CHARACTERS})`, 400);

    const entry: CharacterVersion = { version: currentVersion + 1, at: new Date().toISOString(), ...(u.note ? { note: String(u.note).slice(0, 200) } : {}) };
    const saved: Saved = this.saved.get(id) ?? { versions: [], bodies: new Map() };
    saved.versions.push(entry);
    const dropped = saved.versions.length > MAX_VERSIONS ? saved.versions.splice(0, saved.versions.length - MAX_VERSIONS) : [];
    for (const d of dropped) saved.bodies.delete(d.version);
    if (this.dataDir) {
      const dir = join(this.dataDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `v${entry.version}.md`), markdown);
      const tmp = join(dir, 'history.json.tmp');
      writeFileSync(tmp, JSON.stringify(saved.versions, null, 1));
      renameSync(tmp, join(dir, 'history.json'));
    } else {
      saved.bodies.set(entry.version, markdown);
    }
    this.saved.set(id, saved);
    return this.get(id);
  }

  /** Docs from AI/general-model-info (every model reads these), plus the character template. */
  modelInfo(): { docs: ModelInfoDoc[] } {
    if (!this.aiDir) return { docs: [] };
    const dir = join(this.aiDir, 'general-model-info');
    const docs = safeDir(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort()
      .map((f) => ({ file: `general-model-info/${f}`, markdown: readFileSync(join(dir, f), 'utf8') }));
    const template = join(this.aiDir, 'characters', '_TEMPLATE.md');
    if (existsSync(template)) docs.push({ file: 'characters/_TEMPLATE.md', markdown: readFileSync(template, 'utf8') });
    return { docs };
  }
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.') && !f.startsWith('_'));
  } catch {
    return [];
  }
}
