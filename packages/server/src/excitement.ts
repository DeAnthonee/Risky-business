import { getMap, type GameEvent, type GameView, type PlayerId, type TerritoryId } from '@risk/engine';

/**
 * "Follow the action" (owner decision 19; nested-tournament-orchestration.md §4.1): how exciting a tournament table is
 * right now, 0-100, and which table an opted-in watcher should be shown. Computed on the server from the public
 * spectator view only, so it reveals nothing a spectator cannot already see, and every watcher gets the same ranking.
 * Pure functions: the caller passes the clock. Not wired into a feed yet (tournament feed, PR 9).
 */

/** What the score reads from a table: its spectator view (`viewFor(state, null)`), or the same fields by hand. */
export type TableView = Pick<GameView, 'phase' | 'territories' | 'capitals' | 'options'> & {
  players: Pick<GameView['players'][number], 'id' | 'alive' | 'isNeutral'>[];
};

/** A batch of events and when it happened (a room's history entries fit). */
export interface TimedEvents {
  at: number;
  events: GameEvent[];
}

export type SignalKind = 'elimination' | 'knockout' | 'capitalThreat' | 'capitalFell' | 'closeRace' | 'endgame' | 'fighting' | 'final';

export interface Signal {
  kind: SignalKind;
  points: number;
  /** Words for the caption: "Following: Table 7 (capital under threat)". */
  label: string;
}

export interface Excitement {
  /** 0-100. */
  score: number;
  /** Every signal that scored, strongest first. */
  signals: Signal[];
}

/**
 * What counts as a big move for the reaction pop-ups (reactions.ts): in one turn, an attacker takes at least
 * `minTerritories` from one victim AND at least `minShare` of what that victim held when the turn began; or knocks
 * them out; or takes their capital. The one place to tune it. Pop-ups are at most one per `minGapMs` per game.
 */
export const BIG_MOVE = { minTerritories: 3, minShare: 0.25, minGapMs: 5_000, queue: 3 } as const;

export const EXCITEMENT = {
  elimination: 40,
  eliminationWindowMs: 20_000,
  knockout: 25,
  capitalThreat: 30,
  capitalFell: 30,
  capitalFellWindowMs: 20_000,
  closeRace: 15,
  closeRaceMargin: 0.1,
  endgame: 15,
  fighting: 20,
  fightingWindowMs: 30_000,
  /** Armies lost in the window, as a share of the armies on the table, that earns the full fighting points. */
  fightingFullShare: 0.25,
  final: 20,
} as const;

const LABELS: Record<SignalKind, string> = {
  elimination: 'a player was just knocked out',
  knockout: 'a player is about to be knocked out',
  capitalThreat: 'capital under threat',
  capitalFell: 'a capital just fell',
  closeRace: 'a close race',
  endgame: 'down to the last two',
  fighting: 'heavy fighting',
  final: 'the final',
};

/**
 * The excitement of one table. `recent` are its latest events with their times (older ones are ignored), `now` the
 * clock, `final` true for the tournament's last table. A finished (or not yet started) game scores 0.
 */
