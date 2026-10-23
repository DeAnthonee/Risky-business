import type { RiskApi } from '@risk/mcp';
import type { Agent } from '@risk/selfplay';
import type { Noter } from './notes.js';
import type { PoolEntrant } from './pool.js';
import { playSeat } from './seat.js';
import { playEntrant, type EntrantResult } from './tournament-seat.js';

export interface PoolPlayOptions {
  api: RiskApi;
  agent: Agent;
  paceMs: number;
  log: (line: string) => void;
  notes?: Noter | null;
  random?: () => number;
  onDecision?: (ms: number) => void;
}

/**
 * Plays one of the pool's seats (pool-cli.ts children): a joined entrant plays its tournament, table after table; a
 * takeover plays its one game seat with the seat token, to the end of that table (a stand-in never moves on).
 */
export function playPoolEntrant(e: PoolEntrant, o: PoolPlayOptions): Promise<EntrantResult> {
  if (e.game) {
    return playSeat({ ...o, gameId: e.game.gameId, playerId: e.game.playerId, token: e.token, name: e.name }).then((view) => ({
      name: e.name,
      status: view ? 'finished' : 'gone',
      tables: 1,
    }));
  }
  return playEntrant({ ...o, tournamentId: e.tournamentId, entrantToken: e.token, name: e.name });
}
