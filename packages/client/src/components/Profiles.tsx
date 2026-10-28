import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RankingRow } from '@risk/engine';
import type { TournamentStyle } from '../api';
import { API } from '../api';
import { getName, setName } from '../session';

/** Whispering to the player a profile card shows: seated players send from their seat, watchers under a name. */
export interface Whisper {
  send: (message: string, name?: string) => Promise<void>;
  spectator: boolean;
}

function WhisperForm({ to, whisper }: { to: string; whisper: Whisper }) {
  const [text, setText] = useState('');
  const [watcherName, setWatcherName] = useState(() => getName());
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const send = async () => {
    const t = text.trim();
    const name = watcherName.trim();
    if (!t) return;
    if (whisper.spectator && !name) return setError('Pick a name first');
    setError('');
    setSent(false);
    setText('');
    if (whisper.spectator) setName(name);
    try {
      await whisper.send(t, whisper.spectator ? name : undefined);
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
      setText(t);
    }
  };
  return (
    <form className="profile-whisper chat-form" onSubmit={e => { e.preventDefault(); send(); }}>
      <label className="small muted" htmlFor="profile-whisper-text">
        🤫 Whisper to {to}{whisper.spectator ? ' (they and other watchers see it; the other players don\'t)' : ' (only they and spectators see it)'}
      </label>
      {whisper.spectator && <input className="chat-name" value={watcherName} onChange={e => setWatcherName(e.target.value)} placeholder="Your name" maxLength={24} aria-label="Your name" />}
      <div className="row">
        <input id="profile-whisper-text" value={text} onChange={e => { setText(e.target.value); setSent(false); }} placeholder={`Whisper to ${to}…`} maxLength={500} />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </div>
      {error ? <div className="chat-error small" role="alert">{error}</div> : sent && <div className="small muted" role="status">Whispered to {to}.</div>}
    </form>
  );
}

interface ProfileData { stats: RankingRow; profile: string | null }
async function read<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load rankings. Please try again.');
  return res.json() as Promise<T>;
}

function ProfileDialog({ url, name, onClose, whisper, training }: { url: string; name: string; onClose: () => void; whisper?: Whisper; training?: boolean }) {
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
    <dialog ref={dialog} className="profile-dialog p5" aria-labelledby="profile-title" onCancel={onClose} onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div className="profile-header"><h2 id="profile-title">{name}</h2><button autoFocus onClick={onClose} aria-label="Close profile">Close ✕</button></div>
      {error ? <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></p> : !data ? <p role="status">Loading profile…</p> : <>
        <p className="muted">{data.stats.key.startsWith('league/') ? 'League character' : 'Player profile'} · {training ? 'Training leaderboard' : 'All completed ranked games'}</p>
        <dl className="profile-stats">
          <div><dt>Leaderboard rank</dt><dd>{data.stats.rank ? `#${data.stats.rank}` : 'Unranked'}</dd></div>
          <div><dt>Points</dt><dd>{data.stats.points}</dd></div>
          <div><dt>Wins / losses</dt><dd>{data.stats.wins} / {data.stats.losses}</dd></div>
          <div><dt>Average placement</dt><dd>{data.stats.games ? data.stats.avgPlacement.toFixed(2) : '—'}</dd></div>
          <div><dt>Games</dt><dd>{data.stats.games}</dd></div>
          <div><dt>Win rate</dt><dd>{data.stats.games ? `${data.stats.winRate}%` : '—'}</dd></div>
          <div><dt>Kills</dt><dd>{data.stats.kills ?? 0}</dd></div>
        </dl>
        {!!data.stats.kills && <><h3>Eliminated</h3><ul className="profile-victims">
          {Object.entries(data.stats.victims ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, n]) =>
            <li key={key}>{victimName(key)} × {n}</li>)}
        </ul></>}
        {!data.stats.games && <p>No completed games yet.</p>}
        {data.profile && <details><summary>Personality and strategy</summary><div className="profile-bio">{data.profile}</div></details>}
      </>}
      {whisper && <WhisperForm to={name} whisper={whisper} />}
    </dialog>, document.body);
}

/** A ranking key as a readable name: "league/shen" -> "shen", "bot:alice" -> "alice". */
function victimName(key: string): string { return key.slice(Math.max(key.lastIndexOf('/'), key.indexOf(':')) + 1) || key; }

/** Opening the profile does not navigate, disconnect the game, or change spectator fog. */
export function CharacterName({ name, gameId, playerId, profileKey, season, training, whisper }: { name: string; gameId?: string; playerId?: string; profileKey?: string; season?: string; training?: boolean; whisper?: Whisper }) {
  const [open, setOpen] = useState(false);
  const url = profileKey
    ? `${API}/rankings/profile?key=${encodeURIComponent(profileKey)}${training ? '&board=training' : season ? `&season=${encodeURIComponent(season)}` : ''}`
    : `${API}/games/${encodeURIComponent(gameId!)}/players/${encodeURIComponent(playerId!)}/profile`;
  return <><button className="character-name" onClick={e => { e.stopPropagation(); setOpen(true); }}>{name}</button>{open && <ProfileDialog name={name} url={url} whisper={whisper} training={training} onClose={() => setOpen(false)} />}</>;
}

