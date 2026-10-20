import {
  blitzOdds,
  defenseDiceLimit,
  getMap,
  isBlizzard,
  NEUTRAL_ID,
  nextTradeValue,
  reinforcementsFor,
  type BlitzOdds,
  type ContinentDef,
  type GameState,
  type MapDef,
  type PlayerId,
  type TerritoryId,
} from '@risk/engine';
import { stepAgent, type Candidate, type StepContext } from '@risk/selfplay';
import { DEFAULT_TEACHER_PARAMS, type TeacherParams } from './teacher.js';

/**
 * jacob-sensei@1 ("Jacob Sensei"): a hand-coded Delove teacher built for big tables, where Sensei 2
 * (delove-teacher@2) stalls: with progressive cards every seat ends up on a few thousand armies and nobody attacks,
 * because in a many-player game the armies a fight costs mostly help the players who stay out of it.
 *
 * It keeps Sensei's judgement (src/teacher.ts, unchanged and locked by scripts/golden.mjs) and adds terms taken from
 * the LLM players' post-game notes (AI/general-player/risk-learnings.md), each a tunable number:
 * - pressure the leader: a rival's armies and territories are worth more the further its power (armies + income +
 *   cards) is above the table's mean ("check the leader's income and territory count, not just your neighbours");
 * - go for the kill: when a stack outweighs a rival's whole army, every capture from that rival carries a share of
 *   the elimination's worth ("hunt weak players for their cards", "plan the whole kill run");
 * - always take a card territory: until the turn's first conquest, the attack bar drops by cardUrge;
 * - use huge stacks: own losses count for less the more a stack exceeds what its border needs, relative to income
 *   ("sitting on troops ... the most common mistake");
 * - late-game aggression: from lateRound on, each round lowers the attack bar and the win chance it needs;
 * - never leave interior stacks idle: an interior stack is always fortified to the front, toward the best attack.
 *
 * Like Sensei it picks only from the self-play candidates and is deterministic given the context (ctx.random breaks
 * ties). Skipped from the notes: anything needing chat, diplomacy, fog or memory of earlier turns.
 */
export const JACOB_ID = 'jacob-sensei@1';
export const JACOB_NAME = 'Jacob Sensei';

export interface JacobParams extends TeacherParams {
  /** Power of a player = armies + powerIncome x income per turn + powerCards x cards held x card value. */
  powerIncome: number;
  powerCards: number;
  /** Per unit of a rival's lead (power / mean power - 1, capped at 2): extra worth of its armies lost, of a capture. */
  leaderLoss: number;
  leaderCapture: number;
  /** A capture from a rival whose whole army is under huntRatio x the attacking stack earns huntValue x a share of the elimination. */
  huntRatio: number;
  huntValue: number;
  /** Until the turn's first conquest, the attack bar (minEv) is lower by this much. */
  cardUrge: number;
  /** Own losses are divided by 1 + stackRamp x log(1 + max(0, surplus / income - stackFree)). */
  stackRamp: number;
  stackFree: number;
  /** Late game: every round past lateRound lowers minWin by lateWin, down to minWinFloor. */
  lateWin: number;
  minWinFloor: number;
  /** Fortify: weight of moving an interior stack to the front when no border needs it more. */
  frontPull: number;
}

/** Jacob Sensei's untuned starting numbers: Sensei 2's 28, plus first guesses for the new terms (where tuning starts). */
export const DEFAULT_JACOB_PARAMS: JacobParams = {
  ...DEFAULT_TEACHER_PARAMS,
  targetShare: 3.08,
  targetEnemyRatio: 0.918,
  targetMissing: 0.196,
  defenseGapPad: 2.246,
  cardFloor: 2.089,
  cardDiv: 2.032,
  captureBase: 0.326,
  completeBonus: 2.103,
  breakBonus: 2.231,
  capitalValue: 8.446,
  placeOffenseArmy: 0.137,
  placeDefenseMult: 2.438,
  rivalLoss2: 0.697,
  ownLoss: 0.543,
  minEv: 0.246,
  exposureBase: 0.459,
  exposureThreat: 0.11,
  exposureNeed: 0.323,
  fortifyThreat: 0.066,
  lateRound: 20,
  lateRamp: 0.05,
  powerIncome: 3,
  powerCards: 0.5,
  leaderLoss: 0.3,
  leaderCapture: 1,
  huntRatio: 1.5,
  huntValue: 1,
  cardUrge: 0.5,
  stackRamp: 0.3,
  stackFree: 3,
  lateWin: 0.01,
  minWinFloor: 0.3,
  frontPull: 0.5,
};

