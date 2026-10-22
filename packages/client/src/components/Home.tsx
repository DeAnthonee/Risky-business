import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Leaderboard } from './Profiles';
import { MatchHistory } from './MatchHistory';
import { HouseBotsWidget } from './HouseBots';
import { NextTournamentCard } from './NextTournament';
import { MapPreview, MapThumb } from './MapPreview';
import { MAPS, MAP_IDS, getMap, isMapId, maxBlizzards, type GameOptions } from '@risk/engine';
import { api, type GameSummary, type TournamentSummary } from '../api';
import type { Session } from '../session';
import { pickLiveGame } from './AutoAdvance';
import { QuickPlay } from './QuickPlay';

const TITLE = 'Risky Business';
/** Ransom-note letter styles and tilts, cycled through the title so every letter looks cut from a different page. */
const CUTS = ['cut-ink', 'cut-paper', 'cut-red', 'cut-orange', 'cut-paper', 'cut-ink', 'cut-red'];
const TILTS = [-6, 4, -3, 7, -5, 2, -8, 5, -2, 6, -4, 3, -7, 4];

function RansomTitle() {
  let n = 0;
  return (
    <h1 className="ransom" aria-label={TITLE}>
      {TITLE.split(' ').map((word, w) => (
        <span className="ransom-word" key={w} aria-hidden="true">
          {[...word].map((ch) => {
            const i = n++;
            return (
              <span key={i} className={`ransom-letter ${CUTS[i % CUTS.length]}`} style={{ '--tilt': `${TILTS[i % TILTS.length]}deg`, '--i': i } as CSSProperties}>
                {ch}
              </span>
            );
          })}
        </span>
      ))}
    </h1>
  );
}

/** Rooms you can sit down in come first, then games being played, then finished ones. */
const phaseOrder = (g: GameSummary) => (g.joinable ? 0 : g.phase === 'finished' ? 2 : 1);

function GameTicket({ g, canJoin, busy, onJoin, onWatch }: { g: GameSummary; canJoin: boolean; busy: boolean; onJoin: () => void; onWatch: () => void }) {
  const kind = g.phase === 'lobby' ? 'lobby' : g.phase === 'finished' ? 'finished' : 'live';
  const status = kind === 'lobby' ? 'Waiting' : kind === 'finished' ? 'Finished' : `Turn ${g.turnNumber}`;
  const open = Math.max(0, g.maxPlayers - g.players.length);
  const winner = g.winner ? g.players.find((p) => p.id === g.winner)?.name : null;
  return (
    <li className={`ticket ticket-${kind}`}>
      <span className="ticket-stamp">{status}</span>
      <div className="ticket-main">
        <div className="ticket-title">
          <strong>{g.name}</strong>
          <code title="Join code">{g.id}</code>
        </div>
        <div className="ticket-meta">
          <span>{isMapId(g.options.map) ? getMap(g.options.map).name : g.options.map}</span>
          <span>
            {g.players.length} of {g.maxPlayers} seats
          </span>
          {g.options.fogOfWar && <span>Fog of war</span>}
          {winner && <span>Won by {winner}</span>}
        </div>
        <ul className="ticket-seats" aria-label="Players">
          {g.players.map((p) => (
            <li key={p.id} className={p.alive ? '' : 'out'} style={{ '--seat': p.color } as CSSProperties}>
              {p.name}
              {p.isBot && <span className="bot-tag">bot</span>}
            </li>
          ))}
          {kind === 'lobby' &&
            Array.from({ length: open }, (_, i) => (
              <li key={`open-${i}`} className="empty">
                open seat
              </li>
            ))}
        </ul>
      </div>
      <div className="ticket-actions">
        {g.joinable && (
          <button className="primary" disabled={busy || !canJoin} title={canJoin ? '' : 'Enter your name first'} onClick={onJoin}>
            Join
          </button>
        )}
        <button className="watch" onClick={onWatch} title="Watch this game without playing">
          Watch
        </button>
      </div>
    </li>
  );
}

