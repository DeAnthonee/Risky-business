/**
 * Disconnected seats at tournament tables (owner, 2026-10-22: "a system to catch the disconnections, which is different
 * from a model taking their time to plan out their move"). A seat is disconnected only when BOTH hold:
 * - it ran out of the turn timer `timeouts` times in a row (any move of its own resets the count), and
 * - it sent nothing for the idle window: no request with its token (HTTP, MCP: get_state, wait_for_turn, chat...) and
 *   no open WebSocket, for max(timerFactor x the move timer, idleFloorMs).
 * A model that is thinking polls or holds wait_for_turn, so it is never dropped. Tournament tables only, outside seats
 * only (never bots or Zergs), and only with a turn timer (tournaments run one by default). GameRoom applies it.
 */
export interface DisconnectConfig {
  timeouts: number;
  timerFactor: number;
  idleFloorMs: number;
}

export const DEFAULT_DISCONNECT: DisconnectConfig = { timeouts: 1, timerFactor: 1, idleFloorMs: 90_000 };

/** RISK_DISCONNECT_TIMEOUTS (default 1; 0 turns detection off), RISK_DISCONNECT_IDLE_S (the idle floor, default 90; owner: "90 seconds seems great"). */
export function disconnectConfigFromEnv(env: NodeJS.ProcessEnv): DisconnectConfig {
  const int = (name: string, fallback: number) => {
    const v = Number(env[name] ?? '');
    return env[name] !== undefined && env[name] !== '' && Number.isInteger(v) && v >= 0 ? v : fallback;
  };
  return { ...DEFAULT_DISCONNECT, timeouts: int('RISK_DISCONNECT_TIMEOUTS', DEFAULT_DISCONNECT.timeouts), idleFloorMs: int('RISK_DISCONNECT_IDLE_S', DEFAULT_DISCONNECT.idleFloorMs / 1000) * 1000 };
}

/** The idle window for a move timer of `timerSeconds`. */
export function disconnectIdleMs(timerSeconds: number, c: DisconnectConfig = DEFAULT_DISCONNECT): number {
  return Math.max(c.timerFactor * timerSeconds * 1000, c.idleFloorMs);
}

/** What a dropped seat's old token answers (HTTP 410, MCP): the seat plays on without them. */
export function droppedMessage(reason: string): string {
  return `You were dropped from this table (${reason}): a stand-in plays your seat now, and you are out of the tournament`;
}

/** The thresholds this server runs with (RISK_DISCONNECT_*). */
export const DISCONNECT_FROM_ENV: DisconnectConfig = disconnectConfigFromEnv(process.env);
