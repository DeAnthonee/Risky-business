import {
  blitzOdds,
  defenseDiceLimit,
  getMap,
  isBlizzard,
  NEUTRAL_ID,
  nextTradeValue,
  type BlitzOdds,
  type ContinentDef,
  type GameState,
  type MapDef,
  type PlayerId,
  type TerritoryId,
} from '@risk/engine';
import { stepAgent, type Candidate, type StepContext } from '@risk/selfplay';

/**
 * delove-teacher@1: the hand-coded player Delove learns from first (see docs/delove.md, Stage 0).
 *
 * It picks only from the self-play candidates (never off-list), so every decision it makes is a clean training label.
 * Strategy, in short: pick a continent to take and stack on the territory that attacks into it; defend held
 * continents' borders against real players (the Neutral never attacks); attack when the odds and the payoff
 * (a card, a continent, breaking a bonus, an elimination) beat the expected losses; move armies forward after a
 * conquest; fortify idle interior stacks toward the most threatened border.
 *
 * Deterministic given the context: the only randomness is ctx.random, used to break ties.
 */
export const TEACHER_ID = 'delove-teacher@1';

interface MapInfo {
  map: MapDef;
  continentOf: Map<TerritoryId, ContinentDef>;
  /** Per continent: its territories that touch a territory outside it. */
  borders: Map<string, TerritoryId[]>;
}

const mapInfoCache = new Map<string, MapInfo>();

/** Battle odds depend only on the three numbers; late-game stacks make them worth caching. */
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

/** Read-only helpers over one position, from one player's side. */
class Board {
  readonly info: MapInfo;
  readonly adj: Record<TerritoryId, TerritoryId[]>;
  private readonly heldCache = new Map<string, boolean>();
  private targetCache: ContinentDef | null | undefined;

  constructor(
    readonly state: GameState,
    readonly me: PlayerId,
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

  /** A player who takes turns and can attack: not me, not the Neutral, not nobody. */
  isRival(p: PlayerId | null): p is PlayerId {
    return p !== null && p !== this.me && p !== NEUTRAL_ID;
  }

  /** Neighbours I could attack (anyone else's, the Neutral included). */
  enemyNeighbours(t: TerritoryId): TerritoryId[] {
    return this.adj[t].filter((n) => !isBlizzard(this.state, n) && this.owner(n) !== null && this.owner(n) !== this.me);
  }

  /** Armies rival players could throw at t next turn (each stack keeps one behind). */
  threat(t: TerritoryId): number {
    let sum = 0;
    for (const n of this.adj[t]) if (this.isRival(this.owner(n))) sum += this.armies(n) - 1;
    return sum;
  }

  continentTerritories(c: ContinentDef): TerritoryId[] {
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

  territoryCount(p: PlayerId): number {
    let n = 0;
    for (const t of this.info.map.territoryIds) if (this.owner(t) === p) n++;
    return n;
  }

  /** The continent I am trying to take: a good bonus for its borders, mostly mine already, lightly defended. */
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
      const score = (mine / ts.length) * 4 + (c.bonus / borders) * 2 - theirArmies / (myArmies + 2) - (ts.length - mine) * 0.25;
      if (score > bestScore) (bestScore = score), (best = c);
    }
    this.targetCache = best;
    return best;
  }

  /** How badly a held continent's border territory needs armies (0 when it does not). */
  defenseNeed(t: TerritoryId): number {
    const c = this.info.continentOf.get(t);
    const threat = this.threat(t);
    if (threat <= 0) return 0;
    const gap = threat - this.armies(t) + 2;
    if (gap <= 0) return 0;
    const atStake = c && this.holds(c) ? c.bonus : 0;
    return gap * (0.5 + atStake / 3);
  }

  /** Rough worth of one card in armies: a third of a set, more as progressive sets grow. */
  cardValue(): number {
    const o = this.state.options;
    const p = this.state.players.find((x) => x.id === this.me)!;
    return Math.max(2.5, nextTradeValue(o.cardValues, this.state.tradeCount, p.tradesMade ?? 0) / 2.5);
  }

  rivalsAlive(): number {
    return this.state.players.filter((p) => p.alive && !p.isNeutral && p.id !== this.me).length;
  }

  /** What taking territory u is worth beyond the territory itself. */
  captureValue(u: TerritoryId, cardStillToEarn: boolean): number {
    const owner = this.owner(u);
    let v = 0.6;
    if (cardStillToEarn) v += this.cardValue();
    const c = this.info.continentOf.get(u);
    if (c) {
      const ts = this.continentTerritories(c);
      const othersMine = ts.every((t) => t === u || this.owner(t) === this.me);
      if (othersMine) v += c.bonus * 3;
      else if (this.target()?.id === c.id) v += 1.5;
      if (this.isRival(owner) && this.holds(c, owner)) v += c.bonus * 2;
    }
    if (this.isRival(owner) && this.territoryCount(owner) === 1) {
      const p = this.state.players.find((x) => x.id === owner)!;
      v += 6 + p.cards.length * this.cardValue();
    }
    if (this.state.options.capitals && owner !== null && this.state.capitals[owner] === u) v += 5;
    return v;
  }
}

