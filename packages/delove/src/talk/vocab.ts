import type { PlayerId } from '@risk/engine';

/**
 * The learned Zerg's message vocabulary, v0 (docs/zergs.md §7). One message per seat per turn at most, public or
 * whispered to one seat. On live tables these render through templates; in self-play they travel as tokens.
 */
export const MESSAGE_KINDS = ['claim_zerg', 'ask', 'vouch', 'accuse', 'target', 'thanks', 'warn', 'deny'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Kinds that name another seat. */
export const TARGETED: ReadonlySet<MessageKind> = new Set(['ask', 'vouch', 'accuse', 'target', 'thanks', 'warn']);

export interface TalkMessage {
  from: PlayerId;
  kind: MessageKind;
  /** The seat the message is about (ask, vouch, accuse, target, thanks, warn). */
  about?: PlayerId;
  /** Whisper recipient; absent = public. */
  to?: PlayerId;
  turn: number;
  round: number;
}

/** What `reader` can see: public messages, and whispers it sent or received. Roles are never part of a message. */
export function visibleTo(chat: readonly TalkMessage[], reader: PlayerId): TalkMessage[] {
  return chat.filter((m) => m.to === undefined || m.to === reader || m.from === reader);
}

/** Talk-log format version (packages/delove/src/talk/game.ts): bump on any change to the logged record shape. */
export const TALK_LOG_VERSION = 1;