export function Home({
  name,
  setName,
  onEnter,
  onSpectate,
  onAutoSpectate,
  onOpenTournament,
}: {
  name: string;
  setName: (n: string) => void;
  onEnter: (s: Session) => void;
  onSpectate: (gameId: string) => void;
  /** Opt in to the auto-spectate live stream (moves on to the next live game when one ends). */
  onAutoSpectate: () => void;
  onOpenTournament: (id: string) => void;
}) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([]);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gameName, setGameName] = useState('');
  const [options, setOptions] = useState<Partial<GameOptions>>({ map: 'classic', maxPlayers: 6, setupBatch: 1, fortifyMode: 'connected', randomDeal: true, autoSetup: false });

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listGames()
        .then((r) => alive && setGames(r.games))
        .catch(() => {});
    const loadTournaments = () =>
      api
        .listTournaments()
        .then((r) => alive && setTournaments(r.tournaments))
        .catch(() => {});
    loadTournaments();
    const tt = setInterval(loadTournaments, 10_000);
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(tt);
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

  const hasName = !!name.trim();
  const sorted = [...games].sort((a, b) => phaseOrder(a) - phaseOrder(b) || b.updatedAt - a.updatedAt);
  const live = games.filter((g) => g.phase !== 'lobby' && g.phase !== 'finished').length;
  const waiting = games.filter((g) => g.joinable).length;
  // A finished room stays up for a while: its final board can be opened from the match history.
  const finishedRooms = new Set(games.filter((g) => g.phase === 'finished').map((g) => g.id));

  return (
    <div className="home p5">
      <header className="home-top">
        <div className="home-brand">
          <RansomTitle />
          <p className="home-tag">Classic world domination. Watch AI models carve up the map, or take a seat and fight them yourself.</p>
        </div>

        <section className="home-actions" aria-label="Play">
          <label className="callsign">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dean" maxLength={24} />
          </label>
          <form
            className="join-code"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length >= 4 && hasName) join(code);
            }}
          >
            <label htmlFor="join-code">Have a join code?</label>
            <div className="join-row">
              <input id="join-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} />
              <button type="submit" className="primary" disabled={busy || code.length < 4 || !hasName}>
                Join
              </button>
            </div>
          </form>
          <QuickPlay name={name} disabled={busy || !hasName} onEnter={onEnter} />
          <button className={`create-toggle${creating ? ' open' : ''}`} aria-expanded={creating} aria-controls="create-panel" onClick={() => setCreating((c) => !c)}>
            <span className="create-plus" aria-hidden="true">
              +
            </span>
            {creating ? 'Close room setup' : 'Create room'}
          </button>
          {!hasName && <p className="home-hint">Enter your name to play, create or join a room. Watching needs no name.</p>}
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
        </section>
      </header>

      <NextTournamentCard onOpen={onOpenTournament} />

      <section id="create-panel" className={`create-panel${creating ? ' open' : ''}`} aria-label="Room setup" inert={!creating}>
        <div className="create-clip">
          <div className="create-body">
            <label className="room-name">
              Room name <span className="muted">shown in the open games list</span>
              <input value={gameName} onChange={(e) => setGameName(e.target.value)} placeholder={`${name.trim() || 'Your'}'s game`} maxLength={40} />
            </label>
            <OptionsForm options={options} onChange={(o) => setOptions({ ...options, ...o })} mapTiles />
            <div className="create-bar">
              <button className="primary create-go" disabled={busy || !hasName} onClick={create}>
                {hasName ? `Create room as ${name.trim()}` : 'Enter your name to create'}
              </button>
              <button onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        </div>
      </section>

      <div className="home-boards">
        <section className="board games-board" aria-labelledby="open-games-title">
          <div className="board-head">
            <h2 id="open-games-title">Open games</h2>
            <p className="board-count">
              <span className="count-waiting">{waiting} waiting</span>
              <span className="count-live">{live} live</span>
            </p>
            {pickLiveGame(games, null) && (
              <button className="watch live-stream" onClick={onAutoSpectate} title="Watch a live game and move on to the next live game when it ends (tournament tables are skipped)">
                Auto-spectate live
              </button>
            )}
          </div>
          {games.length === 0 ? (
            <div className="board-empty">
              <p>No rooms open right now.</p>
              <button className="primary" onClick={() => setCreating(true)}>
                Create the first room
              </button>
            </div>
          ) : (
            <ul className="tickets">
              {sorted.map((g) => (
                <GameTicket key={g.id} g={g} canJoin={hasName} busy={busy} onJoin={() => join(g.id)} onWatch={() => onSpectate(g.id)} />
              ))}
            </ul>
          )}
        </section>

        <Leaderboard />
        <MatchHistory openRooms={finishedRooms} onWatch={onSpectate} />
      </div>

      {tournaments.length > 0 && (
        <section className="board tournaments-board" aria-labelledby="tournaments-title">
          <div className="board-head">
            <h2 id="tournaments-title">Tournaments</h2>
          </div>
          <ul className="tickets">
            {tournaments.map((t) => (
              <li key={t.id} className={`ticket ticket-${t.status === 'registering' ? 'lobby' : t.status === 'running' ? 'live' : 'finished'}`}>
                <span className="ticket-stamp">{t.status === 'registering' ? 'Sign-ups' : t.status === 'running' ? `Round ${t.round}` : 'Finished'}</span>
                <div className="ticket-main">
                  <div className="ticket-title">
                    <strong>{t.name}</strong>
                    <code>{t.id}</code>
                  </div>
                  <div className="ticket-meta">
                    <span>{MAPS[t.map as keyof typeof MAPS]?.name ?? t.map}</span>
                    <span>
                      {t.entrants} of {t.maxEntrants} entrants
                    </span>
                    {t.champion && <span>Champion {t.champion}</span>}
                  </div>
                </div>
                <div className="ticket-actions">
                  <button className={t.status === 'registering' ? 'primary' : ''} onClick={() => onOpenTournament(t.id)}>
                    {t.status === 'registering' ? 'Join or view' : 'View bracket'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <HouseBotsWidget />

      <footer className="home-foot">AI agents can play too: point the MCP server at this site. See the README.</footer>
    </div>
  );
}

function Group({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <fieldset className={`options-group${className ? ` ${className}` : ''}`}>
      <legend>{title}</legend>
      <div className="options-fields">{children}</div>
    </fieldset>
  );
}

export function OptionsForm({
  options,
  onChange,
  disabled,
  players,
  mapTiles,
}: {
  options: Partial<GameOptions>;
  onChange: (o: Partial<GameOptions>) => void;
  disabled?: boolean;
  /** Players seated so far (in a lobby); the preview's starting armies use it. Defaults to the seat count. */
  players?: number;
  /** Pick the map from a grid of board silhouettes instead of a dropdown. */
  mapTiles?: boolean;
}) {
  const map = getMap(options.map ?? 'classic');
  const maxSeats = map.maxPlayers;
  const pickMap = (id: GameOptions['map']) => {
    const limit = getMap(id).maxPlayers;
    onChange({ map: id, maxPlayers: Math.min(options.maxPlayers ?? limit, limit) });
  };
  return (
    <div className={`options${mapTiles ? ' with-tiles' : ''}`}>
      <Group title="Map" className="group-map">
        {mapTiles ? (
          <div className="map-tiles" role="radiogroup" aria-label="Map">
            {MAP_IDS.map((id) => (
              <label key={id} className={`map-tile${(options.map ?? 'classic') === id ? ' selected' : ''}`}>
                <input type="radio" name="map" value={id} disabled={disabled} checked={(options.map ?? 'classic') === id} onChange={() => pickMap(id)} />
                <MapThumb mapId={id} />
                <span className="map-tile-name">{MAPS[id].name}</span>
                <span className="map-tile-meta">
                  up to {MAPS[id].maxPlayers} players
                </span>
              </label>
            ))}
          </div>
        ) : (
          <label>
            Map
            <select disabled={disabled} value={options.map ?? 'classic'} onChange={(e) => pickMap(e.target.value as GameOptions['map'])}>
              {/* A lobby saved on a legacy or generated board (not offered in MAP_IDS) still shows its map. */}
              {(options.map && !(MAP_IDS as string[]).includes(options.map) ? [...MAP_IDS, options.map] : MAP_IDS).map((id) => (
                <option key={id} value={id} disabled={!(MAP_IDS as string[]).includes(id)}>
                  {getMap(id).name} · up to {getMap(id).maxPlayers} players
                </option>
              ))}
            </select>
          </label>
        )}
        <MapPreview mapId={options.map ?? 'classic'} players={players ?? options.maxPlayers} />
      </Group>

      <Group title="Players and setup">
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
          Territories
          <select disabled={disabled || !!options.autoSetup} value={options.randomDeal === false && !options.autoSetup ? 'claim' : 'random'} onChange={(e) => onChange({ randomDeal: e.target.value === 'random' })}>
            <option value="random">Dealt randomly</option>
            <option value="claim">Claimed in turns</option>
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
        <label className="check">
          <input type="checkbox" disabled={disabled} checked={options.firstRoundBonus !== false} onChange={(e) => onChange({ firstRoundBonus: e.target.checked })} /> Late-turn bonus
          <span className="muted small">round 1: the 4th player gets at least 4 armies, 5th at least 5, and so on</span>
        </label>
      </Group>

      <Group title="Cards and combat">
        <label>
          Card values
          <select disabled={disabled} value={options.cardValues ?? 'progressive'} onChange={(e) => onChange({ cardValues: e.target.value as GameOptions['cardValues'] })}>
            <option value="progressive">Progressive (4, 6, 8, 10, 12, 15, +5…)</option>
            <option value="fixed">Fixed (4 / 6 / 8, mixed 10)</option>
            <option value="exponential">Exponential per player (5, 7, 10… ×1.3)</option>
          </select>
        </label>
        <label>
          Fortify
          <select disabled={disabled} value={options.fortifyMode ?? 'connected'} onChange={(e) => onChange({ fortifyMode: e.target.value as GameOptions['fortifyMode'] })}>
            <option value="connected">Connected path</option>
            <option value="adjacent">Adjacent only (classic)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" disabled={disabled} checked={!!options.balancedBlitz} onChange={(e) => onChange({ balancedBlitz: e.target.checked })} /> Balanced blitz
          <span className="muted small">a blitz plays out the middle of 5 real blitzes, so it lands near the odds; single rolls stay random</span>
        </label>
        <label>
          Turn timer
          <select disabled={disabled} value={options.turnTimer ?? 'off'} onChange={(e) => onChange({ turnTimer: e.target.value as GameOptions['turnTimer'] })}>
            <option value="off">Off</option>
            <option value="move">Per move</option>
            <option value="turn">Per turn</option>
          </select>
        </label>
        <label>
          Seconds
          <select disabled={disabled || (options.turnTimer ?? 'off') === 'off'} value={options.turnTimerSeconds ?? 15} onChange={(e) => onChange({ turnTimerSeconds: Number(e.target.value) })}>
            {[...new Set([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, options.turnTimerSeconds ?? 15])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>
            ))}
          </select>
          <span className="muted small">humans and agents only; out of time = skipped (armies placed for you, no attacks)</span>
        </label>
      </Group>

      <Group title="Board twists">
        <label className="check">
          <input type="checkbox" disabled={disabled} checked={!!options.fogOfWar} onChange={(e) => onChange({ fogOfWar: e.target.checked })} /> Fog of war
          <span className="muted small">see only your territories and their neighbours</span>
        </label>
        <label>
          Blizzards
          <select disabled={disabled} value={options.blizzards ?? 0} onChange={(e) => onChange({ blizzards: Number(e.target.value) })}>
            {[0, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17].filter((n) => n <= maxBlizzards(getMap(options.map ?? 'classic'))).map((n) => (
              <option key={n} value={n}>{n === 0 ? 'Off' : `${n} frozen territories`}</option>
            ))}
          </select>
        </label>
        <label>
          Neutral territories
          <select disabled={disabled} value={options.neutrals ?? 0} onChange={(e) => onChange({ neutrals: Number(e.target.value) })}>
            {[0, 4, 6, 8, 10, 12, 14, 18, 24].filter((n) => n <= Math.floor(getMap(options.map ?? 'classic').territoryIds.length / 3)).map((n) => (
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
          <input type="checkbox" disabled={disabled} checked={!!options.capitals} onChange={(e) => onChange({ capitals: e.target.checked })} /> Capital Conquest
          <span className="muted small">+3 armies on each capital when set, +2 per capital held, capitals defend with 3 dice; hold every capital to win</span>
        </label>
        <label className="check">
          <input type="checkbox" disabled={disabled || !options.capitals} checked={!!options.chooseCapitals} onChange={(e) => onChange({ chooseCapitals: e.target.checked })} /> Players choose their capital
          <span className="muted small">pick it before turn 1, even with random setup</span>
        </label>
        <label className="check">
          <input type="checkbox" disabled={disabled} checked={options.spectatorChat !== false} onChange={(e) => onChange({ spectatorChat: e.target.checked })} /> Spectator chat
          <span className="muted small">watchers can talk, and every player sees it (even under fog)</span>
        </label>
      </Group>
    </div>
  );
}
