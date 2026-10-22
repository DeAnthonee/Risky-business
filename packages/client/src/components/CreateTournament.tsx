import { useEffect, useState } from 'react';
import { MAP_IDS, getMap } from '@risk/engine';
import { api, type HostEntrantsView, type TournamentPreview } from '../api';
import { saveHostToken } from '../session';
import { HostEntrants } from './HostEntrants';
import { StartButton } from './StartButton';
import './create-tournament.css';

/** Boards that can hold a final: 6+ seats with a region per seat (the server checks too). */
const FINAL_MAPS = MAP_IDS.filter((id) => Math.min(getMap(id).maxPlayers, getMap(id).continents.length) >= 6);

interface Form {
  name: string;
  zergs: number;
  delove: number;
  open: number;
  roundMinutes: number;
  finalMap: string;
  /** Per-move turn timer in seconds; 0 = off. */
  timer: number;
  capitals: boolean;
  fog: boolean;
  code: string;
}

const START: Form = { name: '', zergs: 20, delove: 0, open: 12, roundMinutes: 15, finalMap: '', timer: 90, capitals: true, fog: false, code: '' };

/** The request both the preview and create send (nested format; unset settings keep the server's tournament defaults). */
function specOf(f: Form) {
  return {
    format: 'nested' as const,
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    zergs: f.zergs,
    delove: f.delove,
    open: f.open,
    roundMinutes: f.roundMinutes,
    ...(f.finalMap ? { finalMap: f.finalMap } : {}),
    options: {
      capitals: f.capitals,
      fogOfWar: f.fog,
      ...(f.timer > 0 ? { turnTimer: 'move' as const, turnTimerSeconds: f.timer } : { turnTimer: 'off' as const }),
    },
  };
}

/**
 * "Create tournament": seat counts (Zergs, Delove seats, open spots) and settings, with the breakdown from
 * POST /api/tournaments/preview updated as you type, then create (and start) it. The access code goes with the create.
 */
