import { findSets, getMap, setValue, nextTradeValue, type Card, type GameState, type MapDef } from '@risk/engine';
import { CANDIDATE_KINDS, territoryIndex, type Candidate } from './actions.js';
import { CARD_KINDS, encodeRules, encodeState, OWNER_NEUTRAL, OWNER_NONE, PHASES, RULE_KEYS, type DecisionRecord } from './log.js';
import { TRAIT_KEYS, traitVector, type Traits } from './traits.js';

/**
 * Board encoder: one decision step as fixed-size numbers for the strategy network. It reads the logged form of a
 * decision (DecisionRecord), so training data and live play (encodeState + this) go through the same code.
 *
 * Everything is from the deciding player's point of view: seats are renumbered by turn order starting with the
 * decider (slot 0 = me, slot 1 = next to play, ...), so one network plays every seat.
 *
 * - territory: [T, TERRITORY_FEATURES.length] per territory, in the map's territory order
 * - global:    [GLOBAL_FEATURES.length]
 * - cand:      [C, CANDIDATE_FEATURES.length] per candidate, with candFrom/candTo territory indexes (-1 = none)
 *   so a network can gather the territory embeddings a move is about.
 *
 * Bump ENCODER_VERSION whenever a feature changes meaning; append-only changes too, since tensor widths change.
 */
export const ENCODER_VERSION = 2;

/** Seat slots (largest player count on any map). */
export const MAX_SLOTS = 10;

const slotNames = (prefix: string) => Array.from({ length: MAX_SLOTS }, (_, i) => `${prefix}${i}`);

export const TERRITORY_FEATURES = [
  ...slotNames('owner_slot'),
  'owner_neutral',
  'owner_none',
  'armies_log',
  'armies_lin',
  'blizzard',
  'my_capital',
  'enemy_capital',
  'continent_bonus',
  'continent_my_share',
  'continent_held_by_owner',
  'border',
  'enemy_adjacent_log',
  'own_adjacent_log',
  'in_my_hand',
  'pending_from',
  'pending_to',
  'fortify_from',
] as const;

export const GLOBAL_FEATURES = [
  ...PHASES.map((p) => `phase_${p}`),
  ...TRAIT_KEYS.map((k) => `trait_${k}`),
  ...Array.from({ length: MAX_SLOTS }, (_, i) => [`slot${i}_present`, `slot${i}_alive`, `slot${i}_cards`, `slot${i}_territory_share`, `slot${i}_army_share`, `slot${i}_income`]).flat(),
  'neutral_present',
  'to_place_log',
  'hand_size',
  ...CARD_KINDS.map((k) => `hand_${k}`),
  'hand_set_value',
  'trade_count',
  'next_trade_value',
  'conquered',
  'fortified',
  'turn',
  'round',
  'players',
  'territories',
  ...RULE_KEYS.map((k) => `rule_${k}`),
] as const;

export const CANDIDATE_FEATURES = [...CANDIDATE_KINDS.map((k) => `kind_${k}`), 'amount_share', 'amount_log', 'attack_ratio_log', 'trade_bonus_cards'] as const;

const indexOf = <T extends string>(names: readonly T[]) => Object.fromEntries(names.map((n, i) => [n, i])) as Record<T, number>;
const TI = indexOf(TERRITORY_FEATURES);
const GI = indexOf(GLOBAL_FEATURES as readonly string[]);
const CI = indexOf(CANDIDATE_FEATURES);

export interface Features {
  territory: Float32Array;
  global: Float32Array;
  cand: Float32Array;
  candFrom: Int32Array;
  candTo: Int32Array;
  territories: number;
  candidates: number;
}

export type EncoderInput = Pick<DecisionRecord, 'map' | 'players' | 'seat' | 'phase' | 'turn' | 'round' | 'traits' | 'rules' | 'state' | 'cands'>;

/**
 * The encoder input for a live decision step. The recorder builds every logged record with this too, so a network
 * trained on exported logs sees exactly the features it will get in play. `seatIds` are the player ids in seating
 * order (seat numbers are their indexes).
 */
export function decisionInput(state: GameState, seatIds: string[], me: string, traits: Traits, cands: Candidate[], fortifyFrom = -1): EncoderInput {
  return {
    map: state.options.map,
    players: seatIds.length,
    seat: seatIds.indexOf(me),
    phase: PHASES.indexOf(state.phase),
    turn: state.turnNumber,
    round: state.round,
    traits: traitVector(traits),
    rules: encodeRules(state.options),
    state: encodeState(state, seatIds, me, fortifyFrom),
    cands,
  };
}

