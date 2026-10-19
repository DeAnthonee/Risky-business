import { useEffect, useState } from 'react';
import { api, type GameSummary } from '../api';

// Auto-spectate (opt-in: `/?spectate=1` with no game, or the Home button) moves the viewer on to the next live game.
const COUNTDOWN_S = 8;
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 10_000;

/** A game worth tuning into: under way (past the lobby, not finished) and not a tournament table. */
export function pickLiveGame(games: GameSummary[], exclude: string | null): GameSummary | null {
  return games.find((g) => g.phase !== 'lobby' && g.phase !== 'finished' && !g.tournamentId && g.id !== exclude) ?? null;
}

/** Polls GET /api/games while enabled, backing off from 2 s to 10 s, and stops once a live game turns up. */
export function useLiveGame(enabled: boolean, exclude: string | null): GameSummary | null {
  const [found, setFound] = useState<GameSummary | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let delay = POLL_FIRST_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = pickLiveGame((await api.listGames()).games, exclude);
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
  }, [enabled, exclude]);
  return found;
}

/** What an auto-spectate viewer can do from a game: move on to another one, or stay (which ends auto-spectate). */
export interface AutoSpectate {
  advance: (gameId: string) => void;
  stay: () => void;
}

/** Countdown to the next live game, with "Stay here". Rendered only for auto-spectate viewers. */
export function AutoAdvance({ from, auto }: { from: string; auto: AutoSpectate }) {
  const [left, setLeft] = useState(COUNTDOWN_S);
  const next = useLiveGame(true, from);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  useEffect(() => {
    if (left <= 0 && next) auto.advance(next.id);
  }, [left, next, auto]);

  return (
    <span className="auto-redirect-banner">
      {left > 0 ? (
        <span>
          Next live game in <span className="countdown-badge">{left}s</span>…
        </span>
      ) : (
        <span className="pulse">Waiting for a live game…</span>
      )}
      {next && (
        <button className="small primary" onClick={() => auto.advance(next.id)}>
          Watch {next.name} now
        </button>
      )}
      <button className="small" onClick={auto.stay} title="Stop auto-spectate and keep watching this game">
        Stay here
      </button>
    </span>
  );
}
