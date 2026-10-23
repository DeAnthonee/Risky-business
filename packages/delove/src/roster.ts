import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mixSeed, seededRandom } from '@risk/selfplay';

/**
 * The house roster (packages/delove/README.md "House roster"): the named players the seat pool seats in the daily
 * tournament. Each name always plays one model: a name never changes model. When a version retires (two or more
 * promotions behind the newest, and not the anchor), its names retire with it, and new names are added for a new
 * version. The pool gives each claimed seat a free name, splitting the seats evenly across the active versions, and the
 * seat plays that name's model. The player sees only the name; the roster file is what links names to models (it lives
 * on the host, outside the repo; configs/roster.sample.json is a sample).
 */

export interface RosterName {
  name: string;
  /** The model this name plays, for good (delove@N). */
  model: string;
  /** When the name joined the roster (YYYY-MM-DD). */
  added: string;
  /** When its version retired (YYYY-MM-DD); a retired name is never seated again. */
  retired?: string;
}

export interface Roster {
  v: 1;
  /** The long-lived anchor version: never retired, so every week compares against the same player. */
  anchor: string;
  names: RosterName[];
}

/** Longest player name the server keeps (tournaments.ts MAX_NAME). */
export const MAX_ROSTER_NAME = 24;

export function loadRoster(path: string): Roster {
  const r = JSON.parse(readFileSync(path, 'utf8')) as Roster;
  checkRoster(r, path);
  return r;
}

export function saveRoster(path: string, r: Roster): void {
  checkRoster(r, path);
  writeFileSync(`${path}.tmp`, JSON.stringify(r, null, 1) + '\n');
  renameSync(`${path}.tmp`, path);
}

export function checkRoster(r: Roster, where = 'roster'): void {
  if (r.v !== 1) throw new Error(`${where}: unsupported roster version ${r.v}`);
  const seen = new Set<string>();
  for (const n of r.names) {
    const key = n.name.toLowerCase();
    if (seen.has(key)) throw new Error(`${where}: the name ${n.name} is there twice`);
    seen.add(key);
    if (!n.name.trim() || n.name.length > MAX_ROSTER_NAME) throw new Error(`${where}: ${JSON.stringify(n.name)} must be 1-${MAX_ROSTER_NAME} characters`);
    // "Delove ..." names are the pool's own numbered seats, and "zerg" names make a seat one of the horde in self-play.
    if (/^delove\b/i.test(n.name) || /^zerg/i.test(n.name)) throw new Error(`${where}: ${n.name} may not start with "Delove" or "Zerg"`);
    if (!/^delove@\d+$/.test(n.model)) throw new Error(`${where}: ${n.name} plays ${n.model}, which is not a delove@N version`);
  }
}

/** The versions with at least one name still active, anchor first, then newest first. */
export function activeModels(r: Roster): string[] {
  const models = [...new Set(r.names.filter((n) => !n.retired).map((n) => n.model))];
  const v = (m: string) => Number(m.split('@')[1]);
  return models.sort((a, b) => (a === r.anchor ? -1 : b === r.anchor ? 1 : v(b) - v(a)));
}

/**
 * Free names for `n` seats: active names not in `inUse`, playing a model `canPlay` allows (e.g. fog-trained ones for a
 * fog seat). Seats go to the version with the fewest seats so far (counting `inUse`), so the versions stay even; within
 * a version, names are taken in roster order. Fewer than `n` when the roster runs out.
 */
export function pickNames(r: Roster, n: number, inUse: Iterable<string>, canPlay: (model: string) => boolean = () => true): RosterName[] {
  const used = new Set([...inUse].map((s) => s.toLowerCase()));
  const models = activeModels(r).filter(canPlay);
  const count = new Map(models.map((m) => [m, r.names.filter((x) => x.model === m && used.has(x.name.toLowerCase())).length]));
  const free = new Map(models.map((m) => [m, r.names.filter((x) => x.model === m && !x.retired && !used.has(x.name.toLowerCase()))]));
  const out: RosterName[] = [];
  while (out.length < n) {
    const open = models.filter((m) => free.get(m)!.length);
    if (!open.length) break;
    const m = open.reduce((best, x) => (count.get(x)! < count.get(best)! ? x : best));
    out.push(free.get(m)!.shift()!);
    count.set(m, count.get(m)! + 1);
  }
  return out;
}

