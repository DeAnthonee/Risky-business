import { useEffect, useState } from 'react';
import { MAPS, MAP_IDS, maxBlizzards, type GameOptions } from '@risk/engine';
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
  const [options, setOptions] = useState<Partial<GameOptions>>({ map: 'classic', maxPlayers: 6, setupBatch: 1, fortifyMode: 'connected', randomDeal: true, autoSetup: false });

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
      const r = await api.createGame(name.trim(), gameName, options);
      onEnter({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
    });

  const join = (id: string) =>
    guard(async () => {
      const r = await api.joinGame(id.trim().toUpperCase(), name.trim());
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
          <h2>Join a game</h2>
          <label>
            Your player name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dean" maxLength={24} />
          </label>
          <label>
            Join code
            <div className="row">
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} style={{ textTransform: 'uppercase' }} />
              <button className="primary" disabled={busy || code.length < 4 || !name.trim()} onClick={() => join(code)}>
                Join
              </button>
            </div>
          </label>
          {!name.trim() && <p className="muted small">Enter your player name first.</p>}
          {err && <p className="error">{err}</p>}
        </section>

        <section className="card">
          <h2>Create a game</h2>
          <label>
            Your player name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dean" maxLength={24} />
          </label>
          <label>
            Game name <span className="muted">(what others see in the list)</span>
            <input value={gameName} onChange={(e) => setGameName(e.target.value)} placeholder={`${name.trim() || 'Your'}'s game`} maxLength={40} />
          </label>
          <OptionsForm options={options} onChange={(o) => setOptions({ ...options, ...o })} />
          <button className="primary" disabled={busy || !name.trim()} onClick={create}>
            Create game as {name.trim() || '…'}
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
                  {g.joinable && (
                    <button className="primary" disabled={busy || !name.trim()} title={name.trim() ? '' : 'Enter your player name first'} onClick={() => join(g.id)}>
                      Join
                    </button>
                  )}
                  <button onClick={() => onSpectate(g.id)} title="Watch this game without playing">
                    👁 Watch
                  </button>
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
          {/* A lobby saved on a legacy board (kept in MAPS, not offered in MAP_IDS) still shows its map. */}
          {(options.map && !MAP_IDS.includes(options.map) ? [...MAP_IDS, options.map] : MAP_IDS).map((id) => (
            <option key={id} value={id} disabled={!MAP_IDS.includes(id)}>
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
        Starting armies
        <select disabled={disabled} value={options.autoSetup ? 'auto' : 'manual'} onChange={(e) => onChange({ autoSetup: e.target.value === 'auto' })}>
          <option value="manual">Players place them (classic)</option>
          <option value="auto">Placed randomly, skip setup</option>
        </select>
      </label>
      <label>
        Armies per setup turn
        <select disabled={disabled || !!options.autoSetup} value={options.setupBatch ?? 1} onChange={(e) => onChange({ setupBatch: Number(e.target.value) })}>
          <option value={1}>1 (classic)</option>
          <option value={3}>3</option>
          <option value={5}>5</option>
          <option value={10}>10</option>
          <option value={40}>All at once</option>
        </select>
      </label>
      <label>
        Card values
        <select disabled={disabled} value={options.cardValues ?? 'progressive'} onChange={(e) => onChange({ cardValues: e.target.value as GameOptions['cardValues'] })}>
          <option value="progressive">Progressive (4, 6, 8, 10, 12, 15, +5…)</option>
          <option value="fixed">Fixed (4 / 6 / 8, mixed 10)</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled} checked={!!options.fogOfWar} onChange={(e) => onChange({ fogOfWar: e.target.checked })} /> Fog of war
        <span className="muted small">see only your territories and their neighbours</span>
      </label>
      <label>
        Blizzards
        <select disabled={disabled} value={options.blizzards ?? 0} onChange={(e) => onChange({ blizzards: Number(e.target.value) })}>
          {[0, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17].filter((n) => n <= maxBlizzards(MAPS[options.map ?? 'classic'])).map((n) => (
            <option key={n} value={n}>{n === 0 ? 'Off' : `${n} frozen territories`}</option>
          ))}
        </select>
      </label>
      <label>
        Neutral territories
        <select disabled={disabled} value={options.neutrals ?? 0} onChange={(e) => onChange({ neutrals: Number(e.target.value) })}>
          {[0, 4, 6, 8, 10, 12, 14, 18, 24].filter((n) => n <= Math.floor(MAPS[options.map ?? 'classic'].territoryIds.length / 3)).map((n) => (
            <option key={n} value={n}>{n === 0 ? 'Off (2 players always get a Neutral)' : `${n} territories`}</option>
          ))}
        </select>
      </label>
      <label>
        Neutral armies each
        <select disabled={disabled || !options.neutrals} value={options.neutralArmies ?? 2} onChange={(e) => onChange({ neutralArmies: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled} checked={options.spectatorChat !== false} onChange={(e) => onChange({ spectatorChat: e.target.checked })} /> Spectator chat
        <span className="muted small">watchers can talk, and every player sees it (even under fog)</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled} checked={options.firstRoundBonus !== false} onChange={(e) => onChange({ firstRoundBonus: e.target.checked })} /> Late-turn bonus
        <span className="muted small">round 1: the 4th player gets at least 4 armies, 5th at least 5, and so on</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled} checked={!!options.balancedBlitz} onChange={(e) => onChange({ balancedBlitz: e.target.checked })} /> Balanced blitz
        <span className="muted small">a blitz plays out the middle of 5 real blitzes, so it lands near the odds; single rolls stay random</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled} checked={!!options.capitals} onChange={(e) => onChange({ capitals: e.target.checked })} /> Capital Conquest
        <span className="muted small">+3 armies on each capital when set, +2 per capital held, capitals defend with 3 dice; hold every capital to win</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={disabled || !options.capitals} checked={!!options.chooseCapitals} onChange={(e) => onChange({ chooseCapitals: e.target.checked })} /> Players choose their capital
        <span className="muted small">pick it before turn 1, even with random setup</span>
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
        <select disabled={disabled || !!options.autoSetup} value={options.randomDeal === false && !options.autoSetup ? 'claim' : 'random'} onChange={(e) => onChange({ randomDeal: e.target.value === 'random' })}>
          <option value="random">Dealt randomly</option>
          <option value="claim">Claimed in turns</option>
        </select>
      </label>
    </div>
  );
}
