// Dev page for the "Inception" tournament view (/?dev=inception): a planned tournament with mock tables and one live
// built-in-bot game played in the browser, until the server's tournament feed exists. No server calls.
import { useEffect, useMemo, useState } from 'react';
import {
  PLAYER_COLORS,
  addPlayer,
  applyAction,
  chooseBotAction,
  createGame,
  createRng,
  getMap,
  nextFloat,
  planNest,
  planToNest,
  resolveNest,
  startGame,
  type GameState,
  type NestNode,
} from '@risk/engine';
import { Inception, type TableSnapshot } from './Inception';

const NAMES = ['Delove', 'Komodo', 'Cobra', 'Gecko', 'Mamba', 'Viper', 'Iguana', 'Python', 'Skink', 'Taipan'];

function mockTables(nodes: NestNode[], seed: number): Record<number, TableSnapshot> {
  const rng = createRng(seed);
  const rand = () => nextFloat(rng);
  const deepest = Math.max(...nodes.map((n) => n.depth));
  const out: Record<number, TableSnapshot> = {};
  nodes.forEach((n, i) => {
    const players = Array.from({ length: n.seats }, (_, k) => ({ name: `${NAMES[(i + k) % NAMES.length]} ${1 + ((i * 7 + k) % 20)}`, color: PLAYER_COLORS[k % PLAYER_COLORS.length], alive: true }));
    if (n.depth < deepest - 1 || (n.depth === deepest - 1 && i % 4 !== 0)) {
      out[i] = { players, status: 'waiting' };
      return;
    }
    // A first-round table (or an early second-round one): dealt, some decided.
    const owners: Record<string, number> = {};
    const map = getMap(n.map);
    for (const t of map.territories) owners[t.id] = Math.floor(rand() * n.seats);
    const roll = i % 3;
    const leader = Math.floor(rand() * n.seats);
    if (roll === 0) for (const t of map.territories) owners[t.id] = leader;
    out[i] = {
      players: players.map((p, k) => ({ ...p, alive: roll === 0 ? k === leader : true })),
      owners,
      status: roll === 0 ? 'finished' : roll === 1 ? 'playing' : 'decided',
      leader,
      gameId: 'DEMO00',
    };
  });
  return out;
}

/** A built-in-bot game on one table's board, played in the browser and restarted when it ends. */
function useLiveTable(node: NestNode | undefined, seed: number): TableSnapshot | undefined {
  const [state, setState] = useState<GameState | null>(null);
  const [game, setGame] = useState(0);
  useEffect(() => {
    if (!node) return;
    let s = createGame('LIVE01', { map: node.map as GameState['options']['map'], maxPlayers: node.seats, autoSetup: true }, seed + game);
    for (let k = 0; k < node.seats; k++) s = addPlayer(s, `p${k}`, `${NAMES[k % NAMES.length]} live`, true);
    s = startGame(s).state;
    const rng = createRng(seed + game);
    const random = () => nextFloat(rng);
    let current = s;
    setState(current);
    let restart: number | undefined;
    const timer = window.setInterval(() => {
      for (let n = 0; n < 2 && current.phase !== 'finished'; n++) {
        const me = current.currentPlayer!;
        current = applyAction(current, me, chooseBotAction(current, me, random) ?? { type: 'surrender' }).state;
      }
      setState(current);
      // A finished game stays up a few seconds, then a new one starts.
      if (current.phase === 'finished' && restart === undefined) restart = window.setTimeout(() => setGame((g) => g + 1), 4000);
    }, 150);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(restart);
    };
  }, [node, seed, game]);
  return useMemo(() => {
    if (!state) return undefined;
    const ids = state.players.filter((p) => !p.isNeutral).map((p) => p.id);
    const owners: Record<string, number | null> = {};
    for (const [t, v] of Object.entries(state.territories)) owners[t] = v.owner === null ? null : ids.indexOf(v.owner);
    const counts = ids.map((id) => Object.values(state.territories).filter((v) => v.owner === id).length);
    const leader = state.winner ? ids.indexOf(state.winner) : counts.indexOf(Math.max(...counts));
    return {
      players: state.players.filter((p) => !p.isNeutral).map((p) => ({ name: p.name, color: p.color, alive: p.alive })),
      owners,
      status: state.phase === 'finished' ? 'finished' : 'playing',
      leader,
    };
  }, [state]);
}

