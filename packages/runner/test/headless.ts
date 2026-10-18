import { addPlayer, applyAction, chooseBotAction, createGame, createRng, nextFloat, startGame, viewFor, type Action, type GameOptions, type GameState } from '@risk/engine';
import { DEFAULT_OPTIONS } from '../src/presets.js';
import { choosePlannedAction, isLegalAction, StallTracker, type Plan } from '../src/planned-bot.js';

export type SeatKind = 'engine' | 'planned';

export interface HeadlessResult {
  winner: number | null;
  turns: number;
  rounds: number;
  state: GameState;
  illegal: string[];
}

export const seeded = (seed: number) => {
  const rng = createRng(seed);
  return () => nextFloat(rng);
};

/** Play one headless game on the engine: planned-bot seats choose from their own (fogged) view. */
export function playHeadless(opts: {
  seed: number;
  map: GameOptions['map'];
  seats: SeatKind[];
  plan?: (seat: number, view: ReturnType<typeof viewFor>, random: () => number) => Plan | null;
  maxTurns?: number;
  /** Called with every planned-bot action before it is applied. */
  onAction?: (seat: number, action: Action, state: GameState) => void;
  options?: Partial<GameOptions>;
}): HeadlessResult {
  const n = opts.seats.length;
  const ids = opts.seats.map((_, i) => `s${i}`);
  let state = createGame(`H${opts.seed}`, { ...DEFAULT_OPTIONS, maxPlayers: n, map: opts.map, ...opts.options }, opts.seed);
  ids.forEach((id, i) => (state = addPlayer(state, id, `P${i}`, true)));
  state = startGame(state).state;
  const rnd = seeded(opts.seed ^ 0x9e3779b9);
  const illegal: string[] = [];
  const trackers = ids.map(() => new StallTracker());
  const maxTurns = opts.maxTurns ?? 700;
  let guard = 0;
  let lastTurn = -1;
  let perTurn = 0;
  while (state.phase !== 'finished' && state.turnNumber < maxTurns) {
    const me = state.currentPlayer!;
    const seat = ids.indexOf(me);
    let action: Action | null;
    if (opts.seats[seat] === 'engine') {
      action = chooseBotAction(state, me, rnd);
    } else {
      const view = viewFor(state, me);
      trackers[seat].observe(view, me);
      action = choosePlannedAction(view, me, opts.plan ? opts.plan(seat, view, rnd) : null, rnd, trackers[seat].stall);
      if (action && !isLegalAction(view, action)) illegal.push(`seat ${seat}: ${JSON.stringify(action)}`);
    }
    if (!action) throw new Error(`no action for ${me} in ${state.phase}`);
    opts.onAction?.(seat, action, state);
    state = applyAction(state, me, action).state;
    if (state.turnNumber !== lastTurn) ((lastTurn = state.turnNumber), (perTurn = 0));
    else if (++perTurn > 3000 || ++guard > 2_000_000) throw new Error('stuck turn');
  }
  const winner = state.winner ? ids.indexOf(state.winner) : null;
  return { winner, turns: state.turnNumber, rounds: state.round, state, illegal };
}
