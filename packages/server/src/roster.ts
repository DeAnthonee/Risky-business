import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError } from '@risk/engine';
import { builtInReservedName, nameSkeleton } from './player-keys.js';

/**
 * The house roster (docs/tournaments.md "The house roster"): named house players, each bound for good to one Delove
 * model ("Tom" plays delove@12 forever). The seat pool seats them in tournaments by roster id; they rank as
 * `roster:<id>`, so a name's stats build up across days, and a retired name's row freezes.
 *
 * The name -> model list is the ANSWER KEY: only the admin routes (/api/admin/roster) show it, and the records-key game
 * records (`room.roster`). Every public view shows a roster seat as `ROSTER_AGENT`, like any other AI agent.
 */

/** The player type every public view shows for a roster seat (never its model). */
export const ROSTER_AGENT = 'AI agent';

export type RosterStatus = 'active' | 'retired';

export interface RosterEntry {
  id: string;
  name: string;
  /** The Delove model this name always plays ("delove@13"). Admin and records-key only. */
  model: string;
  status: RosterStatus;
  createdAt: number;
  retiredAt?: number;
}

/** A model id: "delove@13", "delove@12-fog"... */
const MODEL = /^[a-z][a-z0-9_-]{0,23}@[a-z0-9][a-z0-9._-]{0,15}$/i;
/** At most this many names, active and retired (each one stays reserved). */
export const MAX_ROSTER = 1000;

/**
 * The house names, generated once: simple, funny or teasing, never aimed at a real person and never "Delove ...".
 * A create takes the first ones still free (not on the roster, not a registered player's, not an AI character's).
 */
export const ROSTER_NAMES: readonly string[] = [
  // simple
  'Tom', 'Mabel', 'Gus', 'Ruth', 'Otis', 'Nell', 'Hank', 'Ivy', 'Walt', 'Dot',
  'Earl', 'Pearl', 'Clyde', 'June', 'Milo', 'Hazel', 'Ned', 'Rosie', 'Abe', 'Lulu',
  'Vern', 'Edna', 'Rex', 'Opal', 'Moe', 'Fern', 'Sid', 'Bea', 'Cal', 'Wren',
  'Hugo', 'Gert', 'Lenny', 'Mavis', 'Ozzie', 'Tess', 'Barney', 'Flo', 'Rudy', 'Maude',
  // funny
  'Sir Loin', 'Captain Dice', 'Lord Fumble', 'Count Turtle', 'Baron Snooze', 'Duke of Nope', 'Admiral Oops',
  'General Mayhem', 'Major Blunder', 'Colonel Crumbs', 'Professor Pickle', 'Lady Gambit', 'Madame Bluff',
  'Sergeant Snack', 'Private Panic', 'Kernel Panic', 'Waffle Iron', 'Noodle Arms', 'Captain Hindsight',
  'Duchess of Dice', 'Marquis de Meh', 'Sir Reinforce', 'Count Backwards', 'Viscount Vague', 'Admiral Snack',
  'Lord of Lag', 'Emperor Penguin', 'Grand Duke Gravy', 'Baroness Blitz', 'Captain Cardboard',
  // teasing (the table, never a person)
  'Free Real Estate', 'Easy Target', 'Dice Goblin', 'Fort Nobody', 'Last Place Larry', 'Paper Tiger',
  'Glass Cannon', 'Turtle Supreme', 'All Talk', 'Lucky Loser', 'Sore Winner', 'Rage Quit Rick', 'Bonus Thief',
  'Card Hoarder', 'Border Gore', 'Chokepoint Chad', 'Six Sided Sam', 'Snake Eyes', 'Overextended',
  'Spreadsheet Steve', 'Kingmaker Kate', 'Fortress Fred', 'Bluffing Betty', 'Doomstack Dave', 'Australia Again',
  'Turn One Tim', 'Sneaky Sue', 'Backstab Bob', 'Pity Truce', 'Hold My Dice',
];

interface SavedFile {
  version: 1;
  roster: RosterEntry[];
}

export class RosterStore {
  private entries = new Map<string, RosterEntry>();
  /** Every roster name by skeleton, retired ones too: a roster name stays reserved for good. */
  private bySkeleton = new Map<string, RosterEntry>();
  /** Names a create must not take (registered players, AI characters): the app sets it. Returns why, or null. */
  taken: (name: string) => string | null = () => null;

