export type PlayerId = string;
export type TerritoryId = string;

export type CardKind = 'infantry' | 'cavalry' | 'artillery' | 'wild';

export interface Card {
  id: number;
  kind: CardKind;
  /** null for wild cards */
  territory: TerritoryId | null;
}

export type Phase = 'lobby' | 'setup' | 'reinforce' | 'attack' | 'fortify' | 'finished';

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  /** The neutral army used in 2-player games. Never takes a turn. */
  isNeutral: boolean;
  alive: boolean;
  cards: Card[];
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
  /** Which board to play on: 'classic' (42 territories, 2-6 players) or 'world' (74 territories, 2-10). */
  map: 'classic' | 'world';
}

export const DEFAULT_OPTIONS: GameOptions = {
  setupBatch: 1,
  fortifyMode: 'connected',
  randomDeal: true,
  autoSetup: false,
  maxPlayers: 6,
  map: 'classic',
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
  /** Set once the player has fortified this turn. */
  fortifiedThisTurn: boolean;
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
  total: number;
}

export type GameEvent =
  | { type: 'game_started'; players: PlayerId[]; turnOrder: PlayerId[] }
  | { type: 'phase'; phase: Phase; player: PlayerId | null }
  | { type: 'turn_started'; player: PlayerId; turnNumber: number; round: number; reinforcements: ReinforcementBreakdown }
  | { type: 'placed'; player: PlayerId; territory: TerritoryId; armies: number }
  | { type: 'traded'; player: PlayerId; cardIds: number[]; armies: number; bonusTerritory: TerritoryId | null }
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
    }
  | { type: 'conquered'; player: PlayerId; from: TerritoryId; to: TerritoryId; previousOwner: PlayerId }
  | { type: 'moved'; player: PlayerId; from: TerritoryId; to: TerritoryId; armies: number }
  | { type: 'card_drawn'; player: PlayerId }
  | { type: 'cards_taken'; player: PlayerId; from: PlayerId; count: number }
  | { type: 'eliminated'; player: PlayerId; by: PlayerId | null }
  | { type: 'turn_ended'; player: PlayerId }
  | { type: 'game_over'; winner: PlayerId };

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
