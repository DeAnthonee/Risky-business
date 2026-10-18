import { getMap, MAP_IDS, type GameOptions } from '@risk/engine';
import type { SeatSpec } from './setup.js';

/** The runner's table settings (everything except the map and the seat count). Override keys with --options. */
export const DEFAULT_OPTIONS: Omit<GameOptions, 'map' | 'maxPlayers'> = {
  autoSetup: true,
  randomDeal: true,
  setupBatch: 1,
  cardValues: 'progressive',
  fogOfWar: true,
  blizzards: 8,
  neutrals: 0,
  neutralArmies: 2,
  spectatorChat: true,
  firstRoundBonus: true,
  balancedBlitz: true,
  capitals: true,
  chooseCapitals: true,
  fortifyMode: 'connected',
};

/** Most players a random lineup seats, and the fewest (when the roster and map allow). */
export const RANDOM_MIN_PLAYERS = 5;
export const RANDOM_MAX_PLAYERS = 10;

/** How many players a map seats (from the engine's map data). */
export function mapMaxPlayers(id: string): number {
  return getMap(id).maxPlayers;
}

/** Maps offered in the rotation: every current map that fits `seatCount`, except the tiny skirmish board. */
export function rotationMaps(seatCount: number): GameOptions['map'][] {
  return MAP_IDS.filter((id) => id !== 'skirmish' && mapMaxPlayers(id) >= seatCount);
}

export type MapChoice = 'rotate' | 'random' | GameOptions['map'];

/** Map for game number `index` (0-based): a fixed id, the next one in the rotation, or a random one from it. */
export function pickMap(choice: MapChoice, seatCount: number, index: number, random: () => number = Math.random): GameOptions['map'] {
  if (choice !== 'rotate' && choice !== 'random') {
    if (!isKnownMap(choice)) throw new Error(`Unknown map "${choice}"`);
    return choice;
  }
  const pool = rotationMaps(seatCount);
  if (pool.length === 0) throw new Error(`No map fits ${seatCount} players`);
  return choice === 'rotate' ? pool[index % pool.length] : pool[Math.floor(random() * pool.length) % pool.length];
}

function isKnownMap(id: string): boolean {
  try {
    getMap(id);
    return true;
  } catch {
    return false;
  }
}

/** A character that can sit at a table: its id ("league/shen") and the name it plays under. */
export interface RosterEntry {
  id: string;
  name: string;
}

/** How many seats a game gets: a fixed number or a random one (5 to 10, within the map and the roster). */
export type PlayerCount = 'random' | number;

/**
 * A random lineup: pick the map (a fixed id, the next in the rotation, or random; never skirmish or the legacy
 * europe), then the player count (fixed, or random from 5 up to min(10, the map's maxPlayers)), then that many
 * distinct characters from the roster. Seat names are the characters' display names (made unique).
 */
export function pickLineup(o: {
  map: MapChoice;
  players: PlayerCount;
  roster: readonly RosterEntry[];
  index: number;
  random?: () => number;
}): { map: GameOptions['map']; seats: SeatSpec[] } {
  const random = o.random ?? Math.random;
  const R = o.roster.length;
  if (R < 2) throw new Error(`Need at least 2 characters in the roster (found ${R})`);
  const fixed = o.players === 'random' ? null : o.players;
  if (fixed !== null && (!Number.isInteger(fixed) || fixed < 2 || fixed > R)) throw new Error(`--players must be 2 to ${R} (the roster has ${R} characters), got ${fixed}`);
  const lo = fixed ?? Math.min(RANDOM_MIN_PLAYERS, R);

  const map = pickMap(o.map, lo, o.index, random);
  const cap = mapMaxPlayers(map);
  if (fixed !== null && fixed > cap) throw new Error(`${map} seats at most ${cap} players, got ${fixed}`);
  const hi = Math.min(RANDOM_MAX_PLAYERS, R, cap);
  if (hi < lo) throw new Error(`${map} cannot seat ${lo} players`);
  const count = fixed ?? lo + Math.min(hi - lo, Math.floor(random() * (hi - lo + 1)));

  const used = new Set<string>();
  const seats = shuffled(o.roster, random)
    .slice(0, count)
    .map((c) => {
      let name = c.name.trim() || c.id.split('/').pop()!;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${c.name} ${n}`;
      used.add(name.toLowerCase());
      return { name, characterId: c.id };
    });
  return { map, seats };
}

/** Options for a new game: the preset, then caller overrides, with maxPlayers = seat count and the map. */
export function gameOptions(seatCount: number, map: GameOptions['map'], overrides: Partial<GameOptions> = {}, random: () => number = Math.random, cardModes: readonly GameOptions['cardValues'][] = ['progressive', 'fixed', 'exponential']): Partial<GameOptions> {
  // Independent 50/50 switches and equally weighted supported card modes, sampled afresh each game.
  if (!cardModes.length) throw new Error('Server advertises no supported card mode');
  if (overrides.cardValues && !cardModes.includes(overrides.cardValues)) throw new Error(`Server does not support ${overrides.cardValues} cards yet`);
  const randomized: Partial<GameOptions> = {
    blizzards: random() < 0.5 ? 8 : 0,
    capitals: random() < 0.5,
    fogOfWar: random() < 0.5,
    cardValues: cardModes[Math.min(cardModes.length - 1, Math.floor(random() * cardModes.length))],
  };
  return { ...DEFAULT_OPTIONS, ...randomized, maxPlayers: Math.max(2, seatCount), ...overrides, map: overrides.map ?? map };
}

/** Fisher-Yates copy. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
