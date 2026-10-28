import { useEffect, useState } from 'react';
import { api, type GameSummary, type TournamentView } from '../api';

// Auto-spectate (opt-in: `/?spectate=1` with no game, or the Home button) moves the viewer on to the next live game.
// The exceptions (README hard rule 10): the runner's generation training matches move every spectator on to the next
// match, and a tournament table moves its spectators on to another table of the same tournament.
const COUNTDOWN_S = 8;
const GEN_COUNTDOWN_S = 4;
const TABLE_COUNTDOWN_S = 6;
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 10_000;

/** The room name the runner gives a generation training match (packages/runner/src/loop.ts): "Generation 5 Match 3". */
const GENERATION_MATCH = /^Generation \S+ Match \d+$/;

/** Whether a room is a generation training match, by its exact runner-given name (tournament tables never match). */
export function isGenerationGame(name: string | null | undefined): boolean {
  return !!name && GENERATION_MATCH.test(name);
}

/** A game worth tuning into: under way (past the lobby, not finished) and not a tournament table. */
export function pickLiveGame(games: GameSummary[], exclude: string | null): GameSummary | null {
  return games.find((g) => g.phase !== 'lobby' && g.phase !== 'finished' && !g.tournamentId && g.id !== exclude) ?? null;
}

/**
 * Finds the next generation training match to spectate.
 * Unlike standard games, generation training matches can transition straight into a lobby
 * so spectators can watch the lobby fill and start into the next match.
 */
export function pickNextGenerationGame(games: GameSummary[], exclude: string | null): GameSummary | null {
  // First priority: an in-progress generation game (past lobby, not finished)
  const live = games.find((g) => isGenerationGame(g.name) && !g.tournamentId && g.phase !== 'lobby' && g.phase !== 'finished' && g.id !== exclude);
  if (live) return live;

  // Second priority: a generation lobby waiting to start
  const lobby = games.find((g) => isGenerationGame(g.name) && !g.tournamentId && g.phase === 'lobby' && g.id !== exclude);
  if (lobby) return lobby;

  return null;
}

/**
 * The next table of a tournament to watch after `from` ends: the table its winner moved on to, else any other table
 * being played (the latest round first). Null while none is being played (the next round is not built yet).
 */
export function pickTournamentTable(t: TournamentView, from: string | null): { id: string; label: string } | null {
  const tables = t.rounds.flatMap((r) =>
    r.matches.map((m, i) => ({ m, round: r.round, label: r.matches.length === 1 && r.round > 1 ? 'the final' : `round ${r.round} table ${i + 1}` })),
  );
  const winner = tables.find((x) => x.m.gameId === from)?.m.winner;
  const playing = tables.filter((x) => x.m.status === 'playing' && x.m.gameId && x.m.gameId !== from).sort((a, b) => b.round - a.round);
  const next = (winner && playing.find((x) => x.m.players.some((p) => p.entrantId === winner))) || playing[0];
  return next ? { id: next.m.gameId!, label: next.label } : null;
}

/**
 * Polls the tournament while enabled (2 s, backing off to 10 s while no table is being played) and keeps the pick
 * fresh: a table picked early can end before the countdown does, and the winner's next table can start meanwhile.
 */
export function useTournamentTable(enabled: boolean, tournamentId: string | undefined, from: string): { next: { id: string; label: string } | null; over: boolean } {
  const [found, setFound] = useState<{ id: string; label: string } | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled || !tournamentId) return;
    let alive = true;
    let delay = POLL_FIRST_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const t = (await api.getTournament(tournamentId)).tournament;
        if (!alive) return;
        const next = pickTournamentTable(t, from);
        setFound((cur) => (cur?.id === next?.id ? cur : next));
        if (!next && t.status === 'finished') return setOver(true);
        if (next) delay = POLL_FIRST_MS;
      } catch {
        /* retry below */
      }
      if (!alive) return;
      timer = setTimeout(poll, delay);
      delay = Math.min(POLL_MAX_MS, delay * 2);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      setFound(null);
      setOver(false);
    };
  }, [enabled, tournamentId, from]);
  return { next: found, over };
}

/** Polls GET /api/games while enabled, backing off from 2 s to 10 s, and stops once a target game turns up. */
export function useLiveGame(enabled: boolean, exclude: string | null, generationOnly = false): GameSummary | null {
  const [found, setFound] = useState<GameSummary | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let delay = POLL_FIRST_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const games = (await api.listGames()).games;
        const next = generationOnly ? pickNextGenerationGame(games, exclude) : pickLiveGame(games, exclude);
        if (!alive) return;
        if (next) {
          setFound(next);
          return;
        }
      } catch {
        /* retry below */
      }
      if (!alive) return;
      timer = setTimeout(poll, delay);
      delay = Math.min(POLL_MAX_MS, delay * 2);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      setFound(null); // a later search never acts on a stale find
    };
  }, [enabled, exclude, generationOnly]);
  return found;
}

/** What an auto-spectate viewer can do from a game: move on to another one, or stay (which ends auto-spectate). */
export interface AutoSpectate {
  advance: (gameId: string) => void;
  stay: () => void;
}

/** Countdown to the next game, with "Stay here". Rendered for auto-spectate viewers, generation matches and tournament tables. */
export function AutoAdvance({
  from,
  auto,
  generationOnly = false,
  tournamentId,
}: {
  from: string;
  auto: AutoSpectate;
  generationOnly?: boolean;
  /** A tournament table: move on to another table of this tournament. */
  tournamentId?: string;
}) {
  const [left, setLeft] = useState(tournamentId ? TABLE_COUNTDOWN_S : generationOnly ? GEN_COUNTDOWN_S : COUNTDOWN_S);
  const live = useLiveGame(!tournamentId, from, generationOnly);
  const table = useTournamentTable(!!tournamentId, tournamentId, from);
  const next = tournamentId ? table.next : live ? { id: live.id, label: live.name } : null;

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  useEffect(() => {
    if (left <= 0 && next) auto.advance(next.id);
  }, [left, next, auto]);

  if (tournamentId && table.over) return <span className="auto-redirect-banner">The tournament is over.</span>;
  const what = tournamentId ? 'Next table' : generationOnly ? 'Next match' : 'Next live game';
  const waiting = tournamentId ? 'Waiting for the next table…' : generationOnly ? 'Waiting for next generation match…' : 'Waiting for a live game…';
  return (
    <span className="auto-redirect-banner">
      {left > 0 ? (
        <span>
          {what} in <span className="countdown-badge">{left}s</span>…
        </span>
      ) : (
        <span className="pulse">{waiting}</span>
      )}
      {next && (
        <button className="small primary" onClick={() => auto.advance(next.id)}>
          Watch {next.label} now
        </button>
      )}
      <button className="small" onClick={auto.stay} title={tournamentId ? 'Keep watching this table' : 'Stop auto-spectate and keep watching this game'}>
        Stay here
      </button>
    </span>
  );
}