export function excitementScore(view: TableView, recent: readonly TimedEvents[], now: number, opts: { final?: boolean } = {}): Excitement {
  if (view.phase === 'finished' || view.phase === 'lobby') return { score: 0, signals: [] };
  const E = EXCITEMENT;
  const signals: Signal[] = [];
  const add = (kind: SignalKind, points: number) => {
    if (points > 0) signals.push({ kind, points: Math.round(points), label: LABELS[kind] });
  };
  const within = (ms: number) => recent.filter((b) => now - b.at >= 0 && now - b.at <= ms);

  // An elimination in the last 20 s: +40, fading to 0.
  const lastElimination = Math.max(-Infinity, ...within(E.eliminationWindowMs).filter((b) => b.events.some((e) => e.type === 'eliminated')).map((b) => b.at));
  if (Number.isFinite(lastElimination)) add('elimination', E.elimination * (1 - (now - lastElimination) / E.eliminationWindowMs));

  const map = getMap(view.options.map);
  const owner = (t: TerritoryId) => view.territories[t]?.owner ?? null;
  const armies = (t: TerritoryId) => view.territories[t]?.armies ?? 0;
  const neutral = new Set(view.players.filter((p) => p.isNeutral).map((p) => p.id));
  const alive = view.players.filter((p) => p.alive && !p.isNeutral);
  const held = (id: PlayerId) => Object.keys(view.territories).filter((t) => owner(t) === id);
  /** A real opponent's stack next to `t` with at least twice its armies. */
  const outgunned = (t: TerritoryId) => map.adjacency[t].some((n) => { const o = owner(n); return o !== null && o !== owner(t) && !neutral.has(o) && armies(n) >= 2 * armies(t); });

  // A player about to be knocked out: 2 or fewer territories, one of them facing an enemy stack twice its size.
  if (alive.some((p) => { const ts = held(p.id); return ts.length > 0 && ts.length <= 2 && ts.some(outgunned); })) add('knockout', E.knockout);

  // A capital about to fall, and one that just fell.
  if (view.options.capitals) {
    if (Object.values(view.capitals ?? {}).some((t) => owner(t) !== null && outgunned(t))) add('capitalThreat', E.capitalThreat);
    if (within(E.capitalFellWindowMs).some((b) => b.events.some((e) => e.type === 'capital_captured'))) add('capitalFell', E.capitalFell);
  }

  // A close race: the top two within 10% on armies + 2 × territories.
  if (alive.length >= 2) {
    const strength = alive.map((p) => held(p.id).reduce((n, t) => n + armies(t), 0) + 2 * held(p.id).length).sort((a, b) => b - a);
    if (strength[0] > 0 && strength[1] >= strength[0] * (1 - E.closeRaceMargin)) add('closeRace', E.closeRace);
  }

  // The endgame: exactly two players left.
  if (alive.length === 2) add('endgame', E.endgame);

  // Heavy fighting: armies lost in battles over the last 30 s, against the armies on the table.
  const lost = within(E.fightingWindowMs).reduce((n, b) => n + b.events.reduce((m, e) => m + (e.type === 'battle' ? e.attackerLosses + e.defenderLosses : 0), 0), 0);
  const total = Object.keys(view.territories).reduce((n, t) => n + armies(t), 0);
  if (lost > 0 && total > 0) add('fighting', E.fighting * Math.min(1, lost / (total * E.fightingFullShare)));

  if (opts.final) add('final', E.final);

  signals.sort((a, b) => b.points - a.points);
  return { score: Math.max(0, Math.min(100, signals.reduce((n, s) => n + s.points, 0))), signals };
}

/** One table the follow picker can choose. */
export interface FollowCandidate {
  tableId: string;
  /** "Table 7", "Final". */
  name: string;
  excitement: Excitement;
  /** The table's game is over (or its room is gone). */
  finished: boolean;
}

/** Whom the watcher follows and since when (the caller keeps it between updates). */
export interface FollowState {
  tableId: string | null;
  since: number;
}

export interface FollowPick {
  state: FollowState;
  /** The table to show, or null when no table is live. */
  tableId: string | null;
  /** "Following: Table 7 (capital under threat)", or null with no table. */
  caption: string | null;
  switched: boolean;
}

export const FOLLOW = { minStayMs: 20_000, switchMargin: 15 } as const;

/**
 * Pick the table to follow. No flicker: stay on a table at least 20 s, and switch only to a table scoring at least
 * 15 more than the current one, or as soon as the current one ends. Ties go to the earlier candidate.
 */
export function pickFollow(current: FollowState, tables: readonly FollowCandidate[], now: number): FollowPick {
  const live = tables.filter((t) => !t.finished);
  if (!live.length) return { state: { tableId: null, since: now }, tableId: null, caption: null, switched: current.tableId !== null };
  const best = live.reduce((a, b) => (b.excitement.score > a.excitement.score ? b : a));
  const here = live.find((t) => t.tableId === current.tableId);
  let pick = here ?? best;
  if (here && here !== best && now - current.since >= FOLLOW.minStayMs && best.excitement.score >= here.excitement.score + FOLLOW.switchMargin) pick = best;
  const switched = pick.tableId !== current.tableId;
  const state = switched ? { tableId: pick.tableId, since: now } : current;
  const why = pick.excitement.signals[0]?.label;
  return { state, tableId: pick.tableId, caption: `Following: ${pick.name}${why ? ` (${why})` : ''}`, switched };
}
