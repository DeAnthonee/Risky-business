import type { MapDef } from './maps.js';
import { CLASSIC } from './maps.js';
import type { Card, CardKind, GameOptions } from './types.js';

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

/** Personal trade sequence: 5, 7, 10, 13, ...; after trade 25 (3529), add 1000 each time.
 * Integer arithmetic avoids floating point round-up errors on exact multiples of ten.
 */
export function exponentialTradeBonus(tradeIndex: number): number {
  if (!Number.isSafeInteger(tradeIndex) || tradeIndex < 0) throw new RangeError('Invalid personal trade index');
  let value = 5;
  for (let i = 0; i < Math.min(tradeIndex, 24); i++) value = Math.ceil(value * 13 / 10);
  return value + Math.max(0, tradeIndex - 24) * 1000;
}

/** Next set value (maximum set for fixed cards); exponential never uses the lobby trade counter. */
export function nextTradeValue(mode: GameOptions['cardValues'], lobbyTrades: number, personalTrades = 0): number {
  return mode === 'fixed' ? 10 : mode === 'exponential' ? exponentialTradeBonus(personalTrades) : tradeBonus(lobbyTrades);
}

const FIXED: Record<Exclude<CardKind, 'wild'>, number> = { infantry: 4, cavalry: 6, artillery: 8 };
const FIXED_MIXED = 10;

/**
 * Fixed values (RISK: Global Domination "fixed" cards): three infantry 4, three cavalry 6, three
 * artillery 8, one of each 10. A wild stands in for the missing card: wild + two of a kind is that
 * kind's value, wild + two different kinds completes one-of-each (10), two wilds complete the best set.
 */
export function fixedSetValue(cards: Card[]): number {
  const kinds = cards.filter((c) => c.kind !== 'wild').map((c) => c.kind as Exclude<CardKind, 'wild'>);
  const distinct = new Set(kinds);
  const wilds = cards.length - kinds.length;
  if (wilds >= 2) return FIXED_MIXED;
  if (distinct.size === 1) return FIXED[kinds[0]];
  return FIXED_MIXED;
}

/** Value of a traded set under the given rule. */
export function setValue(cards: Card[], mode: GameOptions['cardValues'], tradeIndex: number, personalTrades = 0): number {
  return mode === 'fixed' ? fixedSetValue(cards) : nextTradeValue(mode, tradeIndex, personalTrades);
}
