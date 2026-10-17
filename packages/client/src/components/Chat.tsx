import { useEffect, useRef, useState } from 'react';
import type { GameConnection } from '../useGame';
import { getName, setName } from '../session';

/**
 * Game chat. Seated players post under their seat; spectators post under a display name of their
 * choosing (remembered in this browser) and their messages are marked as coming from the crowd.
 */
export function Chat({ conn, canSend, spectator }: { conn: GameConnection; canSend: boolean; spectator: boolean }) {
  const [text, setText] = useState('');
  const [watcherName, setWatcherName] = useState(() => getName());
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opts = conn.view?.options;
  const spectatorChatOn = opts?.spectatorChat !== false;
  const fog = !!opts?.fogOfWar;
  const canPost = spectator ? spectatorChatOn : canSend;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [conn.chat.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const name = watcherName.trim();
    if (spectator && !name) {
      setError('Pick a name first');
      return;
    }
    setError(null);
    setText('');
    if (spectator) setName(name);
    try {
      await conn.sendChat(t, spectator ? name : undefined);
    } catch (e) {
      setError((e as Error).message);
      setText(t);
    }
  };

  const colorOf = (pid: string | null) => conn.view?.players.find((p) => p.id === pid)?.color ?? '#aaa';

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {conn.chat.length === 0 && <div className="muted small">No messages yet.</div>}
        {conn.chat.map((m) => (
          <div key={m.id} className={`chat-msg${m.spectator ? ' spectator' : ''}`}>
            {m.spectator ? (
              <strong className="chat-spectator-name" title="watching">
                👁 {m.name}
              </strong>
            ) : (
              <strong style={{ color: colorOf(m.playerId) }}>{m.name}</strong>
            )}{' '}
            {m.message}
          </div>
        ))}
      </div>
      {spectator && !spectatorChatOn && <div className="muted small chat-note">The host turned spectator chat off for this game.</div>}
      {spectator && spectatorChatOn && fog && <div className="muted small chat-note">Fog of war: you see the whole board and every player reads chat. Choose wisely.</div>}
      {canPost && (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {spectator && (
            <input
              className="chat-name"
              value={watcherName}
              onChange={(e) => setWatcherName(e.target.value)}
              placeholder="Your name"
              maxLength={24}
              aria-label="Your name"
            />
          )}
          <div className="row">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={spectator ? 'Cheer, heckle, predict…' : 'Say something…'} maxLength={500} />
            <button type="submit" disabled={!text.trim()}>
              Send
            </button>
          </div>
          {error && <div className="chat-error small">{error}</div>}
        </form>
      )}
    </div>
  );
}
