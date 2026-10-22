/**
 * Nested ("Inception") tournaments, the map side: how many rounds and tables a field of players needs (planNest),
 * and which board every table plays on, nested inside a territory ("portal") of its parent's board (NestSpec,
 * resolveNest, planToNest). Every table is still an ordinary game on one map id; only the tournament knows they nest.
 *
 * Owner's numbers (2026-10-21): tables of 3 to 6 seats, a final of 6 to 10 chosen from the player count, losers are
 * out, and Zerg bots fill seats only when the count fits no plan. Pure and deterministic (no Math.random, no clocks);
 * not mirrored by the GPU mirror.
 */
import { getMap, isMapId } from './maps.js';
import { defaultRegions, DEFAULT_TERRITORIES_PER_SEAT, genMapId, pickStartSpots } from './procgen.js';
import { RuleError } from './types.js';

// ---- the planner ---------------------------------------------------------------------------------------------------

export interface NestPlanOptions {
  /** Smallest and largest table before the final (default 3 and 6). */
  minTable?: number;
  maxTable?: number;
  /** Smallest and largest final (default 6 and 10). */
  minFinal?: number;
  maxFinal?: number;
  /** The table size the planner steers toward (default 4). */
  prefer?: number;
  /** Most rounds to consider, final included (default 8). */
  maxRounds?: number;
}

export interface NestTable {
  /** Round, 0 = the first round; the last round is the final. */
  round: number;
  /** Position in its round. */
  index: number;
  seats: number;
  /** Zerg bots seated at this table (first round only). */
  zergs: number;
  /** Index of the table in the next round its winner moves on to (null for the final). */
  parent: number | null;
  /** Which of the parent's seats (portals) the winner takes, 0-based (null for the final). */
  portal: number | null;
}

export interface NestPlan {
  players: number;
  /** Zerg bots added to make the numbers fit (0 unless the count fits no plan). */
  zergs: number;
  finalSeats: number;
  /** Tables per round, first round first; the last round is the final's single table. */
  rounds: NestTable[][];
}

/** Table i of n is one of the `big` larger tables: spread evenly through the round. */
function isBig(i: number, n: number, big: number): boolean {
  return Math.floor(((i + 1) * big) / n) > Math.floor((i * big) / n);
}

/**
 * Seats per round for `seats` players and a final of `final`, or null. Search over seat counts per round, top-down
 * from the final (rooms in a round = seats in the next one): fewest rounds first, then the evenest tables (sum of
 * squared distance of each round's average table from `prefer`).
 */
function seatPlan(seats: number, final: number, o: Required<NestPlanOptions>): { seats: number[]; cost: number } | null {
  if (seats === final) return { seats: [final], cost: 0 };
  let layer = new Map<number, { cost: number; path: number[] }>([[final, { cost: 0, path: [final] }]]);
  for (let round = 1; round < o.maxRounds; round++) {
    const next = new Map<number, { cost: number; path: number[] }>();
    for (const [above, v] of layer)
      for (let s = above * o.minTable; s <= Math.min(above * o.maxTable, seats); s++) {
        const avg = s / above - o.prefer;
        const cost = v.cost + avg * avg;
        const old = next.get(s);
        if (!old || cost < old.cost) next.set(s, { cost, path: [...v.path, s] });
      }
    const hit = next.get(seats);
    if (hit) return { seats: hit.path.slice().reverse(), cost: hit.cost };
    if (!next.size) return null;
    layer = next;
  }
  return null;
}

/**
 * Plan a nested tournament for `players`: the rounds, every table's seat count, where its winner goes, and any Zerg
 * fill. Picks, in order: no Zergs; fewer rounds; the bigger final; the evenest tables. Only when no final fits does it
 * add the fewest Zergs that make one fit (with the same choices), spread over the first-round tables.
 */
