import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  GAME_OUTCOMES,
  RiskHttpError,
  type CharacterMemory,
  type CharacterProfile,
  type CharacterSummary,
  type CharacterUpdate,
  type CharacterVersion,
  type DiaryEntry,
  type DiaryInput,
  type GameOutcome,
  type ModelInfoDoc,
  type RecordLine,
  type Relationship,
  type RelationshipInput,
} from '@risk/mcp';

/** "<universe>/<name>", both lowercase kebab-case, e.g. "marvel/iron-man". */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MARKDOWN = 32 * 1024;
const MAX_CHARACTERS = 100;
/** Older versions beyond this are dropped (oldest first). */
const MAX_VERSIONS = 30;
const MAX_DIARY_TEXT = 8000;
/** Saved diary entries beyond this are dropped (oldest first); repo entries always stay. */
const MAX_DIARY_ENTRIES = 200;
const MAX_RELATIONSHIPS = 100;
const MAX_RELATIONSHIP_NOTES = 20;

/** Diary entries and relationships saved by agents (on top of the repo's seeds). */
interface Memory {
  diary: Omit<DiaryEntry, 'n'>[];
  /** Keyed by lowercase name; holds every player touched since the repo seed, with full notes. */
  relationships: Record<string, Relationship>;
}

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
    /** Keys that allow saving (RISK_CHARACTERS_KEY, the admin token). None set = read-only. */
    writeKeys: (string | null | undefined)[] = [],
  ) {
    this.writeKeys = writeKeys.filter((k): k is string => !!k);
    if (dataDir) this.load();
  }

  private writeKeys: string[];

  get writable(): boolean {
    return this.writeKeys.length > 0;
  }

  /** Every save needs a write key: the endpoints have no other auth, and saved text is read by other models. */
  private checkWrite(key: string | undefined) {
    if (!this.writable) throw new RiskHttpError('Saving characters is turned off on this server (no RISK_CHARACTERS_KEY set): profiles, diaries and relationships are read-only.', 403);
    if (!key) throw new RiskHttpError('Saving characters needs the write key: pass it as "key" (MCP) or the x-characters-key header (HTTP).', 401);
    const given = Buffer.from(key);
    if (!this.writeKeys.some((k) => given.length === Buffer.byteLength(k) && timingSafeEqual(given, Buffer.from(k)))) throw new RiskHttpError('Wrong characters write key', 403);
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

  update(rawId: string, u: CharacterUpdate, writeKey?: string): CharacterProfile {
    this.checkWrite(writeKey);
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
      // Pruned versions leave disk too, or repeated saves would grow RISK_DATA_DIR forever.
      for (const d of dropped) rmSync(join(dir, `v${d.version}.md`), { force: true });
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

  // ---- memory: diary entries and relationships ----

  private memories = new Map<string, Memory>();

  /** Throws 404 unless the character has a profile (repo or saved), so a typo cannot start an orphan diary. */
  private requireCharacter(rawId: string): string {
    const id = checkCharacterId(rawId);
    if (!this.saved.has(id) && this.seed(id) === null) throw new RiskHttpError(`No character "${id}". list_characters shows them all.`, 404);
    return id;
  }

  private memory(id: string): Memory {
    let m = this.memories.get(id);
    if (!m) {
      // Keys come from anonymous input ("__proto__" included): keep them in prototype-less objects.
      const relationships = Object.assign(Object.create(null), readJson(this.dataDir && join(this.dataDir, id, 'relationships.json')) ?? {});
      m = { diary: readJson(this.dataDir && join(this.dataDir, id, 'diary.json')) ?? [], relationships };
      this.memories.set(id, m);
    }
    return m;
  }

  private saveMemory(id: string, m: Memory, part: 'diary' | 'relationships') {
    if (!this.dataDir) return;
    const dir = join(this.dataDir, id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, `${part}.json`), m[part]);
  }

  private seedFile(id: string, kind: 'diary' | 'relationships'): string | null {
    const p = this.aiDir ? join(this.aiDir, 'characters', `${id}.${kind}.md`) : null;
    return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  private diaryEntries(id: string): DiaryEntry[] {
    const seeded = parseDiary(this.seedFile(id, 'diary') ?? '');
    return [...seeded, ...this.memory(id).diary].map((e, i) => ({ ...e, n: i + 1 }));
  }

  private relationshipList(id: string): Relationship[] {
    const all = new Map(parseRelationships(this.seedFile(id, 'relationships') ?? '').map((r) => [r.with.toLowerCase(), r]));
    for (const [k, r] of Object.entries(this.memory(id).relationships)) all.set(k, r);
    return [...all.values()].sort((a, b) => Math.abs(b.rapport) - Math.abs(a.rapport) || a.with.localeCompare(b.with));
  }

  readDiary(rawId: string, limit?: number, gameId?: string): { id: string; total: number; entries: DiaryEntry[] } {
    const id = this.requireCharacter(rawId);
    const all = this.diaryEntries(id);
    const n = limit === undefined ? 5 : Math.max(1, Math.min(Math.floor(limit), 50));
    const entries = gameId ? all.filter((e) => e.gameId?.toUpperCase() === gameId.trim().toUpperCase()) : all.slice(-n);
    return { id, total: all.length, entries };
  }

  addDiaryEntry(rawId: string, input: DiaryInput, writeKey?: string): DiaryEntry {
    this.checkWrite(writeKey);
    const id = this.requireCharacter(rawId);
    const title = String(input.title ?? '').trim();
    const text = String(input.text ?? '').trim();
    if (!title || title.length > 120) throw new RiskHttpError('title is required (max 120 characters)', 400);
    if (!text || text.length > MAX_DIARY_TEXT) throw new RiskHttpError(`text is required (max ${MAX_DIARY_TEXT} characters)`, 400);
    if (input.outcome !== undefined && !GAME_OUTCOMES.includes(input.outcome)) throw new RiskHttpError(`outcome must be one of ${GAME_OUTCOMES.join(', ')}`, 400);
    const short = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const opponents = Array.isArray(input.opponents) ? input.opponents.map((o) => short(o)).filter((o): o is string => !!o).slice(0, 12) : undefined;
    const entry: Omit<DiaryEntry, 'n'> = clean({
      at: new Date().toISOString(),
      source: 'saved' as const,
      title,
      text,
      gameId: short(input.gameId, 12)?.toUpperCase(),
      outcome: input.outcome,
      map: short(input.map, 40),
      opponents: opponents?.length ? opponents : undefined,
      strategy: short(input.strategy),
      winner: short(input.winner),
    });
    const m = this.memory(id);
    m.diary.push(entry);
    if (m.diary.length > MAX_DIARY_ENTRIES) m.diary.splice(0, m.diary.length - MAX_DIARY_ENTRIES);
    this.saveMemory(id, m, 'diary');
    const all = this.diaryEntries(id);
    return all[all.length - 1];
  }

  updateRelationship(rawId: string, input: RelationshipInput, writeKey?: string): Relationship {
    this.checkWrite(writeKey);
    const id = this.requireCharacter(rawId);
    const who = String(input.with ?? '').trim().slice(0, 80);
    const note = String(input.note ?? '').trim();
    if (!who) throw new RiskHttpError('with is required: the other player\'s name or character id', 400);
    if (!note || note.length > 1000) throw new RiskHttpError('note is required (max 1000 characters): what happened', 400);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
    const change = num(input.change);
    const set = num(input.rapport);
    if (change === undefined && set === undefined && (input.change !== undefined || input.rapport !== undefined)) throw new RiskHttpError('change and rapport must be numbers', 400);
    const key = who.toLowerCase();
    const m = this.memory(id);
    const current = this.relationshipList(id).find((r) => r.with.toLowerCase() === key) ?? { with: who, rapport: 0, notes: [] };
    if (!m.relationships[key] && Object.keys(m.relationships).length >= MAX_RELATIONSHIPS) throw new RiskHttpError(`Too many relationships (max ${MAX_RELATIONSHIPS})`, 400);
    const rapport = clamp(set ?? current.rapport + (change ?? 0));
    const updated: Relationship = {
      with: current.with,
      rapport,
      notes: [...current.notes, clean({ at: new Date().toISOString(), gameId: typeof input.gameId === 'string' && input.gameId.trim() ? input.gameId.trim().toUpperCase().slice(0, 12) : undefined, change: rapport - current.rapport, note })].slice(-MAX_RELATIONSHIP_NOTES),
    };
    m.relationships[key] = updated;
    this.saveMemory(id, m, 'relationships');
    return updated;
  }

  memorySummary(rawId: string): CharacterMemory {
    const id = this.requireCharacter(rawId);
    const diary = this.diaryEntries(id);
    const line = (): RecordLine => ({ games: 0, won: 0 });
    // Strategy, map and opponent names come from anonymous diary input: prototype-less maps, so "__proto__"
    // is just a key and cannot reach Object.prototype.
    const record: CharacterMemory['record'] = { ...line(), byStrategy: Object.create(null), byMap: Object.create(null), vsOpponent: Object.create(null) };
    const count = (r: RecordLine, won: boolean) => {
      r.games++;
      if (won) r.won++;
    };
    for (const e of diary) {
      if (!e.outcome) continue;
      const won = e.outcome === 'won';
      count(record, won);
      if (e.strategy) count((record.byStrategy[e.strategy.toLowerCase()] ??= line()), won);
      if (e.map) count((record.byMap[e.map.toLowerCase()] ??= line()), won);
      for (const o of e.opponents ?? []) count((record.vsOpponent[o] ??= line()), won);
    }
    return {
      id,
      record,
      relationships: this.relationshipList(id).map((r) => ({ ...r, notes: r.notes.slice(-3) })),
      diaryEntries: diary.length,
      recentDiary: diary.slice(-5).map((e) => clean({ n: e.n, at: e.at, title: e.title, outcome: e.outcome })),
    };
  }

  /** Docs every model reads: AI/general-player (playbook, ways to win, findings), AI/general-model-info, and the character template. */
  modelInfo(): { docs: ModelInfoDoc[] } {
    if (!this.aiDir) return { docs: [] };
    const order = ['playbook.md', 'ways-to-win.md', 'findings.md'];
    const rank = (f: string) => (order.includes(f) ? order.indexOf(f) : order.length);
    const docs = ['general-player', 'general-model-info'].flatMap((folder) =>
      safeDir(join(this.aiDir!, folder))
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .map((f) => ({ file: `${folder}/${f}`, markdown: readFileSync(join(this.aiDir!, folder, f), 'utf8') })),
    );
    const template = join(this.aiDir, 'characters', '_TEMPLATE.md');
    if (existsSync(template)) docs.push({ file: 'characters/_TEMPLATE.md', markdown: readFileSync(template, 'utf8') });
    return { docs };
  }
}

const clamp = (n: number) => Math.max(-100, Math.min(100, n));

/** Drops undefined fields so saved JSON and replies stay compact. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function readJson<T>(file: string | null): T | null {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
  renameSync(`${file}.tmp`, file);
}

/**
 * A repo diary (<name>.diary.md): one "## <title>" block per entry. Optional "- **Key:** value" lines
 * set Game, Date, Outcome, Map, Opponents (comma-separated), Strategy and Winner; the rest is the text.
 */
export function parseDiary(markdown: string): Omit<DiaryEntry, 'n'>[] {
  const blocks = markdown.split(/^## /m).slice(1);
  return blocks.map((block) => {
    const [heading, ...lines] = block.split('\n');
    const fields: Record<string, string> = {};
    const text = lines
      .filter((l) => {
        const f = l.match(/^- \*\*(Game|Date|Outcome|Map|Opponents|Strategy|Winner):\*\*\s*(.+)$/i);
        if (f) fields[f[1].toLowerCase()] = f[2].trim();
        return !f;
      })
      .join('\n')
      .trim();
    const outcome = fields.outcome?.split(/\s/)[0].toLowerCase() as GameOutcome | undefined;
    return clean({
      at: fields.date && !Number.isNaN(Date.parse(fields.date)) ? new Date(fields.date).toISOString() : null,
      source: 'repo' as const,
      title: heading.trim(),
      text,
      gameId: fields.game?.toUpperCase(),
      outcome: outcome && GAME_OUTCOMES.includes(outcome) ? outcome : undefined,
      map: fields.map,
      opponents: fields.opponents?.split(',').map((o) => o.trim()).filter(Boolean),
      strategy: fields.strategy,
      winner: fields.winner,
    });
  });
}

/** A repo relationships file (<name>.relationships.md): a "| Player | Rapport | Notes |" table. */
export function parseRelationships(markdown: string): Relationship[] {
  const out: Relationship[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.trim().match(/^\|(.*)\|$/)?.[1].split('|').map((c) => c.trim());
    if (!cells || cells.length < 2 || !/^[-+]?\d+$/.test(cells[1])) continue;
    const rapport = clamp(Number(cells[1]));
    out.push({ with: cells[0].replace(/\*\*/g, ''), rapport, notes: cells[2] ? [{ at: null, change: rapport, note: cells[2] }] : [] });
  }
  return out;
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.') && !f.startsWith('_'));
  } catch {
    return [];
  }
}
