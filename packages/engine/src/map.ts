/**
 * Classic Risk world map: 42 territories, 6 continents.
 */
export type ContinentId =
  | 'north_america'
  | 'south_america'
  | 'europe'
  | 'africa'
  | 'asia'
  | 'australia';

export interface ContinentDef {
  id: ContinentId;
  name: string;
  bonus: number;
  territories: string[];
}

export interface TerritoryDef {
  id: string;
  name: string;
  continent: ContinentId;
  /** Layout hint for clients (0..1000 x 0..560). */
  x: number;
  y: number;
}

const T = (id: string, name: string, continent: ContinentId, x: number, y: number): TerritoryDef => ({
  id,
  name,
  continent,
  x,
  y,
});

export const TERRITORIES: TerritoryDef[] = [
  // North America
  T('alaska', 'Alaska', 'north_america', 62, 92),
  T('northwest_territory', 'Northwest Territory', 'north_america', 158, 82),
  T('greenland', 'Greenland', 'north_america', 310, 52),
  T('alberta', 'Alberta', 'north_america', 138, 150),
  T('ontario', 'Ontario', 'north_america', 212, 152),
  T('quebec', 'Quebec', 'north_america', 286, 150),
  T('western_united_states', 'Western United States', 'north_america', 140, 222),
  T('eastern_united_states', 'Eastern United States', 'north_america', 226, 226),
  T('central_america', 'Central America', 'north_america', 160, 296),
  // South America
  T('venezuela', 'Venezuela', 'south_america', 228, 352),
  T('peru', 'Peru', 'south_america', 222, 428),
  T('brazil', 'Brazil', 'south_america', 306, 408),
  T('argentina', 'Argentina', 'south_america', 246, 510),
  // Europe
  T('iceland', 'Iceland', 'europe', 404, 92),
  T('scandinavia', 'Scandinavia', 'europe', 490, 60),
  T('ukraine', 'Ukraine', 'europe', 584, 124),
  T('great_britain', 'Great Britain', 'europe', 404, 150),
  T('northern_europe', 'Northern Europe', 'europe', 488, 144),
  T('western_europe', 'Western Europe', 'europe', 418, 244),
  T('southern_europe', 'Southern Europe', 'europe', 516, 236),
  // Africa
  T('north_africa', 'North Africa', 'africa', 452, 318),
  T('egypt', 'Egypt', 'africa', 534, 310),
  T('east_africa', 'East Africa', 'africa', 568, 366),
  T('congo', 'Congo', 'africa', 506, 408),
  T('south_africa', 'South Africa', 'africa', 516, 488),
  T('madagascar', 'Madagascar', 'africa', 598, 474),
  // Asia
  T('ural', 'Ural', 'asia', 656, 92),
  T('siberia', 'Siberia', 'asia', 724, 58),
  T('yakutsk', 'Yakutsk', 'asia', 806, 50),
  T('kamchatka', 'Kamchatka', 'asia', 898, 70),
  T('irkutsk', 'Irkutsk', 'asia', 776, 132),
  T('mongolia', 'Mongolia', 'asia', 796, 196),
  T('japan', 'Japan', 'asia', 900, 186),
  T('afghanistan', 'Afghanistan', 'asia', 646, 196),
  T('china', 'China', 'asia', 736, 250),
  T('middle_east', 'Middle East', 'asia', 604, 256),
  T('india', 'India', 'asia', 684, 310),
  T('siam', 'Siam', 'asia', 768, 318),
  // Australia
  T('indonesia', 'Indonesia', 'australia', 776, 408),
  T('new_guinea', 'New Guinea', 'australia', 876, 384),
  T('western_australia', 'Western Australia', 'australia', 806, 494),
  T('eastern_australia', 'Eastern Australia', 'australia', 890, 486),
];

export const TERRITORY_IDS: string[] = TERRITORIES.map((t) => t.id);
export const TERRITORY_BY_ID: Record<string, TerritoryDef> = Object.fromEntries(
  TERRITORIES.map((t) => [t.id, t]),
);

const CONTINENT_BONUS: Record<ContinentId, [string, number]> = {
  north_america: ['North America', 5],
  south_america: ['South America', 2],
  europe: ['Europe', 5],
  africa: ['Africa', 3],
  asia: ['Asia', 7],
  australia: ['Australia', 2],
};

export const CONTINENTS: ContinentDef[] = (Object.keys(CONTINENT_BONUS) as ContinentId[]).map((id) => ({
  id,
  name: CONTINENT_BONUS[id][0],
  bonus: CONTINENT_BONUS[id][1],
  territories: TERRITORIES.filter((t) => t.continent === id).map((t) => t.id),
}));

