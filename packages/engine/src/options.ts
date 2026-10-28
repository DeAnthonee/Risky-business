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
import { ICE_DEFAULTS } from './ice.js';
import { looksLikeGenId, parseGenId } from './procgen.js';
import { maxBlizzards } from './engine.js';
import { tradeBonus } from './cards.js';
import { timerOf } from './timeout.js';
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
      'Which board to play on: classic (the Hasbro board), world (finer world), world_large (Grand World, the biggest board, made for 8-10 players), europe, greater_europe (Greater Europe: 116 smaller territories, up to 10 players), europe_classic (Europe Advanced: 84 territories in 14 regions such as the Russian Empire and the Orient, 2-6 players), usa (US states), asia, fantasy (Realms of Halvaren, an original fantasy world), skirmish (Four Crowns: a small, fast 24-territory board for up to 4 players), bohemia (Bohemia: an inland kingdom of 42 territories in 8 regions cut by a river, crossed only at fords, 2-6 players) nine_realms (The Nine Realms: 58 territories on one long north-south continent whose regions meet only at narrow passes, up to 8 players) or hexworld (Hex Earth: the real world on a rotatable hexagon globe, 80 territories in 14 regions with sea links across every ocean, up to 10 players). A generated board is also accepted by its id, gen1-s<seed>-p<seats>-t<territories> (e.g. gen1-s42-p4-t20: a hex board for up to 4 players with 20 territories, built from seed 42; the same id is always the same board). Changing it clamps maxPlayers, neutrals and blizzards to the new map.',
  },
  maxPlayers: {
    kind: 'int',
    label: 'Seats',
    min: 2,
    max: (m) => m.maxPlayers,
    description: 'Number of seats, counting bots and agents (skirmish up to 4, classic, europe_classic and bohemia up to 6, europe, asia and nine_realms up to 8, world, world_large, greater_europe, usa, fantasy and hexworld up to 10).',
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
    values: ['progressive', 'fixed', 'exponential'],
    valueLabels: {
      progressive: `escalating for the whole game: ${[0, 1, 2, 3, 4, 5, 6].map(tradeBonus).join(', ')}, then +5`,
      exponential: 'per player: 5, 7, 10, 13, ...; ceil(previous × 1.3) through trade 25, then +1000 per trade',
      fixed: 'three infantry 4, three cavalry 6, three artillery 8, one of each 10 (a wild completes the best set)',
    },
    description: 'How many armies a traded card set is worth. In all modes a traded card showing a territory you own adds 2 armies there.',
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
  firstRoundBonus: {
    kind: 'boolean',
    label: 'Late-turn bonus (round 1)',
    description: 'true (default): in round 1 only, the Nth player in turn order receives at least N armies (1st-3rd get their normal 3+, 4th at least 4, 5th at least 5, up to 10th at least 10), offsetting the disadvantage of going later. false: everyone gets the normal reinforcements.',
  },
  balancedBlitz: {
    kind: 'boolean',
    label: 'Balanced blitz',
    description: 'true: a blitz attack is rolled 5 times with real dice and the middle outcome is the one that happens, so blitzes land close to the odds (strong attacks rarely collapse, long shots rarely come off). Single rolls (no blitz) stay fully random. false (default): every roll is pure luck.',
  },
  capitals: {
    kind: 'boolean',
    label: 'Capital Conquest',
    description: 'true: after setup each player\'s most garrisoned territory becomes their capital and gets 3 extra armies on the spot. +2 armies per capital held each turn and a capital defends with up to 3 dice. Losing your capital does not knock you out. Holding every capital at once wins the game (eliminating everyone else still wins too).',
  },
  chooseCapitals: {
    kind: 'boolean',
    label: 'Choose capitals',
    description: 'Capital Conquest only. true: after setup (even with random deal and random placement), each player in turn order picks one of their own territories as their capital before turn 1. false (default): each player\'s most garrisoned territory becomes their capital automatically. Either way every capital gets 3 extra armies when it is set.',
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
    description: 'This many random territories are frozen for the whole game (0 = off; up to 8, or a sixth of the map on bigger boards): nobody owns, attacks, enters or crosses them, and continents count only their open territories. Visible to everyone, even under fog.',
  },
  stallFogLift: {
    kind: 'int',
    label: 'Lift fog when stalled',
    min: 0,
    max: () => 20,
    description:
      'Fog of war games only: after this many full rounds in a row with no territory captured by anyone, the fog lifts for the rest of the game and everyone sees the whole board (0 = off). Breaks stalls where every player only reinforces.',
  },
  stallStorm: {
    kind: 'int',
    label: 'Storm when stalled',
    min: 0,
    max: () => 20,
    description:
      'After this many full rounds in a row with no territory captured by anyone, a storm hits at every round start until someone captures: each stack of more than 10 armies loses a fifth of them (0 = off).',
  },
  closingIce: {
    kind: 'boolean',
    label: 'Closing ice',
    description: 'true: from iceStartMinutes after the start, the ice closes in from the North and South poles one ring at a time (sea included on a globe board; other boards by height), every iceEveryRounds rounds (or every iceEveryMinutes minutes, mid-turn too), until iceSafeRings rings are left open in the middle. A territory it reaches becomes a blizzard: its armies retreat to the owner\'s strongest open neighbour or are lost, and a player with no land left is out. On in mega tournaments. false (default): off.',
  },
  iceStartMinutes: {
    kind: 'int',
    label: 'Ice starts after (minutes)',
    min: 0,
    max: () => 600,
    description: 'Closing ice only: minutes after the game starts that the ice starts closing in (default 15).',
  },
  iceEveryRounds: {
    kind: 'int',
    label: 'Ice advances every (rounds)',
    min: 1,
    max: () => 10,
    description: 'Closing ice only: the ice advances at the start of every this-many rounds (default 1). Ignored when iceEveryMinutes is set.',
  },
  iceEveryMinutes: {
    kind: 'int',
    label: 'Ice advances every (minutes)',
    min: 0,
    max: () => 60,
    description: 'Closing ice only: on a clock, the ice advances every this-many minutes after it starts, whoever is moving, even in the middle of a turn (a conquest it reaches is settled; a player frozen out on their turn is passed). 0 (default): by rounds, iceEveryRounds.',
  },
  iceRingsPerStep: {
    kind: 'int',
    label: 'Ice rings per step',
    min: 1,
    max: () => 5,
    description: 'Closing ice only: how many rings of hexes each front (north and south) takes per step (default 1).',
  },
  iceSafeRings: {
    kind: 'int',
    label: 'Ice-free rings at the end',
    min: 1,
    max: () => 40,
    description: 'Closing ice only: the ice stops when this many rings are left open round the middle (default 6).',
  },
  stallEnd: {
    kind: 'int',
    label: 'End a stalled game',
    min: 0,
    max: () => 20,
    description:
      'This many more full rounds with no capture after the last stall breaker (fog lift, storm) came on, the game ends: decided on standing, by territories, then armies, then dice (0 = off).',
  },
  turnTimer: {
    kind: 'enum',
    label: 'Turn timer',
    values: ['off', 'move', 'turn'],
    valueLabels: {
      off: 'no timer',
      move: 'per move: turnTimerSeconds for each decision (placing, each attack, occupying, fortifying)',
      turn: 'per turn: turnTimerSeconds for the whole turn',
    },
    description:
      'A clock for human and agent seats (bots are never timed). When it runs out the player is skipped: pending armies are placed for them over their border territories (weakest first), a pending conquest is occupied with the minimum, and the turn ends with no more attacks and no fortify. Per move, running out while placing only places the armies and the turn goes on with a fresh clock. Setup and capital picks are made for you too. Agents: act fast; get_state and wait_for_turn show the seconds left.',
  },
  turnTimerSeconds: {
    kind: 'int',
    label: 'Seconds on the timer',
    min: 5,
    max: () => 600,
    description: 'Seconds per move or per turn when turnTimer is on (5-600, default 15). Ignored when turnTimer is off.',
  },
};

