import { useEffect, useRef, useState } from 'react';
import type { GameConnection } from '../useGame';

export function Chat({ conn, canSend }: { conn: GameConnection; canSend: boolean }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conn.chat.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await conn.sendChat(t).catch(() => {});
  };

  const colorOf = (pid: string | null) => conn.view?.players.find((p) => p.id === pid)?.color ?? '#aaa';

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {conn.chat.length === 0 && <div className="muted small">No messages yet.</div>}
        {conn.chat.map((m) => (
          <div key={m.id} className="chat-msg">
            <strong style={{ color: colorOf(m.playerId) }}>{m.name}</strong> {m.message}
          </div>
        ))}
      </div>
      {canSend && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something…" maxLength={500} />
          <button type="submit" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
