import { useState } from 'react';
import { api } from '../api';
import { useSpeech } from '../useSpeech';
import './coach-box.css';

const MAX = 280;
const MODE_KEY = 'risk.coachMode';

export type CoachMode = 'box' | 'panel';

/** The coach view's layout: `?coach=panel` in the URL, else the last one used on this browser, else the small box. */
export function initialCoachMode(): CoachMode {
  try {
    if (new URL(window.location.href).searchParams.get('coach') === 'panel') return 'panel';
    return localStorage.getItem(MODE_KEY) === 'panel' ? 'panel' : 'box';
  } catch {
    return 'box';
  }
}

function rememberMode(mode: CoachMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/**
 * The live coach box (quick play): the person whose player key owns a seat in this game sends short notes to their
 * agent. Shown only on the coach's own view of the game, which is the seat's view (fog applied), never the whole board.
 * Two layouts: a small box, and a bigger panel (a bottom sheet on phones) with every note this game. Where the browser
 * has speech-to-text, a mic button puts what you say into the text field for review: it never sends by itself.
 */
export function CoachBox({ gameId, coachKey, seatName, initial }: { gameId: string; coachKey: string; seatName: string; initial: { text: string; at: number }[] }) {
  const [mode, setModeState] = useState<CoachMode>(initialCoachMode);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const speech = useSpeech((heard) => setText((t) => (t ? `${t} ${heard}` : heard).slice(0, MAX)));

  const setMode = (m: CoachMode) => {
    setModeState(m);
    rememberMode(m);
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.sendCoachNote(gameId, coachKey, t);
      setNotes(r.notes);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="coach-toggle small" onClick={() => setOpen(true)}>
        Coach {seatName}
      </button>
    );
  }
  const panel = mode === 'panel';
  const shown = panel ? notes : notes.slice(-5);
  return (
    <aside className={`coach-box${panel ? ' coach-panel' : ''}`} aria-label={`Coach ${seatName}`}>
      <div className="coach-head">
        <strong>Coach {seatName}</strong>
        <div className="coach-head-buttons">
          <button className="small" onClick={() => setMode(panel ? 'box' : 'panel')} aria-label={panel ? 'Make the coach box small' : 'Open the coach panel'}>
            {panel ? 'Smaller' : 'Expand'}
          </button>
          <button className="small" onClick={() => setOpen(false)} aria-label="Hide the coach box">
            Hide
          </button>
        </div>
      </div>
      <p className="muted coach-hint">
        Your agent sees these as advice, not orders. You see the game as your seat does.
        {panel && speech.supported && " Speech-to-text uses your browser's speech service: Chrome and Edge send the audio to their own (Google or Microsoft) servers; this site only gets the text you send."}
      </p>
      <ul className="coach-notes">
        {shown.map((n) => (
          <li key={n.at}>{n.text}</li>
        ))}
        {panel && !notes.length && <li className="muted">No notes yet this game.</li>}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea value={text} maxLength={MAX} rows={panel ? 4 : 2} placeholder="e.g. Hold Australia, then push into Asia" onChange={(e) => setText(e.target.value)} />
        <div className="coach-send">
          <small className="muted">
            {text.length}/{MAX}
          </small>
          <div className="coach-head-buttons">
            {speech.supported && (
              <button type="button" className={`small coach-mic${speech.listening ? ' listening' : ''}`} aria-pressed={speech.listening} onClick={speech.toggle}>
                {speech.listening ? '■ Stop' : '🎤 Speak'}
              </button>
            )}
            <button type="submit" className="primary" disabled={busy || !text.trim()}>
              Send
            </button>
          </div>
        </div>
      </form>
      <p className="coach-sr" aria-live="polite">
        {speech.listening ? 'Listening' : ''}
      </p>
      {(err || speech.error) && (
        <p className="error" role="alert">
          {err ?? speech.error}
        </p>
      )}
    </aside>
  );
}