interface MapInfo {
  map: MapDef;
  continentOf: Map<TerritoryId, ContinentDef>;
  borders: Map<string, TerritoryId[]>;
}

const mapInfoCache = new Map<string, MapInfo>();
const oddsCache = new Map<number, BlitzOdds>();

function odds(from: number, to: number, defenseLimit: number): BlitzOdds {
  const key = (from * 100_003 + to) * 4 + defenseLimit;
  let o = oddsCache.get(key);
  if (!o) {
    if (oddsCache.size > 200_000) oddsCache.clear();
    o = blitzOdds(from, to, defenseLimit);
    oddsCache.set(key, o);
  }
  return o;
}

function mapInfo(map: MapDef): MapInfo {
  let info = mapInfoCache.get(map.id);
  if (!info) {
    const continentOf = new Map<TerritoryId, ContinentDef>();
    for (const c of map.continents) for (const t of c.territories) continentOf.set(t, c);
    const borders = new Map<string, TerritoryId[]>();
    for (const c of map.continents) {
      const inside = new Set(c.territories);
      borders.set(c.id, c.territories.filter((t) => map.adjacency[t].some((n) => !inside.has(n))));
    }
    info = { map, continentOf, borders };
    mapInfoCache.set(map.id, info);
  }
  return info;
}

interface PlayerStats {
  armies: number;
  territories: number;
  income: number;
  power: number;
}

/** Read-only helpers over one position, from one player's side (Sensei's Board plus the table-wide view). */
class Board {
  readonly info: MapInfo;
  readonly adj: Record<TerritoryId, TerritoryId[]>;
  private readonly heldCache = new Map<string, boolean>();
  private targetCache: ContinentDef | null | undefined;
  private readonly enemyCache = new Map<TerritoryId, TerritoryId[]>();
  private readonly threatCache = new Map<TerritoryId, number>();
  private readonly needCache = new Map<TerritoryId, number>();
  private readonly captureCache = new Map<string, number>();
  private cardValueCache: number | undefined;
  private statsCache: Map<PlayerId, PlayerStats> | undefined;
  private meanPowerCache = 0;

  constructor(
    readonly state: GameState,
    readonly me: PlayerId,
    readonly p: JacobParams,
  ) {
    this.info = mapInfo(getMap(state.options.map));
    this.adj = this.info.map.adjacency;
  }

  owner(t: TerritoryId): PlayerId | null {
    return this.state.territories[t].owner;
  }

  armies(t: TerritoryId): number {
    return this.state.territories[t].armies;
  }

  isRival(p: PlayerId | null): p is PlayerId {
    return p !== null && p !== this.me && p !== NEUTRAL_ID;
  }

  enemyNeighbours(t: TerritoryId): TerritoryId[] {
    let v = this.enemyCache.get(t);
    if (v === undefined) {
      v = this.adj[t].filter((n) => !isBlizzard(this.state, n) && this.owner(n) !== null && this.owner(n) !== this.me);
      this.enemyCache.set(t, v);
    }
    return v;
  }

  threat(t: TerritoryId): number {
    let sum = this.threatCache.get(t);
    if (sum === undefined) {
      sum = 0;
      for (const n of this.adj[t]) if (this.isRival(this.owner(n))) sum += this.armies(n) - 1;
      this.threatCache.set(t, sum);
    }
    return sum;
  }

  continentTerritories(c: ContinentDef): TerritoryId[] {
    if (!this.state.blizzards?.length) return c.territories;
    return c.territories.filter((t) => !isBlizzard(this.state, t));
  }

  holds(c: ContinentDef, p: PlayerId = this.me): boolean {
    const key = `${c.id}:${p}`;
    let v = this.heldCache.get(key);
    if (v === undefined) {
      const ts = this.continentTerritories(c);
      v = ts.length > 0 && ts.every((t) => this.owner(t) === p);
      this.heldCache.set(key, v);
    }
    return v;
  }

