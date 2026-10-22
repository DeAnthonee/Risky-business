import { useState } from 'react';

/**
 * The host's Start now, with the seat count live beside it. When seats are still empty, or Delove seats were asked for
 * and have not all joined, a click asks first ("Only J of M seats are filled... Start anyway?"), so a tournament is not
 * started by mistake before the seat pool has joined (the owner's T6VDUN ran without its 50 Delove seats).
 */
export function StartButton({
  joined,
  max,
  deloveAsked,
  deloveJoined,
  busy,
  onStart,
}: {
  joined: number;
  max: number;
  deloveAsked: number;
  deloveJoined: number;
  busy: boolean;
  onStart: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const short = joined < max || deloveJoined < deloveAsked;
  if (asking)
    return (
      <div className="start-confirm" role="alertdialog" aria-label="Start with seats empty?">
        <p>
          Only {joined} of {max} seats are filled
          {deloveAsked > 0 ? ` (Delove requested ${deloveAsked}, joined ${deloveJoined})` : ''}. Start anyway? Empty seats are planned around (Zergs
          take unfilled Delove seats).
        </p>
        <div className="row">
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setAsking(false);
              onStart();
            }}
          >
            Start anyway
          </button>
          <button onClick={() => setAsking(false)}>Wait</button>
        </div>
      </div>
    );
  return (
    <div className="row start-row">
      <button className="primary" disabled={busy} onClick={() => (short ? setAsking(true) : onStart())}>
        Start now
      </button>
      <span className="muted start-seats" aria-live="polite">
        Seats: {joined} / {max}
        {deloveAsked > 0 ? ` · Delove ${deloveJoined} / ${deloveAsked}` : ''}
      </span>
    </div>
  );
}
