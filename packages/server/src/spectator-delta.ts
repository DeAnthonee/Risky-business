import { redactEvents } from '@risk/engine';
import type { ChangeMessage, GameRoom } from './store.js';

/**
 * Compact spectator frames (a socket that subscribes with `frames: 'delta'`). At a 100-seat Mega Earth table every
 * spectator `state` frame is the whole board (~70 KB) and the table can make 30 moves a second, ~2 MB/s per spectator.
 * A `state_delta` frame carries only what changed in the spectator view since the room's previous frame: top-level keys
 * whose value changed, the territories and players that changed, and the move's events. Every KEYFRAME_EVERY frames it
 * carries the whole view instead. Old clients never ask for deltas, so they keep getting full `state` frames.
 *
 * Every delta socket of a room gets the same chain of frames (`frame`, `base` = the frame it applies on), built and
 * stringified once per (room, commit). A client whose last frame is not `base` resubscribes for a full state.
 */
export const KEYFRAME_EVERY = 100;

/** The spectator view as JSON pieces: each top-level key, each territory and each player stringified on its own. */
interface Pieces {
  keys: string[];
  top: Map<string, string>;
  territories: Map<string, string>;
  players: string[];
}

interface Chain {
  /** The state the pieces were built from, and the change that built them (null: a subscribe built them). */
  state: GameRoom['state'];
  change: ChangeMessage | null;
  frame: number;
  pieces: Pieces;
  json: string;
}

const chains = new WeakMap<GameRoom, Chain>();

function piecesOf(view: object): Pieces {
  const top = new Map<string, string>();
  const territories = new Map<string, string>();
  let players: string[] = [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(view)) {
    if (v === undefined) continue;
    keys.push(k);
    if (k === 'territories') for (const [id, t] of Object.entries(v as Record<string, unknown>)) territories.set(id, JSON.stringify(t));
    else if (k === 'players') players = (v as unknown[]).map((p) => JSON.stringify(p));
    else top.set(k, JSON.stringify(v));
  }
  return { keys, top, territories, players };
}

const obj = (entries: [string, string][]) => `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
const territoriesJson = (p: Pieces) => obj([...p.territories]);
const playersJson = (p: Pieces) => `[${p.players.join(',')}]`;

/** The whole view as JSON, from its pieces. */
export function assemble(p: Pieces): string {
  return obj(p.keys.map((k) => [k, k === 'territories' ? territoriesJson(p) : k === 'players' ? playersJson(p) : p.top.get(k)!]));
}

/** `{set?, drop?, territories?, players?}`: what turns `a` into `b` (players by index; a changed seat count resends them all). */
function patch(a: Pieces, b: Pieces): string {
  const set: [string, string][] = [];
  const parts: string[] = [];
  for (const k of b.keys) {
    if (k === 'territories') {
      const changed = [...b.territories].filter(([id, t]) => a.territories.get(id) !== t);
      if (!a.keys.includes(k) || [...a.territories.keys()].some((id) => !b.territories.has(id))) set.push([k, territoriesJson(b)]);
      else if (changed.length) parts.push(`"territories":${obj(changed)}`);
    } else if (k === 'players') {
      if (!a.keys.includes(k) || a.players.length !== b.players.length) set.push([k, playersJson(b)]);
      else {
        const changed = b.players.flatMap((p, i): [string, string][] => (a.players[i] === p ? [] : [[String(i), p]]));
        if (changed.length) parts.push(`"players":${obj(changed)}`);
      }
    } else if (a.top.get(k) !== b.top.get(k)) set.push([k, b.top.get(k)!]);
  }
  const drop = a.keys.filter((k) => !b.keys.includes(k));
  if (set.length) parts.unshift(`"set":${obj(set)}`);
  if (drop.length) parts.push(`"drop":${JSON.stringify(drop)}`);
  return `{${parts.join(',')}}`;
}

/** The `state_delta` frame of this change for every delta-spectator socket of the room. */
export function spectatorDelta(room: GameRoom, m: ChangeMessage, commit: string): string {
  const prev = chains.get(room);
  if (prev && prev.change === m) return prev.json;
  const pieces = piecesOf(room.spectatorView());
  const frame = (prev?.frame ?? 0) + 1;
  const body = !prev || frame % KEYFRAME_EVERY === 0 ? `"state":${assemble(pieces)}` : `"patch":${patch(prev.pieces, pieces)}`;
  const rest = JSON.stringify({ events: redactEvents(m.state, null, m.events), version: m.version, host: room.hostId, name: room.name, you: null, commit });
  const json = `{"type":"state_delta","frame":${frame},"base":${prev ? prev.frame : null},${body},${rest.slice(1)}`;
  chains.set(room, { state: room.state, change: m, frame, pieces, json });
  return json;
}

/**
 * A delta socket's first frame: the whole view as JSON and the chain position it stands at. It reuses the chain's
 * pieces when they show the current state; otherwise (no delta socket watched the last moves) it starts a new link,
 * and any socket still on the old one resyncs at the next delta.
 */
export function spectatorKeyframe(room: GameRoom): { frame: number; state: string } {
  const prev = chains.get(room);
  if (prev && prev.state === room.state) return { frame: prev.frame, state: assemble(prev.pieces) };
  const pieces = piecesOf(room.spectatorView());
  const frame = (prev?.frame ?? 0) + 1;
  chains.set(room, { state: room.state, change: null, frame, pieces, json: '' });
  return { frame, state: assemble(pieces) };
}