export const CONTINENT_BY_ID: Record<ContinentId, ContinentDef> = Object.fromEntries(
  CONTINENTS.map((c) => [c.id, c]),
) as Record<ContinentId, ContinentDef>;

/** Undirected edges. Each pair listed once. */
const EDGES: [string, string][] = [
  // North America
  ['alaska', 'northwest_territory'],
  ['alaska', 'alberta'],
  ['alaska', 'kamchatka'],
  ['northwest_territory', 'alberta'],
  ['northwest_territory', 'ontario'],
  ['northwest_territory', 'greenland'],
  ['greenland', 'ontario'],
  ['greenland', 'quebec'],
  ['greenland', 'iceland'],
  ['alberta', 'ontario'],
  ['alberta', 'western_united_states'],
  ['ontario', 'quebec'],
  ['ontario', 'western_united_states'],
  ['ontario', 'eastern_united_states'],
  ['quebec', 'eastern_united_states'],
  ['western_united_states', 'eastern_united_states'],
  ['western_united_states', 'central_america'],
  ['eastern_united_states', 'central_america'],
  ['central_america', 'venezuela'],
  // South America
  ['venezuela', 'peru'],
  ['venezuela', 'brazil'],
  ['peru', 'brazil'],
  ['peru', 'argentina'],
  ['brazil', 'argentina'],
  ['brazil', 'north_africa'],
  // Europe
  ['iceland', 'great_britain'],
  ['iceland', 'scandinavia'],
  ['scandinavia', 'great_britain'],
  ['scandinavia', 'northern_europe'],
  ['scandinavia', 'ukraine'],
  ['ukraine', 'northern_europe'],
  ['ukraine', 'southern_europe'],
  ['ukraine', 'ural'],
  ['ukraine', 'afghanistan'],
  ['ukraine', 'middle_east'],
  ['great_britain', 'northern_europe'],
  ['great_britain', 'western_europe'],
  ['northern_europe', 'southern_europe'],
  ['northern_europe', 'western_europe'],
  ['western_europe', 'southern_europe'],
  ['western_europe', 'north_africa'],
  ['southern_europe', 'middle_east'],
  ['southern_europe', 'egypt'],
  ['southern_europe', 'north_africa'],
  // Africa
  ['north_africa', 'egypt'],
  ['north_africa', 'east_africa'],
  ['north_africa', 'congo'],
  ['egypt', 'middle_east'],
  ['egypt', 'east_africa'],
  ['east_africa', 'congo'],
  ['east_africa', 'south_africa'],
  ['east_africa', 'madagascar'],
  ['east_africa', 'middle_east'],
  ['congo', 'south_africa'],
  ['south_africa', 'madagascar'],
  // Asia
  ['ural', 'siberia'],
  ['ural', 'china'],
  ['ural', 'afghanistan'],
  ['siberia', 'yakutsk'],
  ['siberia', 'irkutsk'],
  ['siberia', 'mongolia'],
  ['siberia', 'china'],
  ['yakutsk', 'kamchatka'],
  ['yakutsk', 'irkutsk'],
  ['kamchatka', 'irkutsk'],
  ['kamchatka', 'mongolia'],
  ['kamchatka', 'japan'],
  ['irkutsk', 'mongolia'],
  ['mongolia', 'japan'],
  ['mongolia', 'china'],
  ['afghanistan', 'china'],
  ['afghanistan', 'india'],
  ['afghanistan', 'middle_east'],
  ['china', 'india'],
  ['china', 'siam'],
  ['middle_east', 'india'],
  ['india', 'siam'],
  ['siam', 'indonesia'],
  // Australia
  ['indonesia', 'new_guinea'],
  ['indonesia', 'western_australia'],
  ['new_guinea', 'western_australia'],
  ['new_guinea', 'eastern_australia'],
  ['western_australia', 'eastern_australia'],
];

export const ADJACENCY: Record<string, string[]> = (() => {
  const adj: Record<string, string[]> = {};
  for (const t of TERRITORY_IDS) adj[t] = [];
  for (const [a, b] of EDGES) {
    if (!adj[a] || !adj[b]) throw new Error(`Bad edge ${a}-${b}`);
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
})();

export const EDGE_LIST: ReadonlyArray<readonly [string, string]> = EDGES;

export function isAdjacent(a: string, b: string): boolean {
  return ADJACENCY[a]?.includes(b) ?? false;
}

export function isTerritory(id: string): boolean {
  return id in TERRITORY_BY_ID;
}