  /** Armies, territories, income and power of every living player (the Neutral excluded), worked out once. */
  stats(p: PlayerId): PlayerStats | undefined {
    if (!this.statsCache) {
      const m = new Map<PlayerId, PlayerStats>();
      for (const pl of this.state.players) {
        if (!pl.alive || pl.isNeutral) continue;
        m.set(pl.id, { armies: 0, territories: 0, income: 0, power: 0 });
      }
      for (const t of this.info.map.territoryIds) {
        const s = m.get(this.owner(t)!);
        if (s) (s.armies += this.armies(t)), s.territories++;
      }
      const card = this.cardValue();
      let total = 0;
      for (const pl of this.state.players) {
        const s = m.get(pl.id);
        if (!s) continue;
        s.income = s.territories > 0 ? reinforcementsFor(this.state, pl.id).total : 0;
        s.power = s.armies + this.p.powerIncome * s.income + this.p.powerCards * pl.cards.length * card;
        total += s.power;
      }
      this.meanPowerCache = m.size ? total / m.size : 0;
      this.statsCache = m;
    }
    return this.statsCache.get(p);
  }

  territoryCount(p: PlayerId): number {
    return this.stats(p)?.territories ?? 0;
  }

  /** How far a rival's power is above the table's mean (0 when not above it), capped at 2. */
  lead(p: PlayerId | null): number {
    if (!this.isRival(p)) return 0;
    const s = this.stats(p);
    if (!s || this.meanPowerCache <= 0) return 0;
    return Math.min(2, Math.max(0, s.power / this.meanPowerCache - 1));
  }

  target(): ContinentDef | null {
    if (this.targetCache !== undefined) return this.targetCache;
    let best: ContinentDef | null = null;
    let bestScore = -Infinity;
    for (const c of this.info.map.continents) {
      if (this.holds(c)) continue;
      const ts = this.continentTerritories(c);
      if (ts.length === 0) continue;
      let mine = 0;
      let myArmies = 0;
      let theirArmies = 0;
      for (const t of ts) {
        if (this.owner(t) === this.me) (mine++, (myArmies += this.armies(t)));
        else theirArmies += this.armies(t);
      }
      const touching = mine > 0 || ts.some((t) => this.adj[t].some((n) => this.owner(n) === this.me));
      if (!touching) continue;
      const borders = Math.max(1, this.info.borders.get(c.id)!.length);
      const p = this.p;
      const score = (mine / ts.length) * p.targetShare + (c.bonus / borders) * p.targetBonusPerBorder - (theirArmies / (myArmies + 2)) * p.targetEnemyRatio - (ts.length - mine) * p.targetMissing;
      if (score > bestScore) (bestScore = score), (best = c);
    }
    this.targetCache = best;
    return best;
  }

  defenseNeed(t: TerritoryId): number {
    let v = this.needCache.get(t);
    if (v === undefined) this.needCache.set(t, (v = this.computeDefenseNeed(t)));
    return v;
  }

  private computeDefenseNeed(t: TerritoryId): number {
    const c = this.info.continentOf.get(t);
    const threat = this.threat(t);
    if (threat <= 0) return 0;
    const gap = threat - this.armies(t) + this.p.defenseGapPad;
    if (gap <= 0) return 0;
    const atStake = c && this.holds(c) ? c.bonus : 0;
    return gap * (this.p.defenseBase + atStake / this.p.defenseStakeDiv);
  }

  cardValue(): number {
    if (this.cardValueCache === undefined) {
      const o = this.state.options;
      const p = this.state.players.find((x) => x.id === this.me)!;
      this.cardValueCache = Math.max(this.p.cardFloor, nextTradeValue(o.cardValues, this.state.tradeCount, p.tradesMade ?? 0) / this.p.cardDiv);
    }
    return this.cardValueCache;
  }

  rivalsAlive(): number {
    return this.state.players.filter((p) => p.alive && !p.isNeutral && p.id !== this.me).length;
  }

  /** Worth of eliminating `owner`: base plus their cards at card value. */
  elimValue(owner: PlayerId): number {
    const p = this.state.players.find((x) => x.id === owner)!;
    return this.p.elimBase + p.cards.length * this.cardValue();
  }

  /** Share of the elimination a capture from `owner` earns when `stack` armies outweigh their whole army. */
  hunt(owner: PlayerId | null, stack: number): number {
    if (!this.isRival(owner) || this.p.huntValue <= 0) return 0;
    const s = this.stats(owner);
    if (!s || s.territories <= 1 || stack < this.p.huntRatio * s.armies) return 0;
    return (this.p.huntValue * this.elimValue(owner)) / s.territories;
  }