/**
 * The demo after `rounds` more rounds: every table deeper than the round in play has finished (its leader won), and
 * the round in play is dealt and being played (mock owners). 0 leaves the mock tables as they are.
 */
function advanceRounds(nodes: NestNode[], base: Record<number, TableSnapshot>, rounds: number, seed: number): Record<number, TableSnapshot> {
  if (rounds <= 0) return base;
  const deepest = Math.max(...nodes.map((n) => n.depth));
  const playing = Math.max(0, deepest - rounds);
  const rng = createRng(seed + rounds);
  const out: Record<number, TableSnapshot> = { ...base };
  nodes.forEach((n, i) => {
    const t = base[i];
    if (!t) return;
    if (n.depth > playing) {
      const leader = t.leader ?? 0;
      const owners: Record<string, number> = {};
      for (const id of getMap(n.map).territoryIds) owners[id] = leader;
      out[i] = { ...t, owners, leader, status: 'finished', players: t.players.map((p, k) => ({ ...p, alive: k === leader })) };
    } else if (n.depth === playing) {
      const owners: Record<string, number> = {};
      for (const id of getMap(n.map).territoryIds) owners[id] = Math.floor(nextFloat(rng) * n.seats);
      out[i] = { ...t, owners, leader: 0, status: 'playing', gameId: 'DEMO00' };
    } else out[i] = { ...t, owners: undefined, status: 'waiting' };
  });
  return out;
}

export function InceptionDemo() {
  const params = new URLSearchParams(location.search);
  const players = Math.max(6, Math.min(400, Number(params.get('players')) || 100));
  const seed = Number(params.get('seed')) || 7;
  // `final=hexworld` (any existing board seating the final) plays the final there instead of on a generated board.
  const finalMap = params.get('final');
  const nodes = useMemo(() => resolveNest(planToNest(planNest(players), { seed, ...(finalMap ? { final: { map: finalMap } } : {}) }).spec), [players, seed, finalMap]);
  const base = useMemo(() => mockTables(nodes, seed), [nodes, seed]);
  const liveIndex = nodes.length - 1;
  const live = useLiveTable(nodes[liveIndex], seed);
  // "Next round" plays the demo forward a round at a time (the live globe shows the round change).
  const [rounds, setRounds] = useState(0);
  const tables = useMemo(() => {
    const now = live && rounds === 0 ? { ...base, [liveIndex]: live } : base;
    return advanceRounds(nodes, now, rounds, seed);
  }, [base, live, liveIndex, nodes, rounds, seed]);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  // Ready time: from the start of navigation to the first frame after the boards are drawn.
  useEffect(() => {
    requestAnimationFrame(() => setRenderMs(Math.round(performance.now())));
  }, [nodes]);

  return (
    <div className="inception-demo">
      <header>
        <h1>Inception view (demo)</h1>
        <p className="muted">
          {players} players · {nodes.length} boards ({nodes.filter((n) => n.portals.length === 0).length} first-round tables) · mock tables, one live bot game
          (the last board) · drawn {renderMs ?? '…'} ms after load started · <a href="?dev=inception&players=40">40</a> · <a href="?dev=inception&players=100">100</a> ·{' '}
          <a href="?dev=inception&players=250">250</a> · <a href="?dev=inception&players=40&final=hexworld">Hex Earth final</a> ·{' '}
          <button onClick={() => setRounds((n) => n + 1)}>Next round</button> <button onClick={() => setRounds(0)}>Reset</button>
        </p>
      </header>
      <Inception nodes={nodes} tables={tables} onWatch={(id) => alert(`Would open /?game=${id}&spectate=1`)} />
    </div>
  );
}