  constructor(
    private file: string | null,
    private now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as SavedFile;
        for (const e of data.roster ?? []) this.index(e);
      } catch (err) {
        console.error('[roster] could not read the roster file:', (err as Error).message);
      }
    }
  }

  private index(e: RosterEntry) {
    this.entries.set(e.id, e);
    this.bySkeleton.set(nameSkeleton(e.name), e);
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, roster: [...this.entries.values()] } satisfies SavedFile));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[roster] could not save the roster file:', (err as Error).message);
    }
  }

  /** The whole roster with models: the answer key (admin only). */
  list(): RosterEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  get(id: string): RosterEntry | undefined {
    return this.entries.get(id);
  }

  /** Why this name is the house's (a seat or a registration may not use it, nor a look-alike), or null. */
  reservedWhy(name: string): string | null {
    return this.bySkeleton.has(nameSkeleton(name)) ? 'that name is on the house roster' : null;
  }

  /** Why a name cannot join the roster, or null. */
  private refuse(name: string): string | null {
    if (name.length < 2 || name.length > 24) return 'a roster name is 2-24 characters';
    if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) return "a roster name uses letters, digits, spaces and . _ ' - only";
    if (/^delove/.test(nameSkeleton(name))) return 'a roster name never starts with "Delove"';
    return builtInReservedName(name) ?? this.reservedWhy(name) ?? this.taken(name);
  }

  /**
   * Add names bound to `model`: `names` as given (each must be free), or else the next `count` free house names
   * (ROSTER_NAMES). All or none.
   */
  create(rawModel: unknown, count: unknown, names?: unknown): RosterEntry[] {
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!MODEL.test(model)) throw new RuleError('model must be a model id such as "delove@13"');
    let picked: string[];
    if (names !== undefined) {
      if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== 'string')) throw new RuleError('names must be a list of names');
      picked = (names as string[]).map((n) => n.replace(/\s+/g, ' ').trim());
      const seen = new Set<string>();
      for (const n of picked) {
        const why = this.refuse(n) ?? (seen.has(nameSkeleton(n)) ? 'it is in the list twice' : null);
        if (why) throw new RuleError(`"${n}" cannot join the roster: ${why}`);
        seen.add(nameSkeleton(n));
      }
    } else {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > ROSTER_NAMES.length)
        throw new RuleError(`count must be a whole number from 1 to ${ROSTER_NAMES.length}`);
      picked = ROSTER_NAMES.filter((n) => !this.refuse(n)).slice(0, count);
      if (picked.length < count) throw new RuleError(`Only ${picked.length} house names are free: pass your own "names" for the rest`);
    }
    if (this.entries.size + picked.length > MAX_ROSTER) throw new RuleError(`The roster holds at most ${MAX_ROSTER} names`);
    const at = this.now();
    const made = picked.map((name) => {
      let id = `r_${randomBytes(4).toString('hex')}`;
      while (this.entries.has(id)) id = `r_${randomBytes(4).toString('hex')}`;
      const e: RosterEntry = { id, name, model, status: 'active', createdAt: at };
      this.index(e);
      return e;
    });
    this.save();
    return made.map((e) => ({ ...e }));
  }

  /** Retire names (their stats freeze; the names stay reserved): by `ids`, or the oldest `count` active names of `model`. */
  retire(spec: { ids?: unknown; model?: unknown; count?: unknown }): RosterEntry[] {
    let picked: RosterEntry[];
    if (spec.ids !== undefined) {
      if (!Array.isArray(spec.ids) || !spec.ids.length) throw new RuleError('ids must be a list of roster ids');
      picked = spec.ids.map((id) => {
        const e = this.entries.get(String(id));
        if (!e) throw new RuleError(`No roster name has the id "${String(id)}"`);
        return e;
      });
    } else {
      const active = [...this.entries.values()].filter((e) => e.status === 'active' && e.model === spec.model).sort((a, b) => a.createdAt - b.createdAt);
      if (typeof spec.count !== 'number' || !Number.isInteger(spec.count) || spec.count < 1) throw new RuleError('Give ids, or a model and a count of at least 1');
      if (spec.count > active.length) throw new RuleError(`Only ${active.length} active names play ${String(spec.model)}`);
      picked = active.slice(0, spec.count);
    }
    const at = this.now();
    for (const e of picked) {
      if (e.status === 'retired') continue;
      e.status = 'retired';
      e.retiredAt = at;
    }
    this.save();
    return picked.map((e) => ({ ...e }));
  }

  /**
   * `n` active roster ids for a tournament (the daily scheduler), spread evenly over the models: one per model in
   * turn, each model's names in rotation, so every name gets its share of days. Fewer when fewer are active.
   */
  pick(n: number): string[] {
    const byModel = new Map<string, RosterEntry[]>();
    for (const e of this.entries.values()) if (e.status === 'active') byModel.set(e.model, [...(byModel.get(e.model) ?? []), e]);
    const queues = [...byModel.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, list]) => {
      const start = (this.rotation.get(model) ?? 0) % list.length;
      return { model, list: [...list.slice(start), ...list.slice(0, start)], taken: 0 };
    });
    const out: string[] = [];
    while (out.length < n && queues.some((q) => q.taken < q.list.length))
      for (const q of queues) if (out.length < n && q.taken < q.list.length) out.push(q.list[q.taken++].id);
    for (const q of queues) this.rotation.set(q.model, (this.rotation.get(q.model) ?? 0) + q.taken);
    return out;
  }

  /** Where each model's next pick starts (in memory: a restart starts the rotation over, which is harmless). */
  private rotation = new Map<string, number>();

  /** Active roster entries for these ids, in order: throws on an unknown, retired or repeated id. */
  activeEntries(ids: readonly string[]): RosterEntry[] {
    const seen = new Set<string>();
    return ids.map((id) => {
      const e = this.entries.get(id);
      if (!e) throw new RuleError(`No roster name has the id "${id}"`);
      if (e.status !== 'active') throw new RuleError(`${e.name} (${id}) is retired`);
      if (seen.has(id)) throw new RuleError(`The roster id "${id}" is in the list twice`);
      seen.add(id);
      return e;
    });
  }
}
