import { readFileSync } from 'node:fs';
import {
  addPlayer,
  createGame,
  createRng,
  NEUTRAL_ID,
  shuffle,
  startGame,
  stateAtStep,
  type GameRecord,
  type GameState,
  type PlayerId,
} from '@risk/engine';

/**
 * Stage-focused self-play (the Delove range specialists): games that start where only a few players remain, so
 * Mid Range (3 alive) and Close Range (the 1v1) get lessons from their own stage instead of a short tail of each game.
 *
 * Two sources of starting positions:
 * - a lead-in (`StageConfig` in game.ts): a normal game played by lead-in agents until the players alive drop to the
 *   stage's count, then the stage agents take the survivors' seats and recording starts;
 * - a positions file (`StartPosition`, one JSON per line): moments captured from game records (`positionsFromRecord`),
 *   each a full engine state with the seats renamed s0..sN-1 as self-play names them.
 */

/** One captured starting position. `state` uses self-play's ids: s0..s{seats-1} and the Neutral. */
export interface StartPosition {
  /** Where it came from, e.g. `record:<id>@<step>`. */
  source: string;
  map: string;
  /** Seats at the table (the leaderboard's table size: placement points are scored over all of them). */
  seats: number;
  /** Real players alive at this moment. */
  alive: number;
  /** Players already out, in the order they went out (seat ids, the Neutral included when it was wiped out). */
  eliminated: string[];
  state: GameState;
}

export const seatId = (i: number) => `s${i}`;

/** Real (non-neutral) players alive. */
export function aliveCount(state: GameState): number {
  return state.players.filter((p) => !p.isNeutral && p.alive).length;
}

/**
 * Who plays each surviving seat once a stage starts: the survivors in turn order from the player to move get
 * `agents[(r + rotate) % agents.length]` for r = 0, 1, ... (rotate = the game index, so every role moves round the
 * table across a run). Returns seat index -> agent index. The GPU mirror (delove_gpu/stage.py) assigns the same way.
 */
export function stageSeats(state: GameState, ids: string[], agents: number, rotate: number): Map<number, number> {
  const order = state.turnOrder;
  const start = Math.max(0, order.indexOf(state.currentPlayer ?? order[0]));
  const out = new Map<number, number>();
  let r = 0;
  for (let k = 0; k < order.length; k++) {
    const id = order[(start + k) % order.length];
    if (!state.players.find((p) => p.id === id)?.alive) continue;
    out.set(ids.indexOf(id), (r + rotate) % agents);
    r++;
  }
  return out;
}

/**
 * The state with its players renamed to self-play's seat ids (s0.. in `seatOrder`, the Neutral kept) and in
 * self-play's player order (seats, then the Neutral), so engine, logs and the GPU mirror number seats the same way.
 */
export function renameSeats(state: GameState, seatOrder: PlayerId[]): GameState {
  const ren = new Map<PlayerId, PlayerId>(seatOrder.map((id, i) => [id, seatId(i)]));
  ren.set(NEUTRAL_ID, NEUTRAL_ID);
  const r = (id: PlayerId): PlayerId => {
    const x = ren.get(id);
    if (x === undefined) throw new Error(`player ${id} is not a seat of this position`);
    return x;
  };
  const rn = (id: PlayerId | null) => (id === null ? null : r(id));
  const s = structuredClone(state);
  const seated = seatOrder.map((id) => {
    const p = s.players.find((x) => x.id === id);
    if (!p || p.isNeutral) throw new Error(`${id} is not a seat of this position`);
    return p;
  });
  const players = [...seated, ...s.players.filter((p) => p.isNeutral)].map((p) => ({
    ...p,
    id: r(p.id),
    name: r(p.id),
    ...(p.eliminatedBy !== undefined ? { eliminatedBy: r(p.eliminatedBy) } : {}),
  }));
  for (const t of Object.values(s.territories)) t.owner = rn(t.owner);
  return {
    ...s,
    players,
    turnOrder: s.turnOrder.map(r),
    currentPlayer: rn(s.currentPlayer),
    capitals: Object.fromEntries(Object.entries(s.capitals).map(([p, t]) => [r(p), t])),
    winner: rn(s.winner),
  };
}

/** Whether a fresh game with these settings and seats has a Neutral player (the GPU mirror compiles that in). */
function freshHasNeutral(state: GameState, seats: number): boolean {
  let g = createGame('probe', { ...state.options, maxPlayers: seats }, 1);
  for (let i = 0; i < seats; i++) g = addPlayer(g, seatId(i), seatId(i), true);
  return startGame(g).state.players.some((p) => p.isNeutral);
}

/**
 * Starting positions from one game record: for each count in `alive` (e.g. [3, 2]), the moment just after the
 * elimination that left that many real players, when the game goes on from there. Fog is switched off (the
 * position is played with the whole board in view, as every self-play game is). Positions the GPU mirror could not
 * play the same way are left out: a Neutral that a fresh game with these settings would not have (a surrender's).
 */
export function positionsFromRecord(record: GameRecord, alive: number[]): StartPosition[] {
  const seatsList = record.players.filter((p) => !p.isNeutral).map((p) => p.id);
  const n = seatsList.length;
  const real = new Set(seatsList);
  const outs = record.outcome.eliminations.filter((e) => e.step >= 0).sort((a, b) => a.step - b.step);
  const out: StartPosition[] = [];
  for (const k of alive) {
    if (k >= n) continue;
    const realOuts = outs.filter((e) => real.has(e.player));
    const e = realOuts[n - k - 1];
    if (!e) continue;
    const step = e.step + 1;
    if (step >= record.steps.length) continue;
    let state = stateAtStep(record, step);
    if (state.phase === 'finished' || aliveCount(state) !== k) continue;
    state = renameSeats({ ...state, options: { ...state.options, fogOfWar: false } }, seatsList);
    const hasNeutral = state.players.some((p) => p.isNeutral);
    if (hasNeutral !== freshHasNeutral(state, n)) continue;
    const ren = (id: string) => (id === NEUTRAL_ID ? id : seatId(seatsList.indexOf(id)));
    out.push({
      source: `record:${record.id}@${step}`,
      map: record.map,
      seats: n,
      alive: k,
      eliminated: outs.filter((x) => x.step < step).map((x) => ren(x.player)),
      state,
    });
  }
  return out;
}

/**
 * The position ready to play as game `seed`: its own dice from here on (rngState = seed) and the undrawn deck
 * reshuffled with mulberry32(seed ^ 0x5bd1e995), as branch-and-score reseeds a copy, so every game from one position
 * plays out differently and deterministically.
 */
export function startState(pos: StartPosition, seed: number, id: string): GameState {
  const s = structuredClone(pos.state);
  return { ...s, id, seed: seed >>> 0, rngState: seed >>> 0, deck: shuffle(createRng((seed ^ 0x5bd1e995) >>> 0), s.deck) };
}

/** A positions file (one StartPosition per line), optionally only those with `alive` players left. */
export function readPositions(file: string, alive?: number): StartPosition[] {
  const all = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StartPosition);
  return alive === undefined ? all : all.filter((p) => p.alive === alive);
}
