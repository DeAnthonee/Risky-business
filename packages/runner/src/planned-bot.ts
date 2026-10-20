import { blitzOdds, commitForOdds, getMap, type Action, type GameView, type MapDef, type PlayerId, type TerritoryId } from '@risk/engine';
import { chooseMove } from './view-state.js';
import { planElimination, type KillPlan } from './eliminations.js';
import { planConquest, type Campaign, type CampaignOptions } from './campaigns.js';

export type WinPath = 'diplomacy' | 'bonuses' | 'cards' | 'capitals' | 'kills' | 'hopeless';
export const WIN_PATHS: readonly WinPath[] = ['diplomacy', 'bonuses', 'cards', 'capitals', 'kills', 'hopeless'];

/**
 * What the commander (or a test) tells the move chooser. Every field is optional advice: ids that do not
 * exist, numbers out of range and a missing plan are all tolerated (see `cleanPlan`). Only legality is code;
 * every strategy rule below is a knob with a loose default.
 */
export interface Plan {
  /** A territory id or a continent id that placements and attacks favour. */
  focus?: string | null;
  /** Player id to pressure (bonus score for hitting their territories). */
  target?: PlayerId | null;
  /** Player ids not to attack, unless it wins the game. */
  avoid?: PlayerId[];
  /** Territory ids never to attack (border deals), unless it wins the game. */
  noAttack?: TerritoryId[];
  /** 0..1: lower = only near-certain attacks (win chance 0.85), higher = bolder (0.55). */
  aggression?: number;
  /** 0..1: how much loss the seat accepts; sets the capital-attack margin and, with aggression, the attack threshold. Default = aggression. */
  riskTolerance?: number;
  /** Armies to keep on every capital held (a hard floor, no attack dips below it). Unset = a soft few that a measured attack may override. */
  capitalGarrison?: number;
  /** True: a capital's stack may be fortified out and may go with an occupation. Default false. */
  moveCapitalStack?: boolean;
  /** Capital to pick at the capitals phase (must be one of the legal choices). */
  capital?: string | null;
  /** Purpose score an attack needs besides the card attack. Default 0.5 (1.5 on the cards and diplomacy paths). */
  purposeMin?: number;
  /** Multiplier on the garrisons kept on bonus borders, left behind after an occupation and moved in by fortifying. 0 = none, default 1, max 2. */
  borderGuard?: number;
  /** False stops voluntary fortifying altogether. Default true. */
  fortify?: boolean;
  /** False turns off stall pressure (the attack thresholds do not loosen when nobody has conquered for a while). Default true. */
  stallPressure?: boolean;
  /** Progressive cards: win chance a card attack needs. Default 0.6. */
  cardChance?: number;
  /** True, with a reason: do not make the card attack this turn. Ignored without a reason. */
  skipCard?: boolean;
  skipCardReason?: string;
  /** How this seat actually wins from here. */
  winPath?: WinPath | null;
  winPlan?: string;
  /** Remaining armies promised to commit into attacks against `target` under an active joint_attack deal. */
  commitArmies?: number;
  /** Territories where the commander explicitly wants reinforcements placed this turn. */
  placeOn?: TerritoryId[] | TerritoryId;
  /** Ordered sequence of territories the commander wants to attack/advance through this turn. */
  route?: TerritoryId[];
  /** Territory the commander wants to fortify back to at the end of the turn (e.g. a capital or choke). */
  fortifyTo?: TerritoryId | null;
  /** Stop attacking immediately once a focus/target continent bonus is secured/held and a card is earned; prevents bleeding troops into greedy attacks. Default true when winPath is 'bonuses'. Ignored in 1v1 where maximum territory denial dominates. */
  stopAfterBonus?: boolean;
  /** When true (default), stop attacking once all territories in an explicit `route` are conquered, rather than falling through to generic attacks. Ignored in 1v1. */
  stopAfterRoute?: boolean;
}

interface CleanPlan {
  focusTerritory: TerritoryId | null;
  focusContinent: string | null;
  target: PlayerId | null;
  avoid: Set<PlayerId>;
  noAttack: Set<TerritoryId>;
  aggression: number;
  riskTolerance: number;
  capitalGarrison: number | null;
  moveCapitalStack: boolean;
  capital: TerritoryId | null;
  purposeMin: number;
  borderGuard: number;
  fortify: boolean;
  stallPressure: boolean;
  cardChance: number;
  skipCard: boolean;
  winPath: WinPath | null;
  commitArmies: number;
  placeOn: TerritoryId[];
  route: TerritoryId[];
  fortifyTo: TerritoryId | null;
  stopAfterBonus: boolean;
  stopAfterRoute: boolean;
}

const DEFAULT_AGGRESSION = 0.5;
const DEFAULT_CAPITAL_GARRISON = 4;
/** Soft capital floor when the plan names none: a few armies, or what the neighbours suggest if more. */
const SOFT_CAPITAL_FEW = 3;
/** Purpose an attack needs beyond the card attack (any bonus, capital, focus, kill or leader angle counts). Higher values turtled too much in self-play: see README. */
const DEFAULT_PURPOSE_MIN = 0.5;
/** Win chance a card attack needs at stall 0 (fixed cards, where the card is not worth much). */
const CARD_CHANCE = 0.8;
/** Win chance the guaranteed card attack needs under progressive cards. */
const PROGRESSIVE_CARD_CHANCE = 0.6;
const MIN_THRESHOLD = 0.5;
/** A purposeful attack may send a soft-floored capital below its floor by this share of the floor (more as the stall grows). */
const DIP_BASE = 0.5;
/** Purpose that earns the dip besides the card attack: completing or breaking a bonus, a capital, the focus or target. */
const DIP_PURPOSE = 3;

