import { useEffect, useState } from 'react';
import { api, type GameSummary } from '../api';

// Auto-spectate (opt-in: `/?spectate=1` with no game, or the Home button) moves the viewer on to the next live game.
// The one exception: the runner's generation training matches move every spectator on to the next match.
const COUNTDOWN_S = 8;
const GEN_COUNTDOWN_S = 4;
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

/** Countdown to the next game, with "Stay here". Rendered for auto-spectate viewers and generation matches. */
export function AutoAdvance({
  from,
  auto,
  generationOnly = false,
}: {
  from: string;
  auto: AutoSpectate;
  generationOnly?: boolean;
}) {
  const [left, setLeft] = useState(generationOnly ? GEN_COUNTDOWN_S : COUNTDOWN_S);
  const next = useLiveGame(true, from, generationOnly);

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
          {generationOnly ? 'Next match' : 'Next live game'} in <span className="countdown-badge">{left}s</span>…
        </span>
      ) : (
        <span className="pulse">
          {generationOnly ? 'Waiting for next generation match…' : 'Waiting for a live game…'}
        </span>
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
