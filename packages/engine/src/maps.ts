/**
 * Playable maps. Geometry and adjacency are generated from real-world geography by
 * scripts/build-map.mjs into ./generated/*.json; this module wraps them with lookups.
 */
import classicJson from './generated/classic.json' with { type: 'json' };
import worldJson from './generated/world.json' with { type: 'json' };
import { RuleError } from './types.js';

export type MapId = 'classic' | 'world';
export const MAP_IDS: MapId[] = ['classic', 'world'];

export interface TerritoryDef {
  id: string;
  name: string;
  continent: string;
  /** Label / army badge anchor in the map's viewBox. */
  x: number;
  y: number;
  /** SVG path data for the territory shape. */
  path: string;
}

export interface ContinentDef {
  id: string;
  name: string;
  bonus: number;
  territories: string[];
  /** SVG path data for the continent outline (union of its territories). */
  outline: string;
  /** Optional label position in the viewBox. */
  labelX?: number;
  labelY?: number;
}

export interface SeaLink {
  a: string;
  b: string;
  /** Link that wraps around the map edge (Alaska <-> Kamchatka). */
  wrap: boolean;
}

export interface MapDef {
  id: MapId;
  name: string;
  maxPlayers: number;
  viewBox: [number, number];
  territories: TerritoryDef[];
  territoryIds: string[];
  territoryById: Record<string, TerritoryDef>;
  continents: ContinentDef[];
  continentById: Record<string, ContinentDef>;
  adjacency: Record<string, string[]>;
  edges: [string, string][];
  /** Adjacent pairs that do not touch on the map and are drawn as link lines. */
  seaLinks: SeaLink[];
  isAdjacent(a: string, b: string): boolean;
  isTerritory(id: string): boolean;
  /** Starting armies per player for a game with `players` players. */
  startingArmies(players: number): number;
}

interface RawMap {
  id: string;
  name: string;
  maxPlayers: number;
  viewBox: number[];
  territories: TerritoryDef[];
  continents: ContinentDef[];
  edges: string[][];
  seaLinks: SeaLink[];
}

/** Classic Hasbro table: 2 players 40 (plus Neutral), 3: 35, 4: 30, 5: 25, 6: 20. */
function classicStartingArmies(players: number): number {
  const table: Record<number, number> = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
  const n = table[players];
  if (!n) throw new RuleError('The classic map supports 2-6 players');
  return n;
}

/** Larger maps: roughly three armies per territory shared between the players, 20-60 each. */
function scaledStartingArmies(territoryCount: number, maxPlayers: number) {
  return (players: number) => {
    if (players < 2 || players > maxPlayers) throw new RuleError(`This map supports 2-${maxPlayers} players`);
    return Math.max(20, Math.min(60, Math.round((territoryCount * 3) / players)));
  };
}

function wrap(raw: RawMap): MapDef {
  const territoryIds = raw.territories.map((t) => t.id);
  const territoryById = Object.fromEntries(raw.territories.map((t) => [t.id, t]));
  const adjacency: Record<string, string[]> = Object.fromEntries(territoryIds.map((t) => [t, [] as string[]]));
  const edges = raw.edges as [string, string][];
  for (const [a, b] of edges) {
    if (!adjacency[a] || !adjacency[b]) throw new Error(`Map ${raw.id}: bad edge ${a}-${b}`);
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  const id = raw.id as MapId;
  return {
    id,
    name: raw.name,
    maxPlayers: raw.maxPlayers,
    viewBox: [raw.viewBox[0], raw.viewBox[1]],
    territories: raw.territories,
    territoryIds,
    territoryById,
    continents: raw.continents,
    continentById: Object.fromEntries(raw.continents.map((c) => [c.id, c])),
    adjacency,
    edges,
    seaLinks: raw.seaLinks,
    isAdjacent: (a, b) => adjacency[a]?.includes(b) ?? false,
    isTerritory: (t) => t in territoryById,
    startingArmies: id === 'classic' ? classicStartingArmies : scaledStartingArmies(territoryIds.length, raw.maxPlayers),
  };
}

export const MAPS: Record<MapId, MapDef> = {
  classic: wrap(classicJson as RawMap),
  world: wrap(worldJson as RawMap),
};

export function getMap(id: string | undefined): MapDef {
  const m = MAPS[(id ?? 'classic') as MapId];
  if (!m) throw new RuleError(`Unknown map "${id}"`);
  return m;
}

export function isMapId(id: unknown): id is MapId {
  return typeof id === 'string' && id in MAPS;
}

// ---- Backward-compatible aliases for the classic map ----
export const CLASSIC = MAPS.classic;
export const TERRITORIES = CLASSIC.territories;
export const TERRITORY_IDS = CLASSIC.territoryIds;
export const TERRITORY_BY_ID = CLASSIC.territoryById;
export const CONTINENTS = CLASSIC.continents;
export const CONTINENT_BY_ID = CLASSIC.continentById;
export const ADJACENCY = CLASSIC.adjacency;
export const EDGE_LIST: ReadonlyArray<readonly [string, string]> = CLASSIC.edges;
export const isAdjacent = CLASSIC.isAdjacent;
export const isTerritory = CLASSIC.isTerritory;