export function planNest(players: number, options: NestPlanOptions = {}): NestPlan {
  const o: Required<NestPlanOptions> = { minTable: 3, maxTable: 6, minFinal: 6, maxFinal: 10, prefer: 4, maxRounds: 8, ...options };
  if (!Number.isInteger(players) || players < 2) throw new RuleError('A nested tournament needs at least 2 players');
  if (o.minTable < 2 || o.maxTable < o.minTable || o.minFinal < 2 || o.maxFinal < o.minFinal) throw new RuleError('Invalid table sizes');
  for (let zergs = 0; zergs <= Math.max(o.minFinal, players * (o.maxTable - 1)); zergs++) {
    let best: { seats: number[]; cost: number; final: number } | null = null;
    for (let final = o.maxFinal; final >= o.minFinal; final--) {
      const p = seatPlan(players + zergs, final, o);
      // Finals are tried biggest first, so on equal rounds the bigger final stays.
      if (p && (!best || p.seats.length < best.seats.length)) best = { ...p, final };
    }
    if (!best) continue;
    const S = best.seats;
    const rounds: NestTable[][] = S.map((seats, round) => {
      const rooms = round === S.length - 1 ? 1 : S[round + 1];
      const lo = Math.floor(seats / rooms);
      const big = seats - lo * rooms;
      return Array.from({ length: rooms }, (_, index) => ({ round, index, seats: lo + (isBig(index, rooms, big) ? 1 : 0), zergs: 0, parent: null, portal: null }));
    });
    // Winners move up in order: the next round's table j takes as many children as it has seats.
    for (let r = 0; r < rounds.length - 1; r++) {
      let child = 0;
      for (const parent of rounds[r + 1])
        for (let portal = 0; portal < parent.seats; portal++) {
          rounds[r][child].parent = parent.index;
          rounds[r][child].portal = portal;
          child++;
        }
    }
    // Zergs spread over the first round: at most one more at any table than at another.
    const first = rounds[0];
    const each = Math.floor(zergs / first.length);
    const extra = zergs - each * first.length;
    first.forEach((t, i) => (t.zergs = each + (isBig(i, first.length, extra) ? 1 : 0)));
    return { players, zergs, finalSeats: best.final, rounds };
  }
  throw new RuleError(`Could not plan a nested tournament for ${players} players`);
}

// ---- nested boards -------------------------------------------------------------------------------------------------

/** Settings for a generated board; its seats come from the table, its seed from the tree. */
export interface GenBoardOptions {
  territoriesPerSeat?: number;
  regions?: number;
  passes?: number;
}

/** A board: an existing one (seats = its portal count when it has children, else its own maximum) or a generated one. */
export type NestBoard = { map: string; seats?: number } | { gen: GenBoardOptions & { seats: number } };

/** A board with boards inside some of its territories. */
export interface NestNodeSpec {
  board: NestBoard;
  /** The territories holding a child board: listed, or 'spots' (pickStartSpots, one per region). Default 'spots'. */
  portals?: string[] | 'spots';
  /** The board inside each portal: one rule for all, a list in portal order, or none (a leaf). */
  inside?: NestChild | NestChild[];
}
export type NestChild = NestBoard | NestNodeSpec;

export interface NestSpec extends NestNodeSpec {
  v: 1;
  /** Fixes every generated board and start spot in the tree. */
  seed: number;
}

/** One board of a resolved tree. */
export interface NestNode {
  /** Path of portal territory ids from the outermost board ('' for the outermost). */
  path: string;
  depth: number;
  /** The map id the table plays on (an existing board or a gen1 id). */
  map: string;
  seats: number;
  /** The territories that hold the children, in child order (empty for a leaf). */
  portals: string[];
  /** Index of the parent node in the list (null for the outermost) and the portal territory this board sits in. */
  parent: number | null;
  portal: string | null;
}

