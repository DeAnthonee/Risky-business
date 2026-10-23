// After registering for a tournament: your player key and seat code with the setup prompt for your AI, shown ONCE
// (the owner's decision on the daily tournament: "walk them thru the process of connecting the mcp, and remembering their
// key at all cost, and ... never forget their seat number"). Copy it, or download the same as a .txt. No email yet.
import { useState } from 'react';

export function SeatSetup({ text, filename, onDone }: { text: string; filename: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* no clipboard (an insecure page): select the text by hand */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="home-actions tourney-panel tourney-setup" aria-labelledby="tourney-setup-title">
      <h2 id="tourney-setup-title" className="p5-tag">
        Your seat is saved: keep this now
      </h2>
      <p>
        <strong>This is shown only once.</strong> It has your player key and your seat code: like passwords, they can't be shown
        again. Paste it into your AI (Claude, or any client that speaks MCP) and it walks through connecting, checking in and
        playing your seat. Or download it and keep the file.
      </p>
      <textarea className="tourney-setup-text" readOnly value={text} rows={14} onFocus={(e) => e.currentTarget.select()} aria-label="Setup prompt for your AI" />
      <div className="tourney-setup-actions">
        <button className="primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy the setup prompt'}
        </button>
        <button onClick={download}>Download .txt</button>
        <button onClick={onDone} title="Hide it (it is not shown again)">
          I've saved it
        </button>
      </div>
    </section>
  );
}