  captureValue(u: TerritoryId, cardStillToEarn: boolean): number {
    const key = cardStillToEarn ? `1${u}` : `0${u}`;
    let v = this.captureCache.get(key);
    if (v === undefined) this.captureCache.set(key, (v = this.computeCaptureValue(u, cardStillToEarn)));
    return v;
  }

  private computeCaptureValue(u: TerritoryId, cardStillToEarn: boolean): number {
    const owner = this.owner(u);
    let v = this.p.captureBase;
    if (cardStillToEarn) v += this.cardValue();
    const c = this.info.continentOf.get(u);
    if (c) {
      const ts = this.continentTerritories(c);
      const othersMine = ts.every((t) => t === u || this.owner(t) === this.me);
      if (othersMine) v += c.bonus * this.p.completeBonus;
      else if (this.target()?.id === c.id) v += this.p.targetCapture;
      if (this.isRival(owner) && this.holds(c, owner)) v += c.bonus * this.p.breakBonus;
    }
    if (this.isRival(owner) && this.territoryCount(owner) === 1) v += this.elimValue(owner);
    v += this.lead(owner) * this.p.leaderCapture;
    if (this.state.options.capitals && owner !== null && this.state.capitals[owner] === u) v += this.p.capitalValue;
    return v;
  }

  /** Rounds past lateRound, times lateRamp. */
  late(): number {
    return Math.max(0, this.state.round - this.p.lateRound) * this.p.lateRamp;
  }
}

type Pick = (ctx: StepContext) => number;

function argmax(cands: Candidate[], score: (c: Candidate) => number, random: () => number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const s = score(cands[i]);
    if (s === -Infinity) continue;
    const jittered = s + random() * 1e-3;
    if (jittered > bestScore) (bestScore = jittered), (best = i);
  }
  return best;
}

function indexOfKind(cands: Candidate[], kind: Candidate[0]): number {
  return cands.findIndex((c) => c[0] === kind);
}

/** Where to put armies: Sensei's defence-or-offence score, the offence also counting a hunt the new stack makes possible. */
function placementScore(b: Board, t: TerritoryId, placing = 0): number {
  const owner = b.owner(t);
  if (owner === null) {
    const c = b.info.continentOf.get(t);
    const mineNear = b.adj[t].filter((n) => b.owner(n) === b.me).length;
    let mineIn = 0;
    let total = 0;
    if (c) for (const x of b.continentTerritories(c)) (total++, b.owner(x) === b.me && mineIn++);
    return mineNear + (total ? (mineIn / total) * 3 : 0) + (c ? c.bonus / Math.max(1, b.info.borders.get(c.id)!.length) : 0);
  }
  const enemies = b.enemyNeighbours(t);
  if (enemies.length === 0) return -50 - b.armies(t);
  const defense = b.defenseNeed(t);
  let offense = 0;
  const stack = b.armies(t) + placing - 1;
  for (const u of enemies) {
    const value = b.captureValue(u, true) + b.hunt(b.owner(u), stack);
    offense = Math.max(offense, value - Math.max(0, b.armies(u) - b.armies(t)) * b.p.placeOffenseArmy);
  }
  return Math.max(defense * b.p.placeDefenseMult, offense);
}

function pickPlace(b: Board, cands: Candidate[], random: () => number): number {
  const ids = b.info.map.territoryIds;
  let placing = 0;
  for (const c of cands) if (c[0] === 'place') placing = Math.max(placing, c[2]);
  const scores = new Map<number, number>();
  const score = (t: number) => {
    let s = scores.get(t);
    if (s === undefined) scores.set(t, (s = placementScore(b, ids[t], placing)));
    return s;
  };
  return argmax(cands, (c) => (c[0] === 'place' ? score(c[1]) + c[2] * 1e-6 : -Infinity), random);
}

