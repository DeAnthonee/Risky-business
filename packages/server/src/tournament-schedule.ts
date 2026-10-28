// Scheduled nested tournaments (docs/tournaments.md "Scheduled tournaments"). The owner lists times in
// RISK_TOURNAMENT_SCHEDULE (JSON) or RISK_TOURNAMENT_SCHEDULE_FILE (a JSON file); unset means off. For each slot the
// server creates a nested tournament `signupMinutes` before the start (server-made: its host token never leaves the
// server), starts it on time (the nested start fills empty seats with Zergs, by the planner's rule), or calls it off
// when fewer than `minEntrants` people or agents joined. One timer, set to the next event: no polling.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError } from '@risk/engine';
import { parseTournamentSpec } from './http.js';
import { DEFAULT_CHECKIN_MINUTES, NESTED_ROUND_MINUTES, STYLE_LABELS, type CreateTournamentSpec, type TournamentManager, type TournamentSnapshot, type TournamentStyle } from './tournaments.js';

/** One schedule entry as the owner writes it. */
export interface ScheduleEntryInput {
  /** "HH:MM" every day, or "Mon,Thu HH:MM" on those days; in `tz`, else UTC. */
  at?: string;
  /** The daily tournament: "HH:MM" every day, in `tz` (the same as `at` without day names). */
  daily?: string;
  /**
   * A start every this-many minutes (5-1440, dividing 1440), on the UTC clock, lined up on `at` ("HH:MM", no day names):
   * `{"every": 30, "at": "00:03"}` starts at :03 and :33 of every hour. Not with `daily` or `tz`.
   */
  every?: number;
  /** IANA time zone of `at` / `daily` (e.g. "America/Los_Angeles"; summer time followed); default UTC. */
  tz?: string;
  name?: string;
  /** Sign-up opens this many minutes before the start (1-10080, i.e. up to 7 days ahead; default 60). */
  signupMinutes?: number;
  /** The same in days (1-7); not with signupMinutes. */
  signupDays?: number;
  /** House roster seats asked for each slot (0-100, default 0): seat requests go out when the slot opens. */
  roster?: number;
  /** The check-in window, the last this-many minutes before the start (1-60, at most signupMinutes; default 10). */
  checkinMinutes?: number;
  /** Fewer people or agents than this at the start calls the slot off (2-256, default 2: a nested tournament needs 2). */
  minEntrants?: number;
  /** "classic" (default), "1v1" or "survival" (docs/tournaments.md "Tournament styles"). */
  style?: TournamentStyle;
  /**
   * The first round's smallest table (classic and survival, 3-6), or a list the slots take in turn
   * (`[3, 4, 5]`: one slot at 3, the next at 4, then 5, then 3 again).
   */
  minTable?: number | number[];
  /** Zerg entrants added to each slot as it opens (0-256), inside maxEntrants with the roster. */
  zergs?: number;
  /** Any nested tournament setting: finalMap, maxEntrants, roundMinutes, territoriesPerSeat, finishShare, botDelayMs, options. */
  [key: string]: unknown;
}

