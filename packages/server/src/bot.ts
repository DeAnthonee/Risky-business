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

/** Every Zerg gets one of these names, never two alike in one room: the name is how players tell a Zerg. */
export const ZERG_NAMES = [
  'Godzilla', 'Cobra', 'Komodo', 'Basilisk', 'Iguana', 'Gecko', 'Python', 'Mamba', 'Viper', 'Anaconda',
  'Gila', 'Chameleon', 'Caiman', 'Gharial', 'Tuatara', 'Skink', 'Taipan', 'Boomslang',
] as const;

/** A random name from ZERG_NAMES that nobody in the room uses yet (any case). */
export function zergName(state: GameState): string {
  return freeZergName(state.players.map((p) => p.name));
}

/**
 * A random name from ZERG_NAMES that none of `names` uses (any case). Once all are taken: "Godzilla 2", "Godzilla 3",
 * ... (a tournament with more Zergs than the list).
 */
export function freeZergName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  const free = ZERG_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  if (free.length > 0) return free[randomInt(free.length)];
  for (let i = 2; ; i++) {
    const name = `${ZERG_NAMES[0]} ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * A bot seat's move: a Zerg plays zerg@2 (`ZERG_2_PARAMS`: zerg@1 without the mid-game surrender, the owner's call in
 * #198) with every Zerg seat in the room as its horde; any other bot is the built-in bot. Training stays on zerg@1.
 */
export function chooseSeatAction(state: GameState, me: PlayerId): Action | null {
  if (!isZergSeat(me)) return chooseBotAction(state, me);
  const horde = new Set(state.players.filter((p) => isZergSeat(p.id)).map((p) => p.id));
  return chooseZergAction(state, me, horde, Math.random, ZERG_2_PARAMS);
}
