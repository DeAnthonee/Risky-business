import { existsSync, readFileSync } from 'node:fs';
import { getMap, type GameState, type PlayerId, type TerritoryId } from '@risk/engine';
import { encodeDecision, fogInputs, makeTraits, seatInput, type Candidate } from '@risk/selfplay';
import type { SeatMemory } from './fog-sampler.js';
import { NetScorer, seatOrder } from './net-agent.js';

/** The fog guess layout this player reads (fog_guess.py FOG_GUESS_VERSION). */
export const FOG_GUESS_VERSION = 2;
const MAX_SLOTS = 10;
const END_ONLY: Candidate[] = [['end_turn']];

/** One hidden territory's guess: who may own it (player ids) with their probabilities, and the army bins' chances. */
export interface TerritoryGuess {
  owners: PlayerId[];
  p: number[];
  bins: number[];
}

/** A whole view's guess: each hidden territory's, and the army bins ([lo, hi] inclusive). */
export interface FogGuess {
  territories: Map<TerritoryId, TerritoryGuess>;
  armyBins: [number, number][];
}

/**
 * The learned fog guesser (packages/delove/python/fog_guess.py, docs/delove-fog.md section 4.5): one ONNX call on a
 * seat's view gives, for every hidden territory, a distribution over its owner (the opponents still alive and the
 * Neutral) and over its armies in bins. The fog sampler (fog-sampler.ts) draws from it instead of its hand-written
 * guesses. The view is encoded exactly as the networks see it (seatInput, then fog.ts's seat view with the fog columns).
 */
export class FogGuesser {
  private readonly net: NetScorer;
  private readonly armyBins: [number, number][];
  private readonly owners: number;
  /** Memory columns per territory (fog_guess.py MEMORY; 0: a guesser of the current view only). */
  private readonly memory: number;

  constructor(readonly path: string) {
    const json = path.replace(/\.onnx$/, '.json');
    if (!existsSync(path) || !existsSync(json)) throw new Error(`fog guesser ${path}: .onnx and .json needed`);
    const info = JSON.parse(readFileSync(json, 'utf8'));
    if (info.fogGuessVersion > FOG_GUESS_VERSION) throw new Error(`fog guesser ${path}: v${info.fogGuessVersion}, this player reads up to v${FOG_GUESS_VERSION}`);
    this.armyBins = info.armyBins;
    this.owners = info.owners;
    this.memory = info.memory ?? 0;
    this.net = new NetScorer(path);
  }

  /**
   * The guess for `me`'s view `state` (a state rebuilt by stateFromView; its hidden territories are marked), with what
   * the seat saw before (`memory`, FogTracker) when the guesser reads it.
   */
  guess(state: GameState, me: PlayerId, memory?: SeatMemory): FogGuess {
    const map = getMap(state.options.map);
    const T = map.territoryIds.length;
    const seatIds = seatOrder(state);
    const input = seatInput(state, seatIds, me, makeTraits(), END_ONLY);
    const x = fogInputs(encodeDecision(input), map.id, true);
    // slot k (0 = me, by turn order) -> player id, as encode.ts numbers them
    const order = input.state.order;
    const n = order.length;
    const myPos = order.indexOf(input.seat);
    const bySlot = new Map<number, PlayerId>();
    for (const seat of order) bySlot.set((order.indexOf(seat) - myPos + n) % n, seatIds[seat]);
    const neutral = state.players.find((p) => p.isNeutral && p.alive)?.id ?? null;
    let territory = x.territory;
    if (this.memory) {
      // fog_guess.py memory_columns: last-seen owner slot (or the Neutral), seen, log armies, rounds since / 10 (at most 3)
      const slotOf = new Map<PlayerId, number>([...bySlot].map(([k, id]) => [id, k]));
      const neutralId = state.players.find((p) => p.isNeutral)?.id;
      const W = x.territory.length / T;
      territory = new Float32Array(T * (W + this.memory));
      map.territoryIds.forEach((t, i) => {
        territory.set(x.territory.subarray(i * W, (i + 1) * W), i * (W + this.memory));
        const seen = state.territories[t].hidden ? memory?.seen.get(t) : undefined;
        const k = seen?.owner == null ? undefined : seen.owner === neutralId ? MAX_SLOTS : slotOf.get(seen.owner);
        if (k === undefined) return;
        const at = i * (W + this.memory) + W;
        territory[at + k] = 1;
        territory[at + this.owners] = 1;
        territory[at + this.owners + 1] = Math.log1p(seen!.armies) / 5;
        territory[at + this.owners + 2] = Math.min((state.round - seen!.round) / 10, 3);
      });
    }
    const width = this.owners + this.armyBins.length;
    const out = this.net.guess(territory, x.global, map.id, width);
    const alive = new Set(state.players.filter((p) => p.alive && p.id !== me).map((p) => p.id));
    const territories = new Map<TerritoryId, TerritoryGuess>();
    map.territoryIds.forEach((t, i) => {
      if (!state.territories[t].hidden) return;
      const row = out.subarray(i * width, (i + 1) * width);
      const owners: PlayerId[] = [];
      const logits: number[] = [];
      for (let k = 1; k < this.owners; k++) {
        const id = k === MAX_SLOTS ? neutral : bySlot.get(k);
        if (id && alive.has(id)) owners.push(id), logits.push(row[k]);
      }
      territories.set(t, { owners, p: softmax(logits), bins: softmax(Array.from(row.subarray(this.owners))) });
    });
    return { territories, armyBins: this.armyBins };
  }
}

function softmax(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}
