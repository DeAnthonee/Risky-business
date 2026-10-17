import { useState } from 'react';
import { api } from '../api';
import type { Session } from '../session';
import type { GameConnection } from '../useGame';
import { spectateLink } from '../session';
import { OptionsForm } from './Home';
import { Chat } from './Chat';

export function Lobby({ conn, gameId, session, onLeave, onJoin }: { conn: GameConnection; gameId: string; session: Session | null; onLeave: () => void; onJoin?: () => void }) {
  const view = conn.view!;
  const isHost = !!session && conn.host === session.playerId;
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const me = view.players.find((p) => p.id === session?.playerId);
  const [newName, setNewName] = useState(me?.name ?? '');
  const saveName = async () => {
    if (!session) return;
    const n = newName.trim();
    if (!n || n === me?.name) return setEditing(false);
    await run(async () => {
      await api.rename(gameId, session.token, n);
      setEditing(false);
    });
  };
  const link = `${window.location.origin}${window.location.pathname}?game=${gameId}`;

  const run = (fn: () => Promise<unknown>) =>
    fn().catch((e) => setErr((e as Error).message));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const leave = async () => {
    if (session) await api.leave(gameId, session.token).catch(() => {});
    onLeave();
  };

  return (
    <div className="center">
      <div className="card lobby">
        <h1>{conn.name}</h1>
        <p className="muted">
          Join code <code className="code">{gameId}</code>{' '}
          <button className="small" onClick={copy}>
            {copied ? 'Copied!' : 'Copy invite link'}
          </button>{' '}
          <button className="small" onClick={() => navigator.clipboard?.writeText(spectateLink(gameId)).catch(() => {})} title="Link that opens the game as a spectator">
            Copy watch link
          </button>
        </p>
        {!conn.connected && <p className="error">Reconnecting…</p>}
        {!session && (
          <p className="spectate-note">
            👁 You are watching this lobby{conn.presence.spectators > 1 ? ` with ${conn.presence.spectators - 1} other${conn.presence.spectators > 2 ? 's' : ''}` : ''}.{' '}
            {view.players.length < view.options.maxPlayers && onJoin && (
              <button className="small primary" onClick={onJoin}>
                Join this game
              </button>
            )}
          </p>
        )}

        <h2>
          Players ({view.players.length}/{view.options.maxPlayers})
        </h2>
        <ul className="players">
          {view.players.map((p) => (
            <li key={p.id}>
              <span className="swatch" style={{ background: p.color }} />
              <span>
                {p.id === session?.playerId && editing ? (
                  <form
                    className="row inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveName();
                    }}
                  >
                    <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={24} style={{ width: 160 }} />
                    <button type="submit" className="small primary">
                      Save
                    </button>
                    <button type="button" className="small" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    {p.name} {p.isBot && '🤖'} {p.id === conn.host && '👑'}{' '}
                    {p.id === session?.playerId && (
                      <>
                        <em>(you)</em>{' '}
                        <button
                          className="small link"
                          onClick={() => {
                            setNewName(p.name);
                            setEditing(true);
                          }}
                        >
                          rename
                        </button>
                      </>
                    )}
                  </>
                )}
                {!p.isBot && <span className={`online-dot ${conn.presence.online.includes(p.id) ? 'on' : ''}`} title={conn.presence.online.includes(p.id) ? 'online' : 'offline'} />}
              </span>
              {isHost && p.id !== session?.playerId && (
                <button className="small" onClick={() => run(() => api.kick(gameId, session!.token, p.id))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        <h2>Options</h2>
        <OptionsForm options={view.options} disabled={!isHost} onChange={(o) => isHost && run(() => api.setOptions(gameId, session!.token, o))} />

        {err && <p className="error">{err}</p>}
        <div className="row">
          {isHost && (
            <>
              <button disabled={view.players.length >= view.options.maxPlayers} onClick={() => run(() => api.addBot(gameId, session!.token))}>
                Add bot
              </button>
              <button className="primary" disabled={view.players.length < 2} onClick={() => run(() => api.start(gameId, session!.token))}>
                Start game
              </button>
              <button className="danger" onClick={() => confirm('Close this room for everyone?') && run(() => api.closeGame(gameId, session!.token))}>
                Close room
              </button>
            </>
          )}
          {!isHost && <span className="muted">Waiting for the host to start…</span>}
          <button onClick={leave}>Leave</button>
        </div>
        <Chat conn={conn} canSend={!!session} />
      </div>
    </div>
  );
}
