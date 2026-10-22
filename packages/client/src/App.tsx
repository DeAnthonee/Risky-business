import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Home } from './components/Home';
import { Lobby } from './components/Lobby';
import { Game } from './components/Game';
import { AutoAdvance, isGenerationGame, useLiveGame, type AutoSpectate } from './components/AutoAdvance';
import { Tournament } from './components/Tournament';
import { CreateTournament } from './components/CreateTournament';
import {
  clearSession,
  gameIdFromUrl,
  getName,
  hostFormFromUrl,
  getSession,
  saveSession,
  setGameInUrl,
  setName as persistName,
  setHostFormInUrl,
  setTournamentInUrl,
  spectateFromUrl,
  tournamentIdFromUrl,
  type Session,
} from './session';
import { useGame } from './useGame';

export function App() {
  const [gameId, setGameId] = useState<string | null>(() => gameIdFromUrl());
  const [session, setSession] = useState<Session | null>(() => (gameId ? getSession(gameId) : null));
  // ?spectate=1 opens a game as a spectator even when a session exists for it.
  const [spectating, setSpectating] = useState(() => !!gameId && spectateFromUrl());
  // ?spectate=1 without a game is the opt-in auto-spectate live stream: watch a live game, then move on to the next.
  // Only this mode ever moves the viewer; a game opened on purpose (link, list, tournament bracket) stays put.
  const [autoSpectate, setAutoSpectate] = useState(() => !gameId && spectateFromUrl());
  const [name, setNameState] = useState(getName());
  // The tournament being followed: leaving one of its games comes back to its bracket.
  const [tournamentId, setTournamentId] = useState<string | null>(() => tournamentIdFromUrl());
  // ?host=1: the Create tournament form (links to it come from the home page).
  const [hosting, setHosting] = useState(() => hostFormFromUrl());

  useEffect(() => {
    // The stream keeps its URL (`?spectate=1`), so a reload tunes back into whatever is live.
    if (autoSpectate) setGameInUrl(null, true);
    else setGameInUrl(gameId, spectating);
  }, [gameId, spectating, autoSpectate]);
  useEffect(() => {
    setTournamentInUrl(tournamentId);
  }, [tournamentId]);
  useEffect(() => {
    setHostFormInUrl(hosting);
  }, [hosting]);

  const firstLive = useLiveGame(autoSpectate && !gameId, null);
  useEffect(() => {
    if (autoSpectate && !gameId && firstLive) setGameId(firstLive.id);
  }, [autoSpectate, gameId, firstLive]);

  const setName = (n: string) => {
    setNameState(n);
    persistName(n);
  };

  const enter = (s: Session) => {
    saveSession(s);
    setSession(s);
    setGameId(s.gameId);
    setSpectating(false);
    setAutoSpectate(false);
  };

  const leaveToHome = () => {
    if (session) clearSession(session.gameId);
    setSession(null);
    setGameId(null);
    setSpectating(false);
    setAutoSpectate(false);
  };

  const watch = (id: string) => {
    setGameId(id);
    setSpectating(true);
    setAutoSpectate(false);
  };

  const startAutoSpectate = () => {
    setGameId(null);
    setSpectating(true);
    setAutoSpectate(true);
  };

  // Stable, so the countdown's effects do not restart on every render. Staying ends auto-spectate for good.
  const auto = useMemo<AutoSpectate>(() => ({ advance: (id) => setGameId(id), stay: () => setAutoSpectate(false) }), []);

  if (!gameId && !tournamentId && hosting) {
    return (
      <CreateTournament
        onOpen={(id) => {
          setHosting(false);
          setTournamentId(id);
        }}
        onBack={() => setHosting(false)}
      />
    );
  }

  if (!gameId && tournamentId) {
    return <Tournament id={tournamentId} name={name} setName={setName} onPlay={enter} onWatch={watch} onBack={() => setTournamentId(null)} />;
  }

  if (!gameId && autoSpectate) {
    return (
      <div className="center p5 p5-page">
        <div className="card">
          <h2>Auto-spectate</h2>
          <p className="muted pulse">Looking for a live game…</p>
          <div className="row">
            <button onClick={leaveToHome}>Back to games</button>
          </div>
        </div>
      </div>
    );
  }

  if (!gameId) {
    return <Home name={name} setName={setName} onEnter={enter} onSpectate={watch} onAutoSpectate={startAutoSpectate} onOpenTournament={setTournamentId} />;
  }

  if (spectating) {
    return (
      <Connected
        key={gameId}
        gameId={gameId}
        session={null}
        spectating
        onLeave={leaveToHome}
        onJoin={() => {
          setSpectating(false);
          setAutoSpectate(false);
        }}
        onWatch={watch}
        autoSpectate={autoSpectate ? auto : undefined}
      />
    );
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
  onWatch,
  autoSpectate,
}: {
  gameId: string;
  session: Session | null;
  spectating?: boolean;
  onLeave: () => void;
  onJoin?: () => void;
  onWatch?: (id: string) => void;
  /** Auto-spectate viewers only: move on to another live game when this one ends or closes. */
  autoSpectate?: AutoSpectate;
}) {
  const conn = useGame(gameId, spectating ? undefined : session?.token);
  // The room name arrives with the first state; "Stay here" turns the move off for this game.
  const [stayed, setStayed] = useState(false);
  const isGen = !stayed && isGenerationGame(conn.name);

  // Generation training matches move spectators on to the next match even without auto-spectate (hard rule 10)
  const genAuto = isGen && onWatch && spectating ? { advance: (nextId: string) => onWatch(nextId), stay: () => setStayed(true) } : undefined;
  const auto = spectating ? (autoSpectate ?? genAuto) : undefined;

  if (conn.closedReason) {
    const why: Record<string, string> = {
      host: 'The host closed this room.',
      admin: 'This room was removed by the site admin.',
      idle: 'This room was cleaned up after being idle.',
      empty: 'Everyone left this room.',
      gone: 'This room no longer exists.',
    };
    return (
      <div className="center p5 p5-page">
        <div className="card">
          <h2>Room {gameId} is closed</h2>
          <p className="muted">{why[conn.closedReason] ?? 'This room is no longer available.'}</p>
          <div className="row">
            <button className="primary" onClick={onLeave}>
              Back to games
            </button>
            {auto && <AutoAdvance from={gameId} auto={auto} generationOnly={isGen} />}
          </div>
        </div>
      </div>
    );
  }
  if (!conn.view) {
    return (
      <div className="center p5 p5-page">
        <div className="card">
          <h2>Connecting to game {gameId}…</h2>
          {!conn.connected && <p className="muted">Waiting for the server. If this never resolves the game may no longer exist.</p>}
          <button onClick={onLeave}>Back</button>
        </div>
      </div>
    );
  }
  if (conn.view.phase === 'lobby') return <Lobby conn={conn} gameId={gameId} session={spectating ? null : session} onLeave={onLeave} onJoin={onJoin} />;
  return <Game conn={conn} gameId={gameId} session={spectating ? null : session} onLeave={onLeave} onJoin={onJoin} autoSpectate={auto} isGeneration={isGen} />;
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
    <div className="center p5 p5-page">
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
