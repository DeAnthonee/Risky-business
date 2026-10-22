import { RiskHttpError, type RiskApi, type TournamentInfo } from '@risk/mcp';
import type { Agent } from '@risk/selfplay';
import { playSeat } from './seat.js';

/**
 * One tournament entrant played by a Delove version, as an agent plays it over MCP (docs/tournaments.md):
 * wait for a table (the tournament's long poll with the entrant token), play it with the seat player (playSeat), then
 * wait for the next one, until the entrant is out or the tournament is over.
 *
 * Everything comes from the server again after any break: a failed wait (a restart, a dropped connection) is retried
 * with a back-off and re-reads the tournament with the entrant token, which says which table this entrant has now;
 * playSeat itself re-attaches to its table the same way, and acts on the fresh state each time (a move refused because
 * the state moved on, e.g. a turn timer skipping the seat, is dropped and the seat waits again).
 */
export interface EntrantOptions {
  api: RiskApi;
  tournamentId: string;
  /** The entrant's secret from join_tournament; never logged. */
  entrantToken: string;
  name: string;
  agent: Agent;
  paceMs: number;
  log: (line: string) => void;
  random?: () => number;
  onDecision?: (ms: number) => void;
  /** Long-poll length for the tournament (default 25 s). */
  waitMs?: number;
}

export interface EntrantResult {
  name: string;
  /** 'champion', 'out', 'finished' (the tournament ended without this entrant winning it) or 'gone' (deleted). */
  status: 'champion' | 'out' | 'finished' | 'gone';
  /** Tables this entrant played. */
  tables: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function playEntrant(o: EntrantOptions): Promise<EntrantResult> {
  const waitMs = o.waitMs ?? 25_000;
  const played = new Set<string>();
  let since: number | undefined;
  let failures = 0;
  const done = (t: TournamentInfo, status: EntrantResult['status']): EntrantResult => {
    o.log(`${o.name}: ${status === 'champion' ? 'CHAMPION' : status === 'out' ? 'out' : 'tournament over'} after ${played.size} table(s)${t.champion ? ` (champion ${t.champion.name})` : ''}`);
    return { name: o.name, status, tables: played.size };
  };
  for (;;) {
    let t: TournamentInfo;
    try {
      t =
        since === undefined
          ? (await o.api.getTournament(o.tournamentId, o.entrantToken)).tournament
          : (await o.api.waitTournament(o.tournamentId, o.entrantToken, since, waitMs)).tournament;
      failures = 0;
    } catch (e) {
      if (e instanceof RiskHttpError && (e.status === 404 || e.status === 401)) {
        o.log(`${o.name}: tournament is gone (${e.message})`);
        return { name: o.name, status: 'gone', tables: played.size };
      }
      const pause = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      o.log(`${o.name}: tournament wait failed (${(e as Error).message}); retrying in ${pause / 1000} s`);
      await sleep(pause);
      since = undefined; // re-read the whole state after a break
      continue;
    }
    since = t.version;
    const match = t.you?.match;
    if (match && !played.has(match.gameId)) {
      played.add(match.gameId);
      o.log(`${o.name}: round ${match.round}, table ${match.gameId}`);
      await playSeat({ api: o.api, gameId: match.gameId, playerId: match.playerId, token: match.token, name: o.name, agent: o.agent, paceMs: o.paceMs, log: o.log, random: o.random, onDecision: o.onDecision });
      since = undefined; // the table is over (or left): see where the tournament stands now
      continue;
    }
    if (t.champion && t.you && t.champion.entrantId === t.you.entrantId) return done(t, 'champion');
    if (t.status === 'finished') return done(t, 'finished');
    if (t.you?.status === 'out') return done(t, 'out');
  }
}

/** p50 / p90 / max of decision times in ms. */
export function latencySummary(ms: number[]): { decisions: number; p50: number; p90: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
  return { decisions: s.length, p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(s.at(-1) ?? 0) };
}