/** Log scale for counts that can grow without bound (armies, escalating card values): 0 -> 0, 147 -> 1. */
const log1 = (x: number) => Math.log1p(Math.max(0, x)) / 5;

export function encodeDecision(rec: EncoderInput): Features {
  const map = getMap(rec.map);
  const s = rec.state;
  const T = map.territoryIds.length;
  const me = rec.seat;
  const order = s.order;
  const n = order.length;
  const myPos = order.indexOf(me);
  /** Slot of a seat relative to the decider (0 = me), by turn order. */
  const slot = (seat: number) => (order.indexOf(seat) - myPos + n) % n;
  const adj = adjacencyIndex(map);
  const tIdx = territoryIndex(map);
  const continentOf = continentIndex(map);
  const blizzard = new Set(s.blizzards);
  const hand: Card[] = s.hand.map(([id, kind, t]) => ({ id, kind: CARD_KINDS[kind], territory: t < 0 ? null : map.territoryIds[t] }));
  const handTerritories = new Set(s.hand.map((h) => h[2]).filter((t) => t >= 0));
  const capitalOwner = new Map<number, number>();
  s.capitals.forEach((t, seat) => t >= 0 && capitalOwner.set(t, seat));

  // Continents: who holds each one whole (open territories only), and my share of it.
  const contHolder: number[] = [];
  const contMine: number[] = [];
  map.continents.forEach((c, ci) => {
    const open = c.territories.map((t) => tIdx.get(t)!).filter((i) => !blizzard.has(i));
    const owners = new Set(open.map((i) => s.owner[i]));
    contHolder[ci] = owners.size === 1 ? [...owners][0] : OWNER_NONE;
    contMine[ci] = open.length ? open.filter((i) => s.owner[i] === me).length / open.length : 0;
  });

  const TF = TERRITORY_FEATURES.length;
  const territory = new Float32Array(T * TF);
  for (let i = 0; i < T; i++) {
    const f = (name: (typeof TERRITORY_FEATURES)[number], v: number) => (territory[i * TF + TI[name]] = v);
    const o = s.owner[i];
    if (o >= 0) territory[i * TF + slot(o)] = 1;
    else f(o === OWNER_NEUTRAL ? 'owner_neutral' : 'owner_none', 1);
    f('armies_log', log1(s.armies[i]));
    f('armies_lin', Math.min(s.armies[i], 30) / 30);
    f('blizzard', blizzard.has(i) ? 1 : 0);
    const cap = capitalOwner.get(i);
    if (cap !== undefined) f(cap === me ? 'my_capital' : 'enemy_capital', 1);
    const ci = continentOf[i];
    f('continent_bonus', map.continents[ci].bonus / 10);
    f('continent_my_share', contMine[ci]);
    f('continent_held_by_owner', o !== OWNER_NONE && contHolder[ci] === o ? 1 : 0);
    let enemy = 0;
    let own = 0;
    let border = 0;
    for (const j of adj[i]) {
      if (blizzard.has(j)) continue;
      if (s.owner[j] === o) own += s.armies[j];
      else {
        enemy += s.armies[j];
        border = 1;
      }
    }
    f('border', o === OWNER_NONE ? 0 : border);
    f('enemy_adjacent_log', log1(enemy));
    f('own_adjacent_log', log1(own));
    f('in_my_hand', handTerritories.has(i) ? 1 : 0);
    if (s.pending) {
      if (s.pending[0] === i) f('pending_from', 1);
      if (s.pending[1] === i) f('pending_to', 1);
    }
    f('fortify_from', s.fortifyFrom === i ? 1 : 0);
  }

  const global = new Float32Array(GLOBAL_FEATURES.length);
  const g = (name: string, v: number) => {
    const at = GI[name];
    if (at === undefined) throw new Error(`unknown global feature ${name}`);
    global[at] = v;
  };
  g(`phase_${PHASES[rec.phase]}`, 1);
  TRAIT_KEYS.forEach((k, i) => g(`trait_${k}`, rec.traits[i] ?? 0.5));
  const open = T - blizzard.size;
  const totalArmies = s.armies.reduce((a, b) => a + b, 0) || 1;
  for (let seat = 0; seat < n; seat++) {
    const k = slot(seat);
    const [alive, cards, , income] = s.seats[seat];
    let terr = 0;
    let armies = 0;
    for (let i = 0; i < T; i++)
      if (s.owner[i] === seat) {
        terr++;
        armies += s.armies[i];
      }
    g(`slot${k}_present`, 1);
    g(`slot${k}_alive`, alive);
    g(`slot${k}_cards`, cards / 5);
    g(`slot${k}_territory_share`, terr / open);
    g(`slot${k}_army_share`, armies / totalArmies);
    g(`slot${k}_income`, log1(income));
  }
  g('neutral_present', s.owner.includes(OWNER_NEUTRAL) ? 1 : 0);
  g('to_place_log', log1(s.seats[me][2]));
  g('hand_size', hand.length / 5);
  CARD_KINDS.forEach((k) => g(`hand_${k}`, hand.filter((c) => c.kind === k).length / 3));
  const mode = rec.rules[RULE_KEYS.indexOf('fixedCards')] ? 'fixed' : rec.rules[RULE_KEYS.indexOf('exponentialCards')] ? 'exponential' : 'progressive';
  const byId = new Map(hand.map((c) => [c.id, c]));
  const best = Math.max(0, ...findSets(hand).map((set) => setValue(set.map((id) => byId.get(id)!), mode, s.tradeCount, s.personalTrades?.[me] ?? 0)));
  g('hand_set_value', log1(best));
  g('trade_count', log1(s.tradeCount));
  g('next_trade_value', log1(nextTradeValue(mode, s.tradeCount, s.personalTrades?.[me] ?? 0)));
  g('conquered', s.conquered ? 1 : 0);
  g('fortified', s.fortified ? 1 : 0);
  g('turn', rec.turn / 100);
  g('round', rec.round / 50);
  g('players', rec.players / MAX_SLOTS);
  g('territories', T / 120);
  RULE_KEYS.forEach((k, i) => g(`rule_${k}`, rec.rules[i] ?? 0));

  const C = rec.cands.length;
  const CF = CANDIDATE_FEATURES.length;
  const cand = new Float32Array(C * CF);
  const candFrom = new Int32Array(C).fill(-1);
  const candTo = new Int32Array(C).fill(-1);
  rec.cands.forEach((c, ci) => {
    const f = (name: (typeof CANDIDATE_FEATURES)[number], v: number) => (cand[ci * CF + CI[name]] = v);
    cand[ci * CF + CANDIDATE_KINDS.indexOf(c[0])] = 1;
    const [from, to, amount, pool] = candidateGeometry(c, s, me);
    candFrom[ci] = from;
    candTo[ci] = to;
    if (amount > 0) {
      f('amount_share', pool > 0 ? amount / pool : 1);
      f('amount_log', log1(amount));
    }
    if (c[0] === 'attack') f('attack_ratio_log', Math.max(-3, Math.min(3, Math.log((s.armies[c[1]] - 1) / Math.max(1, s.armies[c[2]])))));
    if (c[0] === 'trade') {
      const owned = c[1].filter((id) => {
        const t = byId.get(id)?.territory;
        return t != null && s.owner[tIdx.get(t)!] === me;
      });
      f('trade_bonus_cards', owned.length / 3);
    }
  });

  return { territory, global, cand, candFrom, candTo, territories: T, candidates: C };
}

