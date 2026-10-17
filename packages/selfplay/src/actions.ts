import { getMap, type Action, type GameState, type LegalMoves, type MapDef, type PlayerId } from '@risk/engine';

/**
 * The discrete action space a learning player chooses from: the engine's legal moves broken into small,
 * enumerable decisions. Territories are indexes into the map's `territoryIds`, so a candidate is plain numbers.
 *
 * - `place`: put n armies on one territory (n = all, half or 1 of what may be placed now).
 * - `trade`: trade one card set (card ids, sorted).
 * - `capital`: choose a capital.
 * - `attack`: blitz from -> to; how many armies move in is the next decision (`occupy`).
 * - `occupy`: move n armies into a conquered territory (n = min, half or max).
 * - `fortify_from`: start a fortify move from this territory. The next decision (same board, see
 *   `candidates(..., fortifyFrom)`) is a `fortify_to`; the engine sees one fortify action. Splitting the move keeps
 *   lists short: connected-mode fortify pairs alone ran into the thousands on big maps.
 * - `fortify_to`: finish the fortify: move n armies to this territory (n = all that may move, or half).
 * - `end_turn`: stop attacking/fortifying and pass.
 * - `fortify` (log v1 only): the old one-step move from -> to. No longer offered.
 *
 * `end_attack` is left out: fortify moves and end_turn are offered during the attack phase already.
 * Only append new kinds: logs store candidates as these tuples and CANDIDATE_KINDS indexes them.
 */
export type Candidate =
  | ['place', number, number]
  | ['trade', number[]]
  | ['capital', number]
  | ['attack', number, number]
  | ['occupy', number]
  | ['fortify', number, number, number]
  | ['end_turn']
  | ['fortify_from', number]
  | ['fortify_to', number, number];

export type CandidateKind = Candidate[0];

export const CANDIDATE_KINDS: CandidateKind[] = ['place', 'trade', 'capital', 'attack', 'occupy', 'fortify', 'end_turn', 'fortify_from', 'fortify_to'];

/** Territory id -> index lookup per map, built once. */
const indexCache = new Map<string, Map<string, number>>();

export function territoryIndex(map: MapDef): Map<string, number> {
  let idx = indexCache.get(map.id);
  if (!idx) {
    idx = new Map(map.territoryIds.map((t, i) => [t, i]));
    indexCache.set(map.id, idx);
  }
  return idx;
}

function amounts(...ns: number[]): number[] {
  return [...new Set(ns.filter((n) => n >= 1))].sort((a, b) => b - a);
}

/**
 * Every candidate the player may choose now. Empty when it is not their turn. With `fortifyFrom` (a territory id
 * chosen through a `fortify_from` candidate) it lists the `fortify_to` choices for that source instead.
 */
export function candidates(state: GameState, me: PlayerId, lm: LegalMoves, fortifyFrom?: string): Candidate[] {
  if (!lm.yourTurn) return [];
  const map = getMap(state.options.map);
  const idx = territoryIndex(map);
  const ti = (t: string) => idx.get(t)!;
  const out: Candidate[] = [];

  if (fortifyFrom !== undefined) {
    for (const f of lm.fortifies) {
      if (f.from !== fortifyFrom || f.to === f.from) continue;
      for (const n of amounts(f.maxArmies, Math.ceil(f.maxArmies / 2))) out.push(['fortify_to', ti(f.to), n]);
    }
    return out;
  }
  if (lm.pendingConquest) {
    const { minArmies: min, maxArmies: max } = lm.pendingConquest;
    for (const n of amounts(max, Math.max(min, Math.ceil(max / 2)), min)) out.push(['occupy', n]);
    return out;
  }
  for (const t of lm.capitalChoices) out.push(['capital', ti(t)]);
  for (const set of lm.tradeableSets) out.push(['trade', [...set].sort((a, b) => a - b)]);
  if (lm.placeLimit > 0) {
    const ns = amounts(lm.placeLimit, Math.ceil(lm.placeLimit / 2), 1);
    for (const t of lm.canPlaceOn) for (const n of ns) out.push(['place', ti(t), n]);
  }
  for (const a of lm.attacks) out.push(['attack', ti(a.from), ti(a.to)]);
  const sources = new Set(lm.fortifies.filter((f) => f.from !== f.to).map((f) => f.from));
  for (const t of sources) out.push(['fortify_from', ti(t)]);
  if (lm.canEndTurn) out.push(['end_turn']);
  return out;
}