export interface ScheduleEntry {
  /** Stable id of the entry (its normalized JSON): a changed entry starts afresh. */
  key: string;
  at: string;
  /** The time zone of `at` (IANA), or null for UTC. */
  tz: string | null;
  days: number[] | null;
  minuteOfDay: number;
  /** Minutes between starts (UTC clock, lined up on minuteOfDay), or null: once a day. */
  every: number | null;
  /** House roster seats asked for each slot (0 = none). */
  roster: number;
  /** The first-round minimum table sizes the slots take in turn, or null for the planner's default. */
  minTables: number[] | null;
  signupMinutes: number;
  checkinMinutes: number;
  minEntrants: number;
  spec: CreateTournamentSpec;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ENTRY_KEYS = new Set(['at', 'daily', 'every', 'tz', 'signupDays', 'roster', 'style', 'minTable', 'zergs', 'name', 'signupMinutes', 'checkinMinutes', 'minEntrants', 'finalMap', 'maxEntrants', 'roundMinutes', 'territoriesPerSeat', 'finishShare', 'botDelayMs', 'options']);
/** A scheduled tournament's seats when its entry gives no maxEntrants (the nested default). */
export const DEFAULT_SCHEDULED_MAX = 128;
export const CANCEL_NOT_ENOUGH = 'not enough entrants';
export const CANCEL_MISSED = 'missed: the server was down at the start';
export const CANCEL_CHANGED = 'the schedule changed';

/** Parse `at`: "HH:MM" (daily) or "Mon,Thu HH:MM". */
export function parseAt(at: unknown): { days: number[] | null; minuteOfDay: number } {
  const m = typeof at === 'string' ? /^\s*(?:([A-Za-z]{3}(?:\s*,\s*[A-Za-z]{3})*)\s+)?(\d{1,2}):(\d{2})\s*$/.exec(at) : null;
  if (!m) throw new RuleError('at must be "HH:MM" or "Mon,Thu HH:MM" (UTC)');
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) throw new RuleError(`at "${at}": the time must be 00:00-23:59`);
  let days: number[] | null = null;
  if (m[1]) {
    days = [];
    for (const d of m[1].split(',').map((x) => x.trim().toLowerCase())) {
      const i = DAYS.indexOf(d);
      if (i < 0) throw new RuleError(`at "${at}": unknown day "${d}" (Sun, Mon, Tue, Wed, Thu, Fri, Sat)`);
      if (!days.includes(i)) days.push(i);
    }
    days.sort();
  }
  return { days, minuteOfDay: h * 60 + min };
}

/** The wall clock in `tz` at a UTC instant: its date, weekday and how far the zone is ahead of UTC (minutes). */
function zoned(utcMs: number, tz: string): { y: number; m: number; d: number; offset: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(utcMs);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return { y: p.year, m: p.month - 1, d: p.day, offset: Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000) };
}

/** The UTC instant of a wall-clock time in `tz` (a summer-time gap moves it on by the gap; an overlap takes the first). */
function zonedInstant(y: number, m: number, d: number, minuteOfDay: number, tz: string): number {
  const wall = Date.UTC(y, m, d, 0, minuteOfDay);
  let t = wall - zoned(wall, tz).offset * 60_000;
  t = wall - zoned(t, tz).offset * 60_000;
  return t;
}

/** Whether `tz` is a time zone this runtime knows. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The first start strictly after `after` (ms, UTC); in the entry's time zone when it has one. */
export function nextStart(e: Pick<ScheduleEntry, 'days' | 'minuteOfDay'> & { tz?: string | null; every?: number | null }, after: number): number {
  if (e.every) {
    // Whole UTC minutes since the epoch (a UTC midnight), so `every` dividing 1440 lines up the same every day.
    const first = Math.floor(after / 60_000) + 1;
    const off = (((first - e.minuteOfDay) % e.every) + e.every) % e.every;
    return (off ? first + e.every - off : first) * 60_000;
  }
  if (e.tz) {
    const today = zoned(after, e.tz);
    for (let i = 0; i <= 8; i++) {
      const t = zonedInstant(today.y, today.m, today.d + i, e.minuteOfDay, e.tz);
      const weekday = new Date(Date.UTC(today.y, today.m, today.d + i)).getUTCDay();
      if (t > after && (!e.days || e.days.includes(weekday))) return t;
    }
    throw new Error('unreachable: no start within 8 days');
  }
  const d = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 0, e.minuteOfDay);
    if (t > after && (!e.days || e.days.includes(new Date(t).getUTCDay()))) return t;
  }
  throw new Error('unreachable: no start within 8 days');
}

/**
 * Parse and check the schedule (one entry or a list). Every entry's tournament settings go through the same strict
 * parser as POST /tournaments, then the nested checks, so a bad schedule fails here, at startup, not at sign-up time.
 */