function bestAttack(b: Board, cands: Candidate[], random: () => number): number {
  const ids = b.info.map.territoryIds;
  const me = b.state.players.find((p) => p.id === b.me)!;
  const cardStillToEarn = !me.conqueredThisTurn;
  const balanced = b.state.options.balancedBlitz;
  const P = b.p;
  const rivalLossWorth = b.rivalsAlive() <= 1 ? P.rivalLoss2 : P.rivalLossMulti;
  const late = b.late();
  const minEv = P.minEv - late - (cardStillToEarn ? P.cardUrge : 0);
  const minWin = Math.max(Math.min(P.minWin, P.minWinFloor), P.minWin - late * P.lateWin);
  const income = Math.max(3, b.stats(b.me)?.income ?? 3);
  let best = -1;
  let bestEv = -Infinity;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c[0] !== 'attack') continue;
    const from = ids[c[1]];
    const to = ids[c[2]];
    const a = b.armies(from);
    if (a < 2) continue;
    const o = odds(a, b.armies(to), defenseDiceLimit(b.state, to));
    const p = balanced ? o.balancedWin : o.win;
    if (p < minWin) continue;
    const owner = b.owner(to);
    const value = b.captureValue(to, cardStillToEarn) + b.hunt(owner, a - 1);
    const exposure = (1 - p) * (P.exposureBase + b.threat(from) * P.exposureThreat + b.defenseNeed(from) * P.exposureNeed);
    const defenderWorth = b.isRival(owner) ? rivalLossWorth + b.lead(owner) * P.leaderLoss : P.neutralLoss;
    // Armies beyond what the border needs, in turns of income: idle capital, so losing them costs less.
    const surplus = Math.max(0, (a - b.threat(from)) / income - P.stackFree);
    const ownLoss = P.ownLoss / (1 + late) / (1 + P.stackRamp * Math.log1p(surplus));
    const ev = p * value + o.expectedDefenderLosses * defenderWorth - o.expectedAttackerLosses * ownLoss - exposure + random() * 1e-3;
    if (ev > minEv && ev > bestEv) (bestEv = ev), (best = i);
  }
  return best;
}

function pickOccupy(b: Board, cands: Candidate[]): number {
  const pc = b.state.pendingConquest!;
  const amounts = cands.map((c) => (c[0] === 'occupy' ? c[1] : -1));
  const max = Math.max(...amounts);
  const min = Math.min(...amounts.filter((n) => n >= 0));
  const middle = amounts.find((n) => n !== max && n !== min) ?? max;
  const fromExposed = b.threat(pc.from) > 0 || b.enemyNeighbours(pc.from).some((n) => n !== pc.to);
  const toFront = b.adj[pc.to].some((n) => n !== pc.from && b.owner(n) !== null && b.owner(n) !== b.me && !isBlizzard(b.state, n));
  let want: number;
  if (!fromExposed) want = max;
  else if (!toFront) want = min;
  else if (b.threat(pc.from) === 0) want = max;
  else want = middle;
  return amounts.indexOf(want);
}

interface FortifyPlan {
  from: TerritoryId;
  to: TerritoryId;
}

/** Sensei's fortify (toward the most threatened border), plus: an interior stack always moves to the best front. */
function bestFortify(b: Board, legal: StepContext['legal']): FortifyPlan | null {
  let best: FortifyPlan | null = null;
  let bestScore = 0;
  const anyRealThreat = b.info.map.territoryIds.some((t) => b.owner(t) === b.me && b.threat(t) > 0);
  for (const f of legal.fortifies) {
    if (f.from === f.to || f.maxArmies < 1) continue;
    if (b.threat(f.from) > 0) continue;
    const interior = b.enemyNeighbours(f.from).length === 0;
    if (!anyRealThreat && !interior) continue;
    let score = 0;
    if (anyRealThreat) {
      const need = b.defenseNeed(f.to) + b.threat(f.to) * b.p.fortifyThreat;
      if (need > 0) score = need * Math.min(f.maxArmies, 1 + need);
    } else if (b.enemyNeighbours(f.to).length > 0) {
      score = placementScore(b, f.to) * f.maxArmies * 0.1;
    }
    if (interior) {
      score *= b.p.interiorBonus;
      // Never leave an interior stack idle: pull it to a front, toward the best attack from there.
      if (b.enemyNeighbours(f.to).length > 0) score = Math.max(score, b.p.frontPull * f.maxArmies * 0.1 * (1 + Math.max(0, placementScore(b, f.to, f.maxArmies))));
    }
    if (score > bestScore) (bestScore = score), (best = { from: f.from, to: f.to });
  }
  return best;
}

export function jacobPickWith(params: JacobParams): Pick {
  return (ctx) => pickWith(ctx, params);
}

