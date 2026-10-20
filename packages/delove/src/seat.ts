import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legalMoves, type Action, type GameState, type GameView, type PlayerId } from '@risk/engine';
import { RiskHttpError, type RiskApi } from '@risk/mcp';
import { candidates, makeTraits, type Agent } from '@risk/selfplay';
import { modelsDir, seatOrder } from './net-agent.js';
import { DEFAULT_TEACHER_PARAMS, makeTeacher, teacher, type TeacherParams } from './teacher.js';

/**
 * Plays one seat of a real game over the HTTP API with a Delove player version (the teacher or a trained network):
 * wait for the turn, rebuild the board from this seat's view, pick a move from the self-play candidates, send it.
 * No chat, no character: Delove only plays.
 */

/**
 * The engine state behind one player's view. Hidden parts (deck, discard, other hands, the RNG) are left empty:
 * legal moves and Delove's encoder never read them.
 */
export function stateFromView(view: GameView): GameState {
  const { players, deckSize: _d, discardSize: _s, you: _y, legal: _l, continentOwners: _c, ...rest } = view;
  return {
    ...rest,
    players: players.map(({ cardCount: _cc, territoryCount: _tc, armyCount: _ac, continents: _co, income: _i, cards, ...p }) => ({
      ...p,
      cards: cards ?? [],
    })),
    deck: [],
    discard: [],
    seed: 0,
    rngState: 0,
  };
}

/** Delove's move for this view, or null when it is not this seat's turn. */
export function chooseFromView(agent: Agent, view: GameView, me: PlayerId, random: () => number): Action | null {
  const state = stateFromView(view);
  const legal = view.legal ?? legalMoves(state, me);
  if (!legal.yourTurn) return null;
  const cands = candidates(state, me, legal);
  if (cands.length === 0) return null;
  return agent.choose({ state, me, seat: seatOrder(state).indexOf(me), legal, candidates: cands, traits: makeTraits(), random });
}

export function discoverTunedTeachers(dir = modelsDir()): Agent[] {
  if (!existsSync(dir)) return [];
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir).filter((f) => /^delove-teacher@\d+\.json$/.test(f));
  return files.sort((a, b) => version(a) - version(b)).map((f) => {
    const id = f.replace(/\.json$/, '');
    const params: TeacherParams = { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
    return makeTeacher(id, params);
  });
}

export function defaultName(id: string): string {
  if (id === teacher.id || id === 'sensei@1' || id === 'sensei') return 'Sensei 1';
  if (id === 'delove-teacher@2' || id === 'sensei@2') return 'Sensei 2';
  if (id === 'jacob-sensei@1' || id === 'jacob' || id === 'sensei@3') return 'Sensei 3';
  const m = /^delove@(\d+)(-explore)?$/.exec(id);
  return m ? `Delove ${m[1]}${m[2] ? ' (explore)' : ''}` : id;
}

export interface SeatOptions {
  api: RiskApi;
  gameId: string;
  playerId: PlayerId;
  /** This seat's secret; never logged. */
  token: string;
  name: string;
  agent: Agent;
  /** Pause after each action so spectators can follow. */
  paceMs: number;
  log: (line: string) => void;
  random?: () => number;
}

const WAIT_MS = 25_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Plays until the game ends (or the seat is eliminated). Resolves with the last view. */
export async function playSeat(o: SeatOptions): Promise<GameView | null> {
  const random = o.random ?? Math.random;
  let since: number | undefined;
  let view: GameView | null = null;
  let failures = 0;
  for (;;) {
    let yourTurn: boolean;
    const started = Date.now();
    try {
      const w = await o.api.wait(o.gameId, o.token, since, WAIT_MS);
      view = w.state;
      yourTurn = w.yourTurn;
      failures = 0;
    } catch (e) {
      if (e instanceof RiskHttpError && (e.status === 404 || e.status === 401)) {
        o.log(`${o.name}: game is gone (${e.message})`);
        return view;
      }
      const pause = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      o.log(`${o.name}: wait failed (${(e as Error).message}); retrying in ${pause / 1000} s`);
      await sleep(pause);
      continue;
    }
    const unchanged = since !== undefined && view.version === since;
    since = view.version;
    if (view.phase === 'finished') return view;
    const me = view.players.find((p) => p.id === o.playerId);
    if (me && !me.alive) {
      o.log(`${o.name}: eliminated`);
      return view;
    }
    if (!yourTurn) {
      if (unchanged && Date.now() - started < 1000) await sleep(1000);
      continue;
    }
    // Our turn: keep acting on the fresh view each action returns until the turn passes.
    while (view.phase !== 'finished' && view.currentPlayer === o.playerId) {
      const action = chooseFromView(o.agent, view, o.playerId, random);
      if (!action) break;
      try {
        const res = await o.api.act(o.gameId, o.token, action);
        view = res.state;
        since = view.version;
        o.log(`${o.name}: ${describe(action)}`);
      } catch (e) {
        o.log(`${o.name}: ${describe(action)} refused (${(e as Error).message})`);
        await sleep(1000);
        break;
      }
      if (o.paceMs > 0) await sleep(o.paceMs);
    }
    if (view.phase === 'finished') return view;
  }
}

function describe(a: Action): string {
  switch (a.type) {
    case 'place':
      return `place ${Object.entries(a.placements).map(([t, n]) => `${n} on ${t}`).join(', ')}`;
    case 'attack':
      return `attack ${a.from} -> ${a.to}${a.blitz ? ' (blitz)' : ''}`;
    case 'occupy':
      return `move ${a.armies} in`;
    case 'fortify':
      return `fortify ${a.armies} ${a.from} -> ${a.to}`;
    case 'trade':
      return `trade cards ${a.cardIds.join(', ')}`;
    case 'choose_capital':
      return `capital ${a.territory}`;
    default:
      return a.type.replace('_', ' ');
  }
}