export function parseSchedule(raw: unknown, tournaments: Pick<TournamentManager, 'checkNested'>): ScheduleEntry[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) throw new RuleError('the schedule is empty');
  return list.map((item, i) => {
    const where = `schedule entry ${i + 1}`;
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RuleError('must be an object with "at" or "daily"');
      const e = item as ScheduleEntryInput;
      for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) throw new RuleError(`unknown key "${k}"`);
      if ((e.at === undefined) === (e.daily === undefined)) throw new RuleError('give either "at" or "daily"');
      if (e.daily !== undefined && (typeof e.daily !== 'string' || !/^\s*\d{1,2}:\d{2}\s*$/.test(e.daily))) throw new RuleError('daily must be "HH:MM"');
      if (e.tz !== undefined && !validTimeZone(e.tz)) throw new RuleError(`unknown time zone "${String(e.tz)}" (use an IANA name such as America/New_York)`);
      const at = String(e.at ?? e.daily);
      const { days, minuteOfDay } = parseAt(at);
      const whole = (v: unknown, name: string, lo: number, hi: number, fallback: number) => {
        if (v === undefined) return fallback;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new RuleError(`${name} must be a whole number from ${lo} to ${hi}`);
        return v;
      };
      let every: number | null = null;
      if (e.every !== undefined) {
        every = whole(e.every, 'every', 5, 1440, 0);
        if (1440 % every) throw new RuleError('every must divide a day (1440 minutes): 5, 10, 15, 20, 30, 60, 120, ...');
        if (e.daily !== undefined || e.tz !== undefined || days) throw new RuleError('every goes with a plain "at": "HH:MM" (UTC), not with daily, tz or day names');
      }
      if (e.signupDays !== undefined && e.signupMinutes !== undefined) throw new RuleError('give signupMinutes or signupDays, not both');
      const signupMinutes = e.signupDays !== undefined ? whole(e.signupDays, 'signupDays', 1, 7, 1) * 1440 : whole(e.signupMinutes, 'signupMinutes', 1, 10080, 60);
      // One slot open at a time: the next one opens after this one starts.
      if (every && signupMinutes > every) throw new RuleError(`signupMinutes (${signupMinutes}) must be at most every (${every})`);
      const roster = whole(e.roster, 'roster', 0, 100, 0);
      const checkinMinutes = whole(e.checkinMinutes, 'checkinMinutes', 1, Math.min(60, signupMinutes), Math.min(DEFAULT_CHECKIN_MINUTES, signupMinutes));
      const minEntrants = whole(e.minEntrants, 'minEntrants', 2, 256, 2);
      // The key keeps its #234 shape (checkinMinutes only when the entry sets it), so a deploy restarts no open slot.
      const { at: _at, signupMinutes: _s, minEntrants: _m, ...rest } = e;
      const { checkinMinutes: _c, daily: _d, every: _ev, tz: _t, signupDays: _sd, roster: _r, minTable: _mt, ...specRest } = rest;
      const minTables = e.minTable === undefined ? null : Array.isArray(e.minTable) ? e.minTable : [e.minTable];
      if (minTables && (!minTables.length || minTables.length > 24)) throw new RuleError('minTable must be a number or a list of 1-24 numbers');
      const spec: CreateTournamentSpec = { ...parseTournamentSpec({ ...specRest, format: 'nested' }), name: String(e.name ?? 'Scheduled tournament') };
      // Every table size the slots will take, checked now.
      for (const minTable of minTables ?? [undefined]) tournaments.checkNested({ ...spec, ...(minTable !== undefined ? { minTable } : {}) });
      const zergs = spec.zergs ?? 0;
      if (roster + zergs > (spec.maxEntrants ?? DEFAULT_SCHEDULED_MAX)) throw new RuleError(`roster (${roster})${zergs ? ` plus zergs (${zergs})` : ''} is more than maxEntrants (${spec.maxEntrants ?? DEFAULT_SCHEDULED_MAX})`);
      const key = JSON.stringify({ at: e.at, signupMinutes, minEntrants, ...rest });
      return { key, at, tz: e.tz ?? null, days, minuteOfDay, every, roster, minTables, signupMinutes, checkinMinutes, minEntrants, spec };
    } catch (err) {
      throw new RuleError(`${where}: ${(err as Error).message}`);
    }
  });
}