type Pick = (ctx: StepContext) => number;

/** Index of the candidate with the highest score (ties broken by ctx.random), or -1 if every score is -Infinity. */
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

function placementScore(b: Board, t: TerritoryId): number {
  const owner = b.owner(t);
  if (owner === null) {
    // Claiming phase: grow next to my territories, inside continents I can hope to hold.
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
  for (const u of enemies) {
    const value = b.captureValue(u, true);
    offense = Math.max(offense, value - Math.max(0, b.armies(u) - b.armies(t)) * 0.15);
  }
  return Math.max(defense * 1.5, offense);
}

function pickPlace(b: Board, cands: Candidate[], random: () => number): number {
  const ids = b.info.map.territoryIds;
  const scores = new Map<number, number>();
  const score = (t: number) => {
    let s = scores.get(t);
    if (s === undefined) scores.set(t, (s = placementScore(b, ids[t])));
    return s;
  };
  // Concentrate: every armies-to-place option on the best territory, the largest amount first.
  return argmax(cands, (c) => (c[0] === 'place' ? score(c[1]) + c[2] * 1e-6 : -Infinity), random);
}

interface AttackPlan {
  index: number;
  ev: number;
}

function bestAttack(b: Board, cands: Candidate[], random: () => number): AttackPlan | null {
  const ids = b.info.map.territoryIds;
  const me = b.state.players.find((p) => p.id === b.me)!;
  const cardStillToEarn = !me.conqueredThisTurn;
  const balanced = b.state.options.balancedBlitz;
  // Armies a rival loses are worth almost as much as my own; with several rivals the others gain from the fight.
  const rivalLossWorth = b.rivalsAlive() <= 1 ? 0.45 : 0.35;
  let best: AttackPlan | null = null;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c[0] !== 'attack') continue;
    const from = ids[c[1]];
    const to = ids[c[2]];
    const a = b.armies(from);
    if (a < 2) continue;
    const o = odds(a, b.armies(to), defenseDiceLimit(b.state, to));
    const p = balanced ? o.balancedWin : o.win;
    if (p < 0.45) continue;
    const value = b.captureValue(to, cardStillToEarn);
    // A failed blitz leaves `from` on one army: costly when rivals sit next to it.
    const exposure = (1 - p) * (0.5 + b.threat(from) * 0.1 + b.defenseNeed(from) * 0.2);
    const defenderWorth = b.isRival(b.owner(to)) ? rivalLossWorth : 0.1;
    const ev = p * value + o.expectedDefenderLosses * defenderWorth - o.expectedAttackerLosses * 0.45 - exposure + random() * 1e-3;
    if (ev > 0.3 && (!best || ev > best.ev)) best = { index: i, ev };
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
  // After the move `to` is mine; enemyNeighbours already ignores it as a target from `from`.
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

function bestFortify(b: Board, legal: StepContext['legal']): FortifyPlan | null {
  let best: FortifyPlan | null = null;
  let bestScore = 0;
  const anyRealThreat = b.info.map.territoryIds.some((t) => b.owner(t) === b.me && b.threat(t) > 0);
  for (const f of legal.fortifies) {
    if (f.from === f.to || f.maxArmies < 1) continue;
    // Only move armies that are not needed where they stand.
    if (b.threat(f.from) > 0) continue;
    if (!anyRealThreat && b.enemyNeighbours(f.from).length > 0) continue;
    let score: number;
    if (anyRealThreat) {
      const need = b.defenseNeed(f.to) + b.threat(f.to) * 0.05;
      if (need <= 0) continue;
      score = need * Math.min(f.maxArmies, 1 + need);
    } else {
      if (b.enemyNeighbours(f.to).length === 0) continue;
      score = placementScore(b, f.to) * f.maxArmies * 0.1;
    }
    if (b.enemyNeighbours(f.from).length === 0) score *= 1.2;
    if (score > bestScore) (bestScore = score), (best = { from: f.from, to: f.to });
  }
  return best;
}

export const teacherPick: Pick = (ctx) => {
  const { candidates: cands, state, me, random } = ctx;
  const b = new Board(state, me);
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
  if (attack) return attack.index;

  const plan = bestFortify(b, ctx.legal);
  if (plan) {
    const i = cands.findIndex((c) => c[0] === 'fortify_from' && ids[c[1]] === plan.from);
    if (i >= 0) return i;
  }

  const end = indexOfKind(cands, 'end_turn');
  return end >= 0 ? end : 0;
};

export const teacher = stepAgent(TEACHER_ID, teacherPick);
