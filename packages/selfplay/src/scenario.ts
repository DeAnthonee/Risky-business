import {
  addPlayer,
  applyAction,
  createGame,
  createRng,
  getMap,
  nextFloat,
  nextInt,
  reinforcementsFor,
  shuffle,
  startGame,
  type Card,
  type GameOptions,
  type GameState,
  type PlayerId,
  type Rng,
  type TerritoryId,
} from '@risk/engine';
import { seatId, type StartPosition } from './positions.js';
import { mixSeed } from './seed.js';

/**
 * Ratio scenarios (the Delove range specialists): synthetic late-game boards where 2 or 3 players are left and hold
 * the board in a set split, e.g. 60/40 or 50/25/25. A third source of stage games next to the lead-in and the
 * positions file (positions.ts), generated from the game seed alone, so a cloud pod needs no file: the GPU mirror asks
 * this code for the same positions through node (delove_gpu/stage.py SplitSource) and plays them as positions.
 *
 * A split lists the survivors' shares in turn order from the player to move (60/40: the bigger side moves first,
 * 40/60: the smaller one does). The table's other seats are already out. Each survivor holds one contiguous region
 * grown from a seed territory (so continents and front lines exist), with the share applied to territories and to
 * armies (each jittered by up to SHARE_JITTER points); army totals, the turn, the trade count, hands and the discard
 * pile are drawn from what Jacob Sensei lead-ins look like when 3 or 2 players are left (STAGE_STATS).
 */

/** A ratio scenario's position: a StartPosition plus who holds which share. */
export interface SplitPosition extends StartPosition {
  /** Each seat's nominal share (0: out). */
  shares: number[];
  /** The seat holding share j of the split (j = 0: the player to move). */
  survivors: number[];
}

/** Up to this many percentage points of noise on each survivor's territory share and army share. */
export const SHARE_JITTER = 3;

/**
 * How lumpy armies are: each territory's weight is multiplied by (0.02 + u)^-STACKING, u uniform. At 1.5 a survivor's
 * biggest stack holds a median 26% of its armies, the top three 49%, and 68% of its territories hold 1 army (real
 * 3-/2-alive stage starts: 22%, 47%, 70%).
 */
export const STACKING = 1.5;

/**
 * Real stage starts, measured from Jacob Sensei lead-ins at league settings on the 6-10 player maps
 * (2026-10-21: 100 games per map and table size, 4 league settings; about 1,000 stage starts per count;
 * packages/delove/scripts/stage/measure-stages.mjs measures them again, within a few % on other seeds). Per players alive:
 * `perT` armies per playable territory, `rounds` turns played / seats, `trades` card sets traded / seats, each as the
 * median per `map-seats` (`*` when the table was not measured) and a spread: deciles 0..100 of value / its table's
 * median, pooled. `discard` the share of the undrawn cards in the discard pile (deciles), `hands` the weight of each
 * hand size 0..5 (5: the player to move must trade).
 */
export const STAGE_STATS: Record<
  number,
  {
    median: Record<string, { perT: number; rounds: number; trades: number }>;
    spread: { perT: number[]; rounds: number[]; trades: number[] };
    discard: number[];
    hands: number[];
  }
