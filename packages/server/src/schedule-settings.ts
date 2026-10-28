// The recurring tournaments' settings page (owner, 2026-10-28: "a page for applying setting to these reoccuring
// tournements, to make tweaks and everything"): the admin reads and replaces the schedule's entries over the API
// (GET/PUT/DELETE /api/admin/schedule). A saved schedule goes to RISK_DATA_DIR/tournament-schedule-entries.json, which
// wins over RISK_TOURNAMENT_SCHEDULE at the next start, and replaces the running schedule at once: an unchanged entry
// keeps its slot (same key), a changed or removed one has its open tournament called off (TournamentScheduler).
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError } from '@risk/engine';
import type { Store } from './store.js';
import type { TournamentSnapshot } from './tournaments.js';
import { nextStart, parseSchedule, SAVED_SCHEDULE_SOURCE, TournamentScheduler, type ScheduleEntry } from './tournament-schedule.js';

export interface ScheduleSettingsView {
  /** Where the running schedule came from: the settings page, an env var, or null (no schedule). */
  source: string | null;
  /** The entries as written (the editable form). */
  entries: unknown[];
  /** Each entry's next start (ms), in the same order. */
  nextStarts: number[];
  /** Whether a save survives a restart (RISK_DATA_DIR set). */
  persistent: boolean;
  /** The server's own schedule (env), which DELETE goes back to; null when it has none. */
  envSource: string | null;
}

export class ScheduleSettings {
  constructor(
    private store: Store,
    /** RISK_DATA_DIR/tournament-schedule-entries.json, or null (saves last until a restart). */
    private entriesFile: string | null,
    /** The scheduler's slot state file (RISK_DATA_DIR/tournament-schedule.json). */
    private stateFile: string | null,
    private onOpened: ((t: TournamentSnapshot, e: ScheduleEntry) => void) | null,
    /** The running schedule as written, and where it came from. */
    private raw: unknown[],
    private source: string | null,
    /** The environment's schedule, kept for DELETE. */
    private env: { raw: unknown[]; source: string } | null,
  ) {}

  view(): ScheduleSettingsView {
    const now = this.store.tournaments.clock.now();
    return {
      source: this.source,
      entries: this.raw,
      nextStarts: (this.store.schedule?.entries ?? []).map((e) => nextStart(e, now)),
      persistent: this.entriesFile !== null,
      envSource: this.env?.source ?? null,
    };
  }

  /** Check and run a new list of entries (an empty list turns the schedule off), and save it. Throws RuleError. */
  replace(raw: unknown): ScheduleSettingsView {
    if (!Array.isArray(raw)) throw new RuleError('entries must be a list of schedule entries');
    const entries = raw.length ? parseSchedule(raw, this.store.tournaments) : [];
    if (this.entriesFile) {
      mkdirSync(dirname(this.entriesFile), { recursive: true });
      const tmp = `${this.entriesFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(raw, null, 2));
      renameSync(tmp, this.entriesFile);
    }
    this.run(entries, raw, SAVED_SCHEDULE_SOURCE);
    return this.view();
  }

  /** Forget the saved schedule: back to the server's own (RISK_TOURNAMENT_SCHEDULE), or none. */
  reset(): ScheduleSettingsView {
    if (this.entriesFile && existsSync(this.entriesFile)) rmSync(this.entriesFile);
    const raw = this.env?.raw ?? [];
    this.run(raw.length ? parseSchedule(raw, this.store.tournaments) : [], raw, this.env?.source ?? null);
    return this.view();
  }

  private run(entries: ScheduleEntry[], raw: unknown[], source: string | null) {
    const old = this.store.schedule;
    if (old) {
      old.persist();
      old.stop();
    }
    this.store.schedule = entries.length ? new TournamentScheduler(this.store.tournaments, entries, this.stateFile, this.onOpened) : null;
    this.raw = raw;
    this.source = entries.length ? source : null;
    console.log(`tournament schedule: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${this.source ?? 'nowhere (off)'}`);
  }
}
