export type PlayerId = string;
export type TerritoryId = string;

export type CardKind = 'infantry' | 'cavalry' | 'artillery' | 'wild';

export interface Card {
  id: number;
  kind: CardKind;
  /** null for wild cards */
  territory: TerritoryId | null;
}

/** 'capitals': Capital Conquest with chosen capitals; players pick their capital in turn order before turn 1. */
export type Phase = 'lobby' | 'setup' | 'capitals' | 'reinforce' | 'attack' | 'fortify' | 'finished';

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  /** The neutral army used in 2-player games. Never takes a turn. */
  isNeutral: boolean;
  alive: boolean;
  cards: Card[];
  /** Personal set turn-ins; missing in legacy saves means zero. Public in player views. */
  tradesMade?: number;
  /** Armies waiting to be placed (setup or reinforce, or after a mid-attack trade). */
  armiesToPlace: number;
  conqueredThisTurn: boolean;
  /** Turn order index (0-based). */
  order: number;
  /** Who eliminated this player, if anyone. */
  eliminatedBy?: PlayerId;
}

export interface TerritoryState {
  owner: PlayerId | null;
  armies: number;
  /** Set in a fogged view: the viewer cannot see this territory (owner/armies are blanked). */
  hidden?: boolean;
}

export interface GameOptions {
  /** How many armies a player may place per setup turn. Classic rules = 1. */
  setupBatch: number;
  /** 'adjacent' = classic; 'connected' = any territory reachable through your own territories. */
  fortifyMode: 'adjacent' | 'connected';
  /** Randomly deal territories (true) or let players claim them one by one (false). */
  randomDeal: boolean;
  /** Skip the army-placement setup phase: starting armies are placed randomly and turn 1 begins at once (implies randomDeal). */
  autoSetup: boolean;
  /** Maximum players allowed in this game (2 up to the map's limit). */
  maxPlayers: number;
  /** Which board to play on (see MAP_IDS in maps.ts and OPTION_SPECS.map): 'classic' (42 territories, 2-6 players), 'world' (74, 2-10), 'world_large' (104, 2-10), 'europe' (44, 2-8), 'greater_europe' (Greater Europe, 116, 2-10), 'europe_classic' (Europe Advanced, 84, 2-6), 'usa' (45, 2-10), 'asia' (49, 2-8), 'fantasy' (Realms of Halvaren, 87, 2-10), 'skirmish' (Four Crowns, 24, 2-4), 'bohemia' (Bohemia, 42, 2-6), 'nine_realms' (The Nine Realms, 58, 2-8), 'hexworld' (Hex Earth, 80, 2-10). 'europe_advanced' (Europe (legacy, 99), 2-6) is a legacy board: saved games on it still load, new games cannot pick it. A generated board's id ('gen1-s<seed>-p<seats>-t<territories>', see procgen.ts) is also accepted: the board is built from the seed in the id. */
  map: 'classic' | 'world' | 'world_large' | 'europe' | 'europe_advanced' | 'greater_europe' | 'europe_classic' | 'usa' | 'asia' | 'fantasy' | 'skirmish' | 'bohemia' | 'nine_realms' | 'hexworld' | `gen${number}-${string}`;
  /** Card sets: progressive lobby-wide, fixed by set type, or exponential per player. */
  cardValues: 'progressive' | 'fixed' | 'exponential';
  /** Fog of war: players only see their own territories and the ones adjacent to them. Spectators see everything. */
  fogOfWar: boolean;
  /** Spectators may chat. Every player sees their messages, even under fog of war. */
  spectatorChat: boolean;
  /** Capital Conquest: each player gets a capital after setup; every capital held pays +CAPITAL_BONUS per turn and defends with 3 dice; holding all capitals wins. */
  capitals: boolean;
  /** Capital Conquest: players choose their own capital (in turn order, before turn 1) instead of getting their most garrisoned territory. */
  chooseCapitals: boolean;
  /** Round 1 only: the Nth player in turn order receives at least N armies (offsets going later). */
  firstRoundBonus: boolean;
  /** Balanced blitz: a blitz is rolled several times with real dice and the median outcome happens (fewer upsets). Single rolls stay random. */
  balancedBlitz: boolean;
  /** Neutral territories in games of 3+ players: this many territories go to a Neutral army that never attacks (0 = off). Two-player games always have the classic Neutral. */
  neutrals: number;
  /** Armies on each neutral territory when `neutrals` is on. */
  neutralArmies: number;
  /** Blizzards: this many random territories are impassable for the whole game (0 = off). Nobody owns, attacks or crosses them. */
  blizzards: number;
  /**
   * Turn timer for human and agent seats (never bots), kept by the server: 'move' = each decision, 'turn' = the whole
   * turn, 'off' = none. On a timeout the player is skipped (timeoutSteps in timeout.ts). The engine never reads a clock.
   */
  turnTimer: 'off' | 'move' | 'turn';
  /** Seconds on the turn timer (ignored when turnTimer is 'off'). */
  turnTimerSeconds: number;
  /**
   * Stall breaker (fog games): after this many full rounds in a row with no territory captured by anyone, the fog of
   * war lifts for the rest of the game (0 or absent = off). Absent by default, so games without it are unchanged.
   */
  stallFogLift?: number;
}

