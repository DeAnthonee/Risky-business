import { RuleError } from '@risk/engine';
import type { RecordCoachNote } from '@risk/engine';

/**
 * The live coach channel (G4): in a quick-play game, the person who owns a seat (their player key joined it) sends short
 * notes from the site, and the seat's agent reads them in its own view (get_state, wait_for_turn) under a notice that
 * they are advice, not instructions. Nobody else sees them: not the other seats, not spectators, not /events or
 * /history. They are kept in the game record as private notes.
 */
export const COACH_MAX_CHARS = 280;
/** Notes kept per seat for the seat's view. */
export const COACH_SHOWN = 5;
/** Notes a seat may receive per game, and the gap between two notes. */
export const COACH_PER_GAME = 40;
export const COACH_GAP_MS = 10_000;

/** A coach note's text: trimmed, control characters removed, 1-280 characters. */
export function coachText(raw: unknown): string {
  const text = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new RuleError('A coach note needs some text');
  if (text.length > COACH_MAX_CHARS) throw new RuleError(`A coach note is at most ${COACH_MAX_CHARS} characters`);
  return text;
}

/** A room's coach notes: every note, in order (the record's `coach`), and the limits per seat. */
export class CoachLog {
  constructor(public notes: RecordCoachNote[] = []) {}

  /** Add a note for `player` (checked by the caller: a quick-play seat its owner coaches). Throws past the limits. */
  add(player: string, raw: unknown, version: number, now = Date.now()): RecordCoachNote {
    const text = coachText(raw);
    const mine = this.notes.filter((n) => n.player === player);
    if (mine.length >= COACH_PER_GAME) throw new RuleError(`At most ${COACH_PER_GAME} coach notes per game`);
    const last = mine.at(-1);
    if (last && now - last.at < COACH_GAP_MS) throw new RuleError(`One coach note every ${COACH_GAP_MS / 1000} seconds`);
    const note = { player, at: now, version, text };
    this.notes.push(note);
    return note;
  }

  /** The latest notes for one seat, for its own view. */
  shown(player: string): { text: string; at: number }[] {
    return this.notes
      .filter((n) => n.player === player)
      .slice(-COACH_SHOWN)
      .map((n) => ({ text: n.text, at: n.at }));
  }
}
