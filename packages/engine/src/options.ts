/**
 * The single catalogue of game settings. Every consumer derives from it:
 * - the MCP tool schemas (packages/mcp/src/tools.ts) and the game_options tool,
 * - server-side parsing of options from HTTP/MCP (parseOptions),
 * - human/agent-readable summaries (describeOptions), and GET /api/options.
 *
 * Adding a setting: add it to GameOptions + DEFAULT_OPTIONS (types.ts), add a spec here (the compiler
 * enforces one spec per option), and add any map-dependent bound to validateOptions/optionLimits.
 */
import { getMap, MAP_IDS, type MapDef } from './maps.js';
import { maxBlizzards } from './engine.js';
import { tradeBonus } from './cards.js';
import { DEFAULT_OPTIONS, RuleError, type GameOptions } from './types.js';

interface BaseSpec {
  /** Short human label, e.g. "Fog of war". */
  label: string;
  /** What the setting does, written for agents choosing a value. */
  description: string;
}
export interface EnumSpec extends BaseSpec {
  kind: 'enum';
  values: readonly string[];
  /** Short description per value. */
  valueLabels: Record<string, string>;
}
export interface BooleanSpec extends BaseSpec {
  kind: 'boolean';
}
export interface IntSpec extends BaseSpec {
  kind: 'int';
  min: number;
  /** Upper bound on a given map. */
  max: (map: MapDef) => number;
}
export type OptionSpec = EnumSpec | BooleanSpec | IntSpec;

export type OptionKey = keyof GameOptions;

export const OPTION_SPECS: { [K in OptionKey]: OptionSpec } = {
  map: {
    kind: 'enum',
    label: 'Map',
    values: MAP_IDS,
    // Derived from the map data so a new map only needs registering in maps.ts.
    valueLabels: Object.fromEntries(
      MAP_IDS.map((id) => {
        const m = getMap(id);
        return [id, `${m.name.replace(/ \(\d+\)$/, '')}: ${m.territoryIds.length} territories, ${m.continents.length} ${id === 'classic' ? 'continents' : 'regions'}, 2-${m.maxPlayers} players`];
      }),
    ),
    description:
      'Which board to play on: classic (the Hasbro board), world (finer world), world_large (Grand World, the biggest board, made for 8-10 players), europe, usa (US states) or asia. Changing it clamps maxPlayers, neutrals and blizzards to the new map.',
  },
  maxPlayers: {
    kind: 'int',
    label: 'Seats',
    min: 2,
    max: (m) => m.maxPlayers,
    description: 'Number of seats, counting bots and agents (classic up to 6, europe and asia up to 8, world, world_large and usa up to 10).',
  },
  autoSetup: {
    kind: 'boolean',
    label: 'Skip setup',
    description: 'true: no placement phase; starting armies are scattered randomly over each player\'s territories and turn 1 starts at once (territories are always dealt randomly). false: players place their starting armies.',
  },
  randomDeal: {
    kind: 'boolean',
    label: 'Random deal',
    description: 'true: territories are dealt randomly. false: players claim unowned territories one at a time before placing armies. Ignored when autoSetup is true.',
  },
  setupBatch: {
    kind: 'int',
    label: 'Armies per setup turn',
    min: 1,
    max: () => 40,
    description: 'How many starting armies a player places per setup turn (1 = classic, 40 = all at once). Ignored when autoSetup is true.',
  },
  fortifyMode: {
    kind: 'enum',
    label: 'Fortify',
    values: ['connected', 'adjacent'],
    valueLabels: { connected: 'move along any chain of your own territories', adjacent: 'classic: neighbouring territories only' },
    description: 'Where the single end-of-turn fortify move may go.',
  },
  cardValues: {
    kind: 'enum',
    label: 'Card values',
    values: ['progressive', 'fixed'],
    valueLabels: {
      progressive: `escalating for the whole game: ${[0, 1, 2, 3, 4, 5, 6].map(tradeBonus).join(', ')}, then +5`,
      fixed: 'three infantry 4, three cavalry 6, three artillery 8, one of each 10 (a wild completes the best set)',
    },
    description: 'How many armies a traded card set is worth. In both modes a traded card showing a territory you own adds 2 armies there.',
  },
  fogOfWar: {
    kind: 'boolean',
    label: 'Fog of war',
    description: 'true: each player sees only their own territories and the ones next to them; events elsewhere are reported as "fogged". Spectators always see everything.',
  },
  spectatorChat: {
    kind: 'boolean',
    label: 'Spectator chat',
    description: 'true (default): people watching can post in the game chat, marked as spectators. Every player sees them, even under fog of war, so watchers can cheer, heckle and tip players off. false: only seated players can chat.',
  },
  capitals: {
    kind: 'boolean',
    label: 'Capital Conquest',
    description: 'true: after setup each player\'s most garrisoned territory becomes their capital. +2 armies per capital held each turn, a capital defends with up to 3 dice, and capturing a player\'s capital takes over all their territories, troops and cards.',
  },
  neutrals: {
    kind: 'int',
    label: 'Neutral territories',
    min: 0,
    max: (m) => Math.floor(m.territoryIds.length / 3),
    description: 'Games of 3+ players: this many random territories start held by a Neutral army that never attacks or moves (0 = off; at most a third of the map). Two-player games always have the classic Neutral.',
  },
  neutralArmies: {
    kind: 'int',
    label: 'Armies per neutral territory',
    min: 1,
    max: () => 10,
    description: 'Armies on each neutral territory when neutrals is above 0.',
  },
  blizzards: {
    kind: 'int',
    label: 'Blizzards',
    min: 0,
    max: (m) => maxBlizzards(m),
    description: 'This many random territories are frozen for the whole game (0 = off; at most a sixth of the map): nobody owns, attacks, enters or crosses them, and continents count only their open territories. Visible to everyone, even under fog.',
  },
};

