import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMap, visibleTerritories, type Card, type GameEvent, type GameView } from '@risk/engine';
import { api } from '../api';
import { spectateLink, type Session } from '../session';
import type { EventBatch, GameConnection } from '../useGame';
import { CardsPanel } from './Cards';
import { Chat } from './Chat';
import { DicePanel, type BattleEvent } from './Dice';
import { Log } from './Log';
import { GameMap, territoryName, type FloatAnim, type Highlight, type MoveAnim, type SweepAnim } from './Map';

type Mode = 'idle' | 'place' | 'attack' | 'fortify';

const BATTLE_ROLL_MS = 420;
const BATTLE_SHOW_MS = 650;
const BATTLE_LINGER_MS = 2200;

export function Game({ conn, gameId, session, onLeave, onJoin }: { conn: GameConnection; gameId: string; session: Session | null; onLeave: () => void; onJoin?: () => void }) {
  const view = conn.view!;
  const you = conn.you;
  const me = view.players.find((p) => p.id === you) ?? null;
  const legal = view.legal;
  const myTurn = !!legal?.yourTurn;
  const current = view.players.find((p) => p.id === view.currentPlayer) ?? null;
  const names = useMemo(() => Object.fromEntries(view.players.map((p) => [p.id, p.name])), [view.players]);
  const map = getMap(view.options.map);
  const shortName = (id: string) => territoryName(map, id);
  const colorOf = useCallback((pid: string | null | undefined) => view.players.find((p) => p.id === pid)?.color ?? '#888', [view.players]);

  // ---------- local interaction state ----------
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [dice, setDice] = useState(3);
  const [moveArmies, setMoveArmies] = useState(1);
  const [showCards, setShowCards] = useState(false);
  const [tab, setTab] = useState<'log' | 'chat'>('log');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; color: string } | null>(null);
  const [copiedWatch, setCopiedWatch] = useState(false);
  const spectator = !me;
  // Spectator fog preview: follow the current player by default; click a player to pin, click again to see all.
  const fogOn = !!view.options.fogOfWar;
  const [fogPin, setFogPin] = useState<string | null>(null);
  const [followTurn, setFollowTurn] = useState(true);
  const fogAs = spectator && fogOn ? (followTurn ? view.currentPlayer : fogPin) : null;
  const fogHidden = useMemo(() => {
    if (!fogAs) return undefined;
    const vis = visibleTerritories(view.territories, fogAs, map);
    return new Set(map.territoryIds.filter((t) => !vis.has(t)));
  }, [fogAs, view.territories, map]);
  const pickFog = (pid: string) => {
    if (!spectator || !fogOn) return;
    if (fogAs === pid) {
      setFollowTurn(false);
      setFogPin(null);
    } else {
      setFollowTurn(false);
      setFogPin(pid);
    }
  };
  const copyWatchLink = async () => {
    try {
      await navigator.clipboard.writeText(spectateLink(gameId));
      setCopiedWatch(true);
      setTimeout(() => setCopiedWatch(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const pendingTotal = Object.values(pending).reduce((a, b) => a + b, 0);
  const mode: Mode = !myTurn
    ? 'idle'
    : legal!.pendingConquest
      ? 'idle'
      : legal!.canPlaceOn.length > 0
        ? 'place'
        : view.phase === 'attack'
          ? 'attack'
          : view.phase === 'fortify'
            ? 'fortify'
            : 'idle';

  // Reset selection when the turn/phase changes.
  useEffect(() => {
    setSelected(null);
    setTarget(null);
    setPending({});
  }, [view.phase, view.currentPlayer, legal?.pendingConquest?.to]);

  // Auto-open cards when forced to trade.
  useEffect(() => {
    if (legal?.mustTrade) setShowCards(true);
  }, [legal?.mustTrade]);

  // Default occupy armies.
  useEffect(() => {
    if (legal?.pendingConquest) setMoveArmies(legal.pendingConquest.maxArmies);
  }, [legal?.pendingConquest?.to, legal?.pendingConquest?.maxArmies]);

  // Clear the banner after a moment.
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 1800);
    return () => clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (conn.error) {
      setToast(conn.error);
      const t = setTimeout(() => {
        setToast(null);
        conn.clearError();
      }, 3500);
      return () => clearTimeout(t);
    }
  }, [conn.error]);

  // ---------- animations ----------
  const anim = useAnimations(conn.batches, view, colorOf, setBanner);

  // ---------- actions ----------
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      /* error surfaced via conn.error */
    } finally {
      setBusy(false);
    }
  };

  const submitPlacements = (placements: Record<string, number>) => run(() => conn.act({ type: 'place', placements }));

  const onTerritoryClick = (id: string, shift: boolean) => {
    if (!myTurn || busy) return;
    const ts = view.territories[id];
    if (mode === 'place') {
      if (!legal!.canPlaceOn.includes(id)) return;
      const limit = legal!.placeLimit;
      const add = shift ? limit - pendingTotal : 1;
      if (add <= 0) return;
      const next = { ...pending, [id]: (pending[id] ?? 0) + add };
      const total = pendingTotal + add;
      if (total >= limit) {
        setPending({});
        submitPlacements(next);
      } else {
        setPending(next);
      }
      return;
    }
    if (mode === 'attack') {
      const attacksFrom = legal!.attacks.filter((a) => a.from === id);
      if (selected && ts.owner !== you && legal!.attacks.some((a) => a.from === selected && a.to === id)) {
        setTarget(id);
        setDice(legal!.attacks.find((a) => a.from === selected && a.to === id)!.maxDice);
        return;
      }
      if (ts.owner === you && attacksFrom.length > 0) {
        setSelected(selected === id ? null : id);
        setTarget(null);
        return;
      }
      setSelected(null);
      setTarget(null);
      return;
    }
    if (mode === 'fortify') {
      const from = legal!.fortifies.filter((f) => f.from === id);
      if (selected && legal!.fortifies.some((f) => f.from === selected && f.to === id)) {
        setTarget(id);
        setMoveArmies(legal!.fortifies.find((f) => f.from === selected && f.to === id)!.maxArmies);
        return;
      }
      if (ts.owner === you && from.length > 0) {
        setSelected(selected === id ? null : id);
        setTarget(null);
        return;
      }
      setSelected(null);
      setTarget(null);
    }
  };

  const attack = (blitz: boolean) =>
    selected && target && run(() => conn.act({ type: 'attack', from: selected, to: target, dice: blitz ? undefined : dice, blitz }));
  const occupy = () => run(() => conn.act({ type: 'occupy', armies: moveArmies }));
  const fortify = () => selected && target && run(() => conn.act({ type: 'fortify', from: selected, to: target, armies: moveArmies }));
  const endAttack = () => run(() => conn.act({ type: 'end_attack' }));
  const endTurn = () => run(() => conn.act({ type: 'end_turn' }));
  const trade = (ids: number[]) => conn.act({ type: 'trade', cardIds: ids }).then(() => setShowCards(legal?.mustTrade ?? false));
  const surrender = () => {
    if (confirm('Surrender and leave the game?')) run(() => conn.act({ type: 'surrender' })).then(onLeave);
  };
  const leaveSpectate = async () => {
    if (session && me && !me.alive) await api.leave(gameId, session.token).catch(() => {});
    onLeave();
  };

  // ---------- highlights ----------
  const highlights = useMemo(() => {
    const h: Record<string, Highlight> = {};
    if (!myTurn || !legal) return h;
    if (mode === 'place') {
      for (const t of legal.canPlaceOn) h[t] = 'place';
    } else if (mode === 'attack') {
      if (selected) {
        h[selected] = 'selected';
        for (const a of legal.attacks) if (a.from === selected) h[a.to] = a.to === target ? 'pending-target' : 'target';
      } else {
        for (const a of legal.attacks) h[a.from] = 'source';
      }
    } else if (mode === 'fortify') {
      if (selected) {
        h[selected] = 'selected';
        for (const f of legal.fortifies) if (f.from === selected) h[f.to] = f.to === target ? 'pending-target' : 'target';
      } else {
        for (const f of legal.fortifies) h[f.from] = 'source';
      }
    }
    return h;
  }, [myTurn, legal, mode, selected, target]);

  const attackInfo = selected && target ? legal?.attacks.find((a) => a.from === selected && a.to === target) : null;
  const fortifyInfo = selected && target ? legal?.fortifies.find((f) => f.from === selected && f.to === target) : null;

  // Only dim when we are choosing a source/target.
  const dimOthers = myTurn && (mode === 'attack' || mode === 'fortify') && !!selected;

  return (
    <div className="game">
      <div className="map-area">
        <div className="topbar">
          <div className="topbar-left">
            <strong>{conn.name}</strong> <code className="code small">{gameId}</code>
            {spectator && <span className="spectator-badge">👁 Spectating</span>}
            {conn.presence.spectators > 0 && (
              <span className="muted small" title="people watching this game">
                {' '}
                · 👁 {conn.presence.spectators} watching
              </span>
            )}
            {!conn.connected && <span className="error"> · reconnecting…</span>}
          </div>
          <PhaseSteps phase={view.phase} />
          <div className="topbar-right">
            {current && (
              <span className="turn-indicator">
                <span className="swatch" style={{ background: current.color }} />
                {myTurn ? 'Your turn' : `${current.name}'s turn`} · round {view.round}
              </span>
            )}
          </div>
        </div>

        <GameMap
          view={view}
          hidden={fogHidden}
          highlights={highlights}
          pendingPlacements={pending}
          attackArrow={anim.attackArrow}
          flashes={anim.flashes}
          moves={anim.moves}
          floats={anim.floats}
          sweeps={anim.sweeps}
          onTerritoryClick={onTerritoryClick}
          dimOthers={dimOthers}
        />

        {anim.battle && (
          <DicePanel battle={anim.battle.ev} rolling={anim.battle.rolling} attackerColor={colorOf(anim.battle.ev.attacker)} defenderColor={colorOf(anim.battle.ev.defender)} names={names} mapId={view.options.map} />
        )}

        {banner && (
          <div className="banner" key={banner.text} style={{ borderColor: banner.color }}>
            {banner.text}
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
        {conn.updateAvailable && (
          <div className="update-banner">
            A new version of the game is available.{' '}
            <button className="small primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}

        {/* ---------- action bar ---------- */}
        <div className="action-bar">
          {view.phase === 'finished' ? (
            <div className="action-group">
              <strong>🏆 {names[view.winner ?? ''] ?? 'Someone'} wins!</strong>
              <button onClick={leaveSpectate}>Back to lobby list</button>
            </div>
          ) : !me ? (
            <div className="action-group">
              <span className="muted">
                👁 You are watching. {current ? `${current.name} is playing (${view.phase}).` : ''}
              </span>
              {fogOn && (
                <span className="fog-controls">
                  Fog view:{' '}
                  {fogAs ? (
                    <strong style={{ color: colorOf(fogAs) }}>{names[fogAs]}</strong>
                  ) : (
                    <strong>whole map</strong>
                  )}
                  <button className={`small ${followTurn ? 'primary' : ''}`} onClick={() => { setFollowTurn(true); setFogPin(null); }}>
                    Follow turn
                  </button>
                  <button className="small" onClick={() => { setFollowTurn(false); setFogPin(null); }}>
                    Whole map
                  </button>
                </span>
              )}
              <span className="spacer" />
              <button className="small" onClick={copyWatchLink}>
                {copiedWatch ? 'Copied!' : 'Copy watch link'}
              </button>
              {view.phase === 'lobby' && onJoin && (
                <button className="small primary" onClick={onJoin}>
                  Join
                </button>
              )}
              <button className="small" onClick={onLeave}>
                Leave
              </button>
            </div>
          ) : !me.alive ? (
            <div className="action-group muted">
              You were eliminated. <button onClick={leaveSpectate}>Leave</button>
            </div>
          ) : !myTurn ? (
            <div className="action-group muted">
              Waiting for <span style={{ color: current?.color }}>{current?.name}</span>…
              <button className="small" onClick={() => setShowCards(true)}>
                Cards ({me.cardCount})
              </button>
              <button className="small danger" onClick={surrender}>
                Surrender
              </button>
            </div>
          ) : legal!.pendingConquest ? (
            <div className="action-group">
              <strong>
                Conquered {shortName(legal!.pendingConquest.to)}! Move in armies from {shortName(legal!.pendingConquest.from)}:
              </strong>
              <input
                type="range"
                min={legal!.pendingConquest.minArmies}
                max={legal!.pendingConquest.maxArmies}
                value={moveArmies}
                onChange={(e) => setMoveArmies(Number(e.target.value))}
              />
              <span className="num">{moveArmies}</span>
              <button className="primary" disabled={busy} onClick={occupy}>
                Move in
              </button>
            </div>
          ) : legal!.mustTrade ? (
            <div className="action-group">
              <strong>You must trade a card set.</strong>
              <button className="primary" onClick={() => setShowCards(true)}>
                Open cards
              </button>
            </div>
          ) : mode === 'place' ? (
            <div className="action-group">
              <strong>
                {view.phase === 'setup' ? 'Setup: ' : 'Reinforce: '}
                place {legal!.placeLimit - pendingTotal} more {legal!.placeLimit - pendingTotal === 1 ? 'army' : 'armies'}
                {view.phase === 'setup' && legal!.canPlaceOn.some((t) => view.territories[t].owner === null) ? ' — claim a territory' : ''}
              </strong>
              <span className="muted small">click = +1 · shift-click = all</span>
              {pendingTotal > 0 && (
                <>
                  <button className="primary" disabled={busy} onClick={() => submitPlacements(pending).then(() => setPending({}))}>
                    Confirm {pendingTotal}
                  </button>
                  <button onClick={() => setPending({})}>Reset</button>
                </>
              )}
              {view.phase === 'reinforce' && (
                <button className="small" onClick={() => setShowCards(true)}>
                  Cards ({me.cardCount})
                </button>
              )}
            </div>
          ) : mode === 'attack' ? (
            <div className="action-group">
              {attackInfo ? (
                <>
                  <strong>
                    {shortName(selected!)} ({view.territories[selected!].armies}) → {shortName(target!)} ({view.territories[target!].armies})
                  </strong>
                  <label className="inline">
                    Dice
                    <select value={Math.min(dice, attackInfo.maxDice)} onChange={(e) => setDice(Number(e.target.value))}>
                      {Array.from({ length: attackInfo.maxDice }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" disabled={busy} onClick={() => attack(false)}>
                    Roll
                  </button>
                  <button className="danger" disabled={busy} onClick={() => attack(true)}>
                    Blitz
                  </button>
                  <button onClick={() => setTarget(null)}>Cancel</button>
                </>
              ) : selected ? (
                <strong>Attack from {shortName(selected)}: choose a highlighted enemy territory</strong>
              ) : (
                <strong>Attack: choose one of your territories (2+ armies) or end the phase</strong>
              )}
              <span className="spacer" />
              <button className="small" onClick={() => setShowCards(true)}>
                Cards ({me.cardCount})
              </button>
              <button disabled={busy} onClick={endAttack}>
                End attack → fortify
              </button>
              <button disabled={busy} onClick={endTurn}>
                End turn
              </button>
            </div>
          ) : mode === 'fortify' ? (
            <div className="action-group">
              {fortifyInfo ? (
                <>
                  <strong>
                    Fortify {shortName(selected!)} → {shortName(target!)}
                  </strong>
                  <input type="range" min={1} max={fortifyInfo.maxArmies} value={moveArmies} onChange={(e) => setMoveArmies(Number(e.target.value))} />
                  <span className="num">{moveArmies}</span>
                  <button className="primary" disabled={busy} onClick={fortify}>
                    Move & end turn
                  </button>
                  <button onClick={() => setTarget(null)}>Cancel</button>
                </>
              ) : selected ? (
                <strong>Fortify from {shortName(selected)}: choose a destination</strong>
              ) : (
                <strong>Fortify (optional): choose a source territory, or end your turn</strong>
              )}
              <span className="spacer" />
              <button disabled={busy} onClick={endTurn}>
                End turn
              </button>
            </div>
          ) : (
            <div className="action-group muted">…</div>
          )}
        </div>
      </div>

      {/* ---------- sidebar ---------- */}
      <aside className="sidebar">
        <div className="players-panel">
          {view.players.map((p) => (
            <div
              key={p.id}
              className={`player-row ${p.id === view.currentPlayer ? 'active' : ''} ${!p.alive ? 'dead' : ''} ${fogAs === p.id ? 'fog-as' : ''} ${spectator && fogOn && !p.isNeutral ? 'clickable' : ''}`}
              onClick={() => !p.isNeutral && pickFog(p.id)}
              title={spectator && fogOn ? `Click to see the board as ${p.name} sees it` : undefined}
            >
              <span className="swatch" style={{ background: p.color }} />
              <span className="pname">
                {p.name}
                {p.isBot && ' 🤖'}
                {p.id === you && ' (you)'}
                {!p.isBot && !p.isNeutral && <span className={`online-dot ${conn.presence.online.includes(p.id) ? 'on' : ''}`} title={conn.presence.online.includes(p.id) ? 'online' : 'offline'} />}
              </span>
              <span className="pstats" title="territories · armies · cards">
                {p.territoryCount}t · {p.armyCount}a · {p.cardCount}c
                {view.options.capitals && ` · ${Object.values(view.capitals ?? {}).filter((t) => view.territories[t]?.owner === p.id).length}★`}
              </span>
              {spectator && p.cards && p.cards.length > 0 && <HandSummary cards={p.cards} shortName={shortName} />}
            </div>
          ))}
          {me && (
            <div className="muted small reinforcement-hint">
              Next turn: +{reinforcementPreview(view, me.id)} armies
            </div>
          )}
        </div>
        <div className="tabs">
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
            Log
          </button>
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            Chat {conn.chat.length ? `(${conn.chat.length})` : ''}
          </button>
        </div>
        {tab === 'log' ? <Log batches={conn.batches} view={view} /> : <Chat conn={conn} canSend={!!session} />}
      </aside>

      {showCards && me && (
        <CardsPanel
          mapId={view.options.map}
          cardValues={view.options.cardValues}
          cards={me.cards ?? []}
          tradeCount={view.tradeCount}
          canTrade={myTurn && (view.phase === 'reinforce' || !!legal?.mustTrade)}
          mustTrade={!!legal?.mustTrade && myTurn}
          onTrade={trade}
          onClose={() => setShowCards(false)}
        />
      )}
    </div>
  );
}

const CARD_ICON: Record<Card['kind'], string> = { infantry: '🪖', cavalry: '🐎', artillery: '💣', wild: '🃏' };

function HandSummary({ cards, shortName }: { cards: Card[]; shortName: (id: string) => string }) {
  return (
    <div className="hand-summary" onClick={(e) => e.stopPropagation()}>
      {cards.map((c) => (
        <span key={c.id} className={`hand-card ${c.kind}`} title={c.kind === 'wild' ? 'Wild' : `${c.kind} · ${shortName(c.territory!)}`}>
          {CARD_ICON[c.kind]} {c.kind === 'wild' ? 'Wild' : shortName(c.territory!)}
        </span>
      ))}
    </div>
  );
}

function reinforcementPreview(view: GameView, pid: string): number {
  const p = view.players.find((x) => x.id === pid);
  if (!p) return 0;
  const map = getMap(view.options.map);
  const base = Math.max(3, Math.floor(p.territoryCount / 3));
  const caps = view.options.capitals ? Object.values(view.capitals ?? {}).filter((t) => view.territories[t]?.owner === pid).length * 2 : 0;
  return base + p.continents.reduce((n, c) => n + (map.continentById[c]?.bonus ?? 0), 0) + caps;
}

function PhaseSteps({ phase }: { phase: GameView['phase'] }) {
  const steps: GameView['phase'][] = ['reinforce', 'attack', 'fortify'];
  if (phase === 'setup') return <div className="phase-steps">Setup</div>;
  if (phase === 'finished') return <div className="phase-steps">Game over</div>;
  return (
    <div className="phase-steps">
      {steps.map((s) => (
        <span key={s} className={`step ${s === phase ? 'active' : ''}`}>
          {s}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animation state derived from event batches.
// ---------------------------------------------------------------------------

interface AnimState {
  battle: { ev: BattleEvent; rolling: boolean } | null;
  attackArrow: { from: string; to: string } | null;
  flashes: Record<string, number>;
  moves: MoveAnim[];
  floats: FloatAnim[];
  sweeps: SweepAnim[];
}

function useAnimations(
  batches: EventBatch[],
  view: GameView,
  colorOf: (pid: string | null | undefined) => string,
  setBanner: (b: { text: string; color: string } | null) => void,
) {
  const [state, setState] = useState<AnimState>({ battle: null, attackArrow: null, flashes: {}, moves: [], floats: [], sweeps: [] });
  const seen = useRef(0);
  const queue = useRef<BattleEvent[]>([]);
  const running = useRef(false);
  const ids = useRef(0);

  const pumpBattles = useCallback(() => {
    if (running.current) return;
    const next = queue.current.shift();
    if (!next) {
      setState((s) => ({ ...s, attackArrow: null }));
      return;
    }
    running.current = true;
    setState((s) => ({ ...s, battle: { ev: next, rolling: true }, attackArrow: { from: next.from, to: next.to } }));
    setTimeout(() => {
      setState((s) => ({ ...s, battle: { ev: next, rolling: false } }));
      const more = queue.current.length > 0;
      setTimeout(
        () => {
          running.current = false;
          if (!more) setState((s) => (s.battle?.ev === next ? { ...s, battle: null, attackArrow: null } : s));
          pumpBattles();
        },
        more ? BATTLE_SHOW_MS : BATTLE_LINGER_MS,
      );
    }, BATTLE_ROLL_MS);
  }, []);

  useEffect(() => {
    const fresh = batches.filter((b) => b.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = batches[batches.length - 1].id;
    const flashes: Record<string, number> = {};
    const moves: MoveAnim[] = [];
    const floats: FloatAnim[] = [];
    const sweeps: SweepAnim[] = [];
    let newBattles = 0;
    const myId = view.you;
    for (const b of fresh) {
      const battles = (b.events as GameEvent[]).filter((e): e is BattleEvent => e.type === 'battle');
      if (battles.length) {
        // Don't let the replay fall far behind the live board: a fresh batch trims the backlog,
        // and the viewer's own battles jump the queue entirely.
        const mine = battles.some((e) => e.attacker === myId || e.defender === myId);
        queue.current = mine ? [] : queue.current.slice(-2);
      }
      for (const e of b.events as GameEvent[]) {
        switch (e.type) {
          case 'battle':
            queue.current.push(e);
            newBattles++;
            break;
          case 'conquered':
            flashes[e.to] = Date.now();
            sweeps.push({ id: ++ids.current, territory: e.to, from: e.from, color: colorOf(e.player) });
            break;
          case 'moved':
            moves.push({ id: ++ids.current, from: e.from, to: e.to, armies: e.armies, color: colorOf(e.player) });
            break;
          case 'placed':
            floats.push({ id: ++ids.current, territory: e.territory, text: `+${e.armies}`, color: colorOf(e.player) });
            break;
          case 'turn_started':
            setBanner({ text: `${view.players.find((p) => p.id === e.player)?.name ?? 'Someone'}'s turn`, color: colorOf(e.player) });
            break;
          case 'eliminated':
            setBanner({ text: `${view.players.find((p) => p.id === e.player)?.name ?? 'Someone'} is out!`, color: colorOf(e.player) });
            break;
          case 'game_over':
            setBanner({ text: `🏆 ${view.players.find((p) => p.id === e.winner)?.name ?? 'Someone'} wins!`, color: colorOf(e.winner) });
            break;
        }
      }
    }
    if (Object.keys(flashes).length || moves.length || floats.length || sweeps.length) {
      setState((s) => ({ ...s, flashes: { ...s.flashes, ...flashes }, moves: [...s.moves, ...moves], floats: [...s.floats, ...floats], sweeps: [...s.sweeps, ...sweeps] }));
      setTimeout(() => {
        setState((s) => ({
          ...s,
          moves: s.moves.filter((m) => !moves.includes(m)),
          floats: s.floats.filter((f) => !floats.includes(f)),
          sweeps: s.sweeps.filter((f) => !sweeps.includes(f)),
        }));
      }, 1600);
    }
    if (newBattles) pumpBattles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches]);

  return state;
}
