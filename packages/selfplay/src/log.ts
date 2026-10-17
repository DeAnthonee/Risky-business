import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createGzip, type Gzip } from 'node:zlib';
import { getMap, MAP_IDS, NEUTRAL_ID, type CardKind, type GameState, type Phase } from '@risk/engine';
import { territoryIndex, type Candidate } from './actions.js';
import { TRAIT_KEYS } from './traits.js';

/**
 * Decision log format, version 1. One JSON object per line (JSONL, gzip by default), one line per decision.
 * A Python trainer reads it with `gzip.open(path, 'rt')` + `json.loads` per line; `meta.json` next to the shards
 * describes the maps (territory order, adjacency, continents) and the order of every enum and vector below.
 *
 * Seats: players are numbered 0..N-1 in the order they were seated (not turn order). Territory owner codes:
 * seat index, OWNER_NONE (unowned or blizzard) or OWNER_NEUTRAL.
 */
export const LOG_VERSION = 1;
export const OWNER_NONE = -1;
export const OWNER_NEUTRAL = -2;
export const PHASES: Phase[] = ['lobby', 'setup', 'capitals', 'reinforce', 'attack', 'fortify', 'finished'];
export const CARD_KINDS: CardKind[] = ['infantry', 'cavalry', 'artillery', 'wild'];

export interface EncodedState {
  /** Owner code per territory, in the map's territory order. */
  owner: number[];
  armies: number[];
  /** Per seat: [alive 0/1, cards held, armies to place]. */
  seats: [number, number, number][];
  /** The deciding player's cards: [card id, kind index, territory index or -1 for wild]. */
  hand: [number, number, number][];
  tradeCount: number;
  /** [from, to, min, max] while an occupy decision is pending. */
  pending: [number, number, number, number] | null;
  /** Capital territory per seat (-1 = none). */
  capitals: number[];
  blizzards: number[];
  /** The deciding player has conquered this turn (earns a card) / has fortified this turn. */
  conquered: boolean;
  fortified: boolean;
}

export interface DecisionRecord {
  v: typeof LOG_VERSION;
  game: string;
  seed: number;
  map: string;
  players: number;
  /** Decision number within the game (0-based). */
  i: number;
  turn: number;
  round: number;
  phase: number;
  seat: number;
  agent: string;
  /** In TRAIT_KEYS order. */
  traits: number[];
  state: EncodedState;
  cands: Candidate[];
  /** Index into cands; -1 when the agent played an action outside the discrete space (then see `action`). */
  choice: number;
  action?: unknown;
  /** Filled in when the game ends. */
  outcome: Outcome;
}

export interface Outcome {
  /** Winning seat, or null when the game hit the turn limit. */
  winner: number | null;
  /** Result for the deciding seat: 1 win, 0 loss; at the turn limit survivors share 1 equally, the eliminated get 0. */
  z: number;
  turns: number;
  reason: 'domination' | 'capitals' | 'turn_limit';
}

export function seatOf(seats: string[], id: string | null): number {
  if (id === null) return OWNER_NONE;
  if (id === NEUTRAL_ID) return OWNER_NEUTRAL;
  return seats.indexOf(id);
}

export function encodeState(state: GameState, seats: string[], me: string): EncodedState {
  const map = getMap(state.options.map);
  const idx = territoryIndex(map);
  const ti = (t: string) => idx.get(t)!;
  const player = state.players.find((p) => p.id === me)!;
  const pc = state.pendingConquest;
  return {
    owner: map.territoryIds.map((t) => seatOf(seats, state.territories[t].owner)),
    armies: map.territoryIds.map((t) => state.territories[t].armies),
    seats: seats.map((id) => {
      const p = state.players.find((x) => x.id === id)!;
      return [p.alive ? 1 : 0, p.cards.length, p.armiesToPlace];
    }),
    hand: player.cards.map((c) => [c.id, CARD_KINDS.indexOf(c.kind), c.territory === null ? -1 : ti(c.territory)]),
    tradeCount: state.tradeCount,
    pending: pc ? [ti(pc.from), ti(pc.to), pc.minArmies, pc.maxArmies] : null,
    capitals: seats.map((id) => (state.capitals[id] ? ti(state.capitals[id]) : -1)),
    blizzards: state.blizzards.map(ti),
    conquered: player.conqueredThisTurn,
    fortified: state.fortifiedThisTurn,
  };
}

/** Static description of the log format and every map, written once per log directory as meta.json. */
export function logMeta() {
  return {
    v: LOG_VERSION,
    traitKeys: TRAIT_KEYS,
    phases: PHASES,
    cardKinds: CARD_KINDS,
    ownerCodes: { none: OWNER_NONE, neutral: OWNER_NEUTRAL, seat: '0..N-1 in seating order' },
    candidateKinds: ['place', 'trade', 'capital', 'attack', 'occupy', 'fortify', 'end_turn'],
    maps: Object.fromEntries(
      MAP_IDS.map((id) => {
        const map = getMap(id);
        const idx = territoryIndex(map);
        return [
          id,
          {
            territoryIds: map.territoryIds,
            adjacency: map.territoryIds.map((t) => map.adjacency[t].map((n) => idx.get(n)!)),
            continents: map.continents.map((c) => ({ id: c.id, bonus: c.bonus, territories: c.territories.map((t) => idx.get(t)!) })),
          },
        ];
      }),
    ),
  };
}

export function writeLogMeta(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(logMeta(), null, 1) + '\n');
}

/** Appends JSON lines to a file, gzipped unless the name does not end in .gz. */
export class JsonlWriter {
  private file: WriteStream;
  private gzip: Gzip | null;

  constructor(path: string) {
    this.file = createWriteStream(path);
    this.gzip = path.endsWith('.gz') ? createGzip() : null;
    if (this.gzip) this.gzip.pipe(this.file);
  }

  /** Write many records as one chunk; resolves once the stream can take more. */
  async write(records: unknown[]): Promise<void> {
    if (records.length === 0) return;
    const chunk = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const target = this.gzip ?? this.file;
    if (!target.write(chunk)) await new Promise<void>((resolve) => target.once('drain', () => resolve()));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.file.once('finish', () => resolve());
      this.file.once('error', reject);
      if (this.gzip) this.gzip.end();
      else this.file.end();
    });
  }
}
