import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, MAPS, reinforcementsFor, RULES_TEXT, startGame, viewFor, type GameState, type MapId } from '../src/index.js';

const map = getMap('mega_earth');

/** A two-seat Mega Earth game where `me` holds exactly `mine` and the other seat everything else. */
function holding(mine: string[], blizzards: string[] = []): { s: GameState; me: string } {
  let s = createGame('Z', { map: 'mega_earth', maxPlayers: 2, autoSetup: true }, 7);
  s = addPlayer(s, 'a', 'A');
  s = addPlayer(s, 'b', 'B');
  s = startGame(s).state;
  const me = s.currentPlayer!;
  const other = s.players.find((p) => p.id !== me)!.id;
  const set = new Set(mine);
  for (const t of map.territoryIds) s.territories[t] = { ...s.territories[t], owner: set.has(t) ? me : other };
  s.blizzards = blizzards;
  return { s, me };
}

const base = (n: number) => Math.max(3, Math.floor(n / 3));
const zone = (id: string) => map.zoneById[id];

describe('Mega Earth bonus zones', () => {
  it('only Mega Earth has zones', () => {
    for (const id of Object.keys(MAPS) as MapId[]) expect(MAPS[id].zones.length > 0).toBe(id === 'mega_earth');
  });

  it('micro zones of 5-9 connected hexes cover the board once, inside their section or region', () => {
    const micros = map.zones.filter((z) => z.tier === 'micro');
    expect(micros.flatMap((z) => z.territories).sort()).toEqual([...map.territoryIds].sort());
    for (const z of micros) {
      expect(z.territories.length).toBeGreaterThanOrEqual(5);
      expect(z.territories.length).toBeLessThanOrEqual(9);
      expect(z.bonus === 2 || z.bonus === 3).toBe(true);
      const set = new Set(z.territories);
      const seen = new Set([z.territories[0]]);
      const stack = [z.territories[0]];
      while (stack.length) for (const n of map.adjacency[stack.pop()!]) if (set.has(n) && !seen.has(n)) (seen.add(n), stack.push(n));
      expect([z.id, seen.size]).toEqual([z.id, z.territories.length]);
      const parent = map.zoneById[z.parent!] ?? map.continentById[z.parent!];
      expect(z.territories.every((t) => parent.territories.includes(t))).toBe(true);
    }
    for (const s of map.zones.filter((z) => z.tier === 'section')) expect(s.territories.every((t) => map.continentById[s.parent!].territories.includes(t))).toBe(true);
  });

  it('the rules text gives the zone counts and continent bonuses the map has', () => {
    const count = (tier: string) => map.zones.filter((z) => z.tier === tier).length;
    expect(RULES_TEXT).toContain(`${count('micro')} micro`);
    expect(RULES_TEXT).toContain(`${count('section')} sections`);
    for (const z of map.zones.filter((x) => x.tier === 'continent')) expect(RULES_TEXT).toContain(`${z.name} +${z.bonus}`);
  });

  it('Oceania has three sections', () => {
    expect(map.zones.filter((z) => z.parent === 'oceania').map((z) => z.name)).toEqual(['Western Australia', 'Queensland', 'New South Wales & Pacific']);
  });

  it('one micro zone pays only its own bonus', () => {
    const z = map.zones.find((x) => x.tier === 'micro')!;
    const { s, me } = holding(z.territories);
    const r = reinforcementsFor(s, me);
    expect(r.continents).toEqual([]);
    expect(r.zones).toEqual([{ id: z.id, bonus: z.bonus }]);
    expect(r.total).toBe(base(z.territories.length) + z.bonus);
  });

  it('a whole region stacks its micro zones, its sections and the region bonus', () => {
    const oceania = map.continentById.oceania;
    const { s, me } = holding(oceania.territories);
    const r = reinforcementsFor(s, me);
    const inside = map.zones.filter((z) => z.territories.every((t) => oceania.territories.includes(t)));
    expect(inside.filter((z) => z.tier === 'section')).toHaveLength(3);
    expect(r.continents).toEqual([{ id: 'oceania', bonus: oceania.bonus }]);
    expect(r.zones!.map((z) => z.id).sort()).toEqual(inside.map((z) => z.id).sort());
    expect(r.total).toBe(base(43) + oceania.bonus + inside.reduce((n, z) => n + z.bonus, 0));
  });

  it('all of Africa adds the continent bonus: half its three regions again', () => {
    const regions = ['north_africa', 'east_africa', 'southern_africa'].map((id) => map.continentById[id]);
    const { s, me } = holding(regions.flatMap((c) => c.territories));
    const r = reinforcementsFor(s, me);
    expect(zone('c_africa').bonus).toBe(Math.round(0.5 * regions.reduce((n, c) => n + c.bonus, 0)));
    expect(r.zones).toContainEqual({ id: 'c_africa', bonus: zone('c_africa').bonus });
    expect(r.continents.map((c) => c.id).sort()).toEqual(['east_africa', 'north_africa', 'southern_africa']);
  });

  it('leaves a blizzard out of a zone, like a region', () => {
    const z = map.zones.find((x) => x.tier === 'micro')!;
    const [frozen, ...rest] = z.territories;
    const { s, me } = holding(rest, [frozen]);
    expect(reinforcementsFor(s, me).zones).toEqual([{ id: z.id, bonus: z.bonus }]);
  });

  it('the view lists the zones a player holds; boards without zones leave the field out', () => {
    const z = map.zones.find((x) => x.tier === 'micro')!;
    const { s, me } = holding(z.territories);
    expect(viewFor(s, null).players.find((p) => p.id === me)!.zones).toEqual([z.id]);
    let c = createGame('C', { map: 'classic', maxPlayers: 2, autoSetup: true }, 7);
    c = startGame(addPlayer(addPlayer(c, 'a', 'A'), 'b', 'B')).state;
    expect(reinforcementsFor(c, c.currentPlayer!).zones).toBeUndefined();
    expect(viewFor(c, null).players[0].zones).toBeUndefined();
  });
});