> = {
  3: {
    median: {
      'asia-8': { perT: 2.05, rounds: 6.75, trades: 1.75 },
      'bohemia-6': { perT: 1.79, rounds: 6.33, trades: 1.5 },
      'classic-6': { perT: 1.62, rounds: 6.33, trades: 1.5 },
      'europe-8': { perT: 1.75, rounds: 5.62, trades: 1.38 },
      'europe_classic-6': { perT: 2.24, rounds: 14.25, trades: 4.08 },
      'fantasy-6': { perT: 2.26, rounds: 15.67, trades: 4.67 },
      'greater_europe-6': { perT: 2.6, rounds: 18.17, trades: 5.42 },
      'nine_realms-6': { perT: 2.12, rounds: 9.33, trades: 2.67 },
      'nine_realms-8': { perT: 2.17, rounds: 7.5, trades: 2 },
      'usa-10': { perT: 1.93, rounds: 4.6, trades: 1.2 },
      'world-10': { perT: 2.45, rounds: 8.0, trades: 2.2 },
      'world-6': { perT: 2.18, rounds: 11.33, trades: 3.17 },
      'world_large-10': { perT: 3.44, rounds: 9.5, trades: 2.8 },
      '*': { perT: 2.09, rounds: 8.5, trades: 2.38 },
    },
    spread: {
      perT: [0.39, 0.68, 0.77, 0.85, 0.92, 1, 1.09, 1.22, 1.36, 1.58, 3.23],
      rounds: [0.5, 0.72, 0.79, 0.84, 0.91, 1, 1.1, 1.23, 1.36, 1.63, 3.42],
      trades: [0.22, 0.67, 0.75, 0.82, 0.89, 1, 1.11, 1.29, 1.44, 1.74, 3.72],
    },
    discard: [0, 0.18, 0.34, 0.51, 0.6, 0.66, 0.71, 0.77, 0.83, 0.91, 1],
    hands: [0, 9, 19, 33, 25, 14],
  },
  2: {
    median: {
      'asia-8': { perT: 2.39, rounds: 7.25, trades: 2.12 },
      'bohemia-6': { perT: 2.06, rounds: 6.83, trades: 1.83 },
      'classic-6': { perT: 2.05, rounds: 7.33, trades: 2 },
      'europe-8': { perT: 2.45, rounds: 5.75, trades: 1.62 },
      'europe_classic-6': { perT: 3.01, rounds: 14.67, trades: 4.5 },
      'fantasy-6': { perT: 2.97, rounds: 15.5, trades: 4.67 },
      'greater_europe-6': { perT: 3.03, rounds: 19.83, trades: 6.17 },
      'nine_realms-6': { perT: 2.72, rounds: 10.67, trades: 3.0 },
      'nine_realms-8': { perT: 2.7, rounds: 8.25, trades: 2.38 },
      'usa-10': { perT: 2.47, rounds: 5.0, trades: 1.4 },
      'world-10': { perT: 3.2, rounds: 7.85, trades: 2.3 },
      'world-6': { perT: 2.72, rounds: 12.83, trades: 3.83 },
      'world_large-10': { perT: 3.69, rounds: 10.1, trades: 3.1 },
      '*': { perT: 2.68, rounds: 9.67, trades: 2.83 },
    },
    spread: {
      perT: [0.38, 0.62, 0.72, 0.81, 0.91, 1, 1.1, 1.2, 1.36, 1.61, 3.21],
      rounds: [0.5, 0.74, 0.81, 0.88, 0.94, 1, 1.1, 1.24, 1.37, 1.6, 2.92],
      trades: [0.33, 0.71, 0.78, 0.85, 0.93, 1, 1.11, 1.26, 1.42, 1.68, 3.05],
    },
    discard: [0, 0.15, 0.31, 0.44, 0.6, 0.69, 0.76, 0.82, 0.88, 0.94, 1],
    hands: [0, 6, 17, 32, 27, 17],
  },
};

/** '60/40' -> [60, 40]: 2 or 3 whole-number shares of at least 5 that add up to 100. */
export function parseSplit(text: string): number[] {
  const shares = text.split('/').map((x) => Number(x.trim()));
  if (shares.length < 2 || shares.some((x) => !Number.isInteger(x) || x < 5) || shares.reduce((a, b) => a + b, 0) !== 100) {
    throw new Error(`split ${JSON.stringify(text)}: want 2 or more whole-number shares of at least 5 that add up to 100, e.g. 60/40 or 50/25/25`);
  }
  return shares;
}

/** A value drawn from deciles 0..100 (linear between them). */
function fromDeciles(rng: Rng, d: number[]): number {
  const x = nextFloat(rng) * (d.length - 1);
  const i = Math.min(d.length - 2, Math.floor(x));
  return d[i] + (d[i + 1] - d[i]) * (x - i);
}

