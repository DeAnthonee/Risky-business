// The built-in bot and the Zerg live in the engine so the self-play harness plays the exact same code.
import { randomInt } from 'node:crypto';
import { chooseBotAction, chooseZergAction, ZERG_2_PARAMS, type Action, type GameState, type PlayerId } from '@risk/engine';

export { chooseBotAction };

/** The bot kinds a host can seat: the built-in bot, or a Zerg (docs/zergs.md). */
export type BotKind = 'bot' | 'zerg';
export const BOT_KINDS: readonly BotKind[] = ['bot', 'zerg'];

/** A Zerg seat's id starts with this. The server mints every id, so nobody can join as one. */
const ZERG_PREFIX = 'zerg_';

export function isZergSeat(id: PlayerId): boolean {
  return id.startsWith(ZERG_PREFIX);
}

/** Seat ids: `p_` for players, `bot_` for built-in bots, `zerg_` for Zergs. */
export function seatIdPrefix(kind: BotKind | null): string {
  return kind === 'zerg' ? ZERG_PREFIX : kind === 'bot' ? 'bot_' : 'p_';
}

/**
 * Every Zerg gets one of these names, never two alike in one room: the name is how players tell a Zerg (each has
 * "Zerg" in it). Good-natured puns (owner, 2026-10-22), at most 21 characters so a " 99" suffix still fits a name.
 */
export const ZERG_NAMES = [
  'Mark Zergburg', 'Elon Zerg', 'Zergy Mercury', 'Zerg Lightyear', 'Zerglock Holmes',
  'Bruce Zergsteen', 'Elvis Zergsley', 'Obi-Wan Zergobi', 'Darth Zerger', 'Lady Zerga',
  'Kim Zergdashian', 'Morgan Zergman', 'Leonardo DiZergio', 'Gandalf the Zerg', 'Harry Zerger',
  'Captain Zergica', 'Albert Zergstein', 'Beyonzerg', 'Mick Zergger', 'Jerry Zergfeld',
  "Shaquille O'Zerg", 'Pikazerg', 'Sir Zergalot', 'Zergeant Pepper', 'Zerg Ross',
  'Zergiana Grande', 'Keanu Zerges', 'Indiana Zergs', 'Zergbo Baggins', 'Gordon Zergsay',
  'Agatha Zergstie', 'Jimi Zergdrix', 'Zerge Clooney', 'Zergmund Freud', 'Lionel Zergsi',
  'Zergolas', 'Zerggy Pop', 'Dolly Zergton', 'Zergzilla', 'Zerg Nye',
] as const;

/** A random name from ZERG_NAMES that nobody in the room uses yet (any case). */
export function zergName(state: GameState): string {
  return freeZergName(state.players.map((p) => p.name));
}

/**
 * A random name from ZERG_NAMES that none of `names` uses (any case). Once all are taken, a random one with a number:
 * "Elon Zerg 2", "Pikazerg 2", ..., then " 3" (a tournament with more Zergs than the list).
 */
export function freeZergName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const free = ZERG_NAMES.map((n) => (i === 1 ? n : `${n} ${i}`)).filter((n) => !taken.has(n.toLowerCase()));
    if (free.length > 0) return free[randomInt(free.length)];
  }
}

/**
 * A bot seat's move: a Zerg plays zerg@2 (`ZERG_2_PARAMS`: zerg@1 without the mid-game surrender, the owner's call in
 * #198) with every Zerg seat in the room as its horde; any other bot is the built-in bot. Training plays zerg@2 too
 * since #201.
 */
export function chooseSeatAction(state: GameState, me: PlayerId, standIns: ReadonlySet<PlayerId> = new Set()): Action | null {
  // `standIns`: seats a Zerg took over (a dropped player's, "<name>-Zerg"): Zergs too, in the same horde.
  const zerg = (id: PlayerId) => isZergSeat(id) || standIns.has(id);
  if (!zerg(me)) return chooseBotAction(state, me);
  const horde = new Set(state.players.filter((p) => zerg(p.id)).map((p) => p.id));
  return chooseZergAction(state, me, horde, Math.random, ZERG_2_PARAMS);
}
