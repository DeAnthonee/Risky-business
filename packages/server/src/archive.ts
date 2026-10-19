import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
}

/** What the archive needs to know about the room a game is played in. */
export interface ArchivedRoom {
  id: string;
  name: string;
  tournamentId?: string;
  characterIds: Record<string, string>;
  state: GameState;
  /** The record this room's game is being written to, if any. */
  recordId?: string;
  /** A scenario: the recorded moment the game began from. */
  scenarioOf?: ScenarioRef;
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
  startedAt: number;
  endedAt: number;
  finished: boolean;
  endedBecause?: string;
  winner: { id: string; name: string } | null;
  reason: 'domination' | 'capitals' | null;
  turns: number;
  steps: number;
  players: { id: string; name: string; isBot: boolean; characterId: string | null; place: number | null }[];
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Game records under <RISK_DATA_DIR>/archive: every game that starts is journalled move by move to
 * live/<id>.jsonl (append-only, so it survives restarts), and when it ends (won, or its room closed) the
 * journal becomes games/<yyyy-mm>/<id>.json, a GameRecord, plus a line in index.jsonl.
 * Recording must never break a game: every failure is logged and the game goes on.
 */
export class GameArchive {
  constructor(private dir: string | null) {}

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
      if (!room.recordId || c.action.type === 'system' || !c.playerId) return;
      const file = this.journal(room.recordId);
      // A game that started before recording existed (or whose journal is gone) is not recorded.
      if (!existsSync(file)) {
        room.recordId = undefined;
        return;
      }
      const header = this.header(room.recordId);
      const entries: RecordEntry[] = [recordStep(header, c.before, c.playerId, c.action, c.events, c.at)];
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
    const header = recordHeader(id, { id: room.id, name: room.name, ...(room.tournamentId ? { tournamentId: room.tournamentId } : {}) }, state, events, room.characterIds, room.scenarioOf);
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
      .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, characterId: p.characterId, place: place.get(p.id) ?? null })),
  };
}
