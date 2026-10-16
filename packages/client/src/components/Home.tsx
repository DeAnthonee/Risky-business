import { useEffect, useState } from 'react';
import { MAPS, MAP_IDS, type GameOptions } from '@risk/engine';
import { api, type GameSummary } from '../api';
import type { Session } from '../session';

export function Home({
  name,
  setName,
  onEnter,
  onSpectate,
}: {
  name: string;
  setName: (n: string) => void;
  onEnter: (s: Session) => void;
  onSpectate: (gameId: string) => void;
}) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gameName, setGameName] = useState('');
  const [options, setOptions] = useState<Partial<GameOptions>>({ map: 'classic', maxPlayers: 6, setupBatch: 1, fortifyMode: 'connected', randomDeal: true });

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listGames()
        .then((r) => alive && setGames(r.games))
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    guard(async () => {
      const r = await api.createGame(name || 'Player', gameName, options);
      onEnter({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
    });

  const join = (id: string) =>
    guard(async () => {
      const r = await api.joinGame(id.trim().toUpperCase(), name || 'Player');
      onEnter({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
    });

  return (
    <div className="home">
      <header className="hero">
        <h1>
          <span className="dice">🎲</span> Risky Business
        </h1>
        <p className="muted">Classic world domination. Play friends, bots, or AI agents.</p>
      </header>

      <div className="home-grid">
        <section className="card">
          <h2>You</h2>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Commander" maxLength={24} />
          </label>
          <h2>Join with a code</h2>
          <div className="row">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} style={{ textTransform: 'uppercase' }} />
            <button className="primary" disabled={busy || code.length < 4} onClick={() => join(code)}>
              Join
            </button>
          </div>
          {err && <p className="error">{err}</p>}
        </section>

        <section className="card">
          <h2>Create a game</h2>
          <label>
            Game name
            <input value={gameName} onChange={(e) => setGameName(e.target.value)} placeholder={`${name || 'Player'}'s game`} maxLength={40} />
          </label>
          <OptionsForm options={options} onChange={(o) => setOptions({ ...options, ...o })} />
          <button className="primary" disabled={busy} onClick={create}>
            Create game
          </button>
        </section>

        <section className="card wide">
          <h2>Open games</h2>
          {games.length === 0 && <p className="muted">No games yet. Create one!</p>}
          <ul className="game-list">
            {games.map((g) => (
              <li key={g.id}>
                <div>
                  <strong>{g.name}</strong> <code>{g.id}</code>
                  <div className="muted small">
                    {g.phase === 'lobby' ? 'In lobby' : g.phase === 'finished' ? 'Finished' : `In progress · turn ${g.turnNumber}`} ·{' '}
                    {g.players.map((p) => (
                      <span key={p.id} style={{ color: p.color }}>
                        {p.name}
                        {p.isBot ? ' 🤖' : ''}{' '}
                      </span>
                    ))}
                    ({g.players.length}/{g.maxPlayers}) · {MAPS[g.options.map]?.name ?? g.options.map}
                  </div>
                </div>
                <div className="row">
                  {g.joinable ? (
                    <button className="primary" disabled={busy} onClick={() => join(g.id)}>
                      Join
                    </button>
                  ) : (
                    <button onClick={() => onSpectate(g.id)}>Spectate</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <footer className="muted small">
        AI agents can play too: point the MCP server at this site. See the README.
      </footer>
    </div>
  );
}

export function OptionsForm({
  options,
  onChange,
  disabled,
}: {
  options: Partial<GameOptions>;
  onChange: (o: Partial<GameOptions>) => void;
  disabled?: boolean;
}) {
  const map = MAPS[options.map ?? 'classic'];
  const maxSeats = map.maxPlayers;
  return (
    <div className="options">
      <label>
        Map
        <select
          disabled={disabled}
          value={options.map ?? 'classic'}
          onChange={(e) => {
            const id = e.target.value as GameOptions['map'];
            const limit = MAPS[id].maxPlayers;
            onChange({ map: id, maxPlayers: Math.min(options.maxPlayers ?? limit, limit) });
          }}
        >
          {MAP_IDS.map((id) => (
            <option key={id} value={id}>
              {MAPS[id].name} · up to {MAPS[id].maxPlayers} players
            </option>
          ))}
        </select>
      </label>
      <label>
        Max players
        <select disabled={disabled} value={Math.min(options.maxPlayers ?? maxSeats, maxSeats)} onChange={(e) => onChange({ maxPlayers: Number(e.target.value) })}>
          {Array.from({ length: maxSeats - 1 }, (_, i) => i + 2).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label>
        Armies per setup turn
        <select disabled={disabled} value={options.setupBatch ?? 1} onChange={(e) => onChange({ setupBatch: Number(e.target.value) })}>
          <option value={1}>1 (classic)</option>
          <option value={3}>3</option>
          <option value={5}>5</option>
          <option value={10}>10</option>
          <option value={40}>All at once</option>
        </select>
      </label>
      <label>
        Fortify
        <select disabled={disabled} value={options.fortifyMode ?? 'connected'} onChange={(e) => onChange({ fortifyMode: e.target.value as GameOptions['fortifyMode'] })}>
          <option value="connected">Connected path</option>
          <option value="adjacent">Adjacent only (classic)</option>
        </select>
      </label>
      <label>
        Territories
        <select disabled={disabled} value={options.randomDeal === false ? 'claim' : 'random'} onChange={(e) => onChange({ randomDeal: e.target.value === 'random' })}>
          <option value="random">Dealt randomly</option>
          <option value="claim">Claimed in turns</option>
        </select>
      </label>
    </div>
  );
}