/** Reinforcements per capital held when the capitals option is on. */
export const CAPITAL_BONUS = 2;

/** Holding this many cards forces a trade: at the start of your turn, and right after an elimination hands you cards. */
export const FORCED_TRADE_CARDS = 5;

/** Dice a capital defends with when the capitals option is on (other territories defend with up to 2). */
export const CAPITAL_DEFENSE_DICE = 3;

/** Extra armies placed on every capital when it is set, whether a player chose it or it was assigned automatically. */
export const CAPITAL_PLACEMENT_ARMIES = 3;
/** @deprecated use CAPITAL_PLACEMENT_ARMIES */
export const CHOSEN_CAPITAL_ARMIES = CAPITAL_PLACEMENT_ARMIES;

export const DEFAULT_OPTIONS: GameOptions = {
  setupBatch: 1,
  fortifyMode: 'connected',
  randomDeal: true,
  autoSetup: false,
  maxPlayers: 6,
  map: 'classic',
  cardValues: 'progressive',
  fogOfWar: false,
  spectatorChat: true,
  capitals: false,
  chooseCapitals: false,
  firstRoundBonus: true,
  balancedBlitz: false,
  neutrals: 0,
  neutralArmies: 2,
  blizzards: 0,
  turnTimer: 'off',
  turnTimerSeconds: 15,
};

export interface PendingConquest {
  from: TerritoryId;
  to: TerritoryId;
  minArmies: number;
  maxArmies: number;
}