/** An index drawn with these weights. */
function weighted(rng: Rng, w: number[]): number {
  const total = w.reduce((a, b) => a + b, 0);
  let x = nextFloat(rng) * total;
  for (let i = 0; i < w.length; i++) {
    x -= w[i];
    if (x < 0 && w[i] > 0) return i;
  }
  for (let i = w.length - 1; i > 0; i--) if (w[i] > 0) return i;
  return 0;
}

/** Whole numbers proportional to `weights` that add up to `total`, each at least `min` (largest remainder). */
function apportion(total: number, weights: number[], min: number): number[] {
  const free = total - min * weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (free * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < free - out.reduce((a, b) => a + b, 0); k++) out[order[k][1]]++;
  return out.map((x) => x + min);
}

/** Shares with up to SHARE_JITTER points of noise each, as weights (renormalised by apportion). */
function jitter(rng: Rng, shares: number[]): number[] {
  return shares.map((s) => Math.max(1, s + (nextFloat(rng) * 2 - 1) * SHARE_JITTER));
}

/**
 * The ratio scenario of game `seed` at a table of `seats` with these settings: the survivors hold the board in
 * `shares` (turn order from the player to move), the other seats are out, and it is the start of the mover's turn
 * (reinforcements counted by the engine). Everything is drawn from mulberry32(mixSeed(seed, 0x5ca1e)) and the
 * engine's own deal for `seed`, so the same arguments always give the same position.
 */
