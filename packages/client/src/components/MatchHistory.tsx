import { useEffect, useState } from 'react';
import { MAPS } from '@risk/engine';
import { api, type MatchSummary } from '../api';
import { CharacterName } from './Profiles';

/** "just now", "12m ago", "3h ago", "2d ago", then the date. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(at).toLocaleDateString();
}

function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The leaderboard key the server ranks a seat under (see /games/:id/players/:player/profile). */
const profileKey = (p: MatchSummary['players'][number]) => p.characterId ?? `${p.isBot ? 'bot' : 'player'}:${p.name.trim().toLowerCase()}`;

/** Finished games, newest first, beside the leaderboard. `openRooms` are rooms still on the server, which can be watched. */
export function MatchHistory({ openRooms, onWatch }: { openRooms: Set<string>; onWatch: (gameId: string) => void }) {
  const [games, setGames] = useState<MatchSummary[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listHistory()
        .then((r) => {
          if (!alive) return;
          setGames(r.games);
          setEnabled(r.enabled);
          setLoaded(true);
          setError('');
          setNow(Date.now());
        })
        .catch(() => alive && setError('Could not load match history.'));
    void load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [retry]);

  return (
    <section className="board history-board" aria-labelledby="history-title">
      <div className="board-head">
        <h2 id="history-title">Match history</h2>
        {loaded && games.length > 0 && <p className="board-count"><span>{games.length} recent</span></p>}
      </div>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      )}
      {!loaded && !error && <p role="status">Loading match history…</p>}
      {loaded && !games.length && <p className="board-empty">{enabled ? 'No finished games yet. The first winner shows up here.' : 'Game records are off on this server, so there is no history.'}</p>}
      {!!games.length && (
        <ol className="matches">
          {games.map((g) => {
            // Places are numbered by finishing order among the seats (a record's placings can count a Neutral).
            const seats = [...g.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
            const winner = seats.find((p) => p.id === g.winner.id);
            return (
              <li key={g.id} className="match">
                <div className="match-head">
                  <span className="match-crown" aria-hidden="true">♛</span>
                  <span className="match-winner">
                    {winner ? <CharacterName name={winner.name} profileKey={profileKey(winner)} /> : g.winner.name}
                  </span>
                  <span className="match-how">{g.reason === 'capitals' ? 'took every capital' : 'conquered the world'}</span>
                  <time className="match-when" dateTime={new Date(g.endedAt).toISOString()} title={new Date(g.endedAt).toLocaleString()}>
                    {ago(g.endedAt, now)}
                  </time>
                </div>
                <div className="match-meta">
                  <strong>{g.name}</strong>
                  <span>{MAPS[g.map as keyof typeof MAPS]?.name ?? g.map}</span>
                  <span>{g.turns} turns</span>
                  <span>{duration(g.endedAt - g.startedAt)}</span>
                  {g.fog && <span>Fog</span>}
                  {g.tournamentId && <span>Tournament</span>}
                  {g.scenario && <span>Scenario</span>}
                </div>
                <ol className="match-seats" aria-label="Final places">
                  {seats.map((p, i) => (
                    <li key={p.id} className={p.id === g.winner.id ? 'won' : ''}>
                      <span className="match-place">{p.place === null ? '–' : i + 1}</span>
                      {p.name}
                      {p.isBot && <span className="bot-tag">bot</span>}
                    </li>
                  ))}
                </ol>
                {openRooms.has(g.room) && (
                  <button className="watch match-watch" onClick={() => onWatch(g.room)} title="Open the final board while the room is still around">
                    View final board
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
