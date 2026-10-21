import type { PlayerId } from '@risk/engine';

export type PingType =
  | 'agree'
  | 'decline'
  | 'attack'
  | 'alliance'
  | 'good_neighbor'
  | 'camaraderie'
  | 'anger'
  | 'taunt';

export interface PingAction {
  type: PingType;
  target?: string | null;
  to?: string | null;
}

export interface ParsedPing {
  type: PingType;
  target?: string;
  from: string;
  isWhisper: boolean;
  raw: string;
}

/** Check if a name belongs to a neural net / Delove model player (e.g. Ronny@3, Ronny@4, Sensei@3, etc.) */
export function isModelName(name: string): boolean {
  if (!name) return false;
  return /(@\d+|delove|sensei@|jacob-sensei)/i.test(name);
}

/** Format a ping action into its standardized bracketed chat message with visual tags for spectators. */
export function formatPing(ping: PingAction): string {
  switch (ping.type) {
    case 'agree':
      return '🤝 [agree]';
    case 'decline':
      return '✋ [decline]';
    case 'attack':
      return ping.target ? `⚔️ [attack: ${ping.target}]` : '⚔️ [attack]';
    case 'alliance':
      return '🛡️ [alliance]';
    case 'good_neighbor':
      return '🏡 [good neighbor]';
    case 'camaraderie':
      return '👊 [camaraderie]';
    case 'anger':
      return '💢 [anger]';
    case 'taunt':
      return '😈 [taunt]';
    default:
      return '🤝 [agree]';
  }
}

/**
 * Parse an incoming chat message to check if it contains a valid diplomatic ping.
 * Supports canonical and common alias representations, with or without emojis.
 */
export function parsePing(raw: string, from: string, isWhisper: boolean): ParsedPing | null {
  if (!raw || !from) return null;
  const text = raw.trim();

  // Attack / target ping: [attack: Name] or [target: Name]
  const attackMatch = /\[(?:attack|target):\s*([^\]]+)\]/i.exec(text);
  if (attackMatch) {
    const target = attackMatch[1].trim();
    if (target) return { type: 'attack', target, from, isWhisper, raw: text };
  }

  // Affirmation: [agree] or [yes]
  if (/\[(agree|yes)\]/i.test(text)) {
    return { type: 'agree', from, isWhisper, raw: text };
  }

  // Rejection: [decline] or [no]
  if (/\[(decline|no)\]/i.test(text)) {
    return { type: 'decline', from, isWhisper, raw: text };
  }

  // Alliance: [alliance]
  if (/\[alliance\]/i.test(text)) {
    return { type: 'alliance', from, isWhisper, raw: text };
  }

  // Good neighbor / neutral border: [good neighbor], [neutral border], [border], [truce], [peace]
  if (/\[(?:good[\s_-]*neighbor|neutral[\s_-]*border|border|truce|peace)\]/i.test(text)) {
    return { type: 'good_neighbor', from, isWhisper, raw: text };
  }

  // Camaraderie: [camaraderie], [fistbump], or [handshake]
  if (/\[(camaraderie|fistbump|handshake)\]/i.test(text)) {
    return { type: 'camaraderie', from, isWhisper, raw: text };
  }

  // Anger: [anger], [angry], or [furious]
  if (/\[(anger|angry|furious)\]/i.test(text)) {
    return { type: 'anger', from, isWhisper, raw: text };
  }

  // Taunt: [taunt], [mock], or [laugh]
  if (/\[(taunt|mock|laugh)\]/i.test(text)) {
    return { type: 'taunt', from, isWhisper, raw: text };
  }

  return null;
}