function pickWith(ctx: StepContext, params: JacobParams): number {
  const { candidates: cands, state, me, random } = ctx;
  const b = new Board(state, me, params);
  const ids = b.info.map.territoryIds;

  if (ctx.fortifyFrom !== null) {
    const plan = bestFortify(b, ctx.legal);
    const dest = plan && plan.from === ids[ctx.fortifyFrom] ? plan.to : null;
    const i = argmax(cands, (c) => (c[0] === 'fortify_to' ? (ids[c[1]] === dest ? 10 : b.defenseNeed(ids[c[1]])) + c[2] * 1e-6 : -Infinity), random);
    return i >= 0 ? i : 0;
  }

  if (state.pendingConquest) return pickOccupy(b, cands);

  if (cands.some((c) => c[0] === 'capital')) {
    return argmax(cands, (c) => (c[0] === 'capital' ? b.armies(ids[c[1]]) * 2 - b.enemyNeighbours(ids[c[1]]).length - b.threat(ids[c[1]]) / 4 : -Infinity), random);
  }

  const trades = cands.filter((c) => c[0] === 'trade');
  if (trades.length > 0 && (ctx.legal.mustTrade || state.phase === 'reinforce')) {
    const hand = state.players.find((p) => p.id === me)!.cards;
    const onMine = (cardIds: number[]) => cardIds.filter((id) => {
      const t = hand.find((card) => card.id === id)?.territory;
      return t !== null && t !== undefined && b.owner(t) === me;
    }).length;
    return argmax(cands, (c) => (c[0] === 'trade' ? onMine(c[1]) : -Infinity), random);
  }

  if (cands.some((c) => c[0] === 'place')) return pickPlace(b, cands, random);

  const attack = bestAttack(b, cands, random);
  if (attack >= 0) return attack;

  const plan = bestFortify(b, ctx.legal);
  if (plan) {
    const i = cands.findIndex((c) => c[0] === 'fortify_from' && ids[c[1]] === plan.from);
    if (i >= 0) return i;
  }

  const end = indexOfKind(cands, 'end_turn');
  return end >= 0 ? end : 0;
}

/** A Jacob Sensei version with its own numbers (missing keys fall back to DEFAULT_JACOB_PARAMS). */
export function makeJacob(id: string, params: Partial<JacobParams> = {}) {
  return stepAgent(id, jacobPickWith({ ...DEFAULT_JACOB_PARAMS, ...params }));
}

/**
 * jacob-sensei@1's numbers: DEFAULT_JACOB_PARAMS tuned by src/tune.ts --teacher jacob (30 generations, 2 accepted;
 * mixed 2-10 player tables on 5 maps, with a self-play stall and game-length penalty; packages/delove/README.md).
 */
export const JACOB_SENSEI_1_PARAMS: JacobParams = {
  targetShare: 2.122,
  targetBonusPerBorder: 1.719,
  targetEnemyRatio: 0.83,
  targetMissing: 0.188,
  defenseGapPad: 2.246,
  defenseBase: 0.5,
  defenseStakeDiv: 3,
  cardFloor: 1.791,
  cardDiv: 2.032,
  captureBase: 0.362,
  completeBonus: 2.103,
  targetCapture: 1.107,
  breakBonus: 2.231,
  elimBase: 6,
  capitalValue: 8.446,
  placeOffenseArmy: 0.137,
  placeDefenseMult: 2.375,
  rivalLoss2: 0.697,
  rivalLossMulti: 0.286,
  neutralLoss: 0.108,
  ownLoss: 0.375,
  minWin: 0.45,
  minEv: 0.246,
  exposureBase: 0.459,
  exposureThreat: 0.097,
  exposureNeed: 0.323,
  fortifyThreat: 0.066,
  interiorBonus: 1.2,
  lateRound: 20,
  lateRamp: 0.048,
  powerIncome: 3.583,
  powerCards: 0.653,
  leaderLoss: 0.258,
  leaderCapture: 1,
  huntRatio: 1.5,
  huntValue: 1.088,
  cardUrge: 0.5,
  stackRamp: 0.404,
  stackFree: 3,
  lateWin: 0.012,
  minWinFloor: 0.285,
  frontPull: 0.5,
};

export const jacob = makeJacob(JACOB_ID, JACOB_SENSEI_1_PARAMS);
