// Scheduled nested tournaments (docs/tournaments.md "Scheduled tournaments"). The owner lists times in
// RISK_TOURNAMENT_SCHEDULE (JSON) or RISK_TOURNAMENT_SCHEDULE_FILE (a JSON file); unset means off. For each slot the
// server creates a nested tournament `signupMinutes` before the start (server-made: its host token never leaves the
// server), starts it on time (the nested start fills empty seats with Zergs, by the planner's rule), or calls it off
// when fewer than `minEntrants` people or agents joined. One timer, set to the next event: no polling.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError } from '@risk/engine';
import { parseTournamentSpec } from './http.js';
import { DEFAULT_CHECKIN_MINUTES, type CreateTournamentSpec, type TournamentManager } from './tournaments.js';

/** One schedule entry as the owner writes it. */
export interface ScheduleEntryInput {
  /** "HH:MM" every day, or "Mon,Thu HH:MM" on those days; UTC. */
  at: string;
  name?: string;
  /** Sign-up opens this many minutes before the start (1-10080, i.e. up to 7 days ahead; default 60). */
  signupMinutes?: number;
  /** The check-in window, the last this-many minutes before the start (1-60, at most signupMinutes; default 10). */
  checkinMinutes?: number;
  /** Fewer people or agents than this at the start calls the slot off (2-256, default 2: a nested tournament needs 2). */
  minEntrants?: number;
  /** Any nested tournament setting: finalMap, maxEntrants, roundMinutes, territoriesPerSeat, finishShare, botDelayMs, options. */
  [key: string]: unknown;
}

export interface ScheduleEntry {
  /** Stable id of the entry (its normalized JSON): a changed entry starts afresh. */
  key: string;
  at: string;
  days: number[] | null;
  minuteOfDay: number;
  signupMinutes: number;
  checkinMinutes: number;
  minEntrants: number;
  spec: CreateTournamentSpec;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ENTRY_KEYS = new Set(['at', 'name', 'signupMinutes', 'checkinMinutes', 'minEntrants', 'finalMap', 'maxEntrants', 'roundMinutes', 'territoriesPerSeat', 'finishShare', 'botDelayMs', 'options']);
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

/** The first start strictly after `after` (ms, UTC). */
export function nextStart(e: Pick<ScheduleEntry, 'days' | 'minuteOfDay'>, after: number): number {
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
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RuleError('must be an object with "at"');
      const e = item as ScheduleEntryInput;
      for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) throw new RuleError(`unknown key "${k}"`);
      const { days, minuteOfDay } = parseAt(e.at);
      const whole = (v: unknown, name: string, lo: number, hi: number, fallback: number) => {
        if (v === undefined) return fallback;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new RuleError(`${name} must be a whole number from ${lo} to ${hi}`);
        return v;
      };
      const signupMinutes = whole(e.signupMinutes, 'signupMinutes', 1, 10080, 60);
      const checkinMinutes = whole(e.checkinMinutes, 'checkinMinutes', 1, Math.min(60, signupMinutes), Math.min(DEFAULT_CHECKIN_MINUTES, signupMinutes));
      const minEntrants = whole(e.minEntrants, 'minEntrants', 2, 256, 2);
      // The key keeps its #234 shape (checkinMinutes only when the entry sets it), so a deploy restarts no open slot.
      const { at: _at, signupMinutes: _s, minEntrants: _m, ...rest } = e;
      const { checkinMinutes: _c, ...specRest } = rest;
      const spec: CreateTournamentSpec = { ...parseTournamentSpec({ ...specRest, format: 'nested' }), name: String(e.name ?? 'Scheduled tournament') };
      tournaments.checkNested(spec);
      const key = JSON.stringify({ at: e.at, signupMinutes, minEntrants, ...rest });
      return { key, at: String(e.at), days, minuteOfDay, signupMinutes, checkinMinutes, minEntrants, spec };
    } catch (err) {
      throw new RuleError(`${where}: ${(err as Error).message}`);
    }
  });
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
  } | null;
  /** A scheduled tournament being played now. */
  running: { id: string; name: string; startsAt: number; round: number } | null;
  /** The latest scheduled tournament that was called off, when no later one has started. */
  cancelled: { id: string; name: string; startsAt: number; reason: string } | null;
}

