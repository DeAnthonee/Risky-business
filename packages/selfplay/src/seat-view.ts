import { applyAction, buildDeck, createRng, getMap, legalMoves, RuleError, shuffle, viewFor, type Card, type GameState, type GameView, type PlayerId } from '@risk/engine';
import { candidates, type Candidate } from './actions.js';
import { stepAgent, type Agent } from './agents.js';
import { decisionInput, type EncoderInput } from './encode.js';
import type { Traits } from './traits.js';

/**
 * The engine state behind one player's view. The RNG is left empty (legal moves and Delove's encoder never read it).
 * What the view hides about the cards is filled in so every count is right: each opponent gets a hand of its real
 * size (`cardCount`), and the deck and discard their real sizes, dealt from the cards this seat can't see. Which cards
 * an opponent holds is a guess (one random deal, from `random`); the counts are exact. Delove's encoder and Jacob
 * Sensei read only the counts (opponents' card threat, the worth of eliminating them); branch and score's rollouts
 * also play the guessed cards. Without `random` the deal is in deck order. Under fog of war the hidden territories
 * stay as the view has them (no owner, 0 armies, `hidden`).
 *
 * The live seat player (packages/delove/src/seat.ts) plays from this; self-play's fog games give agents the same
 * (`foggedAgent`), so a fog game in self-play is played on exactly what a live seat would see.
 */
export function stateFromView(view: GameView, random?: () => number): GameState {
  const { players, deckSize, discardSize, you: _y, legal: _l, continentOwners: _c, ...rest } = view;
  const known = new Set(players.flatMap((p) => (p.cards ?? []).map((c) => c.id)));
  let unseen = buildDeck(getMap(view.options.map)).filter((c) => !known.has(c.id));
  if (random) unseen = shuffle(createRng(Math.floor(random() * 0x100000000) >>> 0), unseen);
  const deal = (n: number): Card[] => unseen.splice(0, Math.max(0, Math.min(n, unseen.length)));
  const hands = players.map((p) => p.cards ?? deal(p.cardCount));
  const state: GameState = {
    ...rest,
    players: players.map(({ cardCount: _cc, territoryCount: _tc, armyCount: _ac, continents: _co, income: _i, cards: _h, ...p }, i) => ({
      ...p,
      cards: hands[i],
    })),
    deck: deal(deckSize),
    discard: deal(discardSize),
    seed: 0,
    rngState: 0,
  };
  incomes.set(state, Object.fromEntries(players.filter((p) => p.income).map((p) => [p.id, p.income!.total])));
  return state;
}

/**
 * Each player's income total as the view showed it (public at the table, fog or not), for states made by
 * stateFromView. The engine would recompute an opponent's income from the territories the state holds, which under fog
 * are only the visible ones.
 */
const incomes = new WeakMap<GameState, Record<PlayerId, number>>();

/** Each player's public income total, for a state made by stateFromView (undefined for any other state). */
export function publicIncomes(state: GameState): Readonly<Record<PlayerId, number>> | undefined {
  return incomes.get(state);
}

/**
 * The encoder input of a decision on `state` (decisionInput), with each seat's income the public total when the state
 * was rebuilt from a view. On a full state it is decisionInput itself. Networks build their input with this, so in a
 * fog game they read the same income a live seat is shown, and fog.ts's seat view of it equals the true board's.
 */
export function seatInput(state: GameState, seatIds: string[], me: string, traits: Traits, cands: Candidate[], fortifyFrom = -1): EncoderInput {
  const input = decisionInput(state, seatIds, me, traits, cands, fortifyFrom);
  const known = incomes.get(state);
  if (!known) return input;
  return {
    ...input,
    state: { ...input.state, seats: input.state.seats.map((s, i) => (s[0] && known[seatIds[i]] !== undefined ? [s[0], s[1], s[2], known[seatIds[i]]] : s)) },
  };
}

/** What `me` may know of a state: the whole state in a normal game, its view rebuilt (stateFromView) under fog. */
export function seatState(state: GameState, me: PlayerId, random: () => number): GameState {
  return state.options.fogOfWar ? stateFromView(viewFor(state, me), random) : state;
}

/**
 * An agent that never sees through the fog: in a fog-of-war game it decides on its seat's view (stateFromView, with
 * the view's legal moves and their candidates), as it would at a live table; in a normal game it is the agent itself.
 * The self-play CLI and the ladder wrap every agent with it, so no seat of a fog game, Delove or a teacher, reads a
 * hidden territory or an opponent's cards. Same id: it is the same player version, playing fair. An agent that works
 * out its own legal moves from the state instead of ctx.legal (risky@1) can misread hidden territories as unclaimed in
 * a manual setup; a move that is illegal on the true board is then replaced by the seat's first candidate (fog games
 * with `autoSetup`, the league's, have no such setup).
 */
export function foggedAgent(agent: Agent): Agent {
  return {
    ...agent,
    id: agent.id,
    choose: (ctx) => {
      if (!ctx.state.options.fogOfWar) return agent.choose(ctx);
      const view = viewFor(ctx.state, ctx.me);
      const state = stateFromView(view, ctx.random);
      // The view's own legal moves (the engine's, for this seat): on the rebuilt state hidden territories have no owner,
      // so legalMoves would take them for unclaimed ones in a setup.
      const legal = view.legal ?? legalMoves(state, ctx.me);
      const seen = { ...ctx, state, legal, candidates: candidates(state, ctx.me, legal) };
      const action = agent.choose(seen);
      if (action === null) return null;
      try {
        applyAction(ctx.state, ctx.me, action); // legal on the true board? (pure: the result is dropped)
        return action;
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        return firstCandidate.choose(seen); // an agent that misread the fog (see above) plays its seat's first candidate
      }
    },
  };
}

const firstCandidate = stepAgent('fog-fallback', () => 0);
