import { useEffect, useMemo, useRef, useState } from 'react';
import { getMap } from '@risk/engine';
import type { TournamentView } from '../api';
import { entrantSpot, spotMessage } from '../entrantFocus';
import { toSnapshot, useTournamentFeed } from '../useTournamentFeed';
import { Inception, type TableSnapshot } from './Inception';
import { Bracket } from './Bracket';

type Tab = 'map' | 'bracket' | 'live';
const FOLLOW_KEY = 'risk.tournament.follow';

function loadFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) === '1';
  } catch {
    return false;
  }
}
function saveFollow(on: boolean) {
  try {
    localStorage.setItem(FOLLOW_KEY, on ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the switch just isn't remembered.
  }
}

/**
 * A nested ("Inception") tournament: the round clock, the boards inside boards (zoom in and out), the bracket and the
 * live tables. "Follow the action" is opt-in, off by default, and never offered to a viewer holding a seat in this
 * tournament (README hard rule 10).
 */
export function NestedTournament({ t, onWatch, pick }: { t: TournamentView; onWatch: (gameId: string) => void; pick?: { id: string; seq: number } | null }) {
  const [tab, setTab] = useState<Tab>('map');
  const sectionRef = useRef<HTMLElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [request, setRequest] = useState<{ node: number; name: string; seq: number } | null>(null);
  const feed = useTournamentFeed(t);
  const seated = !!t.you;
  const [followOn, setFollowOn] = useState(() => !seated && loadFollow());
  const setFollow = (on: boolean) => {
    setFollowOn(on);
    saveFollow(on);
  };
  const nodes = t.nested?.nodes ?? null;
  const tables = useMemo(() => {
    const out: Record<number, TableSnapshot> = {};
    if (!nodes) return out;
    for (const [k, table] of Object.entries(feed.tables)) out[Number(k)] = toSnapshot(table, nodes[Number(k)].map);
    return out;
  }, [feed.tables, nodes]);
  const following = !seated && followOn && feed.live ? feed.follow : null;

  // A click on an entrant's name (the Entrants chips or the host's list): open the Map tab and send the globe to their
  // table, focused (the viewer clicks Watch table from there). Knocked out: their last table, with a note.
  useEffect(() => {
    if (!pick) return;
    const spot = entrantSpot(t, pick.id);
    const labelOf = (node: number) => {
      const n = nodes?.[node];
      if (!n || n.parent === null) return 'the final';
      return getMap(nodes![n.parent].map).territoryById[n.portal ?? '']?.name ?? 'their table';
    };
    setToast(spotMessage(spot, labelOf) || null);
    if (spot.kind !== 'waiting' && spot.kind !== 'nowhere' && nodes) {
      setTab('map');
      setRequest({ node: spot.node, name: spot.name, seq: pick.seq });
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      sectionRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    // Only a new click acts; the tournament view refreshing does not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.seq]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <section ref={sectionRef} className="card wide nested-tournament">
      <RoundClock t={t} />
      <p className="entrant-toast" role="status" aria-live="polite">
        {toast}
      </p>
      <div className="nested-tabs" role="tablist">
        {(['map', 'bracket', 'live'] as Tab[]).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
            {x === 'map' ? 'Map' : x === 'bracket' ? 'Bracket' : 'Live tables'}
          </button>
        ))}
        <a className="nested-board-link" href="?leaderboard=tournament">
          Tournament leaderboard
        </a>
      </div>

      {tab === 'map' &&
        (nodes ? (
          <>
            {!seated && (
              <label className="follow-switch" title="Move the view by itself to the most exciting table. Off by default.">
                <input type="checkbox" checked={followOn} disabled={!feed.live} onChange={(e) => setFollow(e.target.checked)} /> Follow the action
                {!feed.live && <span className="muted small"> (needs the live feed)</span>}
              </label>
            )}
            <Inception nodes={nodes} tables={tables} onWatch={onWatch} follow={following} onManualZoom={() => followOn && setFollow(false)} request={request} />
          </>
        ) : (
          <p className="muted">{t.status === 'registering' ? 'The boards appear when the tournament starts.' : 'This server does not send the boards yet; the bracket and live tables have every table.'}</p>
        ))}

      {tab === 'bracket' && <Bracket t={t} onWatch={onWatch} />}
      {tab === 'live' && <LiveTables t={t} feed={feed} onWatch={onWatch} />}
    </section>
  );
}

/** "Round 1 · 9 of 17 tables needed · 14:20 left": a round ends when enough tables finish or its deadline passes. */
function RoundClock({ t }: { t: TournamentView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const round = t.rounds.at(-1);
  if (t.status === 'registering') return <p className="round-clock muted">Registration is open. The plan and the boards are made at the start.</p>;
  if (!round) return null;
  if (t.aborted) return <p className="round-clock">Aborted: the bracket stays as it was, and the tables then being played were recorded with their standing so far.</p>;
  if (t.status === 'finished') return <p className="round-clock">Finished{t.champion ? `: ${t.champion.name} is the champion` : ''}.</p>;
  const tables = round.matches.length;
  const done = round.matches.filter((m) => m.status === 'finished' || m.status === 'bye').length;
  const left = round.deadline ? Math.max(0, round.deadline - now) : null;
  const mmss = left === null ? null : `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  const lastLap = round.lastLapAt !== undefined;
  return (
    <p className="round-clock">
      <strong>{tables === 1 ? 'The final' : `Round ${round.round}`}</strong> · {done} of {tables} tables finished
      {lastLap ? ' · last lap' : mmss !== null && ` · ${mmss} left`}
      <span className="muted small">
        {lastLap
          ? ' (the tables still playing finish this go-around of turns, so everyone has had as many, then are decided on standing)'
          : ' (then the tables still playing finish their go-around of turns and are decided on standing)'}
      </span>
    </p>
  );
}

/** The tables being played now, the most exciting first (with the live feed), else the tightest. */
function LiveTables({ t, feed, onWatch }: { t: TournamentView; feed: ReturnType<typeof useTournamentFeed>; onWatch: (gameId: string) => void }) {
  const round = t.rounds.at(-1);
  const playing = (round?.matches ?? []).filter((m) => m.status === 'playing' && m.gameId);
  const info = (m: (typeof playing)[number]) => (m.node !== undefined ? feed.tables[m.node] : undefined);
  const sorted = playing.slice().sort((a, b) => {
    const ea = info(a)?.excitement?.score ?? 0;
    const eb = info(b)?.excitement?.score ?? 0;
    if (ea !== eb) return eb - ea;
    const alive = (m: (typeof playing)[number]) => info(m)?.players.filter((p) => p.alive).length ?? m.players.length;
    return alive(a) - alive(b);
  });
  if (!sorted.length) return <p className="muted">No table is being played right now.</p>;
  return (
    <ul className="live-tables">
      {sorted.map((m) => {
        const x = info(m);
        return (
          <li key={m.gameId}>
            <strong>{m.players.map((p) => p.name).join(' · ')}</strong>
            <span className="muted small">
              {' '}
              {x ? `${x.players.filter((p) => p.alive).length} of ${x.players.length} left` : `${m.players.length} seats`}
              {x?.excitement?.why ? ` · ${x.excitement.why}` : ''}
            </span>
            <button onClick={() => onWatch(m.gameId!)}>👁 Watch</button>
          </li>
        );
      })}
    </ul>
  );
}
