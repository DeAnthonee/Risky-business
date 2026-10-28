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

/** One line on what the style plays like, under its name. */
function styleLine(next: NonNullable<NextTournament['next']>): string | null {
  if (next.style === '1v1') return 'Head to head: two seats a table, winners move on.';
  if (next.style === 'mega') return 'One game, everyone at the same table, on the Mega Earth globe.';
  if (next.style === 'survival') return `${next.zergs ? `${next.zergs} Zergs in the field. ` : ''}The last one standing who is not a Zerg moves on.`;
  if (next.minTable && next.minTable > 3) return `At least ${next.minTable} players a table in round 1.`;
  return null;
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
  // The daily tournament: "Today's tournament" when it starts today in the viewer's day.
  const today = next ? new Date(next.startsAt).toDateString() === new Date(now).toDateString() : false;

  return (
    <section className="next-tourney" aria-labelledby="next-tourney-title">
      <div className="next-tourney-head">
        <h2 id="next-tourney-title">
          {today ? "Today's tournament" : 'Next tournament'}
          {next?.label && <span className={`next-tourney-style style-${next.style ?? 'classic'}`}>{next.label}</span>}
        </h2>
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
            {styleLine(next) && <span className="muted small">{styleLine(next)}</span>}
            {open ? (
              <>
                <span className="next-tourney-seats">
                  <strong>{next.entrants}</strong> registered{next.maxEntrants ? <> / <strong>{next.maxEntrants}</strong> seats</> : ''} · needs {next.minEntrants} to run
                </span>
                {!!next.roster && <span className="muted small">{next.roster} seats go to the house AI roster</span>}
                {next.checkedIn !== undefined ? (
                  <span className="next-tourney-checkin">
                    Checked in {next.checkedIn} / {next.entrants}
                  </span>
                ) : (
                  next.checkinOpensAt !== undefined && <span className="muted small">Check-in opens {at(next.checkinOpensAt)}: keep its page open then, or no-shows go to Zergs</span>
                )}
              </>
            ) : (
              <span>Sign-up opens {at(next.opensAt)}</span>
            )}
          </div>
          {open && (
            <div className="next-tourney-actions">
              <button className="primary" onClick={() => onOpen(open.id!)} title="Save your seat: your AI (or you) checks in just before the start">
                Register
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
            Playing now: <strong>{running.name}</strong>{running.label ? ` (${running.label})` : ''}, round {running.round}
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
