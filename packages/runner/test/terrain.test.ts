import { describe, expect, it } from 'vitest';
import { getMap, viewFor } from '@risk/engine';
import { terrainBriefing, terrainTopology } from '../src/terrain.js';
import { planConquest } from '../src/campaigns.js';
import { planElimination } from '../src/eliminations.js';
import { Commander } from '../src/commander.js';
import { frozenBoard } from './frozen.js';

const options = { avoid: new Set<string>(), noAttack: new Set<string>(), floor: () => 1 };
describe('opening map reconnaissance and blocked routes', () => {
  it('removes frozen territories and all incident edges and identifies newly created dead ends', () => {
    const s = frozenBoard(false);
    s.blizzards = getMap('classic').adjacency.alaska.slice(0, 2);
    const terrain = terrainTopology(viewFor(s, 's0'));
    expect(terrain.deadEnds).toContain('alaska');
    expect(terrain.adjacency.alaska).toHaveLength(1);
    for (const frozen of s.blizzards) {
      expect(terrain.adjacency[frozen]).toBeUndefined();
      expect(Object.values(terrain.adjacency).flat()).not.toContain(frozen);
    }
  });

  it('detects isolated components and true geographic bottlenecks', () => {
    const s = frozenBoard(false);
    s.blizzards = getMap('classic').adjacency.alaska;
    const isolated = terrainTopology(viewFor(s, 's0'));
    expect(isolated.components.some(c => c.length === 1 && c[0] === 'alaska')).toBe(true);
    expect(terrainBriefing(viewFor(s, 's0'), 's0')).toContain('alaska->NO EXIT');
    s.blizzards = [];
    expect(terrainTopology(viewFor(s, 's0')).bottlenecks).toContain('siam');
  });

  it('rejects a previously usable elimination chain after a blizzard closes the entry', () => {
    const s = frozenBoard(false); s.options.capitals = false;
    for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 's4', armies: 20 };
    s.territories.indonesia = { owner: 's0', armies: 35 };
    s.territories.siam = { owner: 's1', armies: 1 };
    s.territories.india = { owner: 's1', armies: 1 };
    expect(planConquest(viewFor(s, 's0'), 's0', ['siam', 'india'], options)).not.toBeNull();
    s.blizzards = ['siam']; s.territories.siam = { owner: null, armies: 0 };
    expect(planElimination(viewFor(s, 's0'), 's0', options)).toBeNull();
    expect(terrainBriefing(viewFor(s, 's0'), 's0')).toContain('india cannot currently be reached');
  });

  it('does not invent a connection across another player or fogged holdings', () => {
    const s = frozenBoard(false); s.options.capitals = false;
    for (const t of getMap('classic').territoryIds) s.territories[t] = { owner: 's4', armies: 20 };
    s.territories.indonesia = { owner: 's0', armies: 35 };
    s.territories.india = { owner: 's1', armies: 1 };
    const v = viewFor(s, 's0');
    expect(planConquest(v, 's0', ['india'], options)).toBeNull();
    v.players.find(p => p.id === 's1')!.territoryCount = null;
    v.territories.india = { owner: null, armies: null, hidden: true };
    expect(terrainBriefing(v, 's0')).not.toContain('Route warning for P1');
  });

  it('gives the commander the full opening graph and blizzards before its first plan', async () => {
    const s = frozenBoard(false); s.round = 1; s.blizzards = ['siam'];
    let prompt = '';
    const c = new Commander({ llm: { async chat(messages) { prompt = messages.map(m => m.content).join('\n'); return '{"plan":"Budget both bonus entries"}'; } }, seatName: 'P0', playerId: 's0', profile: null, learnings: '', gameId: s.id, scoutingDir: null });
    await c.planFor(viewFor(s, 's0'));
    expect(prompt).toContain('Opening map connection graph');
    expect(prompt).toContain('Blizzards (impassable, removed from every route): siam.');
    const graph = prompt.split('Opening map connection graph')[1].split('Board facts:')[0];
    expect(graph).not.toContain('siam->');
    expect(graph).toContain('indonesia->');
  });
});
