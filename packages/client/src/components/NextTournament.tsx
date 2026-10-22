// "Next tournament" on the home page: the server's scheduled nested tournament (GET /api/tournaments/next), with a
// countdown, the sign-up count and Join / Watch. Hidden when the server has no schedule (docs/tournaments.md).
import { useEffect, useState } from 'react';
import { api, type NextTournament } from '../api';

const REFRESH_MS = 15_000;

/** "2h 05m", "4m 09s", "now". */
export function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

const at = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function NextTournamentCard({ onOpen }: { onOpen: (id: string) => void }) {
  const [info, setInfo] = useState<NextTournament | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .nextTournament()
        .then((r) => alive && setInfo(r))
        .catch(() => {});
    load();
    const refresh = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  if (!info?.scheduled || (!info.next && !info.running && !info.cancelled)) return null;
  const { next, running, cancelled } = info;
  const open = next?.id ? next : null;

  return (
    <section className="next-tourney" aria-labelledby="next-tourney-title">
      <div className="next-tourney-head">
        <h2 id="next-tourney-title">Next tournament</h2>
        <p>Boards inside boards: win your table, carry your army into the next. Empty seats go to the Zerg swarm.</p>
      </div>
      {next && (
        <div className="next-tourney-main">
          <div className="next-tourney-clock" aria-live="off">
            <span className="next-tourney-label">{open ? 'Starts in' : 'Sign-up opens in'}</span>
            <strong>{countdown((open ? next.startsAt : next.opensAt) - now)}</strong>
            <span className="muted small">{at(next.startsAt)}</span>
          </div>
          <div className="next-tourney-info">
            <strong className="next-tourney-name">{next.name}</strong>
            {open ? (
              <span>
                {next.entrants}
                {next.maxEntrants ? ` of ${next.maxEntrants}` : ''} signed up · needs {next.minEntrants} to run
              </span>
            ) : (
              <span>Sign-up opens {at(next.opensAt)}</span>
            )}
          </div>
          {open && (
            <div className="next-tourney-actions">
              <button className="primary" onClick={() => onOpen(open.id!)}>
                Join
              </button>
              <button onClick={() => onOpen(open.id!)}>Watch</button>
            </div>
          )}
        </div>
      )}
      {running && (
        <div className="next-tourney-live">
          <span className="next-tourney-dot" aria-hidden="true" />
          <span>
            Playing now: <strong>{running.name}</strong>, round {running.round}
          </span>
          <button onClick={() => onOpen(running.id)}>Watch</button>
        </div>
      )}
      {cancelled && (
        <p className="next-tourney-off">
          {cancelled.name} ({at(cancelled.startsAt)}) was cancelled: {cancelled.reason}.
        </p>
      )}
    </section>
  );
}
