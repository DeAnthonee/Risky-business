import { useEffect, useRef, useState } from 'react';
import type { GameConnection } from '../useGame';
import { getName, setName } from '../session';

/**
 * Game chat. Seated players post under their seat and can whisper to one other player (only the two of
 * them and spectators see it); spectators post under a display name of their choosing (remembered in
 * this browser) and their messages are marked as coming from the crowd.
 */
export function Chat({ conn, canSend, spectator }: { conn: GameConnection; canSend: boolean; spectator: boolean }) {
  const [text, setText] = useState('');
  const [watcherName, setWatcherName] = useState(() => getName());
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const opts = conn.view?.options;
  const spectatorChatOn = opts?.spectatorChat !== false;
  const fog = !!opts?.fogOfWar;
  const canPost = spectator ? spectatorChatOn : canSend;
  const others = spectator ? [] : (conn.view?.players ?? []).filter((p) => !p.isNeutral && p.id !== conn.you);
  const whisperTo = others.find((p) => p.id === to);

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
      await conn.sendChat(t, spectator ? name : undefined, whisperTo?.id);
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
          <div
            key={m.id}
            className={`chat-msg${m.spectator ? ' spectator' : ''}${m.to ? ' whisper' : ''}`}
            // Tap a whisper you received to whisper back.
            onClick={m.to && m.to === conn.you && m.playerId ? () => setTo(m.playerId!) : undefined}
            title={m.to ? (m.to === conn.you ? 'Whisper: tap to whisper back' : 'Whisper: hidden from the other players') : undefined}
          >
            {m.spectator ? (
              <strong className="chat-spectator-name" title="watching">
                👁 {m.name}
              </strong>
            ) : (
              <strong style={{ color: colorOf(m.playerId) }}>{m.name}</strong>
            )}
            {m.to && (
              <span className="whisper-tag">
                {' '}
                🤫 →{' '}
                <strong style={{ color: colorOf(m.to) }}>{m.to === conn.you ? 'you' : m.toName}</strong>
              </span>
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
          {others.length > 0 && (
            <select className="chat-name chat-to" value={whisperTo ? to : ''} onChange={(e) => setTo(e.target.value)} aria-label="Send to">
              <option value="">📢 All</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  🤫 {p.name}
                </option>
              ))}
            </select>
          )}
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={spectator ? 'Cheer, heckle, predict…' : whisperTo ? `Whisper to ${whisperTo.name}…` : 'Say something…'} maxLength={500} />
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
