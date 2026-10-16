import { useState } from 'react';
import { api } from '../api';
import type { Session } from '../session';
import type { GameConnection } from '../useGame';
import { OptionsForm } from './Home';
import { Chat } from './Chat';

export function Lobby({ conn, gameId, session, onLeave }: { conn: GameConnection; gameId: string; session: Session | null; onLeave: () => void }) {
  const view = conn.view!;
  const isHost = !!session && conn.host === session.playerId;
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
          </button>
        </p>
        {!conn.connected && <p className="error">Reconnecting…</p>}

        <h2>
          Players ({view.players.length}/{view.options.maxPlayers})
        </h2>
        <ul className="players">
          {view.players.map((p) => (
            <li key={p.id}>
              <span className="swatch" style={{ background: p.color }} />
              <span>
                {p.name} {p.isBot && '🤖'} {p.id === conn.host && '👑'} {p.id === session?.playerId && <em>(you)</em>}
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
