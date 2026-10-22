import { CAPITAL_BONUS, createRng, getMap, reinforcementsFor, shuffle, type Card, type GameState, type PlayerId, type TerritoryId, type TerritoryState } from '@risk/engine';
import { publicIncomes } from '@risk/selfplay';

/**
 * The determinized branch teacher's sampler (docs/delove-fog.md section 4.2): from one seat's view of a fog game (a
 * state rebuilt by stateFromView, hidden territories marked `hidden`) and what that seat has seen so far (FogTracker),
 * a plausible full board. Visible territories, the seat's own hand and every public count stay exact; the rest is a
 * guess drawn from `random`, so the same random source gives the same board (no Math.random, no clocks).
 *
 * 1. A hidden territory seen before keeps its last-seen owner and armies with probability `keep` per round since
 *    (`keepNeutral` for the Neutral, which never attacks), if that owner is still in the game.
 * 2. The others are drawn among the opponents still alive (and the Neutral), weighted by how many territories each
 *    still lacks against an estimate (players: from their public income; the Neutral: its visible count scaled up by
 *    the share of the board in sight), times 1 + the neighbours already given to that owner (holdings stay together).
 *    They get 1 or 2 armies.
 * 3. Repair: every opponent still alive holds at least one territory, and a few greedy passes move hidden territories
 *    from opponents whose income on the sample is above their public income to those below it (or to/from the
 *    Neutral), preferring a territory next to the receiver.
 * 4. Each opponent gets `frontShare` of its income as extra armies on its hidden territories that border another
 *    owner (its unseen reinforcements).
 * 5. Capitals out of sight are put back: the remembered one, else the opponent's strongest hidden territory.
 * 6. Opponents' hands, the deck and the discard are redealt from every card that is not in the seat's hand, at their
 *    public sizes (the same pool stateFromView deals from, #143).
 */
export interface FogSamplerOptions {
  keep: number;
  keepNeutral: number;
  frontShare: number;
  repairPasses: number;
}

export const DEFAULT_FOG_SAMPLER: FogSamplerOptions = { keep: 0.85, keepNeutral: 0.97, frontShare: 0.5, repairPasses: 3 };

interface Seen {
  owner: PlayerId | null;
  armies: number;
  round: number;
}

/** What one seat has seen in one game: each territory's last sight, and the capitals it has seen. */
export interface SeatMemory {
  turn: number;
  seen: Map<TerritoryId, Seen>;
  capitals: Map<PlayerId, TerritoryId>;
}

/**
 * Each seat's memory of a fog game, kept by the player across its decisions (keyed by game id and seat, the last
 * `limit` games). A game whose turn number goes back (a new game with the same id, e.g. a mirrored pair's second game)
 * starts a fresh memory.
 */
export class FogTracker {
  private readonly games = new Map<string, SeatMemory>();
  constructor(private readonly limit = 64) {}

  /** Record what `me` sees on `state` (a view-rebuilt state) and return its memory. */
  observe(state: GameState, me: PlayerId): SeatMemory {
    const key = `${state.id}|${me}`;
    let mem = this.games.get(key);
    if (mem && state.turnNumber < mem.turn) mem = undefined;
    if (!mem) mem = { turn: state.turnNumber, seen: new Map(), capitals: new Map() };
    this.games.delete(key);
    this.games.set(key, mem);
    if (this.games.size > this.limit) this.games.delete(this.games.keys().next().value!);
    mem.turn = state.turnNumber;
    const blizzards = new Set(state.blizzards ?? []);
    for (const [t, ts] of Object.entries(state.territories)) {
      if (ts.hidden || blizzards.has(t)) continue;
      mem.seen.set(t, { owner: ts.owner, armies: ts.armies, round: state.round });
    }
    for (const [p, t] of Object.entries(state.capitals ?? {})) mem.capitals.set(p, t);
    return mem;
  }
}

const EMPTY_MEMORY: SeatMemory = { turn: 0, seen: new Map(), capitals: new Map() };

