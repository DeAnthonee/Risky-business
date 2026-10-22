import { useEffect, useState } from 'react';
import { MAPS } from '@risk/engine';
import { api, ApiError, type TournamentView } from '../api';
import { getEntrantToken, saveEntrantToken, type Session } from '../session';
import { NestedTournament } from './NestedTournament';

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
      <div className="center">
        <div className="card">
          <h2>Tournament {id}</h2>
          <p className={err ? 'error' : 'muted'}>{err ?? 'Loading…'}</p>
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  const you = t.you;
  const mapName = MAPS[t.map as keyof typeof MAPS]?.name ?? t.map;
  const nameOf = (eid: string) => t.entrants.find((e) => e.id === eid)?.name ?? '?';
  const nested = t.format === 'nested';

  return (
    <div className="home tournament">
      <header className="hero">
        <h1>
          <span className="dice">🏆</span> {t.name}
        </h1>
        <p className="muted">
          <code>{t.id}</code> · {STATUS_LABEL[t.status]} ·{' '}
          {nested ? 'boards inside boards (tables of 3 to 6, a final of 6 to 10)' : `${mapName} · tables of up to ${t.groupSize}`} · {t.entrants.length}/{t.maxEntrants} entrants
        </p>
      </header>

      {t.champion && (
        <section className="card wide champion">
          <h2>👑 Champion: {t.champion.name}</h2>
        </section>
      )}

      <div className="home-grid">
        <section className="card">
          {you ? (
            <>
              <h2>You: {you.name}</h2>
              <p className="muted">{youLine(you.status, t.status)}</p>
              {you.match && (
                <button className="primary" onClick={() => onPlay({ gameId: you.match!.gameId, playerId: you.match!.playerId, token: you.match!.token, name: you.name })}>
                  ⚔ Play your table (round {you.match.round})
                </button>
              )}
            </>
          ) : t.status === 'registering' ? (
            <>
              <h2>Join this tournament</h2>
              <label>
                Your player name
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dean" maxLength={24} />
              </label>
              <button className="primary" disabled={busy || !name.trim() || t.entrants.length >= t.maxEntrants} onClick={join}>
                Join as {name.trim() || '…'}
              </button>
              <p className="muted small">
                {nested
                  ? "Boards inside boards: each table's winner takes their board up into the next round, until the final."
                  : "Knockout: each table's winner moves on to the next round until one champion is left."}
              </p>
            </>
          ) : (
            <>
              <h2>Watching</h2>
              <p className="muted">Registration is closed. Watch any table below.</p>
            </>
          )}
          {err && <p className="error">{err}</p>}
          <div className="row">
            <button onClick={onBack}>Back to games</button>
          </div>
        </section>

        <section className="card">
          <h2>Entrants</h2>
          {t.entrants.length === 0 && <p className="muted">Nobody yet.</p>}
          <ul className="entrants">
            {t.entrants.map((e) => (
              <li key={e.id} className={`entrant ${e.status}`}>
                {e.status === 'champion' ? '👑 ' : ''}
                {e.name}
                {e.isBot ? ' 🤖' : ''}
                {you?.entrantId === e.id ? ' (you)' : ''}
              </li>
            ))}
          </ul>
        </section>

        {nested && <NestedTournament t={t} onWatch={onWatch} />}

        {!nested && t.rounds
          .slice()
          .reverse()
          .map((r) => (
            <section key={r.round} className="card wide">
              <h2>{r.matches.length === 1 && r.round > 1 ? `Round ${r.round}: the final` : `Round ${r.round}`}</h2>
              <div className="tables">
                {r.matches.map((m, i) => (
                  <div key={m.gameId ?? `bye-${i}`} className={`table-card ${m.status}`}>
                    <div className="table-head">
                      <strong>{m.gameId ? `Table ${i + 1}` : 'Bye'}</strong>
                      {m.gameId && <code>{m.gameId}</code>}
                      <span className="muted small">{m.status === 'playing' ? 'playing' : m.status === 'abandoned' ? 'abandoned' : m.status === 'bye' ? 'moves on' : 'decided'}</span>
                    </div>
                    <ul>
                      {m.players.map((p) => (
                        <li key={p.entrantId} className={m.winner === p.entrantId ? 'winner' : m.winner || m.status === 'abandoned' ? 'out' : ''}>
                          {m.winner === p.entrantId ? '🏅 ' : ''}
                          {p.name}
                          {you?.entrantId === p.entrantId ? ' (you)' : ''}
                        </li>
                      ))}
                    </ul>
                    {m.gameId && (
                      <button onClick={() => onWatch(m.gameId!)} title={`Watch ${m.players.map((p) => nameOf(p.entrantId)).join(' vs ')}`}>
                        👁 Watch
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}

function youLine(status: string, t: TournamentView['status']): string {
  if (status === 'registered') return t === 'registering' ? "You're in. Your table appears here when the host starts the tournament." : 'Waiting for the bracket.';
  if (status === 'playing') return 'Your table is being played.';
  if (status === 'waiting') return 'You won your table! Waiting for the other tables to finish.';
  if (status === 'champion') return 'You won the tournament!';
  return 'You are out. Watch the rest of the bracket below.';
}
