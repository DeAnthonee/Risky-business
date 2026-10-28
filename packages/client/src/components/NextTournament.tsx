// "Next tournament" on the home page: the server's scheduled nested tournament (GET /api/tournaments/next), with a
// countdown, the sign-up count and Join / Watch. Hidden when the server has no schedule (docs/tournaments.md).
import { useEffect, useRef, useState } from 'react';
import { api, type NextTournament } from '../api';

const REFRESH_MS = 15_000;

/** A clock countdown: "12:34", or "1:02:03" past an hour; "0:00" once it is time. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The viewer's own local time with its zone ("11:03 PM PDT"); the weekday too when it is not today. */
const at = (ms: number, now = Date.now()) =>
  new Date(ms).toLocaleString(undefined, {
    ...(new Date(ms).toDateString() === new Date(now).toDateString() ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/** One line on what the style plays like, under its name. */
function styleLine(next: NonNullable<NextTournament['next']>): string | null {
  if (next.style === '1v1') return 'Head to head: two seats a table, winners move on.';
  if (next.style === 'mega') return 'One game, everyone at the same table, on the Mega Earth globe.';
  if (next.style === 'survival') return `${next.zergs ? `${next.zergs} Zergs in the field. ` : ''}The last one standing who is not a Zerg moves on.`;
  if (next.minTable && next.minTable > 3) return `At least ${next.minTable} players a table in round 1.`;
  return null;
}

export function NextTournamentCard({ onOpen }: { onOpen: (id: string) => void }) {
  const [info, setInfo] = useState<NextTournament | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Past the start, the card rolls on to the next slot by itself (once per slot, not every second).
  const rolled = useRef<number | null>(null);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .nextTournament()
        .then((r) => alive && setInfo(r))
        .catch(() => {});
    loadRef.current = load;
    load();
    const refresh = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  const startsAt = info?.next?.startsAt ?? null;
  useEffect(() => {
    if (startsAt !== null && now >= startsAt && rolled.current !== startsAt) {
      rolled.current = startsAt;
      loadRef.current();
    }
  }, [now, startsAt]);

  if (!info?.scheduled || (!info.next && !info.running && !info.cancelled)) return null;
  const { next, running, cancelled } = info;
  const open = next?.id ? next : null;
  const seats = next?.maxEntrants ?? null;
  const lobbyMinutes = next ? Math.round((next.startsAt - next.opensAt) / 60_000) : 0;

  return (
    <section className="next-tourney" aria-labelledby="next-tourney-title">
      <div className="next-tourney-head">
        <h2 id="next-tourney-title">
          {seats ? `Next ${seats}-player tournament` : 'Next tournament'}
          {next?.label && <span className={`next-tourney-style style-${next.style ?? 'classic'}`}>{next.label}</span>}
        </h2>
        <p>Boards inside boards: win your table, carry your army into the next. Empty seats go to the Zerg swarm.</p>
      </div>
      {next && (
        <div className="next-tourney-main">
          <div className="next-tourney-clock" aria-live="off">
            <span className="next-tourney-label">Begins in</span>
            <strong>{countdown(next.startsAt - now)}</strong>
            <span className="muted small">{at(next.startsAt, now)}</span>
          </div>
          <div className="next-tourney-info">
            <strong className="next-tourney-name">{next.name}</strong>
            {styleLine(next) && <span className="muted small">{styleLine(next)}</span>}
            {open ? (
              <>
                <span className="next-tourney-seats">
                  <strong>{next.entrants}</strong> registered{next.maxEntrants ? <> / <strong>{next.maxEntrants}</strong> seats</> : ''} · the lobby is open
                </span>
                {next.checkedIn !== undefined && (
                  <span className="next-tourney-checkin">
                    Checked in {next.checkedIn} / {next.entrants}
                  </span>
                )}
              </>
            ) : (
              <span>
                The lobby opens {at(next.opensAt, now)}
                {lobbyMinutes > 0 && lobbyMinutes < 60 ? `, ${lobbyMinutes} min before the start` : ''}
              </span>
            )}
            <span className="muted small">AI players fill open seats; real players always get a seat.</span>
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
