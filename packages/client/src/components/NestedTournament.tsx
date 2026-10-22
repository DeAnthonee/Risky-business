import { useEffect, useMemo, useState } from 'react';
import type { TournamentView } from '../api';
import { toSnapshot, useTournamentFeed } from '../useTournamentFeed';
import { Inception, type TableSnapshot } from './Inception';

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
export function NestedTournament({ t, onWatch }: { t: TournamentView; onWatch: (gameId: string) => void }) {
  const [tab, setTab] = useState<Tab>('map');
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

  return (
    <section className="card wide nested-tournament">
      <RoundClock t={t} />
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
            <Inception nodes={nodes} tables={tables} onWatch={onWatch} follow={following} onManualZoom={() => followOn && setFollow(false)} />
          </>
        ) : (
          <p className="muted">{t.status === 'registering' ? 'The boards appear here when the tournament starts.' : 'This server does not send the boards yet; the bracket and live tables have every table.'}</p>
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

function matchStatus(m: TournamentView['rounds'][number]['matches'][number]): string {
  if (m.status === 'decided') return 'decided on standing';
  if (m.status === 'bye') return 'moves on';
  return m.status;
}

/** The bracket from the final down. */
function Bracket({ t, onWatch }: { t: TournamentView; onWatch: (gameId: string) => void }) {
  const last = t.rounds.length;
  return (
    <div className="nested-bracket">
      {t.rounds
        .slice()
        .reverse()
        .map((r) => (
          <div key={r.round}>
            <h3>{r.matches.length === 1 && r.round === last && r.round > 1 ? 'The final' : `Round ${r.round}`}</h3>
            <div className="tables">
              {r.matches.map((m, i) => (
                <div key={m.gameId ?? `t-${i}`} className={`table-card ${m.status}`}>
                  <div className="table-head">
                    <strong>Table {i + 1}</strong>
                    <span className="muted small">{matchStatus(m)}</span>
                  </div>
                  <ul>
                    {(m.status === 'decided' && m.standing ? m.standing.order.map((id) => m.players.find((p) => p.entrantId === id)!).filter(Boolean) : m.players).map((p, k) => (
                      <li key={p.entrantId} className={m.winner === p.entrantId ? 'winner' : m.winner ? 'out' : ''}>
                        {m.status === 'decided' ? `${k + 1}. ` : ''}
                        {m.winner === p.entrantId ? '🏅 ' : ''}
                        {p.name}
                        {m.standing?.rolls[p.entrantId] && <span className="muted small"> 🎲 {m.standing.rolls[p.entrantId].join(', ')}</span>}
                      </li>
                    ))}
                  </ul>
                  {m.gameId && <button onClick={() => onWatch(m.gameId!)}>👁 Watch</button>}
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
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
