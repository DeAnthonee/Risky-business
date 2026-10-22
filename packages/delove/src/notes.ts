import { closeSync, existsSync, openSync, readSync, rmSync, statSync, truncateSync } from 'node:fs';
import { getMap, type GameView } from '@risk/engine';
import type { Agent, Candidate } from '@risk/selfplay';
import { decisionScore } from './branch.js';
import { searchOf } from './branch-env.js';
import { scorerOf } from './net-agent.js';

/**
 * Decision notes: with each move, the seat player sends what Delove saw in it (`act`'s private note, stored on the
 * game record's step, never shown during the game; docs/game-records.md). Only what the move already computed is
 * reported, no extra inference:
 *
 * - every seat: `agent` (its label), `model` (the network, null for a teacher), `preset` (the search preset, null
 *   when bare), `phase`, `alive` (players alive), `fog`, and `fb` when a search seat played its ranker's move because
 *   of fog (fogSafe);
 * - a search seat that compared options: `top`, up to 5 of them as `{m: move, s: branch score, r: rollouts}` in the
 *   order they were tried (the teacher's move first), `chosen` (index in `top` of the move played) and `margin`;
 *   a search seat that played its teacher's move without comparing: `br: 0`;
 * - a network seat: `top`, its 3 favourite moves as `{m, p: probability}`, and `value` (its win chance for this seat);
 *   a search seat with a ranker gives `value` too (the ranker's, from ranking the options).
 *
 * Numbers have 3 decimals; a note stays under MAX_NOTE_BYTES (the server's limit is 2 KB) by dropping candidates and
 * then everything but the header; building one never fails a move (on any error the move goes without a note).
 */
export const MAX_NOTE_BYTES = 2000;

export interface SeatInfo {
  label: string;
  model: string | null;
  preset: string | null;
}

export type DecisionNote = Record<string, unknown>;

const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/** A candidate as a few words: `att alaska>kamchatka`, `pl ontario 3`, `occ 5`, `ff a`, `ft b 4`, `trade`, `end`. */
export function shortMove(c: Candidate, territoryIds: readonly string[]): string {
  const t = (i: number) => (i >= 0 ? territoryIds[i] : '?');
  switch (c[0]) {
    case 'place':
      return `pl ${t(c[1])} ${c[2]}`;
    case 'attack':
      return `att ${t(c[1])}>${t(c[2])}`;
    case 'occupy':
      return `occ ${c[1]}`;
    case 'fortify':
      return `fort ${t(c[1])}>${t(c[2])} ${c[3]}`;
    case 'fortify_from':
      return `ff ${t(c[1])}`;
    case 'fortify_to':
      return `ft ${t(c[1])} ${c[2]}`;
    case 'capital':
      return `cap ${t(c[1])}`;
    case 'trade':
      return 'trade';
    case 'end_turn':
      return 'end';
    default:
      return String(c[0]);
  }
}

/** A note within `max` bytes: candidates dropped from the end first, then everything but the header. */
export function capNote(note: DecisionNote, max = MAX_NOTE_BYTES): DecisionNote {
  const size = (n: DecisionNote) => Buffer.byteLength(JSON.stringify(n), 'utf8');
  if (size(note) <= max) return note;
  const n: DecisionNote = { ...note };
  if (Array.isArray(n.top)) {
    const top = [...(n.top as unknown[])];
    while (top.length && size({ ...n, top }) > max) top.pop();
    n.top = top;
    if (typeof n.chosen === 'number' && n.chosen >= top.length) delete n.chosen;
    n.cut = 1;
  }
  if (size(n) <= max) return n;
  const head: DecisionNote = { agent: String(n.agent).slice(0, 60), cut: 1 };
  return head;
}

/**
 * Reads the search's trace lines (branch.ts DELOVE_BRANCH_TRACE) written since the last call. One process decides for
 * its seats one at a time and synchronously (seat.ts: begin, the search, note, with no await in between), so the lines
 * read after a move are that move's own; they are also matched to the game and seat. Our own file is emptied after
 * every read (it never holds more than one move's lines) and deleted when the process exits.
 */
class TraceReader {
  private offset = 0;
  constructor(
    readonly path: string,
    /** Our own file: emptied when it grows, so a long tournament never piles it up. */
    readonly owned: boolean,
  ) {
    this.offset = existsSync(path) ? statSync(path).size : 0;
    if (owned) process.once('exit', () => rmSync(path, { force: true }));
  }

  /** The new lines (parsed), moving past them. */
  read(): Record<string, unknown>[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    if (this.owned) {
      truncateSync(this.path, 0); // branch.ts appends, so the next move's line starts the file again
      this.offset = 0;
    }
    return buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }
}

/** Builds each move's note for the seats of one process (seat.ts playSeat calls begin before a move, note after). */
export class Noter {
  private readonly trace: TraceReader | null;

  constructor(
    private readonly seats: Map<Agent, SeatInfo>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.trace = env.DELOVE_BRANCH_TRACE ? new TraceReader(env.DELOVE_BRANCH_TRACE, !!env.DELOVE_NOTES_TRACE_OWNED) : null;
  }

  /** Before a move: forget the last move's scores and trace lines. */
  begin(agent: Agent): void {
    const s = scorerOf(agent);
    if (s) s.first = null;
    this.trace?.read();
  }

  /** After a move by seat number `seat` (seating order): its note, or undefined on any error (a note never costs a move). */
  note(agent: Agent, view: GameView, seat: number): DecisionNote | undefined {
    try {
      return capNote(this.build(agent, view, seat));
    } catch {
      return undefined;
    }
  }

  private build(agent: Agent, view: GameView, seat: number): DecisionNote {
    const info = this.seats.get(agent) ?? { label: agent.id, model: null, preset: null };
    const alive = view.players.filter((p) => p.alive && !p.isNeutral).length;
    const fog = !!view.options.fogOfWar;
    const search = searchOf(agent);
    const note: DecisionNote = { agent: info.label, model: info.model, preset: info.preset, phase: view.phase, alive, fog };
    const territoryIds = getMap(view.options.map).territoryIds;
    const scored = scorerOf(agent)?.first ?? null;
    // this decision's trace line: branch.ts writes one when it compared options (read even when unused, to move past it)
    const line = this.trace?.read().filter((l) => l.game === view.id && l.seat === seat).pop();
    if (search && fog) note.fb = 1; // fogSafe: the ranker's move, no search
    if (search && !fog) {
      if (line && scored) {
        const options = line.options as number[];
        const means = line.means as number[];
        const rollouts = decisionScore(search, alive).rollouts;
        note.top = options.slice(0, 5).map((ci, k) => ({ m: shortMove(scored.candidates[ci], territoryIds), s: r3(means[k]), r: rollouts }));
        note.chosen = line.best;
        note.margin = r3(search.margin);
      } else note.br = 0; // the teacher's move, nothing compared
    } else if (scored) {
      const { logits, candidates } = scored;
      const mx = Math.max(...logits);
      const e = Array.from(logits, (l) => Math.exp(l - mx));
      const z = e.reduce((a, b) => a + b, 0);
      const idx = [...e.keys()].sort((a, b) => e[b] - e[a]).slice(0, 3);
      note.top = idx.map((i) => ({ m: shortMove(candidates[i], territoryIds), p: r3(e[i] / z) }));
    }
    if (scored) note.value = r3(scored.value);
    return note;
  }
}
