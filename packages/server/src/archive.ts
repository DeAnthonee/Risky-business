import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assembleRecord,
  recordHeader,
  recordStep,
  recordTurnStart,
  type Action,
  type GameEvent,
  type GameRecord,
  type GameState,
  type PlayerId,
  type RecordEntry,
  type RecordHeader,
  type ScenarioRef,
} from '@risk/engine';

/** One committed change to a room, as the archive needs it. */
export interface CommitInfo {
  before: GameState;
  next: GameState;
  events: GameEvent[];
  playerId: PlayerId | null;
  action: Action | { type: 'start' } | { type: 'system'; note: string };
  at: number;
  /** The turn timer ran out and the server made this move for the player. */
  timeout?: true;
  /** The acting seat's private decision note for this move, if it sent one. */
  note?: unknown;
}

/** What the archive needs to know about the room a game is played in. */
export interface ArchivedRoom {
  id: string;
  name: string;
  tournamentId?: string;
  characterIds: Record<string, string>;
  /** Player-type labels by seat; written into the record only when it is filed, after the game. */
  agents: Record<string, string>;
  state: GameState;
  /** The record this room's game is being written to, if any. */
  recordId?: string;
  /** A scenario: the recorded moment the game began from. */
  scenarioOf?: ScenarioRef;
  /** "training": a yardstick game, kept apart from public games (and from Delove's training pool). */
  board?: 'training';
}

/** One line of index.jsonl: a game at a glance, without opening its record. */
export interface ArchiveIndexEntry {
  id: string;
  /** Path of the record, relative to the archive folder. */
  file: string;
  room: string;
  name: string;
  map: string;
  fog: boolean;
  tournamentId?: string;
  scenarioOf?: ScenarioRef;
  /** "training": a yardstick game ranked on the training leaderboard. */
  board?: 'training';
  startedAt: number;
  endedAt: number;
  finished: boolean;
  endedBecause?: string;
  winner: { id: string; name: string } | null;
  reason: 'domination' | 'capitals' | null;
  turns: number;
  steps: number;
  players: { id: string; name: string; isBot: boolean; characterId: string | null; place: number | null; agent?: string }[];
}

/** Records kept by default: roughly 0.3-1.6 GB at 0.3-1.6 MB a game. */
export const DEFAULT_KEEP = 1000;

const RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** What an index line may name as its record: pruning deletes only files that match. */
const RECORD_FILE = /^games\/\d{4}-\d{2}\/[A-Za-z0-9_-]{1,80}\.json$/;

/**
 * Game records under <RISK_DATA_DIR>/archive: every game that starts is journalled move by move to
 * live/<id>.jsonl (append-only, so it survives restarts), and when it ends (won, or its room closed) the
 * journal becomes games/<yyyy-mm>/<id>.json, a GameRecord, plus a line in index.jsonl.
 * Only the newest `keep` records stay (RISK_ARCHIVE_KEEP, default 1000; 0 keeps them all): filing one more deletes
 * the oldest record and its index line.
 * Recording must never break a game: every failure is logged and the game goes on.
 */
export class GameArchive {
  constructor(
    private dir: string | null,
    /** How many finished records to keep, newest first (0 = all). */
    public keep = DEFAULT_KEEP,
  ) {}

  get enabled(): boolean {
    return this.dir !== null;
  }

  describe(): string {
    return this.dir ?? 'disabled';
  }

  private journal(id: string): string {
    return join(this.dir!, 'live', `${id}.jsonl`);
  }

  /** Follow one committed change: start a record, add a step, or finish the record once the game is won. */
  onCommit(room: ArchivedRoom, c: CommitInfo) {
    if (!this.dir) return;
    try {
      if (c.action.type === 'start') return this.begin(room, c.next, c.events, c.at);
      // A system commit can end the game too (owner rule A: only Zergs are left, store.ts endIfOnlySwarm). It adds no
      // step (the board is as it stood), but the record still has to be finished.
      if (room.recordId && c.next.phase === 'finished' && (c.action.type === 'system' || !c.playerId)) return this.finish(room);
      if (!room.recordId || c.action.type === 'system' || !c.playerId) return;
      const file = this.journal(room.recordId);
      // A game that started before recording existed (or whose journal is gone) is not recorded.
      if (!existsSync(file)) {
        room.recordId = undefined;
        return;
      }
      const header = this.header(room.recordId);
      const entries: RecordEntry[] = [recordStep(header, c.before, c.playerId, c.action, c.events, c.at, {
        ...(c.note === undefined ? {} : { note: c.note }),
        ...(c.timeout ? { timeout: true } : {}),
      })];
      const turn = recordTurnStart(header, c.next, c.events, c.at);
      if (turn) entries.push(turn);
      appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
      if (c.next.phase === 'finished') this.finish(room);
    } catch (err) {
      console.error(`[archive] ${room.id}: could not record a move:`, err);
    }
  }