export const OPTION_KEYS = Object.keys(OPTION_SPECS) as OptionKey[];

/** Highest value an int option can take on any map (for static schemas). */
export function globalMax(key: OptionKey): number {
  const spec = OPTION_SPECS[key];
  if (spec.kind !== 'int') throw new Error(`${key} is not an int option`);
  return Math.max(...MAP_IDS.map((id) => spec.max(getMap(id))));
}

/** An int option's upper bound when it is the same on every map, else null. */
function fixedMax(key: OptionKey): number | null {
  const spec = OPTION_SPECS[key];
  if (spec.kind !== 'int') return null;
  const maxes = new Set(MAP_IDS.map((id) => spec.max(getMap(id))));
  return maxes.size === 1 ? [...maxes][0] : null;
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
      // Optional settings (stallFogLift, stallStorm, stallEnd, closing ice) are absent from DEFAULT_OPTIONS: their default
      // is off (0), or the closing ice's own numbers.
      const optional: Record<string, unknown> = { closingIce: false, ...ICE_DEFAULTS };
      const base = { key, label: spec.label, kind: spec.kind, default: DEFAULT_OPTIONS[key] ?? optional[key] ?? 0, description: spec.description };
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
      // A bound that is the same on every map is checked here; map-dependent ones in validateOptions.
      else if (fixedMax(key as OptionKey) !== null && n > fixedMax(key as OptionKey)!) problems.push(`${key} must be at most ${fixedMax(key as OptionKey)}`);
      else out[key] = n;
    } else if (key === 'map' && looksLikeGenId(value)) {
      // A generated board: the id carries its seed and size (procgen.ts).
      try {
        parseGenId(value);
        out[key] = value;
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
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
    `Map: ${(OPTION_SPECS.map as EnumSpec).valueLabels[o.map] ?? `${map.name}: ${map.territoryIds.length} territories, ${looksLikeGenId(o.map) ? `${map.continents.length} regions, 2-${map.maxPlayers} players (generated from its id)` : `2-${map.maxPlayers} players (legacy board, not offered for new games)`}`}`,
    `Seats: ${o.maxPlayers}`,
    o.autoSetup
      ? 'Setup: skipped; starting armies are scattered randomly and turn 1 starts at once'
      : `Setup: ${o.randomDeal ? 'territories dealt randomly' : 'players claim territories one at a time'}, then ${o.setupBatch === 1 ? '1 army' : `${o.setupBatch} armies`} per setup turn`,
    `Fortify: ${(OPTION_SPECS.fortifyMode as EnumSpec).valueLabels[o.fortifyMode]}`,
    o.cardValues === 'fixed'
      ? `Cards: fixed values (${(OPTION_SPECS.cardValues as EnumSpec).valueLabels.fixed})`
      : o.cardValues === 'exponential' ? `Cards: exponential per player, 5 initially, ceil(previous × 1.3) through trade 25, then +1000; see each player’s personal trade count`
      : `Cards: progressive, next set worth ${tradeBonus(tradeCount)} (then ${[1, 2, 3].map((i) => tradeBonus(tradeCount + i)).join(', ')}...)`,
    `Balanced blitz: ${o.balancedBlitz ? 'on (a blitz plays out the middle of 5 real blitzes, close to the odds; single rolls stay random)' : 'off (every roll is pure luck)'}`,
    `Fog of war: ${o.fogOfWar ? 'on (players see only their territories and neighbours, plus opponents’ reinforcement income, card counts and sets traded; troop/territory counts and income breakdown are hidden)' : 'off'}`,
    `Capital Conquest: ${o.capitals ? `on (+2 per capital held, capitals defend with 3 dice, hold every capital to win; ${o.chooseCapitals ? 'players choose their capitals before turn 1' : 'capital = most garrisoned territory after setup'})` : 'off'}`,
    `Neutral territories: ${o.neutrals > 0 ? `${o.neutrals} with ${o.neutralArmies} arm${o.neutralArmies === 1 ? 'y' : 'ies'} each (games of 3+ players)` : 'off'}`,
    `Blizzards: ${o.blizzards > 0 ? `${o.blizzards} frozen territories (max ${maxBlizzards(map)} on this map)` : 'off'}`,
    ...(o.fogOfWar ? [`Stall breaker: ${(o.stallFogLift ?? 0) > 0 ? `the fog lifts for good after ${o.stallFogLift} full round${o.stallFogLift === 1 ? '' : 's'} with no territory captured` : 'off'}`] : []),
    ...((o.stallStorm ?? 0) > 0 ? [`Storm: after ${o.stallStorm} full round${o.stallStorm === 1 ? '' : 's'} with no territory captured, every round start each stack of more than 10 armies loses a fifth of them, until someone captures`] : []),
    ...(o.closingIce ? [`Closing ice: from ${o.iceStartMinutes ?? 15} minutes in, the ice closes in from both poles ${o.iceRingsPerStep ?? 1} ring${(o.iceRingsPerStep ?? 1) === 1 ? '' : 's'} at a time every ${o.iceEveryMinutes ? `${o.iceEveryMinutes === 1 ? 'minute' : `${o.iceEveryMinutes} minutes`} (mid-turn too)` : (o.iceEveryRounds ?? 1) === 1 ? 'round' : `${o.iceEveryRounds} rounds`}, until ${o.iceSafeRings ?? 6} rings are left; frozen land is a blizzard, its armies retreat to the owner's strongest open neighbour or are lost, and a player with no land is out`] : []),
    ...((o.stallEnd ?? 0) > 0 ? [`Stalemate: ${o.stallEnd} more round${o.stallEnd === 1 ? '' : 's'} with no capture after the last stall breaker came on, the game ends decided on standing (territories, armies, dice)`] : []),
    `Turn timer: ${timerOf(o) ? `${timerOf(o)!.seconds}s per ${timerOf(o)!.mode} for human and agent seats; on a timeout the player is skipped (armies placed for them, no attacks, no fortify)` : 'off'}`,
  ];
  return lines;
}
