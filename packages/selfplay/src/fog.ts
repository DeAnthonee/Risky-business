import { getMap, type MapDef } from '@risk/engine';
import { territoryIndex } from './actions.js';
import { GLOBAL_FEATURES, MAX_SLOTS, TERRITORY_FEATURES, type Features } from './encode.js';

/**
 * The seat view of a position under fog of war, as network inputs (docs/delove-fog.md section 2): the board
 * encoder's features (encode.ts, unchanged) turned into what the deciding seat could see with fog on, plus two columns.
 *
 * Visible: the decider's territories and every territory next to one (the engine's `visibleTerritories`), and
 * blizzards. A hidden territory loses its owner, its armies and any capital mark (the engine's view hides a capital
 * that is out of sight, even one's own lost capital). Every feature that sums over
 * other territories is recomputed from visible territories only: `continent_held_by_owner` (no holder while any of the
 * continent is hidden), `border`, `enemy_adjacent_log` and `own_adjacent_log` (hidden neighbours left out), and per
 * seat slot `territory_share` / `army_share` (what is visible of it) and `neutral_present`. Public numbers (alive,
 * cards, income, the hand, the card values) are kept.
 *
 * It is a function of the full-board features alone, and it reads nothing a fogged seat can't see, so:
 * - training applies it to any full-board array (fog dropout, `train.py --fog-dropout`; the same steps in
 *   packages/delove/python/fog.py, checked against this file by test_fog.py);
 * - in a fog game the features of the seat's own view (`stateFromView(viewFor(state, me))`) give exactly the same
 *   result as the true board's (stage.test / fog.test check it), so a network can't see through the fog.
 *
 * Two columns are appended, both 0 on a fully visible board, so a network widened with zero weights for them plays
 * exactly as before on normal games: territory `hidden` and global `hidden_share` (hidden share of the open map).
 * FOG_INPUT_VERSION names this input layout (a model's `fogInputs` in its <model>.json).
 */
export const FOG_INPUT_VERSION = 1;
export const FOG_TERRITORY_FEATURES = ['hidden'] as const;
export const FOG_GLOBAL_FEATURES = ['hidden_share'] as const;

const TI = Object.fromEntries(TERRITORY_FEATURES.map((n, i) => [n, i])) as Record<(typeof TERRITORY_FEATURES)[number], number>;
const GI = Object.fromEntries((GLOBAL_FEATURES as readonly string[]).map((n, i) => [n, i])) as Record<string, number>;
const NEUTRAL = -2;
const NONE = -1;

/** log1 of encode.ts. */
const log1 = (x: number) => Math.log1p(Math.max(0, x)) / 5;

/** Armies of a territory from its features (exact below 30 from armies_lin, else from armies_log). */
function armiesOf(territory: Float32Array, i: number, TF: number): number {
  const lin = territory[i * TF + TI.armies_lin];
  return lin < 1 ? Math.round(lin * 30) : Math.round(Math.expm1(territory[i * TF + TI.armies_log] * 5));
}

/** Owner of a territory from its features: seat slot 0..9, NEUTRAL or NONE. */
function ownerOf(territory: Float32Array, i: number, TF: number): number {
  for (let k = 0; k < MAX_SLOTS; k++) if (territory[i * TF + k] === 1) return k;
  return territory[i * TF + TI.owner_neutral] === 1 ? NEUTRAL : NONE;
}

interface MapFacts {
  adj: number[][];
  continents: number[][];
}
const facts = new Map<string, MapFacts>();
function mapFacts(map: MapDef): MapFacts {
  let f = facts.get(map.id);
  if (!f) {
    const idx = territoryIndex(map);
    f = { adj: map.territoryIds.map((t) => map.adjacency[t].map((x) => idx.get(x)!)), continents: map.continents.map((c) => c.territories.map((t) => idx.get(t)!)) };
    facts.set(map.id, f);
  }
  return f;
}

/** Territories hidden from the decider (slot 0): neither its own, nor next to its own, nor a blizzard. */
export function hiddenMask(f: Features, mapId: string): Uint8Array {
  const { adj } = mapFacts(getMap(mapId));
  const T = f.territories;
  const TF = TERRITORY_FEATURES.length;
  const visible = new Uint8Array(T);
  for (let i = 0; i < T; i++) {
    if (f.territory[i * TF] !== 1) continue; // owner_slot0: mine
    visible[i] = 1;
    for (const j of adj[i]) visible[j] = 1;
  }
  const hidden = new Uint8Array(T);
  for (let i = 0; i < T; i++) hidden[i] = visible[i] || f.territory[i * TF + TI.blizzard] === 1 ? 0 : 1;
  return hidden;
}