  private headers = new Map<string, RecordHeader>();

  private header(id: string): RecordHeader {
    let h = this.headers.get(id);
    if (!h) {
      const first = readFileSync(this.journal(id), 'utf8').split('\n', 1)[0];
      h = (JSON.parse(first) as { kind: 'header'; header: RecordHeader }).header;
      this.headers.set(id, h);
    }
    return h;
  }

  /** Start the record of a game that has just begun in `state` (a started game, or a scenario's first state). */
  begin(room: ArchivedRoom, state: GameState, events: GameEvent[], at: number) {
    if (!this.dir) return;
    const id = `${room.id}-${(state.startedAt ?? at).toString(36)}`;
    const header = recordHeader(id, { id: room.id, name: room.name, ...(room.tournamentId ? { tournamentId: room.tournamentId } : {}), ...(room.board ? { board: room.board } : {}) }, state, events, room.characterIds, room.scenarioOf);
    mkdirSync(join(this.dir, 'live'), { recursive: true });
    const lines = [JSON.stringify({ kind: 'header', header })];
    const turn = recordTurnStart(header, state, events, at);
    if (turn) lines.push(JSON.stringify(turn));
    writeFileSync(this.journal(id), lines.join('\n') + '\n');
    this.headers.set(id, header);
    room.recordId = id;
  }

  /** Turn a room's journal into its finished record. endedBecause: why it stopped, when nobody won. */
  finish(room: ArchivedRoom, endedBecause?: string) {
    const id = room.recordId;
    if (!this.dir || !id) return;
    room.recordId = undefined;
    try {
      const file = this.journal(id);
      if (!existsSync(file)) return;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const header = (JSON.parse(lines[0]) as { header: RecordHeader }).header;
      // A room moved to the training board after its game began.
      if (room.board) header.room = { ...header.room, board: room.board };
      // The game is over, so the seats' player types can go public with the record.
      if (Object.keys(room.agents).length) header.room = { ...header.room, agents: { ...room.agents } };
      const entries = lines.slice(1).map((l) => JSON.parse(l) as RecordEntry);
      const record = assembleRecord(header, entries, room.state, Date.now(), endedBecause);
      const month = new Date(record.startedAt).toISOString().slice(0, 7);
      const rel = `games/${month}/${id}.json`;
      mkdirSync(join(this.dir, 'games', month), { recursive: true });
      const out = join(this.dir, rel);
      writeFileSync(out + '.tmp', JSON.stringify(record));
      renameSync(out + '.tmp', out);
      appendFileSync(join(this.dir, 'index.jsonl'), JSON.stringify(indexEntry(record, rel)) + '\n');
      unlinkSync(file);
      this.headers.delete(id);
    } catch (err) {
      console.error(`[archive] ${room.id}: could not save the record of ${id}:`, err);
    }
    this.prune();
  }

