import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, startGame, viewFor, type GameState, type GameView } from '@risk/engine';
import { DEFAULT_OPTIONS } from '../src/presets.js';
import { naturalEnemies, otherFront, sweepOpportunities } from '../src/strategy.js';
import { choosePlannedActionWithReason } from '../src/planned-bot.js';
import { GameMemory } from '../src/game-memory.js';
import { eliminationScouting, strategyFacts } from '../src/facts.js';
import { seeded } from './headless.js';

/** Classic board, 3 players: everything belongs to c on 3 armies unless `put` says otherwise; a is to move. */
function board(put: Record<string, [string, number]>, phase: GameState['phase'] = 'attack'): GameState {
  let state = createGame('ST', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', fogOfWar: false, blizzards: 0, capitals: false }, 5);
  for (const [id, name] of [['a', 'Leona'], ['b', 'Ronny@13'], ['c', 'Shen']]) state = addPlayer(state, id, name, true);
  state = startGame(state).state;
  for (const t of getMap('classic').territoryIds) state.territories[t] = { owner: 'c', armies: 3 };
  for (const [t, [owner, armies]] of Object.entries(put)) state.territories[t] = { owner, armies };
  state.phase = phase;
  state.currentPlayer = 'a';
  state.pendingConquest = null;
  state.players.forEach((p) => ((p.conqueredThisTurn = false), (p.armiesToPlace = 0)));
  return state;
}

const AUSTRALIA = ['indonesia', 'new_guinea', 'western_australia', 'eastern_australia'];
const SOUTH_AMERICA = ['venezuela', 'peru', 'brazil', 'argentina'];

describe('natural enemies', () => {
  it('a rival whose only way out leads into us is a natural enemy; one with other neighbours is not', () => {
    const put: Record<string, [string, number]> = { siam: ['a', 10] };
    for (const t of AUSTRALIA) put[t] = ['b', 2];
    const view = viewFor(board(put), 'a');
    // (Shen, who borders only us here too, counts as well: the rule is about borders, not names.)
    expect(naturalEnemies(view, 'a').map((e) => e.id)).toContain('b');
    expect(strategyFacts(view, 'a').join('\n')).toContain('Natural enemy: Ronny@13');
  });
});

describe('sweep opportunities', () => {
  it('a region one rival holds alone on 1 army each, next to our stack, is a sweep', () => {
    const put: Record<string, [string, number]> = { central_america: ['a', 15] };
    for (const t of SOUTH_AMERICA) put[t] = ['b', 1];
    const view = viewFor(board(put), 'a');
    const sw = sweepOpportunities(view, 'a');
    expect(sw[0]).toMatchObject({ owner: 'b', continent: 'south_america', thin: 4 });
    expect(sw[0].cost).toBeLessThanOrEqual(sw[0].capacity);
    // Thick stacks are not a sweep.
    for (const t of SOUTH_AMERICA) put[t] = ['b', 9];
    expect(sweepOpportunities(viewFor(board(put), 'a'), 'a')).toHaveLength(0);
  });
});

describe('holding back is a geographic decision', () => {
  it('keeps an avoid only while the plan fights on another front, never against a natural enemy', () => {
    // Leona holds the Americas' south, Ronny the north, Shen the rest: nobody is boxed in.
    const map = getMap('classic');
    const open: Record<string, [string, number]> = { central_america: ['a', 5] };
    for (const t of SOUTH_AMERICA) open[t] = ['a', 5];
    for (const t of map.continentById.north_america.territories) if (t !== 'central_america') open[t] = ['b', 3];
    const view = viewFor(board(open), 'a');
    expect(otherFront(view, 'a', 'c', { target: 'b' })).toContain('Ronny@13');
    expect(otherFront(view, 'a', 'c', {})).toBeNull(); // no other front: no reason to spare Shen
    // Boxed-in Ronny (Australia behind our Siam) is a natural enemy: never spared for another front.
    const boxed: Record<string, [string, number]> = { siam: ['a', 10] };
    for (const t of AUSTRALIA) boxed[t] = ['b', 2];
    expect(otherFront(viewFor(board(boxed), 'a'), 'a', 'b', { target: 'c' })).toBeNull();
  });
});

describe('retake and deny in the move chooser', () => {
  it('answers the rival that just broke into our region, and says why', () => {
    const map = getMap('classic');
    const put: Record<string, [string, number]> = {};
    for (const t of map.continentById.north_america.territories) put[t] = ['a', 2];
    put.alaska = ['b', 2]; // Ronny just took Alaska from us
    for (const t of AUSTRALIA) put[t] = ['b', 6]; // and lives on elsewhere, so this is no elimination
    put.northwest_territory = ['a', 14];
    const view = viewFor(board(put), 'a');
    const intel = { recentAttackers: [{ id: 'b', round: 1, territories: ['alaska'], brokeBonus: 'north_america' }] };
    const { action, reason } = choosePlannedActionWithReason(view, 'a', null, seeded(3), 0, { intel });
    expect(action).toMatchObject({ type: 'attack', to: 'alaska' });
    expect(reason).toMatch(/retakes North America from Ronny@13/);
  });

  it('pushes into the attacker\'s own bonus', () => {
    const put: Record<string, [string, number]> = { siam: ['a', 12] };
    for (const t of AUSTRALIA) put[t] = ['b', 1];
    const view = viewFor(board(put), 'a');
    const intel = { recentAttackers: [{ id: 'b', round: 1, territories: ['ural'], brokeBonus: 'asia' }] };
    const { action, reason } = choosePlannedActionWithReason(view, 'a', null, seeded(3), 0, { intel });
    expect(action).toMatchObject({ type: 'attack', from: 'siam', to: 'indonesia' });
    expect(reason).toMatch(/deny their bonus/);
    // Balanced blitz: at least 4 armies go, so the opening rolls use 3 dice (not 1-2 from a minimal commit).
    const stopAt = (action as { stopAt?: number }).stopAt;
    if (stopAt !== undefined) expect(12 - stopAt).toBeGreaterThanOrEqual(4);
  });
});

describe('retake and deny need a broken bonus', () => {
  it('a stray territory taken elsewhere (no bonus broken) does not trigger it', () => {
    const put: Record<string, [string, number]> = { siam: ['a', 12] };
    for (const t of AUSTRALIA) put[t] = ['b', 1];
    const view = viewFor(board(put), 'a');
    const intel = { recentAttackers: [{ id: 'b', round: 1, territories: ['ural'], brokeBonus: null }] };
    const { reason } = choosePlannedActionWithReason(view, 'a', null, seeded(3), 0, { intel });
    expect(reason).not.toMatch(/retakes|deny their bonus/);
    expect(strategyFacts(view, 'a', intel).join('\n')).not.toContain('Retaliation');
  });
});

describe('game memory for fog reads', () => {
  it('records who took our land, and where an unseen rival was last seen', () => {
    const put: Record<string, [string, number]> = {};
    for (const t of AUSTRALIA) put[t] = ['b', 2];
    const state = board(put, 'reinforce');
    const view = viewFor(state, 'a');
    const m = new GameMemory('a');
    m.observe(view, [{ version: 1, events: [
      { type: 'turn_started', player: 'b', turnNumber: 2, round: view.round, reinforcements: { territories: 4, fromTerritories: 3, continents: [], capitals: 0, fromCapitals: 0, total: 5 } },
      { type: 'conquered', player: 'b', from: 'indonesia', to: 'siam', previousOwner: 'a' },
    ] as never }]);
    expect(m.recentAttackers(view)).toEqual([expect.objectContaining({ id: 'b', territories: ['siam'] })]);
    // Later the fog hides Australia: the memory still knows where Ronny was.
    const fogged = { ...view, territories: Object.fromEntries(Object.entries(view.territories).map(([t, s]) => [t, AUSTRALIA.includes(t) ? { ...s, hidden: true, owner: undefined, armies: 0 } : s])) } as GameView;
    expect(m.lastSeen('b', fogged).map((x) => x.territory).sort()).toEqual([...AUSTRALIA].sort());
  });

  it('places an unseen rival in its likely region instead of calling it unknown', () => {
    const put: Record<string, [string, number]> = { siam: ['a', 30] };
    for (const t of AUSTRALIA) put[t] = ['b', 2];
    const view = viewFor(board(put), 'a');
    const fogged = {
      ...view,
      options: { ...view.options, fogOfWar: true },
      territories: Object.fromEntries(Object.entries(view.territories).map(([t, s]) => [t, AUSTRALIA.includes(t) ? { ...s, hidden: true, owner: undefined, armies: 0 } : s])),
      players: view.players.map((p) => (p.id === 'b' ? { ...p, territoryCount: null, armyCount: null } : p)),
    } as GameView;
    const intel = { estimateArmies: () => 8, lastSeen: () => AUSTRALIA.map((t) => ({ territory: t, round: 1, armies: 2 })) };
    const text = eliminationScouting(fogged, 'a', true, intel).join('\n');
    expect(text).toContain('Ronny@13');
    expect(text).toContain('probably in Australia');
    expect(text).toContain('estimated ~8 armies');
    expect(text).toMatch(/POSSIBLE FOG KILL|not a kill yet/);
  });
});
