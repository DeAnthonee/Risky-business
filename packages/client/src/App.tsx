import { useEffect, useState } from 'react';
import { api } from './api';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';
import { Game } from './components/Game';
import { clearSession, gameIdFromUrl, getName, getSession, saveSession, setGameInUrl, setName as persistName, spectateFromUrl, type Session } from './session';
import { useGame } from './useGame';

export function App() {
  const [gameId, setGameId] = useState<string | null>(() => gameIdFromUrl());
  const [session, setSession] = useState<Session | null>(() => (gameId ? getSession(gameId) : null));
  // ?spectate=1 opens a game as a spectator even when a session exists for it.
  const [spectating, setSpectating] = useState(() => !!gameId && spectateFromUrl());
  const [name, setNameState] = useState(getName());

  useEffect(() => {
    setGameInUrl(gameId, spectating);
  }, [gameId, spectating]);

  const setName = (n: string) => {
    setNameState(n);
    persistName(n);
  };

  const enter = (s: Session) => {
    saveSession(s);
    setSession(s);
    setGameId(s.gameId);
    setSpectating(false);
  };

  const leaveToHome = () => {
    if (session) clearSession(session.gameId);
    setSession(null);
    setGameId(null);
    setSpectating(false);
  };

  if (!gameId) {
    return <Home name={name} setName={setName} onEnter={enter} onSpectate={(id) => { setGameId(id); setSpectating(true); }} />;
  }

  if (spectating) {
    return <Connected gameId={gameId} session={null} spectating onLeave={leaveToHome} onJoin={() => setSpectating(false)} />;
  }

  if (!session) {
    return (
      <JoinPrompt
        gameId={gameId}
        name={name}
        setName={setName}
        onJoined={enter}
        onSpectate={() => setSpectating(true)}
        onBack={leaveToHome}
      />
    );
  }

  return <Connected gameId={gameId} session={session} onLeave={leaveToHome} />;
}

function Connected({
  gameId,
  session,
  spectating = false,
  onLeave,
  onJoin,
}: {
  gameId: string;
  session: Session | null;
  spectating?: boolean;
  onLeave: () => void;
  onJoin?: () => void;
}) {
  const conn = useGame(gameId, spectating ? undefined : session?.token);
  if (conn.closedReason) {
    const why: Record<string, string> = {
      host: 'The host closed this room.',
      admin: 'This room was removed by the site admin.',
      idle: 'This room was cleaned up after being idle.',
      empty: 'Everyone left this room.',
      gone: 'This room no longer exists.',
    };
    return (
      <div className="center">
        <div className="card">
          <h2>Room {gameId} is closed</h2>
          <p className="muted">{why[conn.closedReason] ?? 'This room is no longer available.'}</p>
          <button className="primary" onClick={onLeave}>
            Back to games
          </button>
        </div>
      </div>
    );
  }
  if (!conn.view) {
    return (
      <div className="center">
        <div className="card">
          <h2>Connecting to game {gameId}…</h2>
          {!conn.connected && <p className="muted">Waiting for the server. If this never resolves the game may no longer exist.</p>}
          <button onClick={onLeave}>Back</button>
        </div>
      </div>
    );
  }
  if (conn.view.phase === 'lobby') return <Lobby conn={conn} gameId={gameId} session={spectating ? null : session} onLeave={onLeave} onJoin={onJoin} />;
  return <Game conn={conn} gameId={gameId} session={spectating ? null : session} onLeave={onLeave} onJoin={onJoin} />;
}

function JoinPrompt({
  gameId,
  name,
  setName,
  onJoined,
  onSpectate,
  onBack,
}: {
  gameId: string;
  name: string;
  setName: (n: string) => void;
  onJoined: (s: Session) => void;
  onSpectate: () => void;
  onBack: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ name: string; phase: string; players: number } | null>(null);

  useEffect(() => {
    api
      .getGame(gameId)
      .then((g) => setInfo({ name: g.name, phase: g.state.phase, players: g.state.players.length }))
      .catch((e) => setErr(e.message));
  }, [gameId]);

  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.joinGame(gameId, name || 'Player');
      onJoined({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card">
        <h1>Join game {gameId}</h1>
        {info && (
          <p className="muted">
            {info.name} · {info.players} player{info.players === 1 ? '' : 's'} · {info.phase}
          </p>
        )}
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Commander" maxLength={24} autoFocus />
        </label>
        {err && <p className="error">{err}</p>}
        <div className="row">
          <button className="primary" disabled={busy || info?.phase !== 'lobby'} onClick={join}>
            Join
          </button>
          <button onClick={onSpectate}>Spectate</button>
          <button onClick={onBack}>Back</button>
        </div>
        {info && info.phase !== 'lobby' && <p className="muted">This game has already started; you can spectate.</p>}
      </div>
    </div>
  );
}
