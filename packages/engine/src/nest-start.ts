import type { RandomSource } from './bot.js';
import { applyAction, legalMoves, startGame } from './engine.js';
import { RuleError, type ActionResult, type GameEvent, type GameState, type PlayerId, type TerritoryId } from './types.js';

/**
 * Start a game in which each player begins on a fixed territory: the parent table of a nested tournament, where every
 * player is the winner of the table inside one territory (their "portal"; docs/tournaments.md).
 *
 * It is the normal start (`startGame`: turn order, deck, blizzards, neutrals, a random deal), then each spot is
 * swapped, owner and armies together, with a territory its player was dealt elsewhere, so every player keeps the same
 * number of territories and armies. A blizzard that fell on a spot moves to another open territory, and a spot dealt
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
      const open = Object.keys(state.territories).filter((t) => !spotSet.has(t) && !state.blizzards.includes(t) && state.territories[t].owner !== player);
      if (open.length === 0) throw new RuleError('No open territory to move a blizzard to');
      const moved = pick(open);
      state.territories[spot] = { ...state.territories[moved] };
      state.territories[moved] = { owner: null, armies: 0 };
      state.blizzards = state.blizzards.map((t) => (t === spot ? moved : t));
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