/** [from, to, amount, pool the amount is drawn from] of a candidate (-1/0 where it does not apply). */
function candidateGeometry(c: Candidate, s: DecisionRecord['state'], me: number): [number, number, number, number] {
  switch (c[0]) {
    case 'place':
      return [-1, c[1], c[2], Math.max(c[2], s.seats[me][2])];
    case 'capital':
      return [-1, c[1], 0, 0];
    case 'attack':
      return [c[1], c[2], 0, 0];
    case 'occupy':
      return s.pending ? [s.pending[0], s.pending[1], c[1], s.pending[3]] : [-1, -1, c[1], c[1]];
    case 'fortify':
      return [c[1], c[2], c[3], s.armies[c[1]] - 1];
    case 'fortify_from':
      return [c[1], -1, 0, 0];
    case 'fortify_to':
      return [s.fortifyFrom, c[1], c[2], s.fortifyFrom >= 0 ? s.armies[s.fortifyFrom] - 1 : c[2]];
    default:
      return [-1, -1, 0, 0];
  }
}

const adjCache = new Map<string, number[][]>();
function adjacencyIndex(map: MapDef): number[][] {
  let a = adjCache.get(map.id);
  if (!a) {
    const idx = territoryIndex(map);
    a = map.territoryIds.map((t) => map.adjacency[t].map((x) => idx.get(x)!));
    adjCache.set(map.id, a);
  }
  return a;
}

const contCache = new Map<string, number[]>();
function continentIndex(map: MapDef): number[] {
  let c = contCache.get(map.id);
  if (!c) {
    const byT = new Map<string, number>();
    map.continents.forEach((cont, ci) => cont.territories.forEach((t) => byT.set(t, ci)));
    c = map.territoryIds.map((t) => byT.get(t)!);
    contCache.set(map.id, c);
  }
  return c;
}
