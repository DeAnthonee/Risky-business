import type { MapDef } from './maps.js';
import { CLASSIC } from './maps.js';
import type { Card, CardKind } from './types.js';

/** One card per territory (infantry/cavalry/artillery in rotation) + 2 wilds. */
export function buildDeck(map: MapDef = CLASSIC): Card[] {
  const kinds: CardKind[] = ['infantry', 'cavalry', 'artillery'];
  const n = map.territoryIds.length;
  const cards: Card[] = map.territoryIds.map((territory, i) => ({
    id: i,
    kind: kinds[i % 3],
    territory,
  }));
  cards.push({ id: n, kind: 'wild', territory: null });
  cards.push({ id: n + 1, kind: 'wild', territory: null });
  return cards;
}

/** True if the three cards form a valid set. */
export function isValidSet(cards: Card[]): boolean {
  if (cards.length !== 3) return false;
  const wilds = cards.filter((c) => c.kind === 'wild').length;
  const kinds = new Set(cards.filter((c) => c.kind !== 'wild').map((c) => c.kind));
  if (wilds >= 1) return true; // any 2 cards + wild, or 1 card + 2 wilds
  return kinds.size === 1 || kinds.size === 3;
}

/** Find all valid sets among a hand (as arrays of card ids). */
export function findSets(hand: Card[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < hand.length; i++)
    for (let j = i + 1; j < hand.length; j++)
      for (let k = j + 1; k < hand.length; k++) {
        const trio = [hand[i], hand[j], hand[k]];
        if (isValidSet(trio)) out.push(trio.map((c) => c.id));
      }
  return out;
}

/** Escalating bonus: 4, 6, 8, 10, 12, 15, 20, 25, ... */
export function tradeBonus(tradeIndex: number): number {
  const table = [4, 6, 8, 10, 12, 15];
  if (tradeIndex < table.length) return table[tradeIndex];
  return 15 + 5 * (tradeIndex - table.length + 1);
}
