import { addPlayer, createGame, getMap, startGame, type GameState } from '@risk/engine';
import { DEFAULT_OPTIONS } from '../src/presets.js';

/**
 * The frozen live game: six players, each with one 30-65 stack on its capital next to another player's big
 * stack. s0 holds Peru (41) between Venezuela (63), Brazil (18) and Argentina (3, a plain territory).
 */
export function frozenBoard(fog: boolean): GameState {
  let state = createGame('F1', { ...DEFAULT_OPTIONS, maxPlayers: 6, map: 'classic', fogOfWar: fog, blizzards: 0, chooseCapitals: false }, 9);
  for (let i = 0; i < 6; i++) state = addPlayer(state, `s${i}`, `P${i}`, true);
  state = startGame(state).state;
  const ids = getMap('classic').territoryIds;
  for (const t of ids) state.territories[t] = { owner: 's4', armies: 1 };
  const put = (t: string, owner: string, armies: number) => (state.territories[t] = { owner, armies });
  put('peru', 's0', 41);
  put('venezuela', 's1', 63);
  put('brazil', 's2', 18);
  put('argentina', 's3', 3);
  put('alaska', 's3', 2);
  put('iceland', 's5', 2);
  put('siam', 's5', 2);
  state.capitals = { s0: 'peru', s1: 'venezuela', s2: 'brazil', s3: 'alaska', s4: 'ural', s5: 'iceland' };
  state.phase = 'attack';
  state.currentPlayer = 's0';
  state.pendingConquest = null;
  state.players.forEach((p) => (p.conqueredThisTurn = false));
  return state;
}
