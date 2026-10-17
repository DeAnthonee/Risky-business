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
 * - `fortify`: move n armies from -> to (n = all that may move, or half).
 * - `end_turn`: stop attacking/fortifying and pass.
 *
 * `end_attack` is left out: fortify moves and end_turn are offered during the attack phase already.
 * Only append new kinds: logs store candidates as these tuples.
 */
export type Candidate =
  | ['place', number, number]
  | ['trade', number[]]
  | ['capital', number]
  | ['attack', number, number]
  | ['occupy', number]
  | ['fortify', number, number, number]
  | ['end_turn'];

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

/** Every candidate the player may choose now. Empty when it is not their turn. */
export function candidates(state: GameState, me: PlayerId, lm: LegalMoves): Candidate[] {
  if (!lm.yourTurn) return [];
  const map = getMap(state.options.map);
  const idx = territoryIndex(map);
  const ti = (t: string) => idx.get(t)!;
  const out: Candidate[] = [];

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
  for (const f of lm.fortifies) {
    if (f.from === f.to) continue;
    for (const n of amounts(f.maxArmies, Math.ceil(f.maxArmies / 2))) out.push(['fortify', ti(f.from), ti(f.to), n]);
  }
  if (lm.canEndTurn) out.push(['end_turn']);
  return out;
}

export function candidateToAction(map: MapDef, c: Candidate): Action {
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
  }
}

/** The candidate an action corresponds to, or null when it falls outside the discrete action space. */
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
      if (!action.blitz || action.occupy !== undefined || action.dice !== undefined) return null;
      return ['attack', ti(action.from), ti(action.to)];
    case 'occupy':
      return ['occupy', action.armies];
    case 'fortify':
      return ['fortify', ti(action.from), ti(action.to), action.armies];
    case 'end_turn':
      return ['end_turn'];
    default:
      return null;
  }
}

export function candidateKey(c: Candidate): string {
  return JSON.stringify(c);
}

/** Index of `action` in `cands`, or -1 when it is not one of them. */
export function matchCandidate(map: MapDef, cands: Candidate[], action: Action): number {
  const c = actionToCandidate(map, action);
  if (!c) return -1;
  const key = candidateKey(c);
  return cands.findIndex((x) => candidateKey(x) === key);
}