/** The first-round minimum table of the slot starting at `startsAt`: the entry's list, one slot after another. */
export function slotMinTable(e: Pick<ScheduleEntry, 'minTables' | 'every'>, startsAt: number): number | undefined {
  if (!e.minTables) return undefined;
  const n = Math.floor(startsAt / ((e.every ?? 1440) * 60_000));
  return e.minTables[n % e.minTables.length];
}

/** The schedule the settings page saved (schedule-settings.ts), under RISK_DATA_DIR: it wins over the environment. */
export const SAVED_SCHEDULE_FILE = 'tournament-schedule-entries.json';
export const SAVED_SCHEDULE_SOURCE = 'the settings page';

/** The schedule the settings page saved, or null when it has saved none (or the file is unreadable: logged). */
export function scheduleFromSaved(file: string | null): { raw: unknown; source: string } | null {
  if (!file || !existsSync(file)) return null;
  return { raw: JSON.parse(readFileSync(file, 'utf8')), source: SAVED_SCHEDULE_SOURCE };
}

/** Read the schedule from the environment: RISK_TOURNAMENT_SCHEDULE (JSON) or RISK_TOURNAMENT_SCHEDULE_FILE. */
export function scheduleFromEnv(env: NodeJS.ProcessEnv): { raw: unknown; source: string } | null {
  if (env.RISK_TOURNAMENT_SCHEDULE) return { raw: JSON.parse(env.RISK_TOURNAMENT_SCHEDULE), source: 'RISK_TOURNAMENT_SCHEDULE' };
  if (env.RISK_TOURNAMENT_SCHEDULE_FILE) return { raw: JSON.parse(readFileSync(env.RISK_TOURNAMENT_SCHEDULE_FILE, 'utf8')), source: 'RISK_TOURNAMENT_SCHEDULE_FILE' };
  return null;
}

/** The slot an entry is on: its start, and the tournament made for it (null until sign-up opens). */
interface Slot {
  startsAt: number;
  tournamentId: string | null;
  /** Started or called off: the entry moves on to its next start. */
  done: boolean;
}

/** What the home page's card and the MCP tool show (GET /api/tournaments/next). */
export interface NextTournament {
  /** The next scheduled tournament: open for sign-up (id set) or not yet open (id null). */
  next: {
    id: string | null;
    name: string;
    startsAt: number;
    opensAt: number;
    /** The check-in window opens (ms); people who have not checked in by the start are swapped for Zergs. */
    checkinOpensAt: number;
    entrants: number;
    /** Once check-in is open: how many of `entrants` have checked in. */
    checkedIn?: number;
    maxEntrants: number | null;
    minEntrants: number;
    /** House roster seats asked for this slot (part of maxEntrants). */
    roster: number;
    /** The entry's time zone (IANA), or null for UTC. */
    tz: string | null;
    /** Its style, and what to call it ("Classic groups", "1v1s", "Zerg survival"). */
    style: TournamentStyle;
    label: string;
    /** The first round's smallest table (classic and survival), or null for the planner's 3. */
    minTable: number | null;
    /** Zerg entrants added as it opens. */
    zergs: number;
  } | null;
  /** A scheduled tournament being played now. */
  running: { id: string; name: string; startsAt: number; round: number; style: TournamentStyle; label: string } | null;
  /** The latest scheduled tournament that was called off, when no later one has started. */
  cancelled: { id: string; name: string; startsAt: number; reason: string; style: TournamentStyle; label: string } | null;
}

/** A style and its label (absent = classic). */
function styleOf(style: TournamentStyle | undefined): { style: TournamentStyle; label: string } {
  const s = style ?? 'classic';
  return { style: s, label: STYLE_LABELS[s] };
}