/** Sanitise a plan against the real board: unknown ids become null, numbers are clamped. */
export function cleanPlan(plan: Plan | null | undefined, view: GameView, me: PlayerId): CleanPlan {
  const map = getMap(view.options.map);
  const players = new Set(view.players.filter((p) => p.alive && p.id !== me).map((p) => p.id));
  const raw = (plan ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  const flag = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const focus = str(raw.focus);
  const target = str(raw.target);
  const capital = str(raw.capital);
  const path = WIN_PATHS.find((w) => w === raw.winPath) ?? null;
  const cleanTarget = target && players.has(target) ? target : null;
  // "Hopeless" without a valid target to hit is not a plan the chooser can follow.
  const winPath = path === 'hopeless' && !cleanTarget ? null : path;
  const quiet = winPath === 'cards' || winPath === 'diplomacy';
  const aggression = num(raw.aggression, 0, 1) ?? (quiet ? 0.3 : winPath === 'hopeless' ? 1 : DEFAULT_AGGRESSION);
  const garrison = num(raw.capitalGarrison, 1, 200);
  const reason = typeof raw.skipCardReason === 'string' ? raw.skipCardReason.trim() : '';
  return {
    focusTerritory: focus && map.isTerritory(focus) ? focus : null,
    focusContinent: focus && map.continentById[focus] ? focus : null,
    target: cleanTarget,
    avoid: new Set((Array.isArray(raw.avoid) ? raw.avoid : []).filter((x): x is string => typeof x === 'string' && players.has(x))),
    noAttack: new Set((Array.isArray(raw.noAttack) ? raw.noAttack : []).filter((x): x is string => typeof x === 'string' && map.isTerritory(x))),
    aggression,
    riskTolerance: num(raw.riskTolerance, 0, 1) ?? aggression,
    capitalGarrison: garrison === null ? null : Math.round(garrison),
    moveCapitalStack: raw.moveCapitalStack === true,
    capital: capital && map.isTerritory(capital) ? capital : null,
    purposeMin: num(raw.purposeMin, 0, 10) ?? (quiet ? 1.5 : DEFAULT_PURPOSE_MIN),
    borderGuard: num(raw.borderGuard, 0, 2) ?? 1,
    fortify: flag(raw.fortify, true),
    stallPressure: flag(raw.stallPressure, true),
    cardChance: num(raw.cardChance, 0.3, 0.95) ?? PROGRESSIVE_CARD_CHANCE,
    skipCard: raw.skipCard === true && reason.length > 0,
    winPath,
    commitArmies: Math.round(num(raw.commitArmies, 1, 500) ?? 0),
    placeOn: [...new Set((Array.isArray(raw.placeOn) ? raw.placeOn : typeof raw.placeOn === 'string' ? [raw.placeOn] : []).filter((x): x is string => typeof x === 'string' && map.isTerritory(x)))],
    route: [...new Set((Array.isArray(raw.route) ? raw.route : typeof raw.route === 'string' ? [raw.route] : []).filter((x): x is string => typeof x === 'string' && map.isTerritory(x)))],
    fortifyTo: typeof raw.fortifyTo === 'string' && map.isTerritory(raw.fortifyTo) ? raw.fortifyTo : null,
    stopAfterBonus: flag(raw.stopAfterBonus, winPath === 'bonuses' || winPath === 'cards' || winPath === 'diplomacy'),
    stopAfterRoute: flag(raw.stopAfterRoute, true),
  };
}

/**
 * Counts this seat's own turns since it last conquered something (so since it last earned a card). Feed it
 * every view the seat sees; a frozen board shows up as a rising `stall`, which makes the chooser bolder.
 */
export class StallTracker {
  stall = 0;
  private turn = -1;
  private conquered = false;
  observe(view: GameView, me: PlayerId) {
    if (view.currentPlayer !== me || view.phase === 'finished') return;
    if (view.turnNumber !== this.turn) {
      if (this.turn >= 0) this.stall = this.conquered ? 0 : this.stall + 1;
      this.turn = view.turnNumber;
      this.conquered = false;
    }
    if (view.players.find((p) => p.id === me)?.conqueredThisTurn) this.conquered = true;
  }
}

/** Is `action` one the view's legal-move list allows? (The server would refuse anything else.) */
export function isLegalAction(view: GameView, action: Action): boolean {
  const lm = view.legal;
  if (!lm || !lm.yourTurn) return false;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
  switch (action.type) {
    case 'occupy':
      return !!lm.pendingConquest && whole(action.armies) && action.armies >= lm.pendingConquest.minArmies && action.armies <= lm.pendingConquest.maxArmies;
    case 'choose_capital':
      return lm.capitalChoices.includes(action.territory);
    case 'trade':
      return lm.tradeableSets.some((s) => s.length === action.cardIds.length && s.every((id) => action.cardIds.includes(id)));
    case 'place': {
      if (lm.pendingConquest) return false;
      let sum = 0;
      for (const [t, n] of Object.entries(action.placements)) {
        if (!whole(n) || !lm.canPlaceOn.includes(t)) return false;
        sum += n;
      }
      return sum >= 1 && sum <= lm.placeLimit;
    }
    case 'attack': {
      const a = lm.attacks.find((x) => x.from === action.from && x.to === action.to);
      if (!a) return false;
      if (action.stopAt !== undefined && !(whole(action.stopAt) && action.stopAt <= (view.territories[action.from]?.armies ?? 0) - 1)) return false;
      return true;
    }
    case 'end_attack':
      return lm.canEndAttack;
    case 'fortify':
      return whole(action.armies) && lm.fortifies.some((f) => f.from === action.from && f.to === action.to && action.armies <= f.maxArmies);
    case 'end_turn':
      return lm.canEndTurn;
    default:
      return false;
  }
}

/**
 * The plan-aware move chooser. Always returns an action the view's legal list allows (or null when it is not
 * our move); if anything inside fails it falls back to the engine bot's choice.
 */
export function choosePlannedAction(view: GameView, me: PlayerId, plan: Plan | null, random: () => number = Math.random, stall = 0): Action | null {
  if (!view.legal?.yourTurn) return null;
  try {
    const action = new Chooser(view, me, cleanPlan(plan, view, me), random, stall).choose();
    if (action && isLegalAction(view, action)) return action;
  } catch {
    /* fall through to the engine bot */
  }
  return chooseMove(view, me, random);
}

const oddsCache = new Map<string, number>();

/** Chance that `commit` attackers (stack minus the one left behind) take `defenders` defending with `limit` dice. */
export function winChance(commit: number, defenders: number, limit: number, balancedOn: boolean): number {
  if (defenders <= 0) return 1;
  if (commit < 1) return 0;
  let a = commit;
  let d = defenders;
  const big = Math.max(a, d);
  if (big > 80) {
    const k = big / 80;
    a = Math.max(1, Math.round(a / k));
    d = Math.max(1, Math.round(d / k));
  }
  const key = `${a}:${d}:${limit}:${balancedOn ? 1 : 0}`;
  let p = oddsCache.get(key);
  if (p === undefined) {
    const o = blitzOdds(a + 1, d, limit, 1);
    p = balancedOn ? o.balancedWin : o.win;
    if (oddsCache.size > 20000) oddsCache.clear();
    oddsCache.set(key, p);
  }
  return p;
}

interface Scored {
  from: TerritoryId;
  to: TerritoryId;
  score: number;
  purpose: number;
  p: number;
  keep: number;
}

class Chooser {
  private map: MapDef;
  private blizzards: Set<TerritoryId>;
  private capitalOf = new Map<TerritoryId, PlayerId>();
  private myCapitals = new Set<TerritoryId>();
  private lm: NonNullable<GameView['legal']>;
  private conquered: boolean;
  private balanced: boolean;
  private leader: PlayerId | null = null;

  constructor(
    private view: GameView,
    private me: PlayerId,
    private plan: CleanPlan,
    private random: () => number,
    /** Own turns since this seat last conquered something (see StallTracker). */
    private stall = 0,
  ) {
    this.map = getMap(view.options.map);
    this.lm = view.legal!;
    this.blizzards = new Set(view.blizzards ?? []);
    if (view.options.capitals) {
      for (const [pid, t] of Object.entries(view.capitals ?? {})) {
        this.capitalOf.set(t, pid);
        if (pid === me && view.territories[t]?.owner === me) this.myCapitals.add(t);
      }
    }
    this.conquered = view.players.find((p) => p.id === me)?.conqueredThisTurn ?? false;
    this.balanced = !!view.options.balancedBlitz;
    const borderArmies = new Map<PlayerId, number>();
    for (const t of this.map.territoryIds) {
      if (view.territories[t]?.owner !== me) continue;
      for (const n of this.map.adjacency[t]) {
        const ts = view.territories[n];
        if (!ts || ts.hidden || !ts.owner || ts.owner === me || this.blizzards.has(n)) continue;
        borderArmies.set(ts.owner, (borderArmies.get(ts.owner) ?? 0) + ts.armies);
      }
    }
    const rivals = view.players.filter((p) => p.alive && !p.isNeutral && p.id !== me);
    if (rivals.length > 0 && rivals.every((p) => p.territoryCount !== null)) {
      let best = -1;
      for (const p of rivals) {
        const score = (p.territoryCount ?? 0) * 1000 + (p.income?.total ?? 0) * 20 + (p.armyCount ?? 0);
        if (score > best) ((best = score), (this.leader = p.id));
      }
    } else if (rivals.length > 0) {
      let best = -1;
      for (const p of rivals) {
        const score = (p.income?.total ?? 0) * 100 + (borderArmies.get(p.id) ?? 0);
        if (score > best) ((best = score), (this.leader = p.id));
      }
    }
  }

  // ---------- board helpers ----------

  private owner(t: TerritoryId): PlayerId | null {
    return this.view.territories[t]?.owner ?? null;
  }
  private armies(t: TerritoryId): number {
    return this.view.territories[t]?.armies ?? 0;
  }
  private hostile(t: TerritoryId): boolean {
    const s = this.view.territories[t];
    return !!s && !s.hidden && s.owner !== null && s.owner !== this.me && !this.blizzards.has(t);
  }
  private hostileNeighbours(t: TerritoryId): TerritoryId[] {
    return this.map.adjacency[t].filter((n) => this.hostile(n));
  }
  private threat(t: TerritoryId): number {
    return this.hostileNeighbours(t).reduce((n, e) => n + this.armies(e), 0);
  }
  private mine(): TerritoryId[] {
    return this.map.territoryIds.filter((t) => this.owner(t) === this.me);
  }
  private chance(commit: number, to: TerritoryId): number {
    return winChance(commit, this.armies(to), this.limitFor(to), this.balanced);
  }
  private limitFor(t: TerritoryId): number {
    return this.capitalOf.has(t) ? 3 : 2;
  }
  private hopeless(): boolean {
    return this.plan.winPath === 'hopeless';
  }
  /** Stall pressure (a default the plan can turn off): 0 until two turns pass without a conquest, then one more step per turn. */
  private step(): number {
    return this.plan.stallPressure ? Math.max(0, this.stall - 1) : 0;
  }
  /** Win chance an attack needs: 0.85 at no appetite for risk, down to 0.55 at full aggression and risk tolerance. */
  private threshold(): number {
    return Math.max(MIN_THRESHOLD, 0.85 - 0.15 * this.plan.aggression - 0.15 * this.plan.riskTolerance - 0.05 * this.step());
  }
  /** Attackers needed per defender when attacking a capital (3 defence dice): 3.4 at no risk tolerance, 2.2 at full. */
  private capitalMargin(): number {
    return 3.4 - 1.2 * this.plan.riskTolerance;
  }
  /** Win chance a card attack needs (falls with the stall). */
  private cardMin(): number {
    return Math.max(0.55, CARD_CHANCE - 0.04 * this.step());
  }
  /** Share of a soft capital floor a purposeful attack may dip below (grows with the stall). A garrison the plan names is never dipped. */
  private dipFraction(): number {
    return this.plan.capitalGarrison !== null ? 0 : Math.min(0.9, DIP_BASE + 0.1 * this.step());
  }
  /** Threat for garrison floors: the biggest hostile neighbour counts most, the rest a little (they also border each other). */
  private floorThreat(list: TerritoryId[]): number {
    let max = 0;
    let sum = 0;
    for (const e of list) {
      const a = this.armies(e);
      sum += a;
      if (a > max) max = a;
    }
    return max * 0.6 + (sum - max) * 0.2;
  }
  /** What a capital keeps home: exactly the plan's garrison if it set one, otherwise a soft few or what the neighbours suggest. Nothing when hopeless. */
  private capFloor(t: TerritoryId): number {
    const have = this.armies(t);
    if (this.hopeless()) return 1;
    if (this.plan.capitalGarrison !== null) return Math.max(1, Math.min(have, this.plan.capitalGarrison));
    return Math.max(1, Math.min(have, Math.max(SOFT_CAPITAL_FEW, Math.ceil(this.floorThreat(this.hostileNeighbours(t)) * 0.75) + 1)));
  }
  /** Garrison for a bonus border or a guard left behind, scaled by the plan's borderGuard (0 = none). */
  private guardFor(t: TerritoryId, share = 0.7): number {
    return this.plan.borderGuard <= 0 ? 0 : Math.ceil(this.threat(t) * share * this.plan.borderGuard) + 1;
  }
  /** Armies a capital should hold when reinforcing. */
  private capWanted(t: TerritoryId): number {
    return Math.max(this.plan.capitalGarrison ?? DEFAULT_CAPITAL_GARRISON, Math.ceil(this.floorThreat(this.hostileNeighbours(t)) * 1.1) + 1);
  }
  private inFocus(t: TerritoryId): number {
    if (this.plan.focusTerritory === t) return 2;
    const c = this.plan.focusContinent;
    if (c && this.map.territoryById[t]?.continent === c) return 1;
    return 0;
  }
  /** Is some part of the focus (territory or continent) adjacent to t? */
  private nearFocus(t: TerritoryId): boolean {
    const adj = this.map.adjacency[t];
    if (this.plan.focusTerritory) return adj.includes(this.plan.focusTerritory);
    const c = this.plan.focusContinent;
    return !!c && adj.some((n) => this.map.territoryById[n].continent === c);
  }
  /** Territories of the continent I would need for its bonus, and how many of them I hold. */
  private continentShare(contId: string): { total: number; mine: number; missing: TerritoryId[] } {
    const cont = this.map.continentById[contId];
    const ts = cont.territories.filter((t) => !this.blizzards.has(t));
    const missing = ts.filter((t) => this.owner(t) !== this.me);
    return { total: ts.length, mine: ts.length - missing.length, missing };
  }
  /** Continents in which I already hold every territory except the border ones with enemies: bonus borders. */
  private isBonusBorder(t: TerritoryId): boolean {
    const cont = this.map.territoryById[t].continent;
    return this.view.continentOwners[cont] === this.me && this.hostileNeighbours(t).length > 0;
  }

  /** Only 2 non-neutral players remain alive. */
  private is1v1(): boolean {
    return this.view.players.filter((p) => p.alive && !p.isNeutral).length <= 2;
  }

  /** Do our held bonus borders possess a substantial army surplus above the required defensive garrisons? */
  private hasSubstantialSurplus(): boolean {
    const borders = this.mine().filter((t) => this.isBonusBorder(t));
    if (borders.length === 0) return false;
    return borders.some((t) => {
      const req = this.guardFor(t);
      const have = this.armies(t);
      return have >= req + 6;
    });
  }

  /** Is an attack available that breaks an opponent's high-value (+3 or more) continent bonus with favorable odds? */
  private hasHighValueBonusBreak(): boolean {
    return this.lm.attacks.some((a) => {
      const cont = this.map.territoryById[a.to]?.continent;
      if (!cont) return false;
      const holder = this.view.continentOwners[cont];
      const bonus = this.map.continentById[cont]?.bonus ?? 0;
      return holder && holder !== this.me && bonus >= 3 && this.chance(this.armies(a.from) - 1, a.to) >= 0.8;
    });
  }

  // ---------- decision ----------

  choose(): Action | null {
    const lm = this.lm;
    if (lm.pendingConquest) return { type: 'occupy', armies: this.occupyCount(lm.pendingConquest) };
    if (lm.capitalChoices.length > 0) return { type: 'choose_capital', territory: this.chooseCapital(lm.capitalChoices) };
    if (lm.tradeableSets.length > 0 && (lm.mustTrade || this.view.phase === 'reinforce')) {
      return { type: 'trade', cardIds: this.chooseSet(lm.tradeableSets) };
    }
    if (lm.canPlaceOn.length > 0 && lm.placeLimit > 0) return { type: 'place', placements: this.placements(lm.canPlaceOn, lm.placeLimit) };

    if (this.view.phase === 'attack') {
      // A complete, affordable elimination outranks routine bonus pokes or the once-per-turn card.
      const kill = this.elimination();
      const is1v1 = this.is1v1();
      const hasRouteTargets = this.plan.route.length > 0;
      const hasRemainingRouteAttacks = this.plan.route.some((r) => this.lm.attacks.some((l) => l.to === r));

      // In 1v1, there are no 3rd parties to punish over-expansion: break everything possible!
      // In multi-player FFA, honor stopAfterRoute once the explicit route has finished:
      if (!is1v1 && hasRouteTargets && !hasRemainingRouteAttacks && this.plan.stopAfterRoute && !kill && !this.lm.attacks.some((a) => this.winsGame(a.to))) {
        // Route complete in FFA; stop attacking to preserve garrisons on frontline/choke
      } else {
        const objective = kill ?? (hasRemainingRouteAttacks ? null : this.bonusCampaign());
        const route = objective?.attacks.find((a) => this.lm.attacks.some((l) => l.from === a.from && l.to === a.to));
        if (route && !this.lm.attacks.some((a) => this.winsGame(a.to) && this.chance(this.armies(a.from) - 1, a.to) >= 0.9)) {
          return { type: 'attack', from: route.from, to: route.to, blitz: true, stopAt: route.keep };
        }

        // In FFA, if stopAfterBonus is active and we hold our focus bonus (or any continent bonus) and have conquered a territory this turn:
        // Do NOT make greedy secondary attacks that bleed our new bonus chokepoint!
        // Situational exceptions: continue attacking if lethal game-win, player elimination, substantial surplus, or high-value enemy bonus break is present.
        const holdsBonus = Object.entries(this.view.continentOwners).some(([c, owner]) => owner === this.me && (!this.plan.focusContinent || c === this.plan.focusContinent));
        const hasLethal = this.lm.attacks.some((a) => this.winsGame(a.to));
        const isKillHunt = this.plan.winPath === 'kills' || kill !== null;
        const shouldStopForBonus =
          !is1v1 &&
          this.plan.stopAfterBonus &&
          holdsBonus &&
          this.conquered &&
          !hasLethal &&
          !isKillHunt &&
          !this.hasSubstantialSurplus() &&
          !this.hasHighValueBonusBreak();

        if (!shouldStopForBonus) {
          const attack = this.bestAttack();
          if (attack) {
            const action: Action = { type: 'attack', from: attack.from, to: attack.to, blitz: true };
            if (attack.keep > 1) action.stopAt = attack.keep;
            return action;
          }
          const card = this.cardAttack();
          if (card) {
            const action: Action = { type: 'attack', from: card.from, to: card.to, blitz: true };
            if (card.keep > 1) action.stopAt = card.keep;
            return action;
          }
        }
      }
    }
    if (this.view.phase === 'attack' || this.view.phase === 'fortify') {
      const f = this.bestFortify();
      if (f) return { type: 'fortify', ...f };
      return { type: 'end_turn' };
    }
    return null;
  }

  private campaignOptions(reinforcements = 0, transfer?: CampaignOptions['transfer']): CampaignOptions {
    return {
      avoid: this.plan.avoid, noAttack: this.plan.noAttack,
      floor: t => this.myCapitals.has(t) ? (this.plan.moveCapitalStack || this.plan.route.includes(t) ? (this.plan.capitalGarrison ?? 1) : this.capFloor(t)) : 1,
      reinforcements, transfer,
    };
  }

  private elimination(reinforcements = 0, transfer?: CampaignOptions['transfer']): KillPlan | null {
    return planElimination(this.view, this.me, { ...this.campaignOptions(reinforcements, transfer), targetOnly: this.hopeless() ? this.plan.target : null });
  }

  /** Complete a visible bonus from one or several fronts; route costs include all missing territories. */
  private bonusCampaign(reinforcements = 0, transfer?: CampaignOptions['transfer']): (Campaign & { score: number }) | null {
    if (this.hopeless()) return null;
    let best: (Campaign & { score: number }) | null = null;
    for (const c of this.map.continents) {
      const share = this.continentShare(c.id);
      if (!share.missing.length || share.missing.length > 5) continue;
      const campaign = planConquest(this.view, this.me, share.missing, this.campaignOptions(reinforcements, transfer));
      if (!campaign) continue;
      const focused = this.plan.focusContinent === c.id || (!!this.plan.focusTerritory && c.territories.includes(this.plan.focusTerritory));
      const score = c.bonus * (this.plan.winPath === 'bonuses' ? 4 : 3) + share.mine * 1.5 + (focused ? 12 : 0) - campaign.cost * 0.25 - campaign.deficit * 0.25;
      if (score > 0 && (!best || score > best.score)) best = { ...campaign, score };
    }
    return best;
  }

  // ---------- conquest ----------

  private occupyCount(pc: { from: TerritoryId; to: TerritoryId; minArmies: number; maxArmies: number }): number {
    const { from, to, minArmies: min, maxArmies: max } = pc;
    const clamp = (n: number) => Math.max(min, Math.min(max, n));
    const have = this.armies(from);
    // A capital we hold keeps its floor (a soft few, or the plan's garrison).
    const cap = this.myCapitals.has(from) ? (this.plan.moveCapitalStack || this.plan.route.includes(from) ? (this.plan.capitalGarrison ?? 1) : this.capFloor(from)) : 1;
    const ceiling = clamp(have - cap);
    const fromHostile = this.hostileNeighbours(from).filter((n) => n !== to);
    const toHostile = this.hostileNeighbours(to);
    if (fromHostile.length > 0 && toHostile.length === 0 && !this.capitalOf.has(to) && this.plan.fortifyTo !== to) return min;
    if (this.plan.route.includes(to) && this.plan.route.slice(this.plan.route.indexOf(to) + 1).some((r) => this.hostile(r))) return ceiling;
    const kill = this.elimination(0, { from, to, min, max: Math.min(max, have - cap) });
    if (kill?.occupy !== undefined) return kill.occupy;
    const bonus = this.bonusCampaign(0, { from, to, min, max: Math.min(max, have - cap) });
    if (bonus?.occupy !== undefined) return bonus.occupy;
    if (fromHostile.length === 0) return ceiling; // the source became interior: the whole stack goes
    // Does the attack go on from the new territory? Then the stack goes with it.
    const carry = Math.max(0, ceiling);
    const continues = toHostile.some((e) => this.chance(Math.max(1, carry), e) >= this.threshold() && !this.plan.avoid.has(this.owner(e)!) && !this.plan.noAttack.has(e));
    if (this.plan.route.includes(to) && this.plan.route.slice(this.plan.route.indexOf(to) + 1).some((r) => this.hostile(r))) return ceiling;
    if (continues) return ceiling;
    // Never strand the stack in a dead-end interior pocket while enemies still border `from`.
    if (toHostile.length === 0 && !this.capitalOf.has(to) && this.plan.fortifyTo !== to) return min;
    // Otherwise leave a guard on the old border, and a garrison on a freshly captured capital.
    const guard = Math.max(cap, this.plan.borderGuard <= 0 ? 1 : Math.ceil(this.floorThreat(fromHostile) * 0.75 * this.plan.borderGuard) + 1);
    let n = clamp(have - guard);
    if (this.capitalOf.has(to)) n = clamp(Math.max(n, Math.min(ceiling, this.plan.capitalGarrison ?? DEFAULT_CAPITAL_GARRISON + 2)));
    return Math.min(n, ceiling);
  }

  private bestAttack(): Scored | null {
    const thr = this.threshold();
    const late = this.view.round >= 18 && this.plan.stallPressure;
    const hopeless = this.hopeless();
    const hardGarrison = this.plan.capitalGarrison !== null;
    let best: Scored | null = null;
    for (const a of this.lm.attacks) {
      if (!this.hostile(a.to) || this.owner(a.from) !== this.me) continue;
      const have = this.armies(a.from);
      const d = this.armies(a.to);
      const wins = this.winsGame(a.to);
      const fromCapital = this.myCapitals.has(a.from);
      const isBorder = this.isBonusBorder(a.from);
      // On bonus borders in multi-player FFA, preserve the required defensive border garrison floor,
      // unless attacking wins the game, we are in a hopeless all-in, or following an explicit Commander route:
      const borderFloor = isBorder && !this.is1v1() && !wins && !hopeless && !this.plan.route.includes(a.to)
        ? Math.max(1, this.guardFor(a.from))
        : 1;
      const floor = fromCapital ? this.capFloor(a.from) : borderFloor;
      const toOwner = this.owner(a.to)!;
      if ((this.plan.avoid.has(toOwner) || this.plan.noAttack.has(a.to)) && !wins) continue;
      // All-in against the one player chosen: nobody else is touched unless it wins the game.
      if (hopeless && toOwner !== this.plan.target && !wins) continue;
      const isCap = this.capitalOf.has(a.to);
      const purpose = this.purpose(a.from, a.to, wins);
      // On the diplomacy path, players other than the target get a higher bar.
      const bar = this.plan.winPath === 'diplomacy' && this.plan.target && toOwner !== this.plan.target ? thr + 0.1 : thr;
      const accept = (commit: number, p: number): boolean => {
        if (commit < 1) return false;
        if (isCap && !wins && !hopeless && commit < this.capitalMargin() * d && p < 0.93) return false;
        if (p < bar && !wins) return false;
        const cardAttack = !this.conquered && !this.plan.skipCard && p >= Math.max(bar, this.cardMin());
        const lateAttack = late && p >= bar + 0.1;
        return wins || hopeless || purpose >= this.plan.purposeMin || cardAttack || lateAttack;
      };

      // Full commit: everything above the floor.
      let commit = have - floor;
      let p = commit >= 1 ? this.chance(commit, a.to) : 0;
      let ok = accept(commit, p);

      // Measured commit from a capital: the smallest force that reaches the target odds, allowed to dip below a soft
      // floor by a bounded share when it is a card attack or has a real purpose. The rest stays home.
      if (fromCapital && !wins && !hopeless && !this.plan.moveCapitalStack && !this.plan.route.includes(a.to)) {
        const dips = !hardGarrison && ((!this.conquered && !this.plan.skipCard) || purpose >= DIP_PURPOSE);
        const keepMin = dips ? Math.max(1, Math.ceil(floor * (1 - this.dipFraction()))) : floor;
        const most = have - keepMin;
        if (most >= 1) {
          const target = this.conquered || this.plan.skipCard ? bar : Math.max(bar, this.cardMin());
          let c = commitForOdds(have, d, this.limitFor(a.to), target, this.balanced);
          if (c !== null && isCap) c = Math.max(c, Math.ceil(this.capitalMargin() * d));
          if (c !== null && c <= most && (!ok || c < commit)) {
            const mp = this.chance(c, a.to);
            if (accept(c, mp)) {
              commit = c;
              p = mp;
              ok = true;
            }
          }
        }
      }
      if (this.plan.commitArmies > 0 && toOwner === this.plan.target) {
        const reserve = fromCapital ? (hardGarrison ? floor : Math.max(1, Math.min(SOFT_CAPITAL_FEW, have - 1))) : 1;
        const avail = have - reserve;
        if (avail >= 1) {
          const pledged = Math.min(avail, this.plan.commitArmies);
          if (!ok || commit < pledged) {
            commit = pledged;
            p = this.chance(commit, a.to);
            ok = true;
          }
        }
      }
      if (!ok) continue;
      // A near-certain win over a big stack is decisive (and breaks two giants trading small territories forever).
      const commitBonus = this.plan.commitArmies > 0 && toOwner === this.plan.target ? 8 : 0;
      const nextRouteTarget = this.plan.route.find((r) => this.hostile(r));
      const routeBonus = a.to === nextRouteTarget ? 12 : this.plan.route.includes(a.to) ? 6 : 0;
      const launchBonus = (this.plan.route.includes(a.from) || this.plan.placeOn.includes(a.from)) && routeBonus > 0 ? 4 : 0;
      const pocketBonus = this.hostileNeighbours(a.from).length > 1 && this.hostileNeighbours(a.to).length === 0 ? 2 : 0;
      const score = purpose + commitBonus + routeBonus + launchBonus + pocketBonus + p * 2 + (p >= 0.95 ? Math.min(d, 100) * 0.1 : -Math.min(d, 25) * 0.04) + this.random() * 0.3;
      if (!best || score > best.score) best = { from: a.from, to: a.to, score, purpose, p, keep: have - commit };
    }
    return best;
  }

  /**
   * Progressive cards: a conquest every turn is worth a card, and the set grows with every trade. When nothing else
   * was worth attacking, take the conquest with the best win chance per army committed (weakest neighbours first,
   * capitals only when easy), from any stack, with a measured commit. A soft few stay home on a capital; the plan's
   * garrison is kept when it names one. The plan can opt out with skipCard and a reason.
   */
  private cardAttack(): Scored | null {
    if (this.view.options.cardValues === 'fixed' || this.conquered || this.plan.skipCard) return null;
    const garrison = this.plan.capitalGarrison;
    let best: Scored | null = null;
    for (const a of this.lm.attacks) {
      if (!this.hostile(a.to) || this.owner(a.from) !== this.me) continue;
      const toOwner = this.owner(a.to)!;
      const wins = this.winsGame(a.to);
      if ((this.plan.avoid.has(toOwner) || this.plan.noAttack.has(a.to)) && !wins) continue;
      if (this.hopeless() && toOwner !== this.plan.target && !wins) continue;
      const have = this.armies(a.from);
      const d = this.armies(a.to);
      const limit = this.limitFor(a.to);
      let keepMin = 1;
      if (this.myCapitals.has(a.from) && !this.hopeless()) keepMin = garrison !== null ? garrison : SOFT_CAPITAL_FEW;
      keepMin = Math.max(1, Math.min(have - 1, keepMin));
      const most = have - keepMin;
      if (most < 1) continue;
      const cheap = commitForOdds(have, d, limit, this.plan.cardChance, this.balanced);
      if (cheap === null || cheap > most) continue;
      // A little more force when it is cheap relative to the stack.
      let c = cheap;
      const safe = commitForOdds(have, d, limit, 0.85, this.balanced);
      if (safe !== null && safe <= most && safe <= Math.max(cheap + 2, Math.ceil(most * 0.4))) c = safe;
      const p = this.chance(c, a.to);
      const easy = p >= 0.9;
      const score = (p / c) * (this.capitalOf.has(a.to) && !easy ? 0.4 : 1) + (wins ? 100 : 0) + this.random() * 0.01;
      if (!best || score > best.score) best = { from: a.from, to: a.to, score, purpose: 0, p, keep: have - c };
    }
    return best;
  }

  /** Does taking `to` end the game for us? (Last capital, or the last opponent's last territory.) */
  private winsGame(to: TerritoryId): boolean {
    const v = this.view;
    const others = v.players.filter((p) => p.alive && !p.isNeutral && p.id !== this.me);
    if (v.options.capitals) {
      const entries = Object.entries(v.capitals ?? {});
      const everyone = v.players.filter((p) => !p.isNeutral).length;
      if (entries.length === everyone && this.capitalOf.has(to)) {
        const notMine = entries.filter(([, t]) => this.owner(t) !== this.me);
        if (notMine.length === 1 && notMine[0][1] === to) return true;
      }
    }
    if (others.length === 1 && others[0].territoryCount === 1 && this.owner(to) === others[0].id) return true;
    return false;
  }

  private purpose(from: TerritoryId, to: TerritoryId, wins: boolean): number {
    const path = this.plan.winPath;
    let s = 0;
    if (wins) s += 100;
    const is1v1 = this.is1v1();
    const cont = this.map.territoryById[to].continent;
    const bonus = this.map.continentById[cont].bonus;
    const share = this.continentShare(cont);
    const toOwner = this.owner(to)!;
    let cs = 0;
    if (share.missing.length === 1 && share.missing[0] === to) cs += 6 + bonus;
    else if (share.missing.length <= 3 && share.mine * 2 >= share.total && share.missing.includes(to)) cs += 2.5 + bonus * 0.3;
    const holder = this.view.continentOwners[cont];
    if (holder && holder !== this.me && holder === toOwner) cs += 4.5 + bonus * 0.8;
    s += path === 'bonuses' ? cs * 1.5 : cs;

    // In 1v1, there are no 3rd parties: break every opponent continent and deny territories to crush their turn income!
    if (is1v1) {
      if (holder && holder !== this.me) s += 6 + bonus * 1.5;
      s += 2.5; // each territory stripped from the sole rival directly starves their base income
    }
    const capOwner = this.capitalOf.get(to);
    if (capOwner && capOwner !== this.me) s += path === 'capitals' ? 7 : 4;
    const focus = this.inFocus(to);
    if (focus === 2) s += 7;
    else if (focus === 1) s += 3.5;
    if (this.plan.route.includes(to)) s += 6;
    if (this.plan.target && toOwner === this.plan.target) s += path === 'hopeless' ? 10 : (path === 'kills' ? 5.5 : 3.5);
    const p = this.view.players.find((x) => x.id === toOwner);
    if (p && p.territoryCount === 1) s += (path === 'kills' ? 8 : 6) + p.cardCount * 1.5;
    else if (p && p.cardCount >= 5) s += (path === 'kills' || path === 'cards' ? 6 : 4);
    else if (p && p.cardCount >= 4) s += (path === 'kills' || path === 'cards' ? 4.5 : 2.5);
    else if (p && p.cardCount >= 3) s += path === 'cards' ? 3 : 1.2;
    if (path === 'kills' && p && (p.territoryCount === null || p.territoryCount <= 4)) s += 4 + p.cardCount * 1.2;
    if (toOwner === this.leader) s += 1;
    // Taking it makes the launch point interior.
    if (this.hostileNeighbours(from).length === 1) s += 1.5;
    if (!this.conquered) s += 1;
    return s;
  }

  // ---------- capital choice ----------

  private chooseCapital(choices: TerritoryId[]): TerritoryId {
    if (this.plan.capital && choices.includes(this.plan.capital)) return this.plan.capital;
    const otherCaps = new Set([...this.capitalOf.keys()]);
    let best = choices[0];
    let bestScore = -Infinity;
    for (const t of choices) {
      const adj = this.map.adjacency[t];
      const exits = adj.filter((n) => !this.blizzards.has(n) && this.owner(n) !== this.me && !this.view.territories[n]?.hidden);
      const hiddenNeighbours = adj.filter((n) => this.view.territories[n]?.hidden).length;
      const open = exits.length + hiddenNeighbours;
      const ownNeighbours = adj.filter((n) => this.owner(n) === this.me).length;
      const exitsClear = exits.filter((n) => !otherCaps.has(n)).length + hiddenNeighbours;
      const cont = this.map.territoryById[t].continent;
      const share = this.continentShare(cont);
      let s = this.armies(t) * 1.2;
      s += Math.min(open, 2) * 3; // a door toward the enemy
      s -= Math.max(0, open - 3) * 2; // crossroads
      if (open === 0) s -= 7; // deep pocket
      else if (exitsClear === 0) s -= 6; // the only way out is through another capital
      s += Math.min(ownNeighbours, 3) * 0.8;
      s -= this.threat(t) / 6;
      s += (share.mine / Math.max(1, share.total)) * 3;
      s += this.random() * 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    return best;
  }

  // ---------- cards ----------

  private chooseSet(sets: number[][]): number[] {
    const cards = new Map((this.view.players.find((p) => p.id === this.me)?.cards ?? []).map((c) => [c.id, c]));
    const score = (ids: number[]) => ids.reduce((n, id) => {
      const c = cards.get(id);
      if (!c) return n;
      return n + (c.territory && this.owner(c.territory) === this.me ? 2 : 0) - (c.kind === 'wild' ? 1 : 0);
    }, 0);
    return [...sets].sort((a, b) => score(b) - score(a))[0];
  }

  // ---------- placement ----------

  private placements(options: TerritoryId[], pool: number): Record<TerritoryId, number> {
    // Claiming phase: prefer territories next to ours (and the focus).
    const unclaimed = options.filter((t) => this.owner(t) === null && !this.view.territories[t]?.hidden);
    if (unclaimed.length > 0) {
      const owned = new Set(this.mine());
      let best = unclaimed[0];
      let bestScore = -Infinity;
      for (const t of unclaimed) {
        const s = this.map.adjacency[t].filter((n) => owned.has(n)).length + this.inFocus(t) * 1.5 + this.random();
        if (s > bestScore) ((bestScore = s), (best = t));
      }
      return { [best]: 1 };
    }

    const result: Record<TerritoryId, number> = {};
    const mine = options.filter(t => this.owner(t) === this.me);
    let left = pool;
    const funded = new Set<TerritoryId>();
    const add = (t: TerritoryId, n: number) => {
      n = Math.max(0, Math.min(left, Math.floor(n)));
      if (n > 0) { result[t] = (result[t] ?? 0) + n; left -= n; }
    };

    // If the Commander explicitly chose placement territories, honor them directly.
    const chosenPlace = this.plan.placeOn.filter((t) => mine.includes(t));
    if (chosenPlace.length > 0) {
      const per = Math.floor(left / chosenPlace.length);
      for (const t of chosenPlace) add(t, per);
      for (const t of chosenPlace) if (left > 0) add(t, 1);
      return result;
    }

    // If the Commander specified an explicit attack route, stage reinforcements at its launch pad.
    if (this.plan.route.length > 0 && left > 0) {
      const firstStep = this.plan.route[0];
      const launch = mine.includes(firstStep)
        ? firstStep
        : mine
          .filter((t) => this.map.adjacency[t].includes(firstStep) && !this.blizzards.has(firstStep))
          .sort((a, b) => this.armies(b) - this.armies(a))[0];
      if (launch) {
        add(launch, left);
        return result;
      }
    }

    // First fund the entire objective, not just its most attractive first attack.
    const campaign = this.elimination(pool) ?? this.bonusCampaign(pool);
    if (campaign && Object.keys(campaign.placements).every(t => mine.includes(t))) {
      for (const [t, n] of Object.entries(campaign.placements)) add(t, n);
      for (const t of Object.keys(campaign.requirements)) funded.add(t);
    }
    if (this.plan.commitArmies > 0 && this.plan.target && left > 0) {
      const commitFront = mine
        .filter((t) => this.hostileNeighbours(t).some((n) => this.owner(n) === this.plan.target && !this.plan.noAttack.has(n)))
        .sort((a, b) => this.armies(b) - this.armies(a))[0];
      if (commitFront) {
        const reserve = this.myCapitals.has(commitFront) ? (this.plan.capitalGarrison ?? SOFT_CAPITAL_FEW) : 1;
        const need = Math.max(0, reserve + this.plan.commitArmies - this.armies(commitFront) - (result[commitFront] ?? 0));
        if (need > 0) add(commitFront, need);
        funded.add(commitFront);
      }
    }

    // Protect valuable positions with part of the surplus; route troops already placed count toward defence.
    let guardBudget = Math.ceil(left * 0.4);
    const vital = mine.map(t => ({ t, wanted: this.myCapitals.has(t) ? this.capWanted(t) : this.isBonusBorder(t) ? this.guardFor(t) : 0 }))
      .sort((a, b) => b.wanted - this.armies(b.t) - (a.wanted - this.armies(a.t)));
    for (const v of vital) {
      const n = Math.min(guardBudget, Math.max(0, v.wanted - this.armies(v.t) - (result[v.t] ?? 0)));
      add(v.t, n); guardBudget -= n;
    }

    // Other worthwhile fronts must reach attack strength before we open another front. Never count the
    // same stack twice for two projects, or scatter one army everywhere without funding a usable attack.
    const projects: { from: TerritoryId; to: TerritoryId; needed: number; score: number }[] = [];
    for (const from of mine) {
      if (funded.has(from)) continue;
      const have = this.armies(from) + (result[from] ?? 0);
      const floor = this.myCapitals.has(from) ? this.capFloor(from) : 1;
      for (const to of this.hostileNeighbours(from)) {
        if (this.plan.avoid.has(this.owner(to)!) || this.plan.noAttack.has(to)) continue;
        if (this.hopeless() && this.owner(to) !== this.plan.target) continue;
        const purpose = this.purpose(from, to, this.winsGame(to));
        const card = !this.conquered && !this.plan.skipCard && this.view.options.cardValues !== 'fixed';
        if (purpose < this.plan.purposeMin && !card) continue;
        const commit = commitForOdds(have + left, this.armies(to), this.limitFor(to), Math.max(0.85, this.threshold()), this.balanced);
        if (commit === null) continue;
        const needed = Math.max(0, floor + commit - have);
        projects.push({ from, to, needed, score: this.targetValue(from, to) / (1 + needed * 0.15) });
      }
    }
    projects.sort((a, b) => b.score - a.score || a.needed - b.needed);
    for (const p of projects) {
      if (funded.size >= 4) break;
      if (funded.has(p.from) || p.needed > left) continue;
      add(p.from, p.needed); funded.add(p.from);
    }

    // With no affordable attack, build toward the best real front (including a fog frontier).
    // Otherwise distribute spare casualty reserves over the funded routes rather than one giant stack.
    const reserves = [...funded];
    if (!reserves.length) {
      const fronts = mine.filter(t => this.map.adjacency[t].some(n => !this.blizzards.has(n) &&
        (this.view.territories[n]?.hidden || (this.hostile(n) && !this.plan.avoid.has(this.owner(n)!) && !this.plan.noAttack.has(n)))));
      const stage = projects[0]?.from ?? fronts.sort((a, b) => this.need(b) - this.need(a))[0] ?? mine[0] ?? options[0];
      add(stage, left);
      return result;
    }
    const surplus = left;
    const weights = reserves.map(t => Math.sqrt(Math.max(1, (campaign?.requirements[t] ?? this.threat(t) * 0.25 + 2) - 1)));
    const total = weights.reduce((s, n) => s + n, 0);
    const fractions = reserves.map((t, i) => ({ t, exact: surplus * weights[i] / total }));
    for (const r of fractions) add(r.t, Math.floor(r.exact));
    fractions.sort((a, b) => (b.exact % 1) - (a.exact % 1));
    for (const r of fractions) if (left > 0) add(r.t, 1);
    return result;
  }

  /** How worthwhile hitting `to` from `from` is, ignoring odds (placement uses it to pick a staging point). */
  private targetValue(from: TerritoryId, to: TerritoryId): number {
    const toOwner = this.owner(to);
    if (!toOwner || ((this.plan.avoid.has(toOwner) || this.plan.noAttack.has(to)) && !this.winsGame(to))) return 0;
    return Math.max(0, this.purpose(from, to, false) - 1) + 1 / (1 + this.armies(to) / 3);
  }

  // ---------- fortify ----------

  private need(t: TerritoryId): number {
    const have = this.armies(t);
    let n = Math.max(0, this.threat(t) * 0.9 + 1 - have);
    if (this.myCapitals.has(t)) n += Math.max(0, this.capWanted(t) - have) * 1.5;
    if (this.isBonusBorder(t)) n += 2 * this.plan.borderGuard;
    n += this.inFocus(t) * 1.5 + (this.nearFocus(t) ? 1.5 : 0);
    if (this.plan.fortifyTo === t) n += 25;
    return n;
  }

  private bestFortify(): { from: TerritoryId; to: TerritoryId; armies: number } | null {
    if (!this.plan.fortify) return null;
    const opts = this.lm.fortifies.filter((f) => this.owner(f.from) === this.me && this.owner(f.to) === this.me && f.from !== f.to);
    if (opts.length === 0) return null;
    const isBorder = (t: TerritoryId) => this.hostileNeighbours(t).length > 0;
    // Inside out: interior stacks go to the most threatened border (a capital's stack only when the plan lets it move).
    const mayLeave = (t: TerritoryId) => !this.myCapitals.has(t) || this.plan.moveCapitalStack || (this.plan.fortifyTo !== null && this.plan.fortifyTo !== t);
    let best: { from: TerritoryId; to: TerritoryId; armies: number; score: number } | null = null;
    for (const f of opts) {
      if (!mayLeave(f.from) || isBorder(f.from)) continue;
      if (!isBorder(f.to) && !this.myCapitals.has(f.to) && f.to !== this.plan.fortifyTo) continue;
      const score = this.need(f.to) + this.threat(f.to) * 0.15 + f.maxArmies * 0.2 + this.random() * 0.2;
      if (!best || score > best.score) best = { from: f.from, to: f.to, armies: f.maxArmies, score };
    }
    if (best) return { from: best.from, to: best.to, armies: best.armies };
    // Nothing interior left: shift surplus between borders (out of a capital only when the plan lets it move).
    for (const f of opts) {
      if (!mayLeave(f.from) || !isBorder(f.from) || (!isBorder(f.to) && !this.myCapitals.has(f.to) && f.to !== this.plan.fortifyTo)) continue;
      const pullingBack = f.to === this.plan.fortifyTo || this.myCapitals.has(f.to);
      const stay = f.to === this.plan.fortifyTo
        ? (this.myCapitals.has(f.from) ? this.capFloor(f.from) : 1)
        : this.myCapitals.has(f.to)
          ? (this.isBonusBorder(f.from) ? this.guardFor(f.from) : 1)
          : Math.max(this.guardFor(f.from), this.myCapitals.has(f.from) ? this.capFloor(f.from) : 1);
      const surplus = Math.min(f.maxArmies, this.armies(f.from) - stay);
      if (surplus < (pullingBack ? 1 : 2)) continue;
      const gain = this.need(f.to) - this.need(f.from);
      if (gain < (pullingBack ? 1 : 2)) continue;
      const score = gain + surplus * 0.1 + this.random() * 0.2;
      if (!best || score > best.score) best = { from: f.from, to: f.to, armies: surplus, score };
    }
    return best ? { from: best.from, to: best.to, armies: best.armies } : null;
  }
}
