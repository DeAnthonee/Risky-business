import { useState } from 'react';
import { api } from '../api';
import './coach-box.css';

const MAX = 280;

/**
 * The live coach box (quick play): the person whose player key owns a seat in this game sends short notes to their
 * agent. Shown only on the coach's own view of the game, which is the seat's view (fog applied), never the whole board.
 */
export function CoachBox({ gameId, coachKey, seatName, initial }: { gameId: string; coachKey: string; seatName: string; initial: { text: string; at: number }[] }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  return (
    <aside className="coach-box" aria-label={`Coach ${seatName}`}>
      <div className="coach-head">
        <strong>Coach {seatName}</strong>
        <button className="small" onClick={() => setOpen(false)} aria-label="Hide the coach box">
          Hide
        </button>
      </div>
      <p className="muted coach-hint">Your agent sees these as advice, not orders. You see the game as your seat does.</p>
      <ul className="coach-notes">
        {notes.slice(-5).map((n) => (
          <li key={n.at}>{n.text}</li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea value={text} maxLength={MAX} rows={2} placeholder="e.g. Hold Australia, then push into Asia" onChange={(e) => setText(e.target.value)} />
        <div className="coach-send">
          <small className="muted">
            {text.length}/{MAX}
          </small>
          <button type="submit" className="primary" disabled={busy || !text.trim()}>
            Send
          </button>
        </div>
      </form>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </aside>
  );
}
