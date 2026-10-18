import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RankingRow } from '@risk/engine';
import { API } from '../api';

interface ProfileData { stats: RankingRow; profile: string | null }
async function read<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load rankings. Please try again.');
  return res.json() as Promise<T>;
}

function ProfileDialog({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setError('');
    read<ProfileData>(url).then(v => { if (active) setData(v); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [url, retry]);
  return createPortal(
    <dialog ref={dialog} className="profile-dialog" aria-labelledby="profile-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="profile-header"><h2 id="profile-title">{name}</h2><button autoFocus onClick={onClose} aria-label="Close profile">Close ✕</button></div>
      {error ? <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></p> : !data ? <p role="status">Loading profile…</p> : <>
        <p className="muted">{data.stats.key.startsWith('league/') ? 'League character' : 'Player profile'} · All completed ranked games</p>
        <dl className="profile-stats">
          <div><dt>Leaderboard rank</dt><dd>{data.stats.rank ? `#${data.stats.rank}` : 'Unranked'}</dd></div>
          <div><dt>Points</dt><dd>{data.stats.points}</dd></div>
          <div><dt>Wins / losses</dt><dd>{data.stats.wins} / {data.stats.losses}</dd></div>
          <div><dt>Average placement</dt><dd>{data.stats.games ? data.stats.avgPlacement.toFixed(2) : '—'}</dd></div>
          <div><dt>Games</dt><dd>{data.stats.games}</dd></div>
          <div><dt>Win rate</dt><dd>{data.stats.games ? `${data.stats.winRate}%` : '—'}</dd></div>
        </dl>
        {!data.stats.games && <p>No completed games yet.</p>}
        {data.profile && <details><summary>Personality and strategy</summary><div className="profile-bio">{data.profile}</div></details>}
      </>}
    </dialog>, document.body);
}

/** Opening the profile does not navigate, disconnect the game, or change spectator fog. */
export function CharacterName({ name, gameId, playerId, profileKey }: { name: string; gameId?: string; playerId?: string; profileKey?: string }) {
  const [open, setOpen] = useState(false);
  const url = profileKey ? `${API}/rankings/profile?key=${encodeURIComponent(profileKey)}` : `${API}/games/${encodeURIComponent(gameId!)}/players/${encodeURIComponent(playerId!)}/profile`;
  return <><button className="character-name" onClick={e => { e.stopPropagation(); setOpen(true); }}>{name}</button>{open && <ProfileDialog name={name} url={url} onClose={() => setOpen(false)} />}</>;
}

export function Leaderboard() {
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => read<{ rankings: RankingRow[] }>(`${API}/rankings`).then(r => { if (alive) { setRows(r.rankings); setLoaded(true); setError(''); } }).catch(e => { if (alive) setError(e.message); });
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [retry]);
  return <section className="card leaderboard">
    <h2>Leaderboard</h2>
    <p className="muted small">Placement points · Start at 0, never below 0. Six players: +3, +2, +1, −1, −2, −3. Scores scale with lobby size.</p>
    {error && <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
    {!loaded && !error && <p role="status">Loading leaderboard…</p>}
    {loaded && !rows.length && <p>No completed games yet. The first finished game starts the standings.</p>}
    {!!rows.length && <div className="leaderboard-scroll"><table><thead><tr><th>Rank</th><th>Character / player</th><th>Points</th><th>W–L</th><th>Avg. place</th><th>Win %</th></tr></thead><tbody>
      {rows.map(r => <tr key={r.key}><td>#{r.rank}</td><td><CharacterName name={r.name} profileKey={r.key} /></td><td>{r.points}</td><td>{r.wins}–{r.losses}</td><td>{r.avgPlacement.toFixed(2)}</td><td>{r.winRate}%</td></tr>)}
    </tbody></table></div>}
  </section>;
}
