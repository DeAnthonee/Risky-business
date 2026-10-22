// Where an entrant is in a nested tournament, for "click a name to find them on the globe" (the tournament page).
import type { TournamentView } from './api';

export type EntrantSpot =
  /** No tables yet (registering, or a server without boards). */
  | { kind: 'waiting' }
  /** Not seated at any table (should not happen once the tournament runs). */
  | { kind: 'nowhere'; name: string }
  /** At a table of the round in play (still playing, or waiting for the next round after winning it). */
  | { kind: 'playing'; name: string; node: number; round: number; table: number }
  /** Knocked out: their last table. */
  | { kind: 'out'; name: string; node: number; round: number; table: number }
  /** The tournament's winner: the final. */
  | { kind: 'champion'; name: string; node: number; round: number; table: number };

/** The entrant's latest table (the newest round they were seated in) and what it means for them. */
export function entrantSpot(t: TournamentView, entrantId: string): EntrantSpot {
  const name = t.entrants.find((e) => e.id === entrantId)?.name ?? '?';
  if (t.status === 'registering' || !t.rounds.length) return { kind: 'waiting' };
  for (let r = t.rounds.length - 1; r >= 0; r--) {
    const round = t.rounds[r];
    const i = round.matches.findIndex((m) => m.players.some((p) => p.entrantId === entrantId));
    if (i < 0) continue;
    const m = round.matches[i];
    if (m.node === undefined) continue;
    const spot = { name, node: m.node, round: round.round, table: i + 1 };
    if (t.champion?.entrantId === entrantId) return { kind: 'champion', ...spot };
    const settled = m.status === 'finished' || m.status === 'decided' || m.status === 'abandoned';
    const lost = settled && m.winner !== entrantId && !(m.status === 'decided' && m.standing?.order[0] === entrantId);
    // A table they won in an earlier round, with the next round not drawn yet, still counts as where they are.
    return { kind: lost ? 'out' : 'playing', ...spot };
  }
  return { kind: 'nowhere', name };
}

/** The toast for a spot ("" when the globe needs no words). */
export function spotMessage(s: EntrantSpot, tableLabel: (node: number) => string): string {
  switch (s.kind) {
    case 'waiting':
      return 'The boards appear when the tournament starts.';
    case 'nowhere':
      return `${s.name} has no table yet.`;
    case 'out':
      return `${s.name} is out: round ${s.round}, at ${tableLabel(s.node)}.`;
    case 'champion':
      return `${s.name} won the tournament.`;
    case 'playing':
      return '';
  }
}