  /** Delete the oldest records beyond `keep`, their index lines and any month folder left empty. Returns how many went. */
  prune(): number {
    if (!this.dir || this.keep <= 0) return 0;
    const index = join(this.dir, 'index.jsonl');
    try {
      if (!existsSync(index)) return 0;
      const lines = readFileSync(index, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.keep) return 0;
      const drop = lines.slice(0, lines.length - this.keep);
      const kept = lines.slice(drop.length);
      const fileOf = (line: string): string | null => {
        try {
          const file = (JSON.parse(line) as ArchiveIndexEntry).file;
          return RECORD_FILE.test(file) ? file : null;
        } catch {
          return null; // a torn line names no file
        }
      };
      const keptFiles = new Set(kept.map(fileOf));
      // Rewrite the index first: a crash after it leaves stray files, never index lines pointing at nothing.
      writeFileSync(index + '.tmp', kept.join('\n') + '\n');
      renameSync(index + '.tmp', index);
      for (const rel of drop.map(fileOf)) {
        if (!rel || keptFiles.has(rel)) continue;
        const f = join(this.dir, rel);
        if (existsSync(f)) unlinkSync(f);
        const month = dirname(f);
        if (existsSync(month) && readdirSync(month).length === 0) rmdirSync(month);
      }
      return drop.length;
    } catch (err) {
      console.error('[archive] could not prune old records:', err);
      return 0;
    }
  }

  /**
   * Mark every finished record of a room as on `board` (its record file and its index line), for a game moved to the
   * training board after it was recorded. Returns how many records changed.
   */
  setBoard(roomId: string, board: 'training'): number {
    if (!this.dir) return 0;
    const index = join(this.dir, 'index.jsonl');
    if (!existsSync(index)) return 0;
    let changed = 0;
    try {
      const lines = readFileSync(index, 'utf8').split('\n').filter(Boolean);
      const out = lines.map((line) => {
        let entry: ArchiveIndexEntry;
        try {
          entry = JSON.parse(line);
        } catch {
          return line; // a torn line is left as it is
        }
        if (entry.room !== roomId || entry.board === board || !RECORD_FILE.test(entry.file)) return line;
        const file = join(this.dir!, entry.file);
        if (existsSync(file)) {
          const record = JSON.parse(readFileSync(file, 'utf8')) as GameRecord;
          record.room = { ...record.room, board };
          writeFileSync(file + '.tmp', JSON.stringify(record));
          renameSync(file + '.tmp', file);
        }
        changed++;
        return JSON.stringify({ ...entry, board });
      });
      if (changed) {
        writeFileSync(index + '.tmp', out.join('\n') + '\n');
        renameSync(index + '.tmp', index);
      }
    } catch (err) {
      console.error(`[archive] could not mark the records of ${roomId} as ${board}:`, err);
    }
    return changed;
  }

  /** Recorded games, newest first. */
  list(limit = 100): ArchiveIndexEntry[] {
    if (!this.dir) return [];
    const file = join(this.dir, 'index.jsonl');
    if (!existsSync(file)) return [];
    const out: ArchiveIndexEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean).reverse()) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line (crash mid-write) is skipped, not fatal.
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The record an index entry points to (no index scan), or null when its file is gone. */
  read(entry: ArchiveIndexEntry): GameRecord | null {
    if (!this.dir) return null;
    const file = join(this.dir, entry.file);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GameRecord) : null;
  }

  /** One finished record, by id, or null. */
  get(id: string): GameRecord | null {
    if (!this.dir || !RECORD_ID.test(id)) return null;
    const entry = this.list(Infinity).find((e) => e.id === id);
    if (!entry) return null;
    const file = join(this.dir, entry.file);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GameRecord) : null;
  }
}

function indexEntry(r: GameRecord, file: string): ArchiveIndexEntry {
  const place = new Map(r.outcome.placings.map((id, i) => [id, i + 1]));
  const winner = r.players.find((p) => p.id === r.outcome.winner);
  return {
    id: r.id,
    file,
    room: r.room.id,
    name: r.room.name,
    map: r.map,
    fog: r.fog,
    ...(r.room.tournamentId ? { tournamentId: r.room.tournamentId } : {}),
    ...(r.room.board ? { board: r.room.board } : {}),
    ...(r.scenarioOf ? { scenarioOf: r.scenarioOf } : {}),
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    finished: r.outcome.finished,
    ...(r.outcome.endedBecause ? { endedBecause: r.outcome.endedBecause } : {}),
    winner: winner ? { id: winner.id, name: winner.name } : null,
    reason: r.outcome.reason,
    turns: r.turns.length,
    steps: r.steps.length,
    players: r.players
      .filter((p) => !p.isNeutral)
      .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, characterId: p.characterId, place: place.get(p.id) ?? null, ...(r.room.agents?.[p.id] ? { agent: r.room.agents[p.id] } : {}) })),
  };
}
