import { getMap, isMapId, type MapDef } from './maps.js';
import { buildDeck, findSets, isValidSet, setValue } from './cards.js';
import { createRng, nextInt, rollDie, shuffle, type Rng } from './rng.js';
import {
  CAPITAL_BONUS,
  CAPITAL_DEFENSE_DICE,
  CAPITAL_PLACEMENT_ARMIES,
  DEFAULT_OPTIONS,
  RuleError,
  type Action,
  type ActionResult,
  type AttackAction,
  type Card,
  type FortifyAction,
  type GameEvent,
  type GameOptions,
  type GameState,
  type PlaceAction,
  type Player,
  type PlayerId,
  type ReinforcementBreakdown,
  type TerritoryId,
  type TradeAction,
} from './types.js';

export const PLAYER_COLORS = ['#e63946', '#2a9d8f', '#457bd9', '#f4a261', '#9b5de5', '#f9c74f', '#06d6a0', '#ff70a6', '#b5651d', '#00b4d8'];
export const NEUTRAL_COLOR = '#8d8d8d';
export const NEUTRAL_ID = 'neutral';

/** Starting armies per player for a player count on a map (classic table for the classic map). */
export function startingArmies(playerCount: number, mapId: string = 'classic'): number {
  return getMap(mapId).startingArmies(playerCount);
}

function mapOf(state: GameState): MapDef {
  return getMap(state.options.map);
}

// ------------------------------------------------------------------
// Game creation / lobby
// ------------------------------------------------------------------

