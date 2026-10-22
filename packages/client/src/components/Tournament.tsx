import { useEffect, useState } from 'react';
import { MAPS } from '@risk/engine';
import { api, ApiError, type HostEntrantsView, type TournamentView } from '../api';
import { getEntrantToken, getHostToken, saveEntrantToken, type Session } from '../session';
import { HostEntrants } from './HostEntrants';
import { NestedTournament } from './NestedTournament';
import { ShareButton } from './Share';
import { StartButton } from './StartButton';

const STATUS_LABEL: Record<TournamentView['status'], string> = {
  registering: 'Registration open',
  running: 'In progress',
  finished: 'Finished',
};

/** A tournament bracket: join while it is open, then play your table or watch any table, round by round. */
export function Tournament({
  id,
  name,
  setName,
  onPlay,
  onWatch,
  onBack,
}: {
  id: string;
  name: string;
  setName: (n: string) => void;
  onPlay: (s: Session) => void;
  onWatch: (gameId: string) => void;
  onBack: () => void;
}) {
  const [token, setToken] = useState<string | null>(() => getEntrantToken(id));
  const [t, setT] = useState<TournamentView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The host's start: this browser's host token (from the create form), or a hosting code from anywhere.
  const hostToken = getHostToken(id);
  const [code, setCode] = useState('');
  // The host bar's live entrants (HostEntrants shares what it fetches), for the seat count beside Start now.
  const [hostView, setHostView] = useState<HostEntrantsView | null>(null);
  const start = async () => {
    setBusy(true);
    try {
      const r = hostToken ? await api.startTournament(id, hostToken) : await api.startTournamentWithCode(id, t?.openMode ? '' : code.trim());
      setT(r.tournament);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Follow the bracket with a long-poll: it returns as soon as anything changes.
  useEffect(() => {
    let alive = true;
    let version = -1;
    const loop = async () => {
      while (alive) {
        try {
          const r = version < 0 ? await api.getTournament(id, token ?? undefined) : await api.waitTournament(id, version, token ?? undefined);
          if (!alive) return;
          version = r.tournament.version;
          setT(r.tournament);
          setErr(null);
        } catch (e) {
          if (!alive) return;
          // A stale entrant token (another server, a deleted tournament): drop it and look as a visitor.
          if (token && e instanceof ApiError && e.status === 400) {
            saveEntrantToken(id, null);
            setToken(null);
            return;
          }
          setErr((e as Error).message);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [id, token]);

  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.joinTournament(id, name.trim());
      saveEntrantToken(id, r.token);
      setToken(r.token);
      setT(r.tournament);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!t) {
    return (
      <div className="home p5 tournament-page">
        <section className="home-actions tourney-panel">
          <h2 className="p5-tag">Tournament {id}</h2>
          <p className={err ? 'error' : 'muted'}>{err ?? 'Loading…'}</p>
          <div>
            <button onClick={onBack}>Back to games</button>
          </div>
        </section>
      </div>
    );
  }

  const you = t.you;
  const mapName = MAPS[t.map as keyof typeof MAPS]?.name ?? t.map;
  const nameOf = (eid: string) => t.entrants.find((e) => e.id === eid)?.name ?? '?';
  const nested = t.format === 'nested';
  // The host controls (Start now, who joined) sit above every view of a registering tournament: for this browser's host
  // token, or for anyone in open mode (testing, no hosting codes), so another window or Incognito can still start it.
  const canHost = !!hostToken || !!t.openMode;
  const hostBar = t.status === 'registering' && !t.scheduled && canHost;

  return (
    <div className="home p5 tournament-page">
      <header className="tourney-top">
        <div className="tourney-bar">
          <button className="small" onClick={onBack}>
            ← Back to games
          </button>
          <ShareButton url={`${window.location.origin}${window.location.pathname}?tournament=${t.id}`} title={`${t.name} · Risky Business tournament`} />
        </div>
        <h1 className="tourney-title">
          <span>{t.name}</span>
        </h1>
        <p className="home-tag tourney-tag">
          <code>{t.id}</code> {STATUS_LABEL[t.status]} ·{' '}
          {nested ? 'boards inside boards (tables of 3 to 6, a final of 6 to 10)' : `${mapName} · tables of up to ${t.groupSize}`} · {t.entrants.length}/{t.maxEntrants} entrants
        </p>
      </header>

      {hostBar && (
        <section className="home-actions tourney-hostbar" aria-label="Host controls">
          <h2 className="p5-tag">Host</h2>
          <p>
            {hostToken ? 'You created this tournament.' : 'Testing mode: anyone can start this tournament.'} Start it when everyone is in; empty open
            spots are planned around at the start.
          </p>
          <StartButton
            joined={hostView?.entrants.length ?? t.entrants.length}
            max={hostView?.maxEntrants ?? t.maxEntrants}
            deloveAsked={t.requested?.delove ?? 0}
            deloveJoined={hostView?.counts.delove ?? 0}
            busy={busy}
            onStart={() => void start()}
          />
          {err && <p className="error">{err}</p>}
          <HostEntrants id={id} hostToken={hostToken ?? undefined} onView={setHostView} />
        </section>
      )}

      {t.champion && (
        <section className="tourney-champion" aria-label="Champion">
          <span className="ticket-stamp">Champion</span>
          <strong>👑 {t.champion.name}</strong>
        </section>
      )}

      <div className="tourney-grid">
        <section className="home-actions tourney-panel" aria-labelledby="tourney-you">
          {you ? (
            <>
              <h2 id="tourney-you" className="p5-tag">
                You: {you.name}
              </h2>
              <p>{youLine(you.status, t.status, !!t.scheduled)}</p>
              {t.status === 'registering' && t.scheduled && you.checkedIn !== undefined && (
                <p className={you.checkedIn ? 'tourney-checkin done' : 'tourney-checkin'}>
                  {you.checkedIn
                    ? "✔ You're checked in. Your table appears here at the start."
                    : `Check-in opens ${new Date(t.scheduled.startsAt - (t.scheduled.checkinMinutes ?? 10) * 60_000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, ${t.scheduled.checkinMinutes ?? 10} minutes before the start. Have this page open then (it checks you in), or your seat goes to a Zerg.`}
                </p>
              )}
              {you.match && (
                <button className="primary" onClick={() => onPlay({ gameId: you.match!.gameId, playerId: you.match!.playerId, token: you.match!.token, name: you.name })}>
                  ⚔ Play your table (round {you.match.round})
                </button>
              )}
            </>
          ) : t.status === 'registering' ? (
            <>
              <h2 id="tourney-you" className="p5-tag">
                Join this tournament
              </h2>
              <label className="callsign">
                Your name
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dean" maxLength={24} />
              </label>
              <button className="primary tourney-join" disabled={busy || !name.trim() || t.entrants.length >= t.maxEntrants} onClick={join}>
                Join as {name.trim() || '…'}
              </button>
              <p className="muted">
                {nested
                  ? "Boards inside boards: each table's winner takes their board up into the next round, until the final."
                  : "Knockout: each table's winner moves on to the next round until one champion is left."}
              </p>
            </>
          ) : (
            <>
              <h2 id="tourney-you" className="p5-tag">
                Watching
              </h2>
              <p>Registration is closed. Watch any table below.</p>
            </>
          )}
          {t.status === 'registering' && !t.scheduled && !canHost && (
            <div className="tourney-host">
              <h3>Host</h3>
              <label className="ct-code">
                Hosting code
                <input value={code} autoComplete="off" spellCheck={false} placeholder="from the site owner" onChange={(e) => setCode(e.target.value)} />
              </label>
              <button disabled={busy || !code.trim()} onClick={start}>
                Start with code
              </button>
            </div>
          )}
          {err && <p className="error">{err}</p>}
        </section>

        <section className="board tourney-entrants" aria-labelledby="tourney-entrants">
          <div className="board-head">
            <h2 id="tourney-entrants">Entrants</h2>
            <p className="board-count">
              <span>
                {t.entrants.length} of {t.maxEntrants}
              </span>
            </p>
          </div>
          {t.entrants.length === 0 ? (
            <div className="board-empty">
              <p>Nobody yet. Be the first.</p>
            </div>
          ) : (
            <ul className="ticket-seats tourney-seats">
              {t.entrants.map((e) => (
                <li key={e.id} className={e.status}>
                  {e.status === 'champion' ? '👑 ' : ''}
                  {e.name}
                  {e.isBot && <span className="bot-tag">BOT</span>}
                  {you?.entrantId === e.id ? ' (you)' : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {nested && <NestedTournament t={t} onWatch={onWatch} />}

      {!nested &&
        t.rounds
          .slice()
          .reverse()
          .map((r) => (
            <section key={r.round} className="board tourney-round" aria-label={`Round ${r.round}`}>
              <div className="board-head">
                <h2>{r.matches.length === 1 && r.round > 1 ? `Round ${r.round}: the final` : `Round ${r.round}`}</h2>
              </div>
              <ul className="tickets tourney-tables">
                {r.matches.map((m, i) => (
                  <li key={m.gameId ?? `bye-${i}`} className={`ticket ticket-${m.status === 'playing' ? 'live' : m.status === 'bye' ? 'lobby' : 'finished'}`}>
                    <span className="ticket-stamp">{m.gameId ? `Table ${i + 1}` : 'Bye'}</span>
                    <div className="ticket-main">
                      <div className="ticket-title">
                        {m.gameId && <code>{m.gameId}</code>}
                        <span className="ticket-meta">{m.status === 'playing' ? 'playing' : m.status === 'abandoned' ? 'abandoned' : m.status === 'bye' ? 'moves on' : 'decided'}</span>
                      </div>
                      <ul className="ticket-seats">
                        {m.players.map((p) => (
                          <li key={p.entrantId} className={m.winner === p.entrantId ? 'won' : m.winner || m.status === 'abandoned' ? 'out' : ''}>
                            {m.winner === p.entrantId ? '🏅 ' : ''}
                            {p.name}
                            {you?.entrantId === p.entrantId ? ' (you)' : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {m.gameId && (
                      <div className="ticket-actions">
                        <button className="watch" onClick={() => onWatch(m.gameId!)} title={`Watch ${m.players.map((p) => nameOf(p.entrantId)).join(' vs ')}`}>
                          Watch
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
    </div>
  );
}

function youLine(status: string, t: TournamentView['status'], scheduled = false): string {
  if (status === 'registered')
    return t === 'registering' ? (scheduled ? "You're in. It starts by itself at its time." : "You're in. Your table appears here when the host starts the tournament.") : 'Waiting for the bracket.';
  if (status === 'playing') return 'Your table is being played.';
  if (status === 'waiting') return 'You won your table! Waiting for the other tables to finish.';
  if (status === 'champion') return 'You won the tournament!';
  return 'You are out. Watch the rest of the bracket below.';
}