export function CreateTournament({ onOpen, onBack }: { onOpen: (id: string) => void; onBack: () => void }) {
  const [form, setForm] = useState<Form>(START);
  const [preview, setPreview] = useState<TournamentPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; hostToken: string; started: boolean; maxEntrants: number; delove: number } | null>(null);
  // Who joined so far (HostEntrants shares its live view), for the seat count and the confirm beside Start now.
  const [hostView, setHostView] = useState<HostEntrantsView | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  // The breakdown follows the form, a moment after the last change (the preview is rate-limited per client).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .previewTournament(specOf(form))
        .then((r) => {
          if (!alive) return;
          setPreview(r.preview);
          setPreviewErr(null);
        })
        .catch((e) => {
          if (!alive) return;
          setPreview(null);
          setPreviewErr((e as Error).message);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // The code does not change the plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.name, form.zergs, form.delove, form.open, form.roundMinutes, form.finalMap, form.timer, form.capitals, form.fog]);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createTournament({ ...specOf(form), ...(form.code.trim() ? { code: form.code.trim() } : {}) });
      saveHostToken(r.tournament.id, r.hostToken);
      setCreated({ id: r.tournament.id, hostToken: r.hostToken, started: false, maxEntrants: r.tournament.maxEntrants, delove: r.tournament.requested?.delove ?? form.delove });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!created) return;
    setBusy(true);
    setErr(null);
    try {
      await api.startTournament(created.id, created.hostToken);
      setCreated({ ...created, started: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = (key: 'zergs' | 'delove' | 'open', label: string, hint: string) => (
    <label className="ct-count">
      <span>{label}</span>
      <input type="number" min={0} max={256} value={form[key]} onChange={(e) => set(key, Math.max(0, Math.min(256, Math.floor(Number(e.target.value) || 0))))} />
      <small className="muted">{hint}</small>
    </label>
  );

  if (created) {
    return (
      <div className="home p5 tournament-page create-tournament">
        <TopBar onBack={onBack} />
        <section className="home-actions" aria-live="polite">
          <h2 className="p5-tag">
            Tournament {created.id} {created.started ? 'started' : 'created'}
          </h2>
          <p>
            Share the code <strong>{created.id}</strong>: people join on the site, agents with <code>join_tournament</code>.{' '}
            {created.started ? 'Round 1 is being seated.' : 'Start it when everyone is in; empty open spots are planned around at the start.'}
          </p>
          <p className="muted">This browser keeps the host token, so you can start it from here. Keep it private.</p>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          {!created.started && (
            <StartButton
              joined={hostView?.entrants.length ?? 0}
              max={hostView?.maxEntrants ?? created.maxEntrants}
              deloveAsked={created.delove}
              deloveJoined={hostView?.counts.delove ?? 0}
              busy={busy}
              onStart={() => void start()}
            />
          )}
          <div className="row">
            <button className="watch" onClick={() => onOpen(created.id)}>
              Open the bracket
            </button>
            <button onClick={onBack}>Back to games</button>
          </div>
        </section>
        <HostEntrants id={created.id} hostToken={created.hostToken} onView={setHostView} />
      </div>
    );
  }

  const seats = form.zergs + form.delove + form.open;
  return (
    <div className="home p5 tournament-page create-tournament">
      <TopBar onBack={onBack} />
      <div className="ct-layout">
        <section className="home-actions" aria-label="Create tournament">
          <h2 className="p5-tag">Create tournament</h2>
          <form
            className="options"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
          <label className="ct-name">
            Name
            <input value={form.name} maxLength={60} placeholder="e.g. Friday Inception Cup" onChange={(e) => set('name', e.target.value)} />
          </label>
          <fieldset className="options-group">
            <legend>Seats ({seats})</legend>
            <div className="options-fields">
              {count('zergs', 'Zergs', 'rushing house bots, added now')}
              {count('delove', 'Delove seats', 'the Delove seat pool fills them; Zergs take any left at the start')}
              {count('open', 'Open spots', 'for people and agents to join')}
            </div>
          </fieldset>
          <fieldset className="options-group">
            <legend>Settings</legend>
            <div className="options-fields">
              <label>
                Round deadline (minutes)
                <input type="number" min={1} max={240} value={form.roundMinutes} onChange={(e) => set('roundMinutes', Math.max(1, Math.min(240, Math.floor(Number(e.target.value) || 1))))} />
              </label>
              <label>
                Turn timer
                <select value={form.timer} onChange={(e) => set('timer', Number(e.target.value))}>
                  {[30, 60, 90, 120, 180].map((s) => (
                    <option key={s} value={s}>
                      {s} s per move
                    </option>
                  ))}
                  <option value={0}>off</option>
                </select>
              </label>
              <label>
                Final board
                <select value={form.finalMap} onChange={(e) => set('finalMap', e.target.value)}>
                  <option value="">a generated board</option>
                  {FINAL_MAPS.map((id) => (
                    <option key={id} value={id}>
                      {getMap(id).name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ct-check">
                <input type="checkbox" checked={form.capitals} onChange={(e) => set('capitals', e.target.checked)} /> Capital Conquest
              </label>
              <label className="ct-check">
                <input type="checkbox" checked={form.fog} onChange={(e) => set('fog', e.target.checked)} /> Fog of war
              </label>
            </div>
          </fieldset>
          <label className="ct-code">
            Access code
            <input value={form.code} autoComplete="off" spellCheck={false} placeholder="from the site owner" onChange={(e) => set('code', e.target.value)} />
          </label>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || !preview}>
            Create tournament
          </button>
          </form>
        </section>

        <section className="board ct-breakdown" aria-live="polite" aria-label="Breakdown">
          <div className="board-head">
            <h2>Breakdown</h2>
            {preview && (
              <span className="board-count">
                <span>{preview.seats + preview.plannerZergs}</span> seats
              </span>
            )}
          </div>
          {previewErr && <p className="error">{previewErr}</p>}
          {!preview && !previewErr && (
            <div className="board-empty">
              <p>Planning…</p>
            </div>
          )}
          {preview && (
            <ul className="tickets">
              {preview.seatsPerRound.map((r, i) => (
                <li key={i} className="ticket">
                  <span className="ticket-stamp">{i === preview.rounds - 1 ? 'Final' : `Round ${i + 1}`}</span>
                  <span>
                    {i === preview.rounds - 1
                      ? `${preview.finalists} finalists on ${preview.finalBoard.generated ? `a generated board (${preview.finalBoard.territories} territories)` : preview.finalBoard.name}`
                      : `${r.length} tables of ${[...new Set(r)].join('–')}`}
                    {i === 0 &&
                      ` · ${preview.firstRound.filter((t) => t.people > 0).length} with people, Zergs per table ${Math.min(...preview.firstRound.map((t) => t.zergs))}–${Math.max(...preview.firstRound.map((t) => t.zergs))}${preview.plannerZergs ? ` (+${preview.plannerZergs} added to fit)` : ''}`}
                  </span>
                </li>
              ))}
              <li className="ticket">
                <span className="ticket-stamp">Time</span>
                <span>
                  about {preview.minutes.low}–{preview.minutes.high} min ({preview.minutes.perRound} min per round at most
                  {preview.timer ? `, ${preview.timer.seconds} s per ${preview.timer.mode}` : ', no turn timer'})
                </span>
              </li>
            </ul>
          )}
          {preview?.warnings.map((w) => (
            <p key={w} className="board-note">
              {w}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}

/** The tournament page's header (#251): back to games, the title, a tag line. */
function TopBar({ onBack }: { onBack: () => void }) {
  return (
    <header className="tourney-top">
      <div className="tourney-bar">
        <button className="small" onClick={onBack}>
          ← Back to games
        </button>
      </div>
      <h1 className="tourney-title">
        <span>Host a tournament</span>
      </h1>
      <p className="home-tag">Pick the seats and settings: the breakdown shows the bracket before anything is created.</p>
    </header>
  );
}