interface SeasonInfo { id: string; season: number; current: boolean; games: number }

/** A row of the tournament leaderboard (GET /rankings?board=tournament&style=...). */
interface TournamentRow { key: string; name: string; rank: number; points: number; tournaments: number; championships: number; finals: number; tablesWon: number; kills: number; bestFinish: string; model?: string }

/** Any board's row: `model` is a Delove's model as the boards show it (D13, D13-S = with search), else absent. */
type BoardRow = RankingRow & { model?: string };

/** The tournament styles, each with its own board (docs/tournaments.md "Tournament styles"). */
const STYLES: { id: TournamentStyle; label: string; note: string }[] = [
  { id: 'classic', label: 'Classic groups', note: 'Groups of 3 to 6 a table.' },
  { id: '1v1', label: '1v1s', note: 'Two seats a table, head to head.' },
  { id: 'survival', label: 'Zerg survival', note: 'Zergs in the field: the last one standing who is not a Zerg moves on.' },
  { id: 'mega', label: 'Mega tourney', note: 'One game of up to 100 players on Mega Earth.' },
];

/** The model tag after a name on the boards: "D13", "D13-S" (with search). */
function ModelTag({ model }: { model?: string }) {
  if (!model) return null;
  return <span className="rank-model" title={`Delove model ${model.replace(/^D/, '').replace(/-S$/, '')}${model.endsWith('-S') ? ' with search' : ''}`}>{model}</span>;
}

/**
 * "Archive season": asks for the season password and a confirmation, then archives the public board's season (the old
 * season stays viewable in the picker). The password goes to the server only, never stored.
 */