/** A plausible full board behind `me`'s view `state` (see above). Pure: `state` is not changed. */
export function sampleBoard(
  state: GameState,
  me: PlayerId,
  random: () => number,
  memory: SeatMemory = EMPTY_MEMORY,
  opts: FogSamplerOptions = DEFAULT_FOG_SAMPLER,
): GameState {
  const map = getMap(state.options.map);
  const territories: Record<TerritoryId, TerritoryState> = {};
  for (const t of map.territoryIds) territories[t] = { owner: state.territories[t].owner, armies: state.territories[t].armies };
  const hidden = map.territoryIds.filter((t) => state.territories[t].hidden);
  const hiddenSet = new Set(hidden);
  const others = state.players.filter((p) => p.alive && p.id !== me);
  const neutral = others.find((p) => p.isNeutral)?.id ?? null;
  const ids = others.map((p) => p.id);
  const income = publicIncomes(state) ?? {};
  const pickWeighted = (w: number[]): number => {
    const total = w.reduce((a, b) => a + b, 0);
    let x = random() * total;
    for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i;
    return w.length - 1;
  };

  if (hidden.length && ids.length) {
    // 1. Last seen owners, kept with a probability that falls with age.
    const pending: TerritoryId[] = [];
    for (const t of hidden) {
      const s = memory.seen.get(t);
      if (s && s.owner !== null && s.owner !== me && ids.includes(s.owner)) {
        const keep = s.owner === neutral ? opts.keepNeutral : opts.keep;
        if (random() < keep ** Math.max(0, state.round - s.round)) {
          territories[t] = { owner: s.owner, armies: Math.max(1, s.armies) };
          continue;
        }
      }
      pending.push(t);
    }
    // 2. The rest, by how many territories each owner still lacks.
    const count = new Map<PlayerId, number>(ids.map((p) => [p, 0]));
    for (const t of map.territoryIds) {
      const o = territories[t].owner;
      if (o !== null && count.has(o)) count.set(o, count.get(o)! + 1);
    }
    const blizzards = new Set(state.blizzards ?? []);
    const open = map.territoryIds.filter((t) => !blizzards.has(t)).length;
    const inSight = open - hidden.length;
    const estimate = (p: PlayerId): number => {
      if (p === neutral) {
        const seen = map.territoryIds.filter((t) => !hiddenSet.has(t) && territories[t].owner === p).length;
        return inSight > 0 ? (seen * open) / inSight : 0;
      }
      const inc = income[p];
      if (inc === undefined) return open / (ids.length + 1);
      const fromTerritories = inc - (state.options.capitals ? CAPITAL_BONUS : 0);
      return fromTerritories <= 3 ? 6 : 3 * fromTerritories + 1;
    };
    const lack = new Map<PlayerId, number>(ids.map((p) => [p, estimate(p) - count.get(p)!]));
    for (const t of pending) {
      const w = ids.map((p) => {
        let near = 0;
        for (const u of map.adjacency[t]) if (territories[u].owner === p) near++;
        return Math.max(0.25, lack.get(p)!) * (1 + near);
      });
      const p = ids[pickWeighted(w)];
      territories[t] = { owner: p, armies: random() < 0.5 ? 1 : 2 };
      lack.set(p, lack.get(p)! - 1);
    }

    // 3. Repair: everyone alive holds a territory; incomes move toward the public ones.
    const sampled = (): GameState => ({ ...state, territories });
    const owned = (p: PlayerId) => hidden.filter((t) => territories[t].owner === p);
    const give = (t: TerritoryId, to: PlayerId) => {
      territories[t] = { owner: to, armies: territories[t].owner === to ? territories[t].armies : Math.max(1, Math.min(2, territories[t].armies)) };
    };
    const nextTo = (ts: TerritoryId[], p: PlayerId): TerritoryId | undefined => ts.find((t) => map.adjacency[t].some((u) => territories[u].owner === p)) ?? ts[0];
    for (const p of ids) {
      if (p === neutral || map.territoryIds.some((t) => territories[t].owner === p)) continue;
      const donor = [...ids].sort((a, b) => owned(b).length - owned(a).length).find((d) => owned(d).length > 1);
      if (donor) give(owned(donor)[Math.floor(random() * owned(donor).length)], p);
    }
    const rivals = ids.filter((p) => p !== neutral && income[p] !== undefined);
    for (let pass = 0; pass < opts.repairPasses; pass++) {
      let moved = false;
      const diff = (p: PlayerId) => reinforcementsFor(sampled(), p).total - income[p];
      for (const u of rivals) {
        for (let guard = 0; guard < hidden.length && diff(u) < 0; guard++) {
          const donors = [...rivals.filter((o) => o !== u && diff(o) > 0), ...(neutral ? [neutral] : [])];
          const pool = donors.flatMap((d) => owned(d).filter(() => d === neutral || owned(d).length > 1));
          const t = nextTo(pool, u);
          if (!t) break;
          give(t, u);
          moved = true;
        }
      }
      for (const o of rivals) {
        for (let guard = 0; guard < hidden.length && diff(o) > 0; guard++) {
          const mine = owned(o);
          if (map.territoryIds.filter((t) => territories[t].owner === o).length <= 1) break;
          const to = rivals.find((u) => u !== o && diff(u) < 0) ?? neutral;
          if (!to) break;
          const t = nextTo(mine, to);
          if (!t) break;
          give(t, to);
          moved = true;
        }
      }
      if (!moved) break;
    }

    // 4. Unseen reinforcements on each opponent's hidden fronts.
    for (const p of rivals) {
      const mine = owned(p);
      if (!mine.length) continue;
      const fronts = mine.filter((t) => map.adjacency[t].some((u) => territories[u].owner !== p && territories[u].owner !== null));
      const where = fronts.length ? fronts : mine;
      for (let k = Math.round(opts.frontShare * income[p]); k > 0; k--) territories[where[Math.floor(random() * where.length)]].armies++;
    }
  }

  // 5. Capitals out of sight.
  let capitals = state.capitals;
  if (state.options.capitals && state.phase !== 'setup' && state.phase !== 'capitals' && state.phase !== 'lobby') {
    capitals = { ...state.capitals };
    const taken = new Set(Object.values(capitals));
    for (const p of state.players) {
      if (p.isNeutral || capitals[p.id]) continue;
      let t = memory.capitals.get(p.id);
      if (!t || taken.has(t)) {
        const free = hidden.filter((h) => !taken.has(h));
        const theirs = free.filter((h) => territories[h].owner === p.id).sort((a, b) => territories[b].armies - territories[a].armies);
        t = theirs[0] ?? free[Math.floor(random() * free.length)];
      }
      if (t) (capitals[p.id] = t), taken.add(t);
    }
  }

  // 6. Hidden cards: redeal everything not in my hand at the public sizes.
  const pool: Card[] = [...state.players.filter((p) => p.id !== me).flatMap((p) => p.cards), ...state.deck, ...state.discard];
  const dealt = shuffle(createRng(Math.floor(random() * 0x100000000) >>> 0), pool);
  const deal = (n: number) => dealt.splice(0, n);
  const players = state.players.map((p) => (p.id === me ? p : { ...p, cards: deal(p.cards.length) }));
  return { ...state, territories, capitals, players, deck: deal(state.deck.length), discard: deal(state.discard.length) };
}