/**
 * The engine action for a complete choice. A `fortify_to` needs the source picked by the `fortify_from` before it;
 * a `fortify_from` alone is not an action (throws).
 */
export function candidateToAction(map: MapDef, c: Candidate, fortifyFrom?: number): Action {
  const t = (i: number) => map.territoryIds[i];
  switch (c[0]) {
    case 'place':
      return { type: 'place', placements: { [t(c[1])]: c[2] } };
    case 'trade':
      return { type: 'trade', cardIds: [...c[1]] };
    case 'capital':
      return { type: 'choose_capital', territory: t(c[1]) };
    case 'attack':
      return { type: 'attack', from: t(c[1]), to: t(c[2]), blitz: true };
    case 'occupy':
      return { type: 'occupy', armies: c[1] };
    case 'fortify':
      return { type: 'fortify', from: t(c[1]), to: t(c[2]), armies: c[3] };
    case 'end_turn':
      return { type: 'end_turn' };
    case 'fortify_to':
      if (fortifyFrom === undefined) throw new Error('fortify_to needs the fortify_from source');
      return { type: 'fortify', from: t(fortifyFrom), to: t(c[1]), armies: c[2] };
    case 'fortify_from':
      throw new Error('fortify_from is half a move: pick a fortify_to next');
  }
}

/** One decision as logged: the list offered, the index picked, and the fortify source when this is a fortify_to. */
export interface Step {
  cands: Candidate[];
  choice: number;
  fortifyFrom: number | null;
}

/**
 * The decisions an action amounts to: one step, or two for a fortify (source, then destination and amount).
 * A step with choice -1 means the action is not in the discrete space (it is then the last step).
 */
export function actionSteps(state: GameState, me: PlayerId, lm: LegalMoves, action: Action, first = candidates(state, me, lm)): Step[] {
  const map = getMap(state.options.map);
  const idx = territoryIndex(map);
  const find = (cands: Candidate[], c: Candidate) => cands.findIndex((x) => candidateKey(x) === candidateKey(c));
  if (action.type === 'fortify') {
    const from = idx.get(action.from) ?? -1;
    const choice = find(first, ['fortify_from', from]);
    if (choice < 0) return [{ cands: first, choice, fortifyFrom: null }];
    const second = candidates(state, me, lm, action.from);
    return [
      { cands: first, choice, fortifyFrom: null },
      { cands: second, choice: find(second, ['fortify_to', idx.get(action.to) ?? -1, action.armies]), fortifyFrom: from },
    ];
  }
  const c = actionToCandidate(map, action);
  return [{ cands: first, choice: c ? find(first, c) : -1, fortifyFrom: null }];
}

/** The candidate a one-step action corresponds to, or null when it falls outside the discrete action space. */
export function actionToCandidate(map: MapDef, action: Action): Candidate | null {
  const idx = territoryIndex(map);
  const ti = (t: string) => idx.get(t) ?? -1;
  switch (action.type) {
    case 'place': {
      const entries = Object.entries(action.placements);
      if (entries.length !== 1) return null;
      return ['place', ti(entries[0][0]), entries[0][1]];
    }
    case 'trade':
      return ['trade', [...action.cardIds].sort((a, b) => a - b)];
    case 'choose_capital':
      return ['capital', ti(action.territory)];
    case 'attack':
      if (!action.blitz || action.occupy !== undefined || action.dice !== undefined || action.stopAt !== undefined) return null;
      return ['attack', ti(action.from), ti(action.to)];
    case 'occupy':
      return ['occupy', action.armies];
    case 'end_turn':
      return ['end_turn'];
    default:
      return null;
  }
}

export function candidateKey(c: Candidate): string {
  return JSON.stringify(c);
}