export function splitPosition(shares: number[], options: Partial<GameOptions>, seats: number, seed: number): SplitPosition {
  const k = shares.length;
  if (k < 2 || k > seats) throw new Error(`a ${shares.join('/')} split needs a table of at least ${k} seats, not ${seats}`);
  const stats = STAGE_STATS[k];
  if (!stats) throw new Error(`ratio scenarios have ${Object.keys(STAGE_STATS).join(' or ')} players left, not ${k}`);
  const ids = Array.from({ length: seats }, (_, i) => seatId(i));
  let s = createGame('split', { ...options, maxPlayers: seats, fogOfWar: false }, seed);
  for (const id of ids) s = addPlayer(s, id, id, true);
  s = startGame(s).state;
  if (s.players.some((p) => p.isNeutral)) throw new Error('ratio scenarios are for tables without a Neutral (3+ seats, no neutrals option)');
  const map = getMap(s.options.map);
  const rng = createRng(mixSeed(seed, 0x5ca1e));
  const blocked = new Set(s.blizzards);
  const playable = map.territoryIds.filter((t) => !blocked.has(t));
  const adj = (t: TerritoryId) => map.adjacency[t].filter((u) => !blocked.has(u));

  // Who is left: k seats at random; shares go round the turn order from a random survivor (the player to move).
  const alive = new Set(shuffle(rng, ids).slice(0, k));
  const ring = s.turnOrder.filter((id) => alive.has(id));
  const first = nextInt(rng, k);
  const survivors = ring.map((_, j) => ring[(first + j) % k]);
  const share = new Map(survivors.map((id, j) => [id, shares[j]]));

  // Territories: one seed each, spread out (each next seed as far as it can be from the others), then regions grown
  // from them, the survivor furthest below its target claiming a neighbouring territory, compact ones first. A
  // survivor boxed in by the others takes a bordering territory from the neighbour furthest over its own share
  // (never a seed), which then grows on elsewhere; where even that fails (a board cut in two by blizzards), the free
  // territory nearest its region.
  const target = apportion(playable.length, jitter(rng, shares), 1);
  const owner = new Map<TerritoryId, number>();
  const dist = (from: TerritoryId[]) => {
    const d = new Map(from.map((t) => [t, 0]));
    const q = [...from];
    for (let h = 0; h < q.length; h++) for (const u of adj(q[h])) if (!d.has(u)) (d.set(u, d.get(q[h])! + 1), q.push(u));
    return d;
  };
  const seeds: TerritoryId[] = [playable[nextInt(rng, playable.length)]];
  while (seeds.length < k) {
    const d = dist(seeds);
    const far = (t: TerritoryId) => d.get(t) ?? playable.length;
    const open = playable.filter((t) => !seeds.includes(t));
    const best = Math.max(...open.map(far));
    const ties = open.filter((t) => far(t) === best);
    seeds.push(ties[nextInt(rng, ties.length)]);
  }
  const count = new Array<number>(k).fill(0);
  seeds.forEach((t, j) => (owner.set(t, j), count[j]++));
  let pushes = 0;
  /** Whether taking t away splits its holder's region (its other neighbours of the same holder no longer all meet). */
  const cuts = (t: TerritoryId) => {
    const o = owner.get(t);
    const near = adj(t).filter((u) => owner.get(u) === o);
    if (near.length <= 1) return false;
    const seen = new Set([near[0]]);
    const q = [near[0]];
    for (let h = 0; h < q.length; h++) for (const u of adj(q[h])) if (u !== t && owner.get(u) === o && !seen.has(u)) (seen.add(u), q.push(u));
    return near.some((u) => !seen.has(u));
  };
  while (owner.size < playable.length) {
    const want = count.map((c, j) => (c < target[j] ? c / target[j] : Infinity));
    const low = Math.min(...want);
    const lows = want.flatMap((w, j) => (w === low ? [j] : []));
    const j = lows[nextInt(rng, lows.length)];
    const own = (t: TerritoryId) => adj(t).filter((u) => owner.get(u) === j).length;
    const free = playable.filter((t) => !owner.has(t));
    let pool = free.filter((t) => own(t) > 0);
    if (!pool.length && pushes < 2 * playable.length) {
      const over = (o: number) => count[o] / target[o];
      const taken = playable.filter((t) => owner.has(t) && owner.get(t) !== j && own(t) > 0 && !seeds.includes(t) && !cuts(t));
      const most = Math.max(...taken.map((t) => over(owner.get(t)!)));
      pool = taken.filter((t) => over(owner.get(t)!) === most);
      if (pool.length) pushes++;
    }
    if (!pool.length) {
      const d = dist(playable.filter((t) => owner.get(t) === j));
      const near = Math.min(...free.map((t) => d.get(t) ?? Infinity));
      pool = free.filter((t) => (d.get(t) ?? Infinity) === near);
    }
    const t = pool[weighted(rng, pool.map((x) => (1 + own(x)) ** 2))];
    if (owner.has(t)) count[owner.get(t)!]--;
    owner.set(t, j);
    count[j]++;
  }

  // Capitals (Capital Conquest): each survivor's seed is its capital; the fallen seats' capitals lie elsewhere on the
  // board, held by whoever holds them now.
  const capitals: Record<PlayerId, TerritoryId> = {};
  if (s.options.capitals) {
    survivors.forEach((id, j) => (capitals[id] = seeds[j]));
    const rest = shuffle(rng, playable.filter((t) => !seeds.includes(t)));
    ids.filter((id) => !alive.has(id)).forEach((id, x) => (capitals[id] = rest[x]));
  }
  const isCapital = new Set(Object.values(capitals));

  // Armies: a stage-like total for this map (STAGE_STATS), split by the (jittered) shares counting the mover's
  // reinforcements as its own, so the split is the balance when its first attack comes (on the placed board alone a
  // 50/50 mover would hold about 59% by then, and won 83-96% of Jacob Sensei duels). Every territory keeps 1 and the
  // rest goes in a few big stacks, mostly on the fronts (more where more enemy territories touch, capitals doubled),
  // little to the interior: heavy-tailed weights (STACKING) as lumpy as real stage boards.
  const med = stats.median[`${map.id}-${seats}`] ?? stats.median['*'];
  const total = Math.round(med.perT * fromDeciles(rng, stats.spread.perT) * playable.length);
  const placed = { ...s, capitals, territories: { ...s.territories, ...Object.fromEntries(playable.map((t) => [t, { owner: survivors[owner.get(t)!], armies: 1 }])) } };
  const tempo = reinforcementsFor(placed, survivors[0]).total;
  const budget = apportion(Math.max(total, playable.length) + tempo, jitter(rng, shares), 0).map((a, j) => Math.max(a - (j === 0 ? tempo : 0), count[j]));
  const armies = new Map(playable.map((t) => [t, 1]));
  for (let j = 0; j < k; j++) {
    const mine = playable.filter((t) => owner.get(t) === j);
    const w = mine.map((t) => {
      const enemies = adj(t).filter((u) => owner.get(u) !== j).length;
      return (enemies ? 2 + enemies : 0.15) * (isCapital.has(t) ? 2 : 1) * (0.02 + nextFloat(rng)) ** -STACKING;
    });
    for (let a = budget[j] - mine.length; a > 0; a--) {
      const t = mine[weighted(rng, w)];
      armies.set(t, armies.get(t)! + 1);
    }
  }

  // The turn and the cards: how far a real game is when this many are left, the sets traded so far (shared among all
  // seats, survivors twice as often), hands like a late game's and part of the undrawn cards in the discard pile.
  const rounds = Math.max(2, med.rounds * fromDeciles(rng, stats.spread.rounds));
  const turnNumber = Math.max(seats + 1, Math.round(rounds * seats));
  const tradeCount = Math.round(med.trades * fromDeciles(rng, stats.spread.trades) * seats);
  const tradesMade = new Array<number>(seats).fill(0);
  for (let x = 0; x < tradeCount; x++) tradesMade[weighted(rng, ids.map((id) => (alive.has(id) ? 2 : 1)))]++;
  const deck = [...s.deck];
  const hands = new Map<PlayerId, Card[]>();
  survivors.forEach((id, j) => {
    // the player to move may hold 5 (a forced trade); the one ending its turn before it, at most 4
    const w = stats.hands.map((x, size) => (j === 0 || size < 5 ? x : 0));
    hands.set(id, deck.splice(0, weighted(rng, w)));
  });
  const discard = deck.splice(0, Math.floor(deck.length * fromDeciles(rng, stats.discard)));

  // Who went out, in what order, and to whom (a bigger survivor took more of them).
  const out = shuffle(rng, ids.filter((id) => !alive.has(id)));
  const killer = new Map(out.map((id) => [id, survivors[weighted(rng, survivors.map((x) => share.get(x)!))]]));

  for (const t of playable) s.territories[t] = { owner: survivors[owner.get(t)!], armies: armies.get(t)! };
  s.players = s.players.map((p) => {
    const i = ids.indexOf(p.id);
    const up = alive.has(p.id);
    return {
      ...p,
      alive: up,
      cards: up ? hands.get(p.id)! : [],
      tradesMade: tradesMade[i],
      armiesToPlace: 0,
      conqueredThisTurn: false,
      ...(up ? {} : { eliminatedBy: killer.get(p.id)! }),
    };
  });
  s.deck = deck;
  s.discard = discard;
  s.tradeCount = tradeCount;
  s.capitals = capitals;
  s.pendingConquest = null;
  s.fortifiedThisTurn = false;
  s.winner = null;
  s.createdAt = 0; // not the clock: the same seed gives the same position, byte for byte
  s.startedAt = 0;
  s.round = Math.floor(rounds);
  s.turnNumber = turnNumber - 1;
  // The survivor before the mover ends its turn: the engine starts the mover's (reinforcements, a forced trade).
  s.phase = 'attack';
  s.currentPlayer = survivors[k - 1];
  s = applyAction(s, survivors[k - 1], { type: 'end_turn' }).state;
  if (s.currentPlayer !== survivors[0]) throw new Error('ratio scenario: the turn did not pass to the player to move');
  return {
    source: `split:${shares.join('/')}@${seed >>> 0}`,
    map: map.id,
    seats,
    alive: k,
    eliminated: out,
    state: s,
    shares: ids.map((id) => share.get(id) ?? 0),
    survivors: survivors.map((id) => ids.indexOf(id)),
  };
}