export const OPTION_KEYS = Object.keys(OPTION_SPECS) as OptionKey[];

/** Highest value an int option can take on any map (for static schemas). */
export function globalMax(key: OptionKey): number {
  const spec = OPTION_SPECS[key];
  if (spec.kind !== 'int') throw new Error(`${key} is not an int option`);
  return Math.max(...MAP_IDS.map((id) => spec.max(getMap(id))));
}

/** Bounds of every int option on a given map. */
export function optionLimits(mapId: string): Record<string, { min: number; max: number }> {
  const map = getMap(mapId);
  const out: Record<string, { min: number; max: number }> = {};
  for (const key of OPTION_KEYS) {
    const spec = OPTION_SPECS[key];
    if (spec.kind === 'int') out[key] = { min: spec.min, max: spec.max(map) };
  }
  return out;
}

/** JSON-friendly catalogue for GET /api/options and the game_options tool. */
export function optionCatalogue() {
  return {
    defaults: DEFAULT_OPTIONS,
    options: OPTION_KEYS.map((key) => {
      const spec = OPTION_SPECS[key];
      const base = { key, label: spec.label, kind: spec.kind, default: DEFAULT_OPTIONS[key], description: spec.description };
      if (spec.kind === 'enum') return { ...base, values: spec.values, valueLabels: spec.valueLabels };
      if (spec.kind === 'int') return { ...base, min: spec.min, max: globalMax(key) };
      return base;
    }),
    limitsByMap: Object.fromEntries(MAP_IDS.map((id) => [id, optionLimits(id)])),
  };
}

function toBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

/**
 * Parse untrusted options (HTTP body, MCP input). Coerces "true"/"1" and numeric strings, and rejects
 * unknown keys and wrong types with one RuleError listing every problem, so a typo is never silently
 * ignored. Range checks that depend on the map happen later in validateOptions.
 */
export function parseOptions(raw: unknown): Partial<GameOptions> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RuleError('options must be an object');
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    const spec = (OPTION_SPECS as Record<string, OptionSpec>)[key];
    if (!spec) {
      problems.push(`unknown setting "${key}"`);
      continue;
    }
    if (spec.kind === 'boolean') {
      const b = toBool(value);
      if (b === undefined) problems.push(`${key} must be true or false`);
      else out[key] = b;
    } else if (spec.kind === 'int') {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) problems.push(`${key} must be a whole number`);
      else if (n < spec.min) problems.push(`${key} must be at least ${spec.min}`);
      else out[key] = n;
    } else {
      if (typeof value !== 'string' || !spec.values.includes(value)) problems.push(`${key} must be one of ${spec.values.map((v) => `"${v}"`).join(', ')}`);
      else out[key] = value;
    }
  }
  if (problems.length) throw new RuleError(`Invalid game settings: ${problems.join('; ')}. Valid settings: ${OPTION_KEYS.join(', ')}.`);
  return out as Partial<GameOptions>;
}

/** One line per setting, in plain words, for lobbies, agents and logs. */
export function describeOptions(o: GameOptions, tradeCount = 0): string[] {
  const map = getMap(o.map);
  const lines = [
    `Map: ${OPTION_SPECS.map.kind === 'enum' ? (OPTION_SPECS.map as EnumSpec).valueLabels[o.map] : o.map}`,
    `Seats: ${o.maxPlayers}`,
    o.autoSetup
      ? 'Setup: skipped; starting armies are scattered randomly and turn 1 starts at once'
      : `Setup: ${o.randomDeal ? 'territories dealt randomly' : 'players claim territories one at a time'}, then ${o.setupBatch === 1 ? '1 army' : `${o.setupBatch} armies`} per setup turn`,
    `Fortify: ${(OPTION_SPECS.fortifyMode as EnumSpec).valueLabels[o.fortifyMode]}`,
    o.cardValues === 'fixed'
      ? `Cards: fixed values (${(OPTION_SPECS.cardValues as EnumSpec).valueLabels.fixed})`
      : `Cards: progressive, next set worth ${tradeBonus(tradeCount)} (then ${[1, 2, 3].map((i) => tradeBonus(tradeCount + i)).join(', ')}...)`,
    `Fog of war: ${o.fogOfWar ? 'on (players see only their territories and neighbours)' : 'off'}`,
    `Capital Conquest: ${o.capitals ? 'on (+2 per capital held, capitals defend with 3 dice, capture a capital to take that player over)' : 'off'}`,
    `Neutral territories: ${o.neutrals > 0 ? `${o.neutrals} with ${o.neutralArmies} arm${o.neutralArmies === 1 ? 'y' : 'ies'} each (games of 3+ players)` : 'off'}`,
    `Blizzards: ${o.blizzards > 0 ? `${o.blizzards} frozen territories (max ${maxBlizzards(map)} on this map)` : 'off'}`,
  ];
  return lines;
}