/**
 * After a promotion to `newest` (delove@N): every version two or more promotions behind, except the anchor, retires
 * with its names. Returns the models retired.
 */
export function retireOld(r: Roster, newest: string, today: string): string[] {
  const top = Number(newest.split('@')[1]);
  const gone = activeModels(r).filter((m) => m !== r.anchor && Number(m.split('@')[1]) <= top - 2);
  for (const n of r.names) if (gone.includes(n.model) && !n.retired) n.retired = today;
  return gone;
}

// Names: half simple (one word), half funny (two words). Plain, friendly, nobody real.
const SIMPLE = [
  'Ada', 'Bram', 'Cleo', 'Dash', 'Edda', 'Finn', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kit', 'Lark', 'Milo', 'Nell', 'Otto',
  'Pip', 'Quin', 'Rhea', 'Sol', 'Tess', 'Uma', 'Vito', 'Wren', 'Xan', 'Yara', 'Zed', 'Arlo', 'Bea', 'Cass', 'Dov',
  'Elio', 'Fern', 'Gwen', 'Hugo', 'Isla', 'Jax', 'Kaia', 'Lev', 'Mara', 'Nico', 'Odie', 'Pax', 'Rory', 'Sage', 'Theo',
  'Una', 'Vera', 'Wade', 'Yuri', 'Zola', 'Abe', 'Bo', 'Cy', 'Dot', 'Eve', 'Flo', 'Hal', 'Ike', 'Jo', 'Lu',
];
const FUNNY_FIRST = [
  'Captain', 'Sir', 'Lady', 'Baron', 'Count', 'Duke', 'Professor', 'Admiral', 'Sergeant', 'Madam', 'Doctor', 'Grandpa',
  'Little', 'Big', 'Sneaky', 'Lucky', 'Grumpy', 'Sleepy', 'Wobbly', 'Fancy', 'Mighty', 'Tiny', 'Saucy', 'Dizzy',
];
const FUNNY_SECOND = [
  'Pancake', 'Waffles', 'Noodle', 'Biscuit', 'Pickles', 'Muffin', 'Turnip', 'Meatball', 'Dumpling', 'Crumpet',
  'Fumbles', 'Snorkel', 'Wiggles', 'Gumdrop', 'Nugget', 'Pudding', 'Bagel', 'Pretzel', 'Sprout', 'Doodle', 'Taco',
  'Marmalade', 'Hiccup', 'Teacup', 'Kazoo', 'Jellybean', 'Sardine', 'Toast', 'Banjo', 'Mustard',
];

/** `count` new names, none already in `taken` (case-insensitive): alternately simple and funny, seeded. */
export function generateNames(count: number, taken: Iterable<string>, seed: number): string[] {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  const rand = seededRandom(mixSeed(seed, 0x0a5e7));
  const pickFrom = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const out: string[] = [];
  for (let tries = 0; out.length < count && tries < count * 200; tries++) {
    const simple = out.length % 2 === 0;
    // Simple names: an unused one while any is left, then one with a number (still short and unique).
    const fresh = SIMPLE.filter((x) => !used.has(x.toLowerCase()));
    const name = !simple
      ? `${pickFrom(FUNNY_FIRST)} ${pickFrom(FUNNY_SECOND)}`
      : fresh.length
        ? pickFrom(fresh)
        : `${pickFrom(SIMPLE)} ${2 + Math.floor(rand() * 98)}`;
    if (name.length > MAX_ROSTER_NAME || used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length < count) throw new Error(`could only make ${out.length} of ${count} new names`);
  return out;
}

/** Adds `count` new names playing `model`. */
export function addNames(r: Roster, model: string, count: number, today: string, seed: number): RosterName[] {
  const names = generateNames(count, r.names.map((n) => n.name), seed).map((name) => ({ name, model, added: today }));
  r.names.push(...names);
  checkRoster(r);
  return names;
}

/** A new roster: `models` maps each version to its number of names; `anchor` is never retired. */
export function newRoster(models: Record<string, number>, anchor: string, today: string, seed: number): Roster {
  const r: Roster = { v: 1, anchor, names: [] };
  for (const [m, n] of Object.entries(models)) addNames(r, m, n, today, mixSeed(seed, Number(m.split('@')[1])));
  return r;
}

/** The roster at `path`, or null when there is none (the pool then seats "Delove N" as before). */
export function maybeRoster(path: string | undefined): Roster | null {
  return path && existsSync(path) ? loadRoster(path) : null;
}
