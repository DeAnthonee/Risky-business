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
 * could have put it (or, with none left, thaws with any blizzards that would cut it off, and as many freeze again
 * elsewhere where the rule allows, taken from the players who gained the thawed ones), and a spot dealt
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
        // Nowhere it may go alone (no single open territory keeps the rule, e.g. the spot's only way out is another
        // blizzard): it thaws. A spot ringed by blizzards would be cut off once open, so the blizzards next to its open
        // patch thaw too, one at a time, until the open territories are one network again. Each thawed territory goes,
        // with one army from the armies left to place, to its spot's player, else to this one.
        state.blizzards = others;
        const thawed = [spot];
        while (!playable(map, new Set(state.blizzards))) {
          const patch = reach(map, spot, new Set(state.blizzards));
          const next = state.blizzards.find((b) => map.adjacency[b].some((n) => patch.has(n)));
          // Only a board whose territories are not one network could get here; never loop on it.
          if (next === undefined) throw new RuleError(`${state.options.map}: the open territories cannot be joined around ${spot}`);
          state.blizzards = state.blizzards.filter((t) => t !== next);
          thawed.push(next);
        }
        const gainers: PlayerId[] = [];
        for (const t of thawed) {
          const owner = t === spot ? player : (wanted.find(([, s]) => s === t)?.[0] ?? player);
          state.territories[t] = { owner, armies: 1 };
          const p = state.players.find((x) => x.id === owner)!;
          p.armiesToPlace = Math.max(0, p.armiesToPlace - 1);
          gainers.push(owner);
        }
        // Then the board gets its blizzards back where the rule allows: for each thawed territory, one of its new
        // owner's other territories (never a spot) freezes and its army goes back to place, so the deal stays even.
        // With none that fits, the board keeps fewer blizzards.
        for (const g of gainers) {
          const fits = Object.keys(state.territories).filter(
            (t) => state.territories[t].owner === g && !spotSet.has(t) && !thawed.includes(t) && playable(map, new Set([...state.blizzards, t])),
          );
          if (fits.length === 0) continue;
          const t = pick(fits);
          state.players.find((x) => x.id === g)!.armiesToPlace += state.territories[t].armies;
          state.territories[t] = { owner: null, armies: 0 };
          state.blizzards = map.territoryIds.filter((x) => x === t || state.blizzards.includes(x));
        }
      }
      for (const e of events) if (e.type === 'blizzards') e.territories = [...state.blizzards];
    }
    if (state.territories[spot].owner === player) continue;
    const mine = Object.keys(state.territories).filter((t) => state.territories[t].owner === player && !spotSet.has(t));
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

/** The open territories reachable from `from` (itself included) without crossing `blocked`. */
function reach(map: MapDef, from: TerritoryId, blocked: Set<TerritoryId>): Set<TerritoryId> {
  const seen = new Set<TerritoryId>([from]);
  const queue = [from];
  while (queue.length) for (const n of map.adjacency[queue.pop()!]) if (!blocked.has(n) && !seen.has(n)) (seen.add(n), queue.push(n));
  return seen;
}