function ArchiveSeason({ season, onDone }: { season: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const close = () => { setOpen(false); setPassword(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`${API}/rankings/new-season`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(body.error ?? `Failed (${res.status})`);
      else {
        setMessage(`Season ${body.archived} archived; season ${body.season} has begun.`);
        close();
        onDone();
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
      setPassword('');
    }
  };
  return <span className="archive-season">
    {!open && <button type="button" className="board-toggle" onClick={() => { setOpen(true); setMessage(''); }} title="Archive this season and start a new one (needs the season password)">Archive season</button>}
    {open && <form className="archive-season-form" onSubmit={submit}>
      <p className="small">Archive season {season} and start season {season + 1}? Old seasons stay viewable.</p>
      <input type="password" autoComplete="off" placeholder="Season password" aria-label="Season password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
      <button type="submit" disabled={!password || busy}>{busy ? 'Archiving…' : 'Archive'}</button>
      <button type="button" onClick={close}>Cancel</button>
    </form>}
    {message && <span className="small" role="status"> {message}</span>}
  </span>;
}

export function Leaderboard() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [tournamentRows, setTournamentRows] = useState<TournamentRow[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  // '' is the current season; archived seasons come from /rankings/seasons and never change, so they load once.
  const [season, setSeason] = useState('');
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  // The server allows archiving the season from here (RISK_SEASON_KEY is set); otherwise the button shows disabled.
  const [archiving, setArchiving] = useState(false);
  // Other boards, apart from the public one, no seasons: training (model-vs-model yardstick games, Delove against Claude
  // seats) and tournament (one result per entrant per finished tournament; tournament tables never count publicly).
  const [board, setBoard] = useState<'' | 'training' | 'tournament'>('');
  const training = board === 'training';
  const tournament = board === 'tournament';
  const toggle = (b: 'training' | 'tournament') => setBoard(cur => (cur === b ? '' : b));
  // The tournament board shows one style at a time.
  const [style, setStyle] = useState<TournamentStyle>('classic');
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    const query = board === 'tournament' ? `?board=tournament&style=${style}` : board ? `?board=${board}` : season ? `?season=${encodeURIComponent(season)}` : '';
    const load = () => Promise.all([
      read<{ rankings: RankingRow[] | TournamentRow[] }>(`${API}/rankings${query}`),
      read<{ seasons: SeasonInfo[]; archiving?: boolean }>(`${API}/rankings/seasons`),
    ]).then(([r, s]) => {
      if (!alive) return;
      if (board === 'tournament') setTournamentRows(r.rankings as TournamentRow[]);
      else setRows(r.rankings as BoardRow[]);
      setSeasons(s.seasons); setArchiving(!!s.archiving); setLoaded(true); setError('');
    }).catch(e => { if (alive) setError(e.message); });
    void load();
    const timer = season && !board ? undefined : setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [retry, season, board, style]);
  const shown = tournament ? tournamentRows : rows;
  const current = seasons.find(s => s.current);
  return <section className="board leaderboard" aria-labelledby="leaderboard-title">
    <div className="board-head"><h2 id="leaderboard-title">{training ? 'Training board' : tournament ? 'Tournament board' : 'Leaderboard'}</h2>
      <div className="board-controls">
        {seasons.length > 1 && !board && <label className="board-season">Season{' '}
          <select value={season} onChange={e => setSeason(e.target.value)}>
            <option value="">{current ? `${current.season} (current)` : 'Current'}</option>
            {seasons.filter(s => !s.current).map(s => <option key={s.id} value={s.id}>{s.id} ({s.games} games)</option>)}
          </select>
        </label>}
        {!board && current && (archiving
          ? <ArchiveSeason season={current.season} onDone={() => { setSeason(''); setRetry(n => n + 1); }} />
          : <button type="button" className="board-toggle" disabled title="Archiving seasons from the site is off on this server (its host has not set a season password)">Archive season</button>)}
        <button type="button" className={`board-toggle${training ? ' on' : ''}`} aria-pressed={training} onClick={() => toggle('training')}
          title="Model-vs-model yardstick games, ranked apart from the public leaderboard">Training</button>
        <button type="button" className={`board-toggle${tournament ? ' on' : ''}`} aria-pressed={tournament} onClick={() => toggle('tournament')}
          title="Tournament results, ranked apart from the public leaderboard">Tournament</button>
      </div>
    </div>
    {training && <p className="small muted board-note">Yardstick games between AI models (e.g. Delove against Claude seats), ranked by seat name. They never count on the public leaderboard.</p>}
    {tournament && <div className="board-styles" role="group" aria-label="Tournament style">
      {STYLES.map(s => <button key={s.id} type="button" className={`board-toggle${style === s.id ? ' on' : ''}`} aria-pressed={style === s.id} onClick={() => setStyle(s.id)} title={s.note}>{s.label}</button>)}
    </div>}
    {tournament && <p className="small muted board-note">{STYLES.find(s => s.id === style)!.note} One result per player per finished tournament. Tournament tables never count on the public leaderboard.</p>}
    {error && <p role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
    {!loaded && !error && <p role="status">Loading leaderboard…</p>}
    {loaded && !shown.length && <p className="board-empty">{training ? 'No training games yet.' : tournament ? `No finished ${STYLES.find(s => s.id === style)!.label} tournaments yet.` : season ? 'No games were ranked in this season.' : 'No completed games yet this season. The first finished game starts the standings.'}</p>}
    {tournament && !!tournamentRows.length && <ol className="ranks">
      {tournamentRows.map(r => <li key={r.key} className={`rank-row${r.rank <= 3 ? ` podium podium-${r.rank}` : ''}`}>
        <span className="rank-num" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
        <span className="rank-name">{r.name}<ModelTag model={r.model} /></span>
        <span className="rank-points"><strong>{r.points}</strong> pts</span>
        <span className="rank-stats">
          <span title="Tournaments played">{r.tournaments} played</span>
          <span title="Championships">🏆 {r.championships}</span>
          <span title="Finals reached">{r.finals} finals</span>
          <span title="Tables won">{r.tablesWon} tables</span>
          <span title="Players eliminated">{r.kills} kills</span>
          <span title="Best finish">best: {r.bestFinish}</span>
        </span>
      </li>)}
    </ol>}
    {!tournament && !!rows.length && <ol className="ranks">
      {rows.map(r => <li key={r.key} className={`rank-row${r.rank <= 3 ? ` podium podium-${r.rank}` : ''}`}>
        <span className="rank-num" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
        <span className="rank-name"><CharacterName name={r.name} profileKey={r.key} season={season || undefined} training={training} /><ModelTag model={r.model} /></span>
        <span className="rank-points"><strong>{r.points}</strong> pts</span>
        <span className="rank-stats">
          <span title="Wins and losses">{r.wins}–{r.losses}</span>
          <span title="Win rate">{r.winRate}% wins</span>
          <span title="Average placement">avg {r.avgPlacement.toFixed(2)}</span>
          <span title="Players eliminated">{r.kills ?? 0} kills</span>
        </span>
      </li>)}
    </ol>}
    <details className="rank-rules"><summary>How points work</summary>
      {tournament
        ? <p>Per tournament: 3 points for each round you survive before the final; in the final, 3 per earlier round plus 2 for each finalist you finish above, and +6 for the champion. Plus 2 for each table you win (1 if it was decided on standing) and 1 for each player you eliminate.</p>
        : <p>Placement points plus 1 for each player you eliminate. Everyone starts at 0 and never drops below it. In a six-player game the places score +3, +2, +1, −1, −2, −3; scores scale with lobby size.</p>}
    </details>
  </section>;
}