export class TournamentScheduler {
  private slots = new Map<string, Slot>();
  /** On-demand runs (runNow) waiting for their start: each with its entry's key. */
  private oneOffs = new Map<string, { entry: string; slot: Slot }>();
  private timer: unknown = null;
  private retryAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private tournaments: TournamentManager,
    readonly entries: ScheduleEntry[],
    private file: string | null,
    /** A slot's tournament was just created (app.ts: the house roster's seat requests go out here). */
    private onOpened: ((t: TournamentSnapshot, e: ScheduleEntry) => void) | null = null,
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { slots?: Record<string, Slot>; oneOffs?: Record<string, { entry: string; slot: Slot }> };
        for (const e of entries) if (saved.slots?.[e.key]) this.slots.set(e.key, saved.slots[e.key]);
        // On-demand runs keep their start across a restart, or are called off with their entry.
        for (const [key, run] of Object.entries(saved.oneOffs ?? {})) {
          if (entries.some((e) => e.key === run.entry)) this.oneOffs.set(key, run);
          else if (run.slot.tournamentId && this.tournaments.get(run.slot.tournamentId)?.status === 'registering') this.tournaments.cancel(run.slot.tournamentId, CANCEL_CHANGED);
        }
        // An entry the owner changed or removed has a new key (or none): its open tournament would never start, so it
        // is called off rather than left registering, holding a maxActive place and its entrants.
        const keys = new Set(entries.map((e) => e.key));
        for (const [key, slot] of Object.entries(saved.slots ?? {})) {
          if (keys.has(key) || slot.done || !slot.tournamentId) continue;
          if (this.tournaments.get(slot.tournamentId)?.status === 'registering') {
            this.tournaments.cancel(slot.tournamentId, CANCEL_CHANGED);
            console.log(`tournament schedule: ${slot.tournamentId} called off (${CANCEL_CHANGED})`);
          }
        }
      } catch (err) {
        console.error('Failed to load the tournament schedule state:', err);
      }
    }
    this.tick();
  }

  private get now() {
    return this.tournaments.clock.now();
  }

  /** Do whatever is due, then sleep until the next event. */
  tick() {
    if (this.stopped) return;
    let wake = Infinity;
    for (const e of this.entries) {
      try {
        wake = Math.min(wake, this.step(e));
      } catch (err) {
        console.error(`tournament schedule (${e.at}):`, err);
        wake = Math.min(wake, this.now + 5 * 60_000);
      }
    }
    for (const [key, run] of this.oneOffs) {
      const e = this.entries.find((x) => x.key === run.entry);
      if (e && this.now < run.slot.startsAt) {
        wake = Math.min(wake, run.slot.startsAt);
        continue;
      }
      try {
        if (e) this.begin(e, run.slot);
      } catch (err) {
        console.error(`tournament schedule (on demand ${run.slot.tournamentId}):`, err);
      }
      this.oneOffs.delete(key);
    }
    this.save();
    this.arm(wake);
  }

  /** One entry: open, start or call off its slot as due. Returns when it next needs a tick. */
  private step(e: ScheduleEntry): number {
    const now = this.now;
    let slot = this.slots.get(e.key);
    // A slot whose tournament was deleted by the admin is over.
    if (slot && !slot.done && slot.tournamentId && this.tournaments.get(slot.tournamentId)?.status !== 'registering') slot.done = true;
    if (!slot || slot.done) {
      const startsAt = nextStart(e, Math.max(now, slot?.startsAt ?? 0));
      slot = { startsAt, tournamentId: null, done: false };
      this.slots.set(e.key, slot);
    }
    const opensAt = slot.startsAt - e.signupMinutes * 60_000;
    if (!slot.tournamentId) {
      if (now < opensAt) return opensAt;
      // Booted after this slot's start without having opened it: skip to the next one.
      if (now >= slot.startsAt) {
        slot.done = true;
        return this.step(e);
      }
      const retry = this.retryAt.get(e.key);
      if (retry !== undefined && now < retry) return retry;
      try {
        slot.tournamentId = this.open(e, slot.startsAt).id;
        this.retryAt.delete(e.key);
      } catch (err) {
        // Too many tournaments open (maxActive): try again in a few minutes, until the start.
        console.error(`tournament schedule: could not open "${e.spec.name}": ${(err as Error).message}`);
        const at = Math.min(now + 5 * 60_000, slot.startsAt);
        this.retryAt.set(e.key, at);
        return at;
      }
    }
    if (now < slot.startsAt) return slot.startsAt;
    this.begin(e, slot);
    // On to the entry's next start (strictly later, so this ends).
    return this.step(e);
  }

  /** Create a slot's tournament (sign-up opens) and send its roster request. Throws when it cannot be created. */
  private open(e: ScheduleEntry, startsAt: number): TournamentSnapshot {
    // Roster seats are counted like a host's Delove seats (requested.delove), inside the slot's maxEntrants.
    const seats = e.roster ? { delove: e.roster, maxEntrants: e.spec.maxEntrants ?? DEFAULT_SCHEDULED_MAX } : {};
    const minTable = slotMinTable(e, startsAt);
    const t = this.tournaments.create({ ...e.spec, ...seats, ...(minTable !== undefined ? { minTable } : {}), scheduled: { startsAt, checkinMinutes: e.checkinMinutes } });
    console.log(`tournament schedule: ${t.id} "${t.name}" open for sign-up, starts ${new Date(startsAt).toISOString()}${e.roster ? `, ${e.roster} roster seats requested` : ''}`);
    try {
      this.onOpened?.(t, e);
    } catch (err) {
      // The roster is a bonus: the slot stays open without it (unfilled seats go to Zergs at the start).
      console.error(`tournament schedule: roster seats for ${t.id}: ${(err as Error).message}`);
    }
    return t;
  }

  /** At its start: start the slot's tournament, or call it off (too few checked in, or missed). The slot is done. */
  private begin(e: ScheduleEntry, slot: Slot) {
    slot.done = true;
    const t = slot.tournamentId ? this.tournaments.get(slot.tournamentId) : undefined;
    // Deleted, or called off already (expired: tournament-access.ts): nothing to start.
    if (!t || t.status !== 'registering') return;
    // Only people who checked in count; the rest are no-shows, swapped for Zergs at the start.
    const people = t.entrants.filter((x) => !x.isBot && x.checkedInAt).length;
    // Late by more than a round (the server was down at the start): call it off rather than start at a surprise time.
    const grace = (e.spec.roundMinutes ?? NESTED_ROUND_MINUTES) * 60_000;
    if (this.now > slot.startsAt + grace) this.tournaments.cancel(t.id, CANCEL_MISSED);
    else if (people < e.minEntrants) this.tournaments.cancel(t.id, CANCEL_NOT_ENOUGH);
    else this.tournaments.startScheduled(t.id);
    console.log(`tournament schedule: ${t.id} ${t.scheduled?.cancelled ? `called off (${t.scheduled.cancelled})` : `started with ${people} checked-in entrant(s), ${t.scheduled?.noShows ?? 0} no-show(s) swapped for Zergs`}`);
  }

  /**
   * On demand (POST /api/admin/schedule/run, the owner's "and on demand when i feel like testing it"): a one-off run of
   * the first entry of `style`, as its slots run (its roster, Zergs and settings; roster seats yield to people), with
   * sign-up open now and the start in `startsInMinutes` (1-60, default the entry's check-in window). The entry's own
   * timetable is untouched.
   */
  runNow(style: TournamentStyle, startsInMinutes?: number): TournamentSnapshot {
    const e = this.entries.find((x) => (x.spec.style ?? 'classic') === style);
    if (!e) throw new RuleError(`The schedule has no ${STYLE_LABELS[style]} entry`);
    const minutes = startsInMinutes ?? e.checkinMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new RuleError('startsInMinutes must be a whole number from 1 to 60');
    const startsAt = Math.ceil((this.now + minutes * 60_000) / 60_000) * 60_000;
    const t = this.open(e, startsAt);
    this.oneOffs.set(`${e.key}#now:${startsAt}:${t.id}`, { entry: e.key, slot: { startsAt, tournamentId: t.id, done: false } });
    this.tick();
    return t;
  }

  private arm(wake: number) {
    if (this.timer !== null) this.tournaments.clock.clearTimeout(this.timer);
    this.timer = null;
    if (!Number.isFinite(wake)) return;
    // setTimeout holds at most ~24.8 days; a longer wait just wakes up and sleeps again.
    const ms = Math.min(Math.max(0, wake - this.now), 2 ** 31 - 1);
    this.timer = this.tournaments.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  /** The card's view: the next one (open or upcoming), the one being played, and the last one called off. */
  next(): NextTournament {
    const scheduled = [...this.tournaments.tournaments.values()].filter((t) => t.scheduled);
    let next: NextTournament['next'] = null;
    for (const e of this.entries) {
      const slot = this.slots.get(e.key);
      if (!slot || slot.done) continue;
      if (next && next.startsAt <= slot.startsAt) continue;
      const t = slot.tournamentId ? this.tournaments.get(slot.tournamentId) : undefined;
      next = {
        id: t?.id ?? null,
        name: t?.name ?? e.spec.name ?? 'Scheduled tournament',
        startsAt: slot.startsAt,
        opensAt: slot.startsAt - e.signupMinutes * 60_000,
        checkinOpensAt: slot.startsAt - e.checkinMinutes * 60_000,
        // People and agents only, the count minEntrants is checked against (an admin may have added bots).
        entrants: t ? t.entrants.filter((x) => !x.isBot).length : 0,
        ...(t && this.tournaments.checkinOpen(t) ? { checkedIn: t.entrants.filter((x) => !x.isBot && x.checkedInAt).length } : {}),
        maxEntrants: t ? t.maxEntrants : (e.spec.maxEntrants ?? (e.roster ? DEFAULT_SCHEDULED_MAX : null)),
        minEntrants: e.minEntrants,
        roster: e.roster,
        tz: e.tz,
        ...styleOf(e.spec.style),
        minTable: t?.nested?.minTable ?? slotMinTable(e, slot.startsAt) ?? null,
        zergs: e.spec.zergs ?? 0,
      };
    }
    const playing = scheduled.filter((t) => t.status === 'running').sort((a, b) => b.scheduled!.startsAt - a.scheduled!.startsAt)[0];
    const lastStarted = Math.max(0, ...scheduled.filter((t) => t.status !== 'registering' && !t.scheduled!.cancelled).map((t) => t.scheduled!.startsAt));
    const off = scheduled.filter((t) => t.scheduled!.cancelled && t.scheduled!.startsAt > lastStarted).sort((a, b) => b.scheduled!.startsAt - a.scheduled!.startsAt)[0];
    return {
      next,
      running: playing ? { id: playing.id, name: playing.name, startsAt: playing.scheduled!.startsAt, round: playing.rounds.length, ...styleOf(playing.nested?.style) } : null,
      cancelled: off ? { id: off.id, name: off.name, startsAt: off.scheduled!.startsAt, reason: off.scheduled!.cancelled!, ...styleOf(off.nested?.style) } : null,
    };
  }

  /** Write the slots now (before the settings page swaps this schedule for a new one). */
  persist() {
    this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ slots: Object.fromEntries(this.slots), oneOffs: Object.fromEntries(this.oneOffs) }));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save the tournament schedule state:', err);
    }
  }

  /** The schedule was turned off: call off its tournaments still registering (they would never start). */
  cancelOpen() {
    const runs = [...this.slots.values(), ...[...this.oneOffs.values()].map((r) => r.slot)];
    for (const slot of runs) {
      if (slot.done || !slot.tournamentId || this.tournaments.get(slot.tournamentId)?.status !== 'registering') continue;
      this.tournaments.cancel(slot.tournamentId, CANCEL_CHANGED);
      console.log(`tournament schedule: ${slot.tournamentId} called off (${CANCEL_CHANGED})`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.tournaments.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
