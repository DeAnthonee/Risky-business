import { useEffect, useState } from 'react';
import { api, type HostEntrantsView } from '../api';
import './host-entrants.css';

const KIND: Record<HostEntrantsView['entrants'][number]['kind'], string> = {
  zerg: '🦎 Zerg',
  bot: 'Bot',
  delove: 'Delove',
  agent: 'Agent',
  human: 'Human',
};

/** "just now", "3 min ago", "2 h ago". */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 30) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * The host's live view of who joined (GET /api/tournaments/:id/entrants, host token): counter tiles (Zergs, Delove,
 * other agents, humans, open spots) and every entrant, newest first, with a kind badge and when they joined. It
 * refreshes whenever the tournament changes (the /wait long-poll), and stops once registration closes. `hostToken`:
 * this browser's host token; without it (open mode) the server answers anyone.
 */
export function HostEntrants({
  id,
  hostToken,
  onView,
  onPick,
}: {
  id: string;
  hostToken?: string;
  onView?: (v: HostEntrantsView) => void;
  /** Nested tournaments: a click on a name finds that entrant on the globe. */
  onPick?: (entrantId: string) => void;
}) {
  const [view, setView] = useState<HostEntrantsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      let version: number | undefined;
      while (alive) {
        try {
          const v = await api.hostEntrants(id, hostToken);
          if (!alive) return;
          setView(v);
          onView?.(v);
          setErr(null);
          if (v.status !== 'registering') return;
          // Wait for the next change (a join, a leave, the start), then fetch again.
          if (version === v.version) await new Promise((r) => setTimeout(r, 3000));
          version = v.version;
          await api.waitTournament(id, v.version);
        } catch (e) {
          if (!alive) return;
          setErr((e as Error).message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, hostToken]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!view) return err ? <p className="error">{err}</p> : <p className="muted">Loading entrants…</p>;
  const c = view.counts;
  const tiles: [string, number][] = [
    ['Zergs', c.zergs],
    ['Delove', c.delove],
    ['Other agents', c.agents],
    ['Humans', c.humans],
    ...(c.bots ? ([['Bots', c.bots]] as [string, number][]) : []),
    ['Open spots', c.open],
  ];
  return (
    <section className="board host-entrants" aria-label="Who joined" aria-live="polite">
      <div className="board-head">
        <h2>Who joined</h2>
        <p className="board-count">
          <span>{view.entrants.length}</span> of {view.maxEntrants}
        </p>
      </div>
      <ul className="he-tiles">
        {tiles.map(([label, n]) => (
          <li key={label}>
            <strong>{n}</strong>
            <span>{label}</span>
          </li>
        ))}
      </ul>
      {view.entrants.length ? (
        <ul className="tickets he-list">
          {view.entrants.map((e) => (
            <li key={e.id} className="ticket">
              <span className="ticket-stamp">{e.kind === 'agent' && e.agent ? e.agent : KIND[e.kind]}</span>
              {onPick ? (
                <button type="button" className="he-name entrant-link" title={`Find ${e.name} on the globe`} onClick={() => onPick(e.id)}>
                  {e.name}
                </button>
              ) : (
                <span className="he-name">{e.name}</span>
              )}
              <time className="muted" dateTime={new Date(e.joinedAt).toISOString()}>
                {ago(e.joinedAt, now)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <div className="board-empty">
          <p>Nobody yet: share the code.</p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
