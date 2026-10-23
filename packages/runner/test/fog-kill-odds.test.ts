import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, startGame, viewFor, type GameView } from '@risk/engine';
import { eliminationScouting } from '../src/facts.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';

function board(): GameView {
  let s = createGame('FK', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false }, 11);
  for (const [id, name] of [['a', 'Lux'], ['b', 'Jinx'], ['c', 'Thresh']]) s = addPlayer(s, id, name, true);
  return viewFor(startGame(s).state, 'a');
}

/** Hide every territory of `pid` except `keep`, as a fogged view does, and drop its public totals. */
function fog(view: GameView, pid: string, keep: string[] = []): GameView {
  const territories = Object.fromEntries(Object.entries(view.territories).map(([t, v]) =>
    [t, v.owner === pid && !keep.includes(t) ? { ...v, hidden: true, owner: undefined, armies: 0 } : v]));
  const players = view.players.map((p) => (p.id === pid ? { ...p, territoryCount: null, armyCount: null } : p));
  return { ...view, territories, players, options: { ...view.options, fogOfWar: true } } as GameView;
}

describe('kill odds under fog', () => {
  it('a rival with no visible territory is not a 100% kill', () => {
    const lines = eliminationScouting(fog(board(), 'b'), 'a', true).join('\n');
    expect(lines).toContain('Jinx: 0 cards; none of its territories are visible (fog)');
    expect(lines).not.toMatch(/Jinx[^\n]*Blitz win chance: 100%/);
  });

  it('a rival seen only away from our borders is not a kill this turn', () => {
    const base = board();
    const map = getMap('classic');
    const far = map.territoryIds.find((t) => base.territories[t].owner === 'b')!;
    // Hand Lux's territories next to it to Thresh, so Lux sees it but does not border it.
    const territories = { ...base.territories };
    for (const n of map.adjacency[far]) if (territories[n].owner === 'a') territories[n] = { ...territories[n], owner: 'c' };
    const view = { ...base, territories } as GameView;
    expect(map.territoryIds.some((t) => view.territories[t].owner === 'a')).toBe(true);
    const lines = eliminationScouting(fog(view, 'b', [far]), 'a', true).join('\n');
    expect(lines).toMatch(/Jinx[^\n]*NO SHARED BORDER/);
  });

  it('full visibility keeps the normal verdicts', () => {
    const lines = eliminationScouting(board(), 'a', true).join('\n');
    expect(lines).toContain('Jinx:');
    expect(lines).not.toContain('none of its territories are visible');
  });
});
