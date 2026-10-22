import type { RandomSource } from './bot.js';
import { applyAction, legalMoves, startGame } from './engine.js';
import { getMap, type MapDef } from './maps.js';
import { RuleError, type ActionResult, type GameEvent, type GameState, type PlayerId, type TerritoryId } from './types.js';

/**
 * Start a game in which each player begins on a fixed territory: the parent table of a nested tournament, where every
 * player is the winner of the table inside one territory (their "portal"; docs/tournaments.md).
 *
 * It is the normal start (`startGame`: turn order, deck, blizzards, neutrals, a random deal), then each spot is
 * swapped, owner and armies together, with a territory its player was dealt elsewhere, so every player keeps the same
 * number of territories and armies. A blizzard that fell on a spot moves to another open territory where pickBlizzards
 * could have put it (or, when no single territory will do, the whole set is drawn again away from the spots, the
 * territories trading holders so the deal stays even), and a spot dealt
 * to the neutral is swapped like any other. With `autoSetup` the remaining armies are then placed at random through
 * ordinary setup moves, and the game is at its first turn as usual; without it the game waits in setup as usual.
 *
 * `spots` maps player ids to distinct territories. Pure apart from `random`, which picks the swaps and the placements.
 */
export function startOnSpots(lobby: GameState, spots: Record<PlayerId, TerritoryId>, random: RandomSource = Math.random): ActionResult {
  const wanted = Object.entries(spots);
  const spotSet = new Set(wanted.map(([, t]) => t));
  if (spotSet.size !== wanted.length) throw new RuleError('Each player needs a different start spot');
  for (const [p, t] of wanted) {
    if (!lobby.players.some((x) => x.id === p && !x.isNeutral)) throw new RuleError(`Unknown player ${p}`);
    if (!(t in lobby.territories)) throw new RuleError(`Unknown territory ${t}`);
  }

  // Deal at random and stop in setup, so the spots can be fixed before anyone places an army or a turn begins.
  const autoSetup = lobby.options.autoSetup;
  const started = startGame({ ...lobby, options: { ...lobby.options, randomDeal: true, autoSetup: false } });
  let state = started.state;
  const events: GameEvent[] = [...started.events];
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];

  /** Spots already given to their players (in `wanted` order): never traded away again. */
  const settled = new Set<TerritoryId>();
  for (const [player, spot] of wanted) {
    if (state.blizzards.includes(spot)) {
      // Move the blizzard to an open territory that is nobody's spot; that territory's holder takes the spot instead.
      // Only where pickBlizzards could have put it: the open territories stay one network and every continent keeps two.
      const map = getMap(state.options.map);
      const others = state.blizzards.filter((t) => t !== spot);
      const open = Object.keys(state.territories).filter(
        (t) => !spotSet.has(t) && !state.blizzards.includes(t) && playable(map, new Set([...others, t])),
      );
      if (open.length > 0) {
        const moved = pick(open);
        state.territories[spot] = { ...state.territories[moved] };
        state.territories[moved] = { owner: null, armies: 0 };
        state.blizzards = state.blizzards.map((t) => (t === spot ? moved : t));
      } else {
        // Nowhere it may go alone (e.g. the spot's only way out is another blizzard): the whole set is drawn again, as
        // many as before where pickBlizzards could put them and never on a spot (fewer only if the board holds no
        // more). Each territory that freezes hands its holder and armies to one that thaws, so every player keeps the
        // same territories and armies; a thawed one left over goes, with an army from those left to place, to the
        // player holding the fewest.
        const fresh = redrawBlizzards(map, state.blizzards.length, spotSet, random);
        const freezing = fresh.filter((t) => !state.blizzards.includes(t));
        const thawing = state.blizzards.filter((t) => !fresh.includes(t));
        thawing.forEach((t, i) => {
          const from = freezing[i];
          if (from) return void (state.territories[t] = { ...state.territories[from] });
          const held = (id: PlayerId) => Object.values(state.territories).filter((x) => x.owner === id).length;
          const p = state.players.filter((x) => !x.isNeutral).sort((x, y) => held(x.id) - held(y.id))[0];
          state.territories[t] = { owner: p.id, armies: 1 };
          p.armiesToPlace = Math.max(0, p.armiesToPlace - 1);
        });
        for (const t of freezing) state.territories[t] = { owner: null, armies: 0 };
        state.blizzards = fresh;
      }
      for (const e of events) if (e.type === 'blizzards') e.territories = [...state.blizzards];
    }
    settled.add(spot);
    if (state.territories[spot].owner === player) continue;
    // Trade one of the player's other territories for the spot: a non-spot one if they hold any, else another
    // player's spot not settled yet (that player takes it back by the same trade when their turn here comes).
    const held = Object.keys(state.territories).filter((t) => state.territories[t].owner === player && !settled.has(t));
    const mine = held.some((t) => !spotSet.has(t)) ? held.filter((t) => !spotSet.has(t)) : held;
    if (mine.length === 0) throw new RuleError(`${player} has no territory to trade for its start spot`);
    const other = pick(mine);
    const a = state.territories[spot];
    state.territories[spot] = state.territories[other];
    state.territories[other] = a;
  }

  if (autoSetup) {
    // Place what is left at random, one setup turn at a time, until the first turn begins.
    for (let guard = 0; state.phase === 'setup' && guard < 10_000; guard++) {
      const me = state.currentPlayer!;
      const lm = legalMoves(state, me);
      const placements: Record<TerritoryId, number> = {};
      for (let n = 0; n < lm.placeLimit; n++) {
        const t = pick(lm.canPlaceOn);
        placements[t] = (placements[t] ?? 0) + 1;
      }
      const r = applyAction(state, me, { type: 'place', placements });
      state = r.state;
      events.push(...r.events);
    }
  }
  // The deal was random whatever the table asked for (a parent table always deals), so only autoSetup is restored.
  return { state: { ...state, options: { ...state.options, autoSetup } }, events };
}

/**
 * The rule `pickBlizzards` keeps for any set of blizzards: the open territories are one connected network and every
 * continent keeps at least two open territories, so the game stays winnable and every bonus reachable.
 */
function playable(map: MapDef, blocked: Set<TerritoryId>): boolean {
  for (const c of map.continents) if (c.territories.filter((t) => !blocked.has(t)).length < 2) return false;
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

/**
 * `count` blizzards drawn again where pickBlizzards could put them (one open network, two open per continent), never
 * on `avoid`. The best of a few shuffles, so it falls short only when the board really holds no more. Map order.
 */
function redrawBlizzards(map: MapDef, count: number, avoid: Set<TerritoryId>, random: RandomSource): TerritoryId[] {
  let best: TerritoryId[] = [];
  for (let attempt = 0; attempt < 20 && best.length < count; attempt++) {
    const order = map.territoryIds.filter((t) => !avoid.has(t));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const chosen = new Set<TerritoryId>();
    for (const t of order) {
      if (chosen.size >= count) break;
      if (playable(map, new Set([...chosen, t]))) chosen.add(t);
    }
    if (chosen.size > best.length) best = map.territoryIds.filter((t) => chosen.has(t));
  }
  return best;
}