export function createGame(id: string, options: Partial<GameOptions> = {}, seed?: number): GameState {
  const opts: GameOptions = { ...DEFAULT_OPTIONS, ...options };
  validateOptions(opts);
  const map = getMap(opts.map);
  const s = seed ?? ((Math.random() * 0xffffffff) >>> 0);
  return {
    id,
    version: 0,
    phase: 'lobby',
    options: opts,
    players: [],
    turnOrder: [],
    currentPlayer: null,
    turnNumber: 0,
    round: 0,
    territories: Object.fromEntries(map.territoryIds.map((t) => [t, { owner: null, armies: 0 }])),
    deck: [],
    discard: [],
    tradeCount: 0,
    pendingConquest: null,
    capitals: {},
    blizzards: [],
    fortifiedThisTurn: false,
    winner: null,
    seed: s,
    rngState: s >>> 0,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
}

export function validateOptions(o: GameOptions): void {
  if (!Number.isInteger(o.setupBatch) || o.setupBatch < 1 || o.setupBatch > 40)
    throw new RuleError('setupBatch must be an integer between 1 and 40');
  if (o.fortifyMode !== 'adjacent' && o.fortifyMode !== 'connected')
    throw new RuleError("fortifyMode must be 'adjacent' or 'connected'");
  if (!isMapId(o.map)) throw new RuleError(`Unknown map "${String(o.map)}"`);
  if (o.cardValues !== 'progressive' && o.cardValues !== 'fixed') throw new RuleError("cardValues must be 'progressive' or 'fixed'");
  const map = getMap(o.map);
  const maxBliz = maxBlizzards(map);
  if (!Number.isInteger(o.blizzards) || o.blizzards < 0 || o.blizzards > maxBliz)
    throw new RuleError(`blizzards must be an integer between 0 and ${maxBliz} on the ${map.name} map`);
  const maxNeutrals = Math.floor(map.territoryIds.length / 3);
  if (!Number.isInteger(o.neutrals) || o.neutrals < 0 || o.neutrals > maxNeutrals)
    throw new RuleError(`neutrals must be an integer between 0 and ${maxNeutrals} on the ${map.name} map`);
  if (!Number.isInteger(o.neutralArmies) || o.neutralArmies < 1 || o.neutralArmies > 10)
    throw new RuleError('neutralArmies must be an integer between 1 and 10');
  if (!Number.isInteger(o.maxPlayers) || o.maxPlayers < 2 || o.maxPlayers > map.maxPlayers)
    throw new RuleError(`maxPlayers must be between 2 and ${map.maxPlayers} on the ${map.name} map`);
}

export function setOptions(state: GameState, options: Partial<GameOptions>): GameState {
  if (state.phase !== 'lobby') throw new RuleError('Options can only be changed in the lobby');
  const next = clone(state);
  next.options = { ...next.options, ...options };
  // Switching maps: clamp maxPlayers to the new map's limit rather than rejecting.
  if (options.map && options.map !== state.options.map && options.maxPlayers === undefined) {
    next.options.maxPlayers = Math.min(next.options.maxPlayers, getMap(options.map).maxPlayers);
  }
  if (options.map && options.map !== state.options.map && options.blizzards === undefined) {
    next.options.blizzards = Math.min(next.options.blizzards ?? 0, maxBlizzards(getMap(options.map)));
  }
  if (options.map && options.map !== state.options.map && options.neutrals === undefined) {
    next.options.neutrals = Math.min(next.options.neutrals ?? 0, Math.floor(getMap(options.map).territoryIds.length / 3));
  }
  validateOptions(next.options);
  if (next.players.length > next.options.maxPlayers) throw new RuleError('maxPlayers is below the current player count');
  if (options.map && options.map !== state.options.map) {
    next.territories = Object.fromEntries(getMap(next.options.map).territoryIds.map((t) => [t, { owner: null, armies: 0 }]));
  }
  next.version++;
  return next;
}

export function addPlayer(state: GameState, id: PlayerId, name: string, isBot = false): GameState {
  if (state.phase !== 'lobby') throw new RuleError('Game already started');
  if (state.players.some((p) => p.id === id)) throw new RuleError('Player id already in game');
  if (state.players.length >= state.options.maxPlayers) throw new RuleError('Game is full');
  if (id === NEUTRAL_ID) throw new RuleError('Reserved player id');
  const next = clone(state);
  const usedColors = new Set(next.players.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[next.players.length % PLAYER_COLORS.length];
  next.players.push({
    id,
    name: name.trim().slice(0, 24) || `Player ${next.players.length + 1}`,
    color,
    isBot,
    isNeutral: false,
    alive: true,
    cards: [],
    armiesToPlace: 0,
    conqueredThisTurn: false,
    order: next.players.length,
  });
  next.version++;
  return next;
}

export function renamePlayer(state: GameState, id: PlayerId, name: string): GameState {
  if (state.phase !== 'lobby') throw new RuleError('Names can only be changed in the lobby');
  const clean = name.trim().slice(0, 24);
  if (!clean) throw new RuleError('Name cannot be empty');
  const next = clone(state);
  const p = next.players.find((x) => x.id === id);
  if (!p) throw new RuleError('Unknown player');
  p.name = clean;
  next.version++;
  return next;
}

export function removePlayer(state: GameState, id: PlayerId): GameState {
  if (state.phase !== 'lobby') throw new RuleError('Cannot leave a game in progress; surrender instead');
  const next = clone(state);
  next.players = next.players.filter((p) => p.id !== id);
  next.players.forEach((p, i) => (p.order = i));
  next.version++;
  return next;
}

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------

export function startGame(state: GameState): ActionResult {
  if (state.phase !== 'lobby') throw new RuleError('Game already started');
  const humansAndBots = state.players.filter((p) => !p.isNeutral);
  const map = mapOf(state);
  if (humansAndBots.length < 2) throw new RuleError('Need at least 2 players');
  if (humansAndBots.length > map.maxPlayers) throw new RuleError(`At most ${map.maxPlayers} players on this map`);

  const next = clone(state);
  const rng = rngOf(next);
  const events: GameEvent[] = [];
  const armies = map.startingArmies(humansAndBots.length);

  // Two-player games use a neutral third army (classic rules); larger games get one when the neutrals option is on.
  const neutralTerritories = humansAndBots.length === 2 ? 0 : Math.min(next.options.neutrals ?? 0, map.territoryIds.length - humansAndBots.length);
  if (humansAndBots.length === 2 || neutralTerritories > 0) {
    next.players.push({
      id: NEUTRAL_ID,
      name: 'Neutral',
      color: NEUTRAL_COLOR,
      isBot: false,
      isNeutral: true,
      alive: true,
      cards: [],
      armiesToPlace: 0,
      conqueredThisTurn: false,
      order: 2,
    });
  }

  // Randomise turn order (classic: highest roll goes first).
  const order = shuffle(
    rng,
    next.players.filter((p) => !p.isNeutral).map((p) => p.id),
  );
  next.turnOrder = order;
  next.players.forEach((p) => {
    p.order = p.isNeutral ? order.length : order.indexOf(p.id);
    p.armiesToPlace = p.isNeutral && neutralTerritories > 0 ? 0 : armies;
    p.cards = [];
    p.alive = true;
  });

  next.deck = shuffle(rng, buildDeck(map));
  next.discard = [];

  // Blizzards: block some territories for the whole game before anything is dealt.
  next.blizzards = pickBlizzards(map, next.options.blizzards, rng);
  for (const t of next.blizzards) next.territories[t] = { owner: null, armies: 0 };
  if (next.blizzards.length) events.push({ type: 'blizzards', territories: [...next.blizzards] });
  const playable = map.territoryIds.filter((t) => !next.blizzards.includes(t));

  // Neutral territories (3+ players): set aside at random from the open territories before the deal, each with a fixed garrison.
  let dealable = playable;
  if (neutralTerritories > 0) {
    const picked = shuffle(rng, playable).slice(0, Math.min(neutralTerritories, playable.length - humansAndBots.length));
    for (const t of picked) next.territories[t] = { owner: NEUTRAL_ID, armies: next.options.neutralArmies };
    dealable = playable.filter((t) => !picked.includes(t));
  }

  // Deal territories round-robin in turn order (neutral included for 2p).
  const dealOrder = [...order, ...(neutralTerritories > 0 ? [] : next.players.filter((p) => p.isNeutral).map((p) => p.id))];
  const randomDeal = next.options.randomDeal || next.options.autoSetup;
  if (randomDeal) {
    const shuffledTerritories = shuffle(rng, dealable);
    shuffledTerritories.forEach((t, i) => {
      const owner = dealOrder[i % dealOrder.length];
      next.territories[t] = { owner, armies: 1 };
      playerOf(next, owner).armiesToPlace -= 1;
    });
  } else {
    // Claiming phase: nobody owns anything yet; players claim one per setup turn.
    for (const t of dealable) next.territories[t] = { owner: null, armies: 0 };
  }

  // Neutral player: auto-distribute all remaining armies evenly.
  const neutral = next.players.find((p) => p.isNeutral);
  if (neutral && randomDeal) {
    distributeEvenly(next, neutral, rng);
  }

  next.startedAt = Date.now();
  events.push({ type: 'game_started', players: next.players.map((p) => p.id), turnOrder: order });

  if (next.options.autoSetup) {
    // Skip the placement phase: every player's starting armies land on random territories they own.
    for (const p of next.players) if (!p.isNeutral) distributeRandomly(next, p, rng);
    saveRng(next, rng);
    next.version++;
    beginFirstTurn(next, events);
    return { state: next, events };
  }

  next.phase = 'setup';
  next.currentPlayer = order[0];
  saveRng(next, rng);
  next.version++;
  events.push({ type: 'phase', phase: 'setup', player: next.currentPlayer });

  // If nobody has anything to place (impossible with classic numbers, but keep safe) start turn 1.
  if (next.players.every((p) => p.armiesToPlace === 0)) beginFirstTurn(next, events);
  return { state: next, events };
}

/** Drop each remaining army on a uniformly random territory the player owns. */
function distributeRandomly(state: GameState, player: Player, rng: Rng): void {
  const owned = mapOf(state).territoryIds.filter((t) => state.territories[t].owner === player.id);
  if (owned.length === 0) {
    player.armiesToPlace = 0;
    return;
  }
  while (player.armiesToPlace > 0) {
    state.territories[owned[nextInt(rng, owned.length)]].armies += 1;
    player.armiesToPlace -= 1;
  }
}

function distributeEvenly(state: GameState, player: Player, rng: Rng): void {
  const owned = mapOf(state).territoryIds.filter((t) => state.territories[t].owner === player.id);
  if (owned.length === 0) {
    player.armiesToPlace = 0;
    return;
  }
  let i = nextInt(rng, owned.length);
  while (player.armiesToPlace > 0) {
    state.territories[owned[i % owned.length]].armies += 1;
    player.armiesToPlace -= 1;
    i++;
  }
}

// ------------------------------------------------------------------
// Action dispatch
// ------------------------------------------------------------------

export function applyAction(state: GameState, playerId: PlayerId, action: Action): ActionResult {
  if (state.phase === 'lobby') throw new RuleError('Game has not started');
  if (state.phase === 'finished') throw new RuleError('Game is over');
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new RuleError('Unknown player');
  if (player.isNeutral) throw new RuleError('Neutral cannot act');

  if (action.type === 'surrender') return surrender(state, playerId);

  if (state.currentPlayer !== playerId) throw new RuleError('Not your turn');
  if (!player.alive) throw new RuleError('You have been eliminated');

  const next = clone(state);
  const events: GameEvent[] = [];
  switch (action.type) {
    case 'place':
      doPlace(next, playerId, action, events);
      break;
    case 'trade':
      doTrade(next, playerId, action, events);
      break;
    case 'choose_capital':
      doChooseCapital(next, playerId, action.territory, events);
      break;
    case 'attack':
      doAttack(next, playerId, action, events);
      break;
    case 'occupy':
      doOccupy(next, playerId, action.armies, events);
      break;
    case 'end_attack':
      doEndAttack(next, playerId, events);
      break;
    case 'fortify':
      doFortify(next, playerId, action, events);
      break;
    case 'end_turn':
      doEndTurn(next, playerId, events);
      break;
    default:
      throw new RuleError(`Unknown action type ${(action as { type: string }).type}`);
  }
  next.version++;
  return { state: next, events };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function clone<T>(x: T): T {
  return structuredClone(x);
}

function rngOf(state: GameState): Rng {
  return createRng(state.rngState);
}

function saveRng(state: GameState, rng: Rng): void {
  state.rngState = rng.state;
}

export function playerOf(state: GameState, id: PlayerId): Player {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new RuleError(`Unknown player ${id}`);
  return p;
}

export function territoriesOf(state: GameState, id: PlayerId): TerritoryId[] {
  return mapOf(state).territoryIds.filter((t) => state.territories[t].owner === id);
}

export function armiesOf(state: GameState, id: PlayerId): number {
  return territoriesOf(state, id).reduce((n, t) => n + state.territories[t].armies, 0);
}

/** True if the territory is an impassable blizzard (blizzards option). */
export function isBlizzard(state: Pick<GameState, 'blizzards'>, t: TerritoryId): boolean {
  return (state.blizzards ?? []).includes(t);
}

/** A player controls a continent when they own every non-blizzard territory in it. */
export function controlsContinent(state: Pick<GameState, 'territories' | 'blizzards'>, territories: TerritoryId[], id: PlayerId): boolean {
  const open = territories.filter((t) => !isBlizzard(state, t));
  return open.length > 0 && open.every((t) => state.territories[t].owner === id);
}

function unclaimedTerritories(state: GameState): TerritoryId[] {
  return mapOf(state).territoryIds.filter((t) => state.territories[t].owner === null && !isBlizzard(state, t));
}

/** Most blizzards a map allows: 8, or a sixth of its territories on bigger maps. */
export function maxBlizzards(map: MapDef): number {
  return Math.max(8, Math.floor(map.territoryIds.length / 6));
}

/**
 * Pick `count` random blizzard territories. A territory is only frozen if the open territories stay one
 * connected network and every continent keeps at least two open territories, so the game stays winnable
 * and every continent bonus stays reachable.
 */
export function pickBlizzards(map: MapDef, count: number, rng: Rng): TerritoryId[] {
  if (count <= 0) return [];
  const chosen = new Set<TerritoryId>();
  const continentOf = new Map<TerritoryId, TerritoryId[]>();
  for (const c of map.continents) for (const t of c.territories) continentOf.set(t, c.territories);
  for (const t of shuffle(rng, map.territoryIds)) {
    if (chosen.size >= count) break;
    const cont = continentOf.get(t) ?? [];
    if (cont.filter((x) => x !== t && !chosen.has(x)).length < 2) continue;
    chosen.add(t);
    if (!openNetworkConnected(map, chosen)) chosen.delete(t);
  }
  return map.territoryIds.filter((t) => chosen.has(t));
}

function openNetworkConnected(map: MapDef, blocked: Set<TerritoryId>): boolean {
  const open = map.territoryIds.filter((t) => !blocked.has(t));
  if (open.length === 0) return false;
  const seen = new Set<TerritoryId>([open[0]]);
  const queue = [open[0]];
  while (queue.length) {
    const t = queue.pop()!;
    for (const n of map.adjacency[t]) if (!blocked.has(n) && !seen.has(n)) (seen.add(n), queue.push(n));
  }
  return seen.size === open.length;
}

export function continentsOf(state: GameState, id: PlayerId) {
  return mapOf(state).continents.filter((c) => controlsContinent(state, c.territories, id));
}

export function capitalsHeldBy(state: GameState, id: PlayerId): TerritoryId[] {
  return Object.values(state.capitals).filter((t) => state.territories[t]?.owner === id);
}

export function reinforcementsFor(state: GameState, id: PlayerId): ReinforcementBreakdown {
  const owned = territoriesOf(state, id).length;
  const fromTerritories = Math.max(3, Math.floor(owned / 3));
  const continents = continentsOf(state, id).map((c) => ({ id: c.id, bonus: c.bonus }));
  const capitals = state.options.capitals ? capitalsHeldBy(state, id).length : 0;
  const fromCapitals = capitals * CAPITAL_BONUS;
  const total = fromTerritories + continents.reduce((n, c) => n + c.bonus, 0) + fromCapitals;
  return { territories: owned, fromTerritories, continents, capitals, fromCapitals, total };
}

/** Does the player have to trade cards right now before doing anything else? */
export function mustTrade(state: GameState, id: PlayerId): boolean {
  const p = playerOf(state, id);
  if (state.phase === 'reinforce') return p.cards.length >= 5;
  if (state.phase === 'attack') return p.cards.length >= 6;
  return false;
}

function requireTerritory(state: GameState, id: string): void {
  if (!mapOf(state).isTerritory(id)) throw new RuleError(`Unknown territory ${id}`);
}

/** Territories reachable from `from` through territories owned by `owner` (excluding from). */
export function connectedTerritories(state: GameState, owner: PlayerId, from: TerritoryId): Set<TerritoryId> {
  const adjacency = mapOf(state).adjacency;
  const seen = new Set<TerritoryId>([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of adjacency[cur]) {
      if (!seen.has(n) && state.territories[n].owner === owner) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  seen.delete(from);
  return seen;
}

// ------------------------------------------------------------------
// Setup + reinforce: place
// ------------------------------------------------------------------

function doPlace(state: GameState, playerId: PlayerId, action: PlaceAction, events: GameEvent[]): void {
  const player = playerOf(state, playerId);
  if (state.pendingConquest) throw new RuleError('You must occupy the conquered territory first');
  if (state.phase !== 'setup' && state.phase !== 'reinforce' && state.phase !== 'attack')
    throw new RuleError('Cannot place armies now');
  if (state.phase === 'attack' && player.armiesToPlace === 0) throw new RuleError('No armies to place');
  if (state.phase === 'reinforce' && mustTrade(state, playerId))
    throw new RuleError('You hold 5 or more cards and must trade a set first');

  const entries = Object.entries(action.placements ?? {});
  if (entries.length === 0) throw new RuleError('No placements given');
  let total = 0;
  for (const [t, n] of entries) {
    requireTerritory(state, t);
    if (!Number.isInteger(n) || n <= 0) throw new RuleError(`Invalid army count for ${t}`);
    total += n;
  }

  if (state.phase === 'setup') {
    const limit = Math.min(player.armiesToPlace, state.options.setupBatch);
    const unclaimed = unclaimedTerritories(state);
    if (unclaimed.length > 0) {
      // Claiming phase: exactly one army on one unclaimed territory.
      if (entries.length !== 1 || total !== 1) throw new RuleError('Claim exactly one unclaimed territory with one army');
      const [t] = entries[0];
      if (state.territories[t].owner !== null) throw new RuleError(`${t} is already claimed`);
      state.territories[t] = { owner: playerId, armies: 1 };
      player.armiesToPlace -= 1;
      events.push({ type: 'placed', player: playerId, territory: t, armies: 1 });
      // Neutral in claim mode: nothing (2p claim mode gives the neutral no territories; its armies are dropped).
      advanceSetup(state, events);
      return;
    }
    if (total > limit) throw new RuleError(`You may place at most ${limit} armies this setup turn`);
  } else if (total > player.armiesToPlace) {
    throw new RuleError(`You only have ${player.armiesToPlace} armies to place`);
  }

  for (const [t, n] of entries) {
    if (state.territories[t].owner !== playerId) throw new RuleError(`You do not own ${t}`);
  }
  for (const [t, n] of entries) {
    state.territories[t].armies += n;
    player.armiesToPlace -= n;
    events.push({ type: 'placed', player: playerId, territory: t, armies: n });
  }

  if (state.phase === 'setup') {
    advanceSetup(state, events);
  } else if (state.phase === 'reinforce' && player.armiesToPlace === 0) {
    state.phase = 'attack';
    events.push({ type: 'phase', phase: 'attack', player: playerId });
  }
}

function advanceSetup(state: GameState, events: GameEvent[]): void {
  const order = state.turnOrder;
  // Neutral armies for claim mode: once all territories are claimed, drop neutral's leftover armies evenly.
  const neutral = state.players.find((p) => p.isNeutral);
  if (neutral && neutral.armiesToPlace > 0 && unclaimedTerritories(state).length === 0) {
    const rng = rngOf(state);
    distributeEvenly(state, neutral, rng);
    saveRng(state, rng);
  }
  if (order.every((id) => !playerOf(state, id).alive || playerOf(state, id).armiesToPlace === 0)) {
    beginFirstTurn(state, events);
    return;
  }
  // Next living player in order who still has armies to place.
  const idx = order.indexOf(state.currentPlayer!);
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(idx + i) % order.length];
    const cp = playerOf(state, cand);
    if (cp.alive && cp.armiesToPlace > 0) {
      state.currentPlayer = cand;
      return;
    }
  }
}

function beginFirstTurn(state: GameState, events: GameEvent[]): void {
  state.turnNumber = 0;
  state.round = 1;
  if (state.options.capitals && Object.keys(state.capitals).length === 0) {
    if (state.options.chooseCapitals) {
      // Players pick their own capitals, in turn order, before anyone takes a turn.
      const picker = nextCapitalPicker(state);
      if (picker) {
        state.phase = 'capitals';
        state.currentPlayer = picker;
        events.push({ type: 'phase', phase: 'capitals', player: picker });
        return;
      }
    }
    assignCapitals(state, events);
  }
  const first = state.turnOrder.find((id) => playerOf(state, id).alive);
  if (!first) return;
  beginTurn(state, first, events);
}

/** Next player (in turn order) who still has to choose a capital, if any. */
function nextCapitalPicker(state: GameState): PlayerId | undefined {
  return state.turnOrder.find((id) => {
    const p = playerOf(state, id);
    return p.alive && !state.capitals[id] && territoriesOf(state, id).length > 0;
  });
}

function doChooseCapital(state: GameState, playerId: PlayerId, territory: TerritoryId, events: GameEvent[]): void {
  if (state.phase !== 'capitals') throw new RuleError('Capitals are chosen only before the first turn');
  requireTerritory(state, territory);
  if (state.territories[territory].owner !== playerId) throw new RuleError(`You do not own ${territory}`);
  if (Object.values(state.capitals).includes(territory)) throw new RuleError(`${territory} is already a capital`);
  state.capitals[playerId] = territory;
  state.territories[territory].armies += CAPITAL_PLACEMENT_ARMIES;
  events.push({ type: 'capital_chosen', player: playerId, territory, armies: CAPITAL_PLACEMENT_ARMIES });
  const next = nextCapitalPicker(state);
  if (next) {
    state.currentPlayer = next;
    events.push({ type: 'phase', phase: 'capitals', player: next });
    return;
  }
  events.push({ type: 'capitals_assigned', capitals: { ...state.capitals } });
  beginFirstTurn(state, events);
}

/** Each player's capital: their most heavily garrisoned territory after setup (ties: first by map order). */
function assignCapitals(state: GameState, events: GameEvent[]): void {
  for (const p of state.players) {
    if (p.isNeutral || !p.alive || state.capitals[p.id]) continue;
    const owned = territoriesOf(state, p.id);
    if (!owned.length) continue;
    let best = owned[0];
    for (const t of owned) if (state.territories[t].armies > state.territories[best].armies) best = t;
    state.capitals[p.id] = best;
    state.territories[best].armies += CAPITAL_PLACEMENT_ARMIES;
    events.push({ type: 'capital_chosen', player: p.id, territory: best, armies: CAPITAL_PLACEMENT_ARMIES, auto: true });
  }
  events.push({ type: 'capitals_assigned', capitals: { ...state.capitals } });
}

function beginTurn(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const player = playerOf(state, playerId);
  state.currentPlayer = playerId;
  state.turnNumber += 1;
  state.phase = 'reinforce';
  state.pendingConquest = null;
  state.fortifiedThisTurn = false;
  player.conqueredThisTurn = false;
  const reinforcements = reinforcementsFor(state, playerId);
  // Round 1: going later is a disadvantage, so the Nth player in turn order gets at least N armies.
  if (state.round === 1 && state.options.firstRoundBonus) {
    const position = state.turnOrder.indexOf(playerId) + 1;
    if (position > reinforcements.total) {
      reinforcements.fromTurnOrder = position - reinforcements.total;
      reinforcements.total = position;
    }
  }
  player.armiesToPlace = reinforcements.total;
  events.push({ type: 'turn_started', player: playerId, turnNumber: state.turnNumber, round: state.round, reinforcements });
  events.push({ type: 'phase', phase: 'reinforce', player: playerId });
}

// ------------------------------------------------------------------
// Cards
// ------------------------------------------------------------------

function doTrade(state: GameState, playerId: PlayerId, action: TradeAction, events: GameEvent[]): void {
  const player = playerOf(state, playerId);
  if (state.phase !== 'reinforce' && state.phase !== 'attack') throw new RuleError('Cards can only be traded during reinforce or attack phase');
  if (state.pendingConquest) throw new RuleError('You must occupy the conquered territory first');
  if (state.phase === 'attack' && !mustTrade(state, playerId))
    throw new RuleError('During the attack phase you may only trade when forced to (6+ cards)');
  const ids = action.cardIds ?? [];
  if (ids.length !== 3) throw new RuleError('Trade exactly 3 cards');
  const cards: Card[] = [];
  for (const id of ids) {
    const c = player.cards.find((x) => x.id === id);
    if (!c) throw new RuleError(`You do not hold card ${id}`);
    if (cards.includes(c)) throw new RuleError('Duplicate card id');
    cards.push(c);
  }
  if (!isValidSet(cards)) throw new RuleError('Those cards do not form a set (3 of a kind, 1 of each, or with a wild)');

  const armies = setValue(cards, state.options.cardValues ?? 'progressive', state.tradeCount);
  state.tradeCount += 1;
  player.cards = player.cards.filter((c) => !cards.includes(c));
  state.discard.push(...cards);
  player.armiesToPlace += armies;

  // Bonus: if any traded card shows a territory you own, +2 armies there (once per trade).
  let bonusTerritory: TerritoryId | null = null;
  for (const c of cards) {
    if (c.territory && state.territories[c.territory].owner === playerId) {
      bonusTerritory = c.territory;
      break;
    }
  }
  if (bonusTerritory) {
    state.territories[bonusTerritory].armies += 2;
    events.push({ type: 'placed', player: playerId, territory: bonusTerritory, armies: 2 });
  }
  events.push({ type: 'traded', player: playerId, cardIds: ids, cards: cards.map((c) => ({ ...c })), armies, bonusTerritory });
}

function drawCard(state: GameState, player: Player, events: GameEvent[]): void {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) return;
    const rng = rngOf(state);
    state.deck = shuffle(rng, state.discard);
    state.discard = [];
    saveRng(state, rng);
  }
  const card = state.deck.pop()!;
  player.cards.push(card);
  events.push({ type: 'card_drawn', player: player.id });
}

// ------------------------------------------------------------------
// Attack
// ------------------------------------------------------------------

/** Most dice a territory may defend with: 2, or 3 for a capital (Capital Conquest, as in RISK: Global Domination). */
export function defenseDiceLimit(state: GameState, territory: TerritoryId): number {
  return state.options.capitals && Object.values(state.capitals).includes(territory) ? CAPITAL_DEFENSE_DICE : 2;
}

/** How many full blitzes a balanced blitz rolls before playing out the middle one. Odd, so there is a median. */
export const BALANCED_BLITZ_RUNS = 5;

interface Roll {
  attackerDice: number[];
  defenderDice: number[];
  attackerLosses: number;
  defenderLosses: number;
}
interface BattleRun {
  rolls: Roll[];
  fromArmies: number;
  toArmies: number;
  balanced?: boolean;
}

/** Roll one attack (or a whole blitz) on copies of the army counts. */
function rollBattle(rng: Rng, fromArmies: number, toArmies: number, defenseLimit: number, dice: number | undefined, blitz: boolean): BattleRun {
  const rolls: Roll[] = [];
  for (;;) {
    const maxDice = Math.min(3, fromArmies - 1);
    if (maxDice < 1) break;
    const aDiceCount = Math.min(dice ?? 3, maxDice);
    const dDiceCount = Math.min(defenseLimit, toArmies);
    const attackerDice = Array.from({ length: aDiceCount }, () => rollDie(rng)).sort((a, b) => b - a);
    const defenderDice = Array.from({ length: dDiceCount }, () => rollDie(rng)).sort((a, b) => b - a);
    let attackerLosses = 0;
    let defenderLosses = 0;
    for (let i = 0; i < Math.min(attackerDice.length, defenderDice.length); i++) {
      if (attackerDice[i] > defenderDice[i]) defenderLosses++;
      else attackerLosses++;
    }
    fromArmies -= attackerLosses;
    toArmies -= defenderLosses;
    rolls.push({ attackerDice, defenderDice, attackerLosses, defenderLosses });
    if (toArmies === 0 || !blitz) break;
  }
  return { rolls, fromArmies, toArmies };
}

/**
 * The middle run by how well it went for the attacker: a conquest beats a failed attack, a conquest with
 * more armies left beats one with fewer, and a failed attack that left fewer defenders beats one that left more.
 */
function medianRun(runs: BattleRun[]): BattleRun {
  const score = (r: BattleRun) => (r.toArmies === 0 ? 1_000_000 + r.fromArmies : -r.toArmies);
  const sorted = [...runs].sort((a, b) => score(a) - score(b));
  return { ...sorted[Math.floor(sorted.length / 2)], balanced: true };
}

function doAttack(state: GameState, playerId: PlayerId, action: AttackAction, events: GameEvent[]): void {
  const player = playerOf(state, playerId);
  if (state.phase !== 'attack') throw new RuleError('Not in attack phase');
  if (state.pendingConquest) throw new RuleError('You must occupy the conquered territory first');
  if (mustTrade(state, playerId)) throw new RuleError('You hold 6 or more cards and must trade before attacking');
  if (player.armiesToPlace > 0) throw new RuleError(`Place your ${player.armiesToPlace} armies before attacking`);
  requireTerritory(state, action.from);
  requireTerritory(state, action.to);
  const from = state.territories[action.from];
  const to = state.territories[action.to];
  if (from.owner !== playerId) throw new RuleError(`You do not own ${action.from}`);
  if (to.owner === playerId) throw new RuleError(`You already own ${action.to}`);
  if (isBlizzard(state, action.to)) throw new RuleError(`${action.to} is a blizzard: it cannot be attacked or entered`);
  if (!mapOf(state).isAdjacent(action.from, action.to)) throw new RuleError(`${action.from} is not adjacent to ${action.to}`);
  if (from.armies < 2) throw new RuleError('You need at least 2 armies to attack');
  if (action.dice !== undefined && (!Number.isInteger(action.dice) || action.dice < 1 || action.dice > 3))
    throw new RuleError('dice must be 1, 2 or 3');

  if (action.dice !== undefined && !action.blitz && action.dice > Math.min(3, from.armies - 1))
    throw new RuleError(`You can roll at most ${Math.min(3, from.armies - 1)} dice from ${action.from}`);

  const rng = rngOf(state);
  const defenderId = to.owner!;
  const defenseLimit = defenseDiceLimit(state, action.to);
  const roll = () => rollBattle(rng, from.armies, to.armies, defenseLimit, action.dice, !!action.blitz);
  // Balanced blitz: roll the whole blitz BALANCED_BLITZ_RUNS times with real dice and play out the median
  // run, so blitzes land close to the odds (fewer freak wins and collapses). Single rolls stay fully random.
  const result = action.blitz && state.options.balancedBlitz ? medianRun(Array.from({ length: BALANCED_BLITZ_RUNS }, roll)) : roll();
  saveRng(state, rng);
  let lastAttackerDice = 0;
  for (const r of result.rolls) {
    from.armies -= r.attackerLosses;
    to.armies -= r.defenderLosses;
    lastAttackerDice = r.attackerDice.length;
    events.push({
      type: 'battle',
      attacker: playerId,
      defender: defenderId,
      from: action.from,
      to: action.to,
      attackerDice: r.attackerDice,
      defenderDice: r.defenderDice,
      attackerLosses: r.attackerLosses,
      defenderLosses: r.defenderLosses,
      fromArmies: from.armies,
      toArmies: to.armies,
      ...(result.balanced ? { balanced: true } : {}),
    });
  }

  if (to.armies === 0) {
    // Conquered.
    to.owner = playerId;
    player.conqueredThisTurn = true;
    events.push({ type: 'conquered', player: playerId, from: action.from, to: action.to, previousOwner: defenderId });
    const minArmies = Math.min(lastAttackerDice, from.armies - 1);
    const maxArmies = from.armies - 1;
    state.pendingConquest = { from: action.from, to: action.to, minArmies: Math.max(1, minArmies), maxArmies };

    // Capital Conquest: a captured capital is just a (valuable) territory; its old holder plays on.
    const defender = playerOf(state, defenderId);
    if (state.options.capitals && Object.values(state.capitals).includes(action.to)) {
      events.push({ type: 'capital_captured', player: playerId, territory: action.to, previousOwner: defenderId });
    }

    // Elimination check.
    if (territoriesOf(state, defenderId).length === 0) {
      defender.alive = false;
      defender.eliminatedBy = playerId;
      events.push({ type: 'eliminated', player: defenderId, by: playerId });
      if (defender.cards.length > 0) {
        events.push({ type: 'cards_taken', player: playerId, from: defenderId, count: defender.cards.length });
        player.cards.push(...defender.cards);
        defender.cards = [];
      }
    }

    // Auto-occupy if requested.
    if (action.occupy !== undefined) {
      const n =
        action.occupy === 'min'
          ? state.pendingConquest.minArmies
          : action.occupy === 'max'
            ? state.pendingConquest.maxArmies
            : action.occupy;
      doOccupy(state, playerId, n, events);
    }
  }
}

function doOccupy(state: GameState, playerId: PlayerId, armies: number, events: GameEvent[]): void {
  const pc = state.pendingConquest;
  if (!pc) throw new RuleError('Nothing to occupy');
  if (!Number.isInteger(armies)) throw new RuleError('armies must be an integer');
  if (armies < pc.minArmies || armies > pc.maxArmies)
    throw new RuleError(`Move between ${pc.minArmies} and ${pc.maxArmies} armies into ${pc.to}`);
  state.territories[pc.from].armies -= armies;
  state.territories[pc.to].armies += armies;
  state.pendingConquest = null;
  events.push({ type: 'moved', player: playerId, from: pc.from, to: pc.to, armies });
  checkVictory(state, playerId, events);
}

function checkVictory(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const alive = state.players.filter((p) => p.alive && !p.isNeutral);
  if (alive.length === 1) return finishGame(state, alive[0].id, 'domination', events);
  // Capital Conquest: holding every capital (including those of eliminated players) wins outright.
  const capitals = Object.values(state.capitals);
  if (state.options.capitals && capitals.length > 1 && capitals.every((t) => state.territories[t]?.owner === playerId)) {
    finishGame(state, playerId, 'capitals', events);
  }
}

function finishGame(state: GameState, winner: PlayerId, reason: 'domination' | 'capitals', events: GameEvent[]): void {
  state.phase = 'finished';
  state.winner = winner;
  state.finishedAt = Date.now();
  state.currentPlayer = null;
  events.push({ type: 'game_over', winner, reason });
}

function doEndAttack(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  if (state.phase !== 'attack') throw new RuleError('Not in attack phase');
  if (state.pendingConquest) throw new RuleError('You must occupy the conquered territory first');
  if (mustTrade(state, playerId)) throw new RuleError('You hold 6 or more cards and must trade first');
  const player = playerOf(state, playerId);
  if (player.armiesToPlace > 0) throw new RuleError(`Place your ${player.armiesToPlace} armies first`);
  state.phase = 'fortify';
  events.push({ type: 'phase', phase: 'fortify', player: playerId });
}

// ------------------------------------------------------------------
// Fortify + end turn
// ------------------------------------------------------------------

function doFortify(state: GameState, playerId: PlayerId, action: FortifyAction, events: GameEvent[]): void {
  if (state.phase !== 'fortify' && state.phase !== 'attack') throw new RuleError('Cannot fortify now');
  if (state.phase === 'attack') doEndAttack(state, playerId, events);
  if (state.fortifiedThisTurn) throw new RuleError('You may only fortify once per turn');
  requireTerritory(state, action.from);
  requireTerritory(state, action.to);
  if (action.from === action.to) throw new RuleError('Choose two different territories');
  const from = state.territories[action.from];
  const to = state.territories[action.to];
  if (from.owner !== playerId) throw new RuleError(`You do not own ${action.from}`);
  if (to.owner !== playerId) throw new RuleError(`You do not own ${action.to}`);
  if (!Number.isInteger(action.armies) || action.armies < 1) throw new RuleError('Move at least 1 army');
  if (action.armies > from.armies - 1) throw new RuleError(`At least one army must stay in ${action.from}`);
  if (state.options.fortifyMode === 'adjacent') {
    if (!mapOf(state).isAdjacent(action.from, action.to)) throw new RuleError('Territories must be adjacent to fortify');
  } else if (!connectedTerritories(state, playerId, action.from).has(action.to)) {
    throw new RuleError('Territories must be connected through your own territories');
  }
  from.armies -= action.armies;
  to.armies += action.armies;
  state.fortifiedThisTurn = true;
  events.push({ type: 'moved', player: playerId, from: action.from, to: action.to, armies: action.armies });
  doEndTurn(state, playerId, events);
}

function doEndTurn(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  if (state.phase === 'setup') throw new RuleError('Place your armies to finish your setup turn');
  if (state.phase === 'capitals') throw new RuleError('Choose your capital first: {"type":"choose_capital","territory":"<one of yours>"}');
  if (state.phase === 'reinforce') throw new RuleError('Place all your reinforcements before ending your turn');
  if (state.pendingConquest) throw new RuleError('You must occupy the conquered territory first');
  if (mustTrade(state, playerId)) throw new RuleError('You hold too many cards and must trade first');
  const player = playerOf(state, playerId);
  if (player.armiesToPlace > 0) throw new RuleError(`Place your ${player.armiesToPlace} armies first`);
  if (player.conqueredThisTurn) drawCard(state, player, events);
  events.push({ type: 'turn_ended', player: playerId });
  nextTurn(state, playerId, events);
}

function nextTurn(state: GameState, fromPlayer: PlayerId, events: GameEvent[]): void {
  const order = state.turnOrder;
  const idx = order.indexOf(fromPlayer);
  for (let i = 1; i <= order.length; i++) {
    const j = (idx + i) % order.length;
    const cand = order[j];
    if (playerOf(state, cand).alive) {
      if (j <= idx) state.round += 1;
      beginTurn(state, cand, events);
      return;
    }
  }
  // Should be unreachable (victory is detected on elimination).
  checkVictory(state, fromPlayer, events);
}

function surrender(state: GameState, playerId: PlayerId): ActionResult {
  const next = clone(state);
  const events: GameEvent[] = [];
  const player = playerOf(next, playerId);
  if (!player.alive) throw new RuleError('Already eliminated');
  player.alive = false;
  // Surrendered territories become neutral-ish: keep ownership label but player is dead. For simplicity,
  // hand them to a neutral player so the map stays playable.
  let neutral = next.players.find((p) => p.isNeutral);
  if (!neutral) {
    neutral = {
      id: NEUTRAL_ID,
      name: 'Neutral',
      color: NEUTRAL_COLOR,
      isBot: false,
      isNeutral: true,
      alive: true,
      cards: [],
      armiesToPlace: 0,
      conqueredThisTurn: false,
      order: next.players.length,
    };
    next.players.push(neutral);
  }
  for (const t of territoriesOf(next, playerId)) next.territories[t].owner = neutral.id;
  next.discard.push(...player.cards);
  player.cards = [];
  player.armiesToPlace = 0;
  events.push({ type: 'eliminated', player: playerId, by: null });

  if (next.currentPlayer === playerId) {
    next.pendingConquest = null;
    if (next.phase === 'setup') {
      advanceSetup(next, events);
    } else if (next.phase === 'capitals') {
      const picker = nextCapitalPicker(next);
      if (picker) {
        next.currentPlayer = picker;
        events.push({ type: 'phase', phase: 'capitals', player: picker });
      } else {
        events.push({ type: 'capitals_assigned', capitals: { ...next.capitals } });
        beginFirstTurn(next, events);
      }
    } else {
      nextTurn(next, playerId, events);
    }
  }
  checkVictory(next, playerId, events);
  next.version++;
  return { state: next, events };
}

// ------------------------------------------------------------------
// Legal move helper (used by UI, bots and MCP)
// ------------------------------------------------------------------

export interface LegalMoves {
  phase: GameState['phase'];
  yourTurn: boolean;
  mustTrade: boolean;
  armiesToPlace: number;
  canPlaceOn: TerritoryId[];
  /** Max armies placeable this action (setup batch limit or armies to place). */
  placeLimit: number;
  tradeableSets: number[][];
  attacks: { from: TerritoryId; to: TerritoryId; maxDice: number }[];
  pendingConquest: GameState['pendingConquest'];
  canEndAttack: boolean;
  fortifies: { from: TerritoryId; to: TerritoryId; maxArmies: number }[];
  canEndTurn: boolean;
  /** Capitals phase: territories you may choose as your capital. */
  capitalChoices: TerritoryId[];
}

export function legalMoves(state: GameState, playerId: PlayerId): LegalMoves {
  const empty: LegalMoves = {
    phase: state.phase,
    yourTurn: state.currentPlayer === playerId,
    mustTrade: false,
    armiesToPlace: 0,
    canPlaceOn: [],
    placeLimit: 0,
    tradeableSets: [],
    attacks: [],
    pendingConquest: null,
    canEndAttack: false,
    fortifies: [],
    canEndTurn: false,
    capitalChoices: [],
  };
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.alive || state.currentPlayer !== playerId || state.phase === 'finished' || state.phase === 'lobby')
    return empty;

  const owned = territoriesOf(state, playerId);
  const lm: LegalMoves = { ...empty, armiesToPlace: player.armiesToPlace, pendingConquest: state.pendingConquest };
  if (state.pendingConquest) return lm;

  lm.mustTrade = mustTrade(state, playerId);
  if ((state.phase === 'reinforce' || (state.phase === 'attack' && lm.mustTrade))) {
    lm.tradeableSets = findSets(player.cards);
  }

  if (state.phase === 'capitals') {
    const taken = new Set(Object.values(state.capitals));
    lm.capitalChoices = owned.filter((t) => !taken.has(t));
    return lm;
  }

  if (state.phase === 'setup') {
    const unclaimed = unclaimedTerritories(state);
    if (unclaimed.length > 0) {
      lm.canPlaceOn = unclaimed;
      lm.placeLimit = 1;
    } else {
      lm.canPlaceOn = owned;
      lm.placeLimit = Math.min(player.armiesToPlace, state.options.setupBatch);
    }
    return lm;
  }

  if (state.phase === 'reinforce') {
    if (!lm.mustTrade) {
      lm.canPlaceOn = owned;
      lm.placeLimit = player.armiesToPlace;
    }
    return lm;
  }

  if (state.phase === 'attack') {
    if (lm.mustTrade) return lm;
    if (player.armiesToPlace > 0) {
      lm.canPlaceOn = owned;
      lm.placeLimit = player.armiesToPlace;
      return lm;
    }
    const adjacency = mapOf(state).adjacency;
    for (const t of owned) {
      const armies = state.territories[t].armies;
      if (armies < 2) continue;
      for (const n of adjacency[t]) {
        if (state.territories[n].owner !== playerId && !isBlizzard(state, n)) lm.attacks.push({ from: t, to: n, maxDice: Math.min(3, armies - 1) });
      }
    }
    lm.canEndAttack = true;
    lm.canEndTurn = true;
    lm.fortifies = fortifyOptions(state, playerId, owned);
    return lm;
  }

  if (state.phase === 'fortify') {
    lm.fortifies = fortifyOptions(state, playerId, owned);
    lm.canEndTurn = true;
    return lm;
  }
  return lm;
}

function fortifyOptions(state: GameState, playerId: PlayerId, owned: TerritoryId[]) {
  const out: { from: TerritoryId; to: TerritoryId; maxArmies: number }[] = [];
  if (state.fortifiedThisTurn) return out;
  const adjacency = mapOf(state).adjacency;
  for (const t of owned) {
    const armies = state.territories[t].armies;
    if (armies < 2) continue;
    const targets =
      state.options.fortifyMode === 'adjacent'
        ? adjacency[t].filter((n) => state.territories[n].owner === playerId)
        : [...connectedTerritories(state, playerId, t)];
    for (const n of targets) out.push({ from: t, to: n, maxArmies: armies - 1 });
  }
  return out;
}