/**
 * The fog inputs of an encoded decision: territory [T, TF + 1] and global [GF + 1]. `fogged` false gives the
 * full-board features with the two columns at 0 (a normal game); true gives the seat view described above.
 */
export function fogInputs(f: Features, mapId: string, fogged: boolean): { territory: Float32Array; global: Float32Array } {
  const T = f.territories;
  const TF = TERRITORY_FEATURES.length;
  const GF = GLOBAL_FEATURES.length;
  const TW = TF + FOG_TERRITORY_FEATURES.length;
  const territory = new Float32Array(T * TW);
  const global = new Float32Array(GF + FOG_GLOBAL_FEATURES.length);
  for (let i = 0; i < T; i++) territory.set(f.territory.subarray(i * TF, (i + 1) * TF), i * TW);
  global.set(f.global);
  if (!fogged) return { territory, global };

  const { adj, continents } = mapFacts(getMap(mapId));
  const hidden = hiddenMask(f, mapId);
  const owner = new Int32Array(T);
  const armies = new Float64Array(T);
  const bliz = new Uint8Array(T);
  let open = 0;
  let nHidden = 0;
  for (let i = 0; i < T; i++) {
    bliz[i] = f.territory[i * TF + TI.blizzard] === 1 ? 1 : 0;
    if (!bliz[i]) open++;
    if (hidden[i]) {
      nHidden++;
      owner[i] = NONE;
      armies[i] = 0;
    } else {
      owner[i] = ownerOf(f.territory, i, TF);
      armies[i] = armiesOf(f.territory, i, TF);
    }
  }
  // Continent holders over the open territories, none while any of it is hidden.
  const holder = new Int32Array(T).fill(NONE);
  for (const ts of continents) {
    const openTs = ts.filter((i) => !bliz[i]);
    if (openTs.some((i) => hidden[i])) continue;
    const owners = new Set(openTs.map((i) => owner[i]));
    if (owners.size === 1) for (const i of ts) holder[i] = [...owners][0];
  }
  const at = (i: number, name: (typeof TERRITORY_FEATURES)[number]) => i * TW + TI[name];
  for (let i = 0; i < T; i++) {
    if (hidden[i]) {
      for (let k = 0; k < MAX_SLOTS; k++) territory[i * TW + k] = 0;
      for (const n of ['owner_neutral', 'owner_none', 'armies_log', 'armies_lin', 'my_capital', 'enemy_capital', 'continent_held_by_owner', 'border', 'enemy_adjacent_log', 'own_adjacent_log'] as const)
        territory[at(i, n)] = 0;
      territory[i * TW + TF] = 1;
      continue;
    }
    const o = owner[i];
    let enemy = 0;
    let own = 0;
    let border = 0;
    for (const j of adj[i]) {
      if (bliz[j] || hidden[j]) continue;
      if (owner[j] === o) own += armies[j];
      else {
        enemy += armies[j];
        border = 1;
      }
    }
    territory[at(i, 'continent_held_by_owner')] = o !== NONE && holder[i] === o ? 1 : 0;
    territory[at(i, 'border')] = o === NONE ? 0 : border;
    territory[at(i, 'enemy_adjacent_log')] = log1(enemy);
    territory[at(i, 'own_adjacent_log')] = log1(own);
  }
  // Per seat slot, what is visible of it.
  let total = 0;
  for (let i = 0; i < T; i++) total += armies[i];
  total = total || 1;
  for (let k = 0; k < MAX_SLOTS; k++) {
    if (global[GI[`slot${k}_present`]] !== 1) continue;
    let terr = 0;
    let arm = 0;
    for (let i = 0; i < T; i++)
      if (owner[i] === k) {
        terr++;
        arm += armies[i];
      }
    global[GI[`slot${k}_territory_share`]] = terr / open;
    global[GI[`slot${k}_army_share`]] = arm / total;
  }
  let neutral = 0;
  for (let i = 0; i < T; i++) if (owner[i] === NEUTRAL) neutral = 1;
  global[GI.neutral_present] = neutral;
  global[GF] = open ? nHidden / open : 0;
  return { territory, global };
}