export class TournamentScheduler {
  private slots = new Map<string, Slot>();
  private timer: unknown = null;
  private retryAt = new Map<string, number>();
  private stopped = false;

  constructor(
    private tournaments: TournamentManager,
    readonly entries: ScheduleEntry[],
    private file: string | null,
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { slots?: Record<string, Slot> };
        for (const e of entries) if (saved.slots?.[e.key]) this.slots.set(e.key, saved.slots[e.key]);
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
        const t = this.tournaments.create({ ...e.spec, scheduled: { startsAt: slot.startsAt, checkinMinutes: e.checkinMinutes } });
        slot.tournamentId = t.id;
        this.retryAt.delete(e.key);
        console.log(`tournament schedule: ${t.id} "${t.name}" open for sign-up, starts ${new Date(slot.startsAt).toISOString()}`);
      } catch (err) {
        // Too many tournaments open (maxActive): try again in a few minutes, until the start.
        console.error(`tournament schedule: could not open "${e.spec.name}": ${(err as Error).message}`);
        const at = Math.min(now + 5 * 60_000, slot.startsAt);
        this.retryAt.set(e.key, at);
        return at;
      }
    }
    if (now < slot.startsAt) return slot.startsAt;
    const t = this.tournaments.get(slot.tournamentId!);
    // Deleted, or called off already (expired: tournament-access.ts): nothing to start.
    if (!t || t.status !== 'registering') {
      slot.done = true;
      return this.step(e);
    }
    // Only people who checked in count; the rest are no-shows, swapped for Zergs at the start.
    const people = t.entrants.filter((x) => !x.isBot && x.checkedInAt).length;
    // Late by more than a round (the server was down at the start): call it off rather than start at a surprise time.
    const grace = (e.spec.roundMinutes ?? 30) * 60_000;
    if (now > slot.startsAt + grace) this.tournaments.cancel(t.id, CANCEL_MISSED);
    else if (people < e.minEntrants) this.tournaments.cancel(t.id, CANCEL_NOT_ENOUGH);
    else this.tournaments.startScheduled(t.id);
    console.log(`tournament schedule: ${t.id} ${t.scheduled?.cancelled ? `called off (${t.scheduled.cancelled})` : `started with ${people} checked-in entrant(s), ${t.scheduled?.noShows ?? 0} no-show(s) swapped for Zergs`}`);
    slot.done = true;
    // On to the entry's next start (strictly later, so this ends).
    return this.step(e);
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
        maxEntrants: t ? t.maxEntrants : (e.spec.maxEntrants ?? null),
        minEntrants: e.minEntrants,
      };
    }
    const playing = scheduled.filter((t) => t.status === 'running').sort((a, b) => b.scheduled!.startsAt - a.scheduled!.startsAt)[0];
    const lastStarted = Math.max(0, ...scheduled.filter((t) => t.status !== 'registering' && !t.scheduled!.cancelled).map((t) => t.scheduled!.startsAt));
    const off = scheduled.filter((t) => t.scheduled!.cancelled && t.scheduled!.startsAt > lastStarted).sort((a, b) => b.scheduled!.startsAt - a.scheduled!.startsAt)[0];
    return {
      next,
      running: playing ? { id: playing.id, name: playing.name, startsAt: playing.scheduled!.startsAt, round: playing.rounds.length } : null,
      cancelled: off ? { id: off.id, name: off.name, startsAt: off.scheduled!.startsAt, reason: off.scheduled!.cancelled! } : null,
    };
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ slots: Object.fromEntries(this.slots) }));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save the tournament schedule state:', err);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.tournaments.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