/** 32-bit FNV-1a of the root seed and a path: each board's own seed. */
export function nestSeed(rootSeed: number, path: string): number {
  let h = 0x811c9dc5 ^ (rootSeed >>> 0);
  h = Math.imul(h, 0x01000193) >>> 0;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const isNode = (c: NestChild): c is NestNodeSpec => 'board' in c;

/**
 * Resolve a nested spec into its boards, outermost first (breadth-first). Every board with children gets as many
 * portals as children and as many seats as portals; a generated parent board gets at least one region per seat so its
 * start spots fall in different regions. Throws RuleError for a bad tree.
 */
export function resolveNest(spec: NestSpec): NestNode[] {
  if (spec.v !== 1) throw new RuleError(`Unknown nest version ${String(spec.v)}`);
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff) throw new RuleError('seed must be an integer 0-4294967295');
  const nodes: NestNode[] = [];
  const queue: Array<{ node: NestNodeSpec; path: string; depth: number; parent: number | null; portal: string | null }> = [{ node: spec, path: '', depth: 0, parent: null, portal: null }];
  for (let q = 0; q < queue.length; q++) {
    const { node, path, depth, parent, portal } = queue[q];
    if (depth > 6) throw new RuleError('Nested boards go at most 6 levels deep');
    const inside = node.inside;
    const children: NestChild[] | null = inside === undefined ? null : Array.isArray(inside) ? inside : null;
    const single = inside !== undefined && !Array.isArray(inside) ? inside : null;
    const map = boardId(node.board, nestSeed(spec.seed, path), inside !== undefined);
    const def = getMap(map);
    let portals: string[] = [];
    if (inside !== undefined) {
      const listed = Array.isArray(node.portals) ? node.portals.length : null;
      const wanted = children ? children.length : (listed ?? ('gen' in node.board ? node.board.gen.seats : (node.board.seats ?? def.maxPlayers)));
      if (node.portals === undefined || node.portals === 'spots') portals = pickStartSpots(def, wanted, nestSeed(spec.seed, `${path}#spots`));
      else {
        portals = node.portals;
        if (new Set(portals).size !== portals.length) throw new RuleError(`${map}: portals repeat`);
        for (const t of portals) if (!def.isTerritory(t)) throw new RuleError(`${map}: "${t}" is not a territory`);
      }
      if (portals.length !== wanted) throw new RuleError(`${map}: ${portals.length} portals for ${wanted} children`);
      if (portals.length < 2 || portals.length > def.maxPlayers) throw new RuleError(`${map}: a board with children seats 2-${def.maxPlayers}, not ${portals.length}`);
    }
    const seats = inside !== undefined ? portals.length : 'gen' in node.board ? node.board.gen.seats : (node.board.seats ?? def.maxPlayers);
    const index = nodes.length;
    nodes.push({ path, depth, map, seats, portals, parent, portal });
    portals.forEach((t, i) => {
      const child = children ? children[i] : single!;
      queue.push({ node: isNode(child) ? child : { board: child }, path: path ? `${path}/${t}` : t, depth: depth + 1, parent: index, portal: t });
    });
  }
  return nodes;
}

function boardId(board: NestBoard, seed: number, hasChildren: boolean): string {
  if ('map' in board) {
    if (!isMapId(board.map)) throw new RuleError(`Unknown map "${board.map}"`);
    return board.map;
  }
  const { seats, territoriesPerSeat = DEFAULT_TERRITORIES_PER_SEAT, regions, passes } = board.gen;
  const territories = seats * territoriesPerSeat;
  // A board with children needs a region per portal.
  const r = regions ?? (hasChildren ? Math.max(defaultRegions(territories), seats) : undefined);
  return genMapId({ seed, seats, territoriesPerSeat, regions: r, passes });
}

/**
 * The boards for a planned tournament: the final on `final` (a generated board by default, or an existing one that
 * seats the final), every other table on a generated board for its seat count. Returns the spec and, per table of the
 * plan, its resolved board ([round][index]).
 */
export function planToNest(plan: NestPlan, opts: { seed: number; final?: { map: string }; boards?: GenBoardOptions }): { spec: NestSpec; boards: NestNode[][] } {
  const R = plan.rounds.length;
  const gen = (seats: number): NestBoard => ({ gen: { ...opts.boards, seats } });
  const build = (round: number, index: number): NestNodeSpec => {
    const t = plan.rounds[round][index];
    const board: NestBoard = round === R - 1 && opts.final ? { map: opts.final.map, seats: t.seats } : gen(t.seats);
    if (round === 0) return { board };
    const children = plan.rounds[round - 1].filter((c) => c.parent === index).sort((a, b) => a.portal! - b.portal!);
    return { board, inside: children.map((c) => build(round - 1, c.index)) };
  };
  const spec: NestSpec = { v: 1, seed: opts.seed, ...build(R - 1, 0) };
  const nodes = resolveNest(spec);
  // Breadth-first order from the final down: map nodes back to [round][index] by walking the plan the same way.
  const boards: NestNode[][] = plan.rounds.map((r) => new Array<NestNode>(r.length));
  const order: Array<[number, number]> = [[R - 1, 0]];
  for (let q = 0; q < order.length; q++) {
    const [round, index] = order[q];
    boards[round][index] = nodes[q];
    if (round > 0)
      for (const c of plan.rounds[round - 1].filter((c) => c.parent === index).sort((a, b) => a.portal! - b.portal!)) order.push([round - 1, c.index]);
  }
  return { spec, boards };
}