export interface GameState {
  id: string;
  /** Monotonic counter bumped on every successful action. */
  version: number;
  phase: Phase;
  options: GameOptions;
  players: Player[];
  /** Player ids in turn order (excludes neutral). */
  turnOrder: PlayerId[];
  currentPlayer: PlayerId | null;
  /** Total number of turns taken so far (increments on each end of turn). */
  turnNumber: number;
  /** Full rounds completed (every living player has taken a turn). */
  round: number;
  territories: Record<TerritoryId, TerritoryState>;
  deck: Card[];
  discard: Card[];
  /** Number of card sets traded so far (drives escalating bonus). */
  tradeCount: number;
  pendingConquest: PendingConquest | null;
  /** Capital territory per player (capitals option). */
  capitals: Record<PlayerId, TerritoryId>;
  /** Impassable blizzard territories (blizzards option). Unowned, 0 armies, chosen at game start. */
  blizzards: TerritoryId[];
  /** Set once the player has fortified this turn. */
  fortifiedThisTurn: boolean;
  /**
   * Stall relievers' counter (stall.ts), present only while a reliever is on: the round of the last territory captured
   * by anyone (0 = none yet), and the round each reliever kicked in.
   */
  stall?: { lastCaptureRound: number; fogLiftedRound?: number };
  /** The stall breaker lifted the fog of war (stallFogLift): every view sees the whole board for the rest of the game. */
  fogLifted?: boolean;
  winner: PlayerId | null;
  seed: number;
  rngState: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// ---------- Actions ----------

export interface PlaceAction {
  type: 'place';
  /** territory -> armies */
  placements: Record<TerritoryId, number>;
}

/** Capitals phase: pick one of your own territories as your capital. */
export interface ChooseCapitalAction {
  type: 'choose_capital';
  territory: TerritoryId;
}

export interface TradeAction {
  type: 'trade';
  cardIds: number[];
}

export interface AttackAction {
  type: 'attack';
  from: TerritoryId;
  to: TerritoryId;
  /** Number of dice (1-3). Default: as many as possible. */
  dice?: number;
  /** Keep attacking until the territory falls or the attack can no longer continue. */
  blitz?: boolean;
  /**
   * If the territory is conquered, automatically move this many armies in.
   * 'min' = the minimum required, 'max' = everything but one.
   */
  occupy?: number | 'min' | 'max';
  /**
   * Blitz, but stop once the attacking stack is down to this many armies (at least 1, below the stack).
   * The attacker never rolls more dice than it can lose without going below it, so the stack always keeps
   * at least stopAt armies. Implies blitz. With occupy 'max', everything above stopAt moves in.
   */
  stopAt?: number;
}

export interface OccupyAction {
  type: 'occupy';
  armies: number;
}

export interface EndAttackAction {
  type: 'end_attack';
}

export interface FortifyAction {
  type: 'fortify';
  from: TerritoryId;
  to: TerritoryId;
  armies: number;
}

export interface EndTurnAction {
  type: 'end_turn';
}

export interface SurrenderAction {
  type: 'surrender';
}

export type Action =
  | PlaceAction
  | ChooseCapitalAction
  | TradeAction
  | AttackAction
  | OccupyAction
  | EndAttackAction
  | FortifyAction
  | EndTurnAction
  | SurrenderAction;

export type ActionType = Action['type'];

// ---------- Events (for logs + animations) ----------

export interface ReinforcementBreakdown {
  territories: number;
  fromTerritories: number;
  continents: { id: string; bonus: number }[];
  /** Capitals held (capitals option) and the armies they add. */
  capitals: number;
  fromCapitals: number;
  /** Set when fog of war hides this breakdown from the viewer (all numbers are then 0). */
  hidden?: boolean;
  /** Round 1 only (firstRoundBonus): extra armies that lift later players to their turn position (4th gets 4, ...). */
  fromTurnOrder?: number;
  total: number;
}

export type GameEvent =
  | { type: 'game_started'; players: PlayerId[]; turnOrder: PlayerId[] }
  | { type: 'phase'; phase: Phase; player: PlayerId | null }
  | { type: 'turn_started'; player: PlayerId; turnNumber: number; round: number; reinforcements: ReinforcementBreakdown }
  /** The stall breaker: `rounds` full rounds passed with no territory captured, so the fog of war lifts for good. */
  | { type: 'fog_lifted'; rounds: number }
  | { type: 'placed'; player: PlayerId; territory: TerritoryId; armies: number }
  /** auto: the game traded this set itself because the player held 5 or more cards. */
  | { type: 'traded'; player: PlayerId; cardIds: number[]; cards: Card[]; armies: number; bonusTerritory: TerritoryId | null; auto?: boolean }
  | {
      type: 'battle';
      attacker: PlayerId;
      defender: PlayerId;
      from: TerritoryId;
      to: TerritoryId;
      attackerDice: number[];
      defenderDice: number[];
      attackerLosses: number;
      defenderLosses: number;
      fromArmies: number;
      toArmies: number;
      /** Part of a balanced blitz: the median of several real blitzes (see the balancedBlitz option). */
      balanced?: boolean;
    }
  | { type: 'conquered'; player: PlayerId; from: TerritoryId; to: TerritoryId; previousOwner: PlayerId }
  | { type: 'moved'; player: PlayerId; from: TerritoryId; to: TerritoryId; armies: number }
  | { type: 'card_drawn'; player: PlayerId }
  | { type: 'cards_taken'; player: PlayerId; from: PlayerId; count: number }
  | { type: 'eliminated'; player: PlayerId; by: PlayerId | null }
  | { type: 'capitals_assigned'; capitals: Record<PlayerId, TerritoryId> }
  /** auto: assigned automatically (most garrisoned territory) rather than picked by the player. */
  | { type: 'capital_chosen'; player: PlayerId; territory: TerritoryId; armies: number; auto?: boolean }
  | { type: 'blizzards'; territories: TerritoryId[] }
  | { type: 'capital_captured'; player: PlayerId; territory: TerritoryId; previousOwner: PlayerId }
  /** A fogged-out event the viewer is not allowed to see in detail. */
  | { type: 'fogged'; kind: GameEvent['type'] }
  | { type: 'turn_ended'; player: PlayerId }
  /** The turn timer ran out: the moves in this step and the ones after it were made for the player (see timeout.ts). */
  | { type: 'timeout'; player: PlayerId; scope: 'move' | 'turn' }
  /** reason: 'domination' = last player standing; 'capitals' = held every capital (Capital Conquest). Older logs omit it. */
  | { type: 'game_over'; winner: PlayerId; reason?: 'domination' | 'capitals' };

export interface ActionResult {
  state: GameState;
  events: GameEvent[];
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}
