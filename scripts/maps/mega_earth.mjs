// Mega Earth: Hex Earth on a finer globe (frequency 16: 2562 cells, 674 of them land) where every land hexagon is its own
// territory, for the 100-player mega tournament (owner, 2026-10-28: "all 100 players play on the world map, but i want
// enough territories for the 100"): about 6.7 territories a player, like classic Risk's 42 for 6. Hex Earth's
// territories only name the hexes ("Beringia 3") and its regions group them; its sea lanes join the closest hexes.
// Region bonuses are the builder's classic suggestion (size and entry points). Up to 100 players.
import hexworld from './hexworld.mjs';

export default {
  ...hexworld,
  id: 'mega_earth',
  name: 'Mega Earth',
  maxPlayers: 100,
  frequency: 16,
  cellTerritories: true,
  autoBonus: true,
  badgeGap: 10,
  // Closing ice (the engine's ice.ts): each hex's ring count from either pole, sea counted.
  poleRings: true,
  // Two land hexes the finer grid finds that no Hex Earth site reaches over land: a Malacca shore hex and an Arctic islet.
  sea: [...hexworld.sea, [102.1, 3.8]],
  ice: [...hexworld.ice, [-94, 75.5]],
  // Layered bonuses (owner, 2026-10-28: "micro bonuses that need about 5 to 8 territories, ... a continent has multiple mid
  // level bonuses, and then if you get all the continent then you get a much bigger bonus"). Each layer pays on top of the
  // ones inside it: micro zones (built from the Hex Earth sites below, 5-8 hexes each) inside sections (Hex Earth sites
  // grouped by hand; regions under 25 hexes have none) inside the regions, and continents over several regions.
  zones: {
    micro: { min: 5, max: 8, bonus: 2, busyBonus: 3, busyNeighbours: 6 },
    sections: {
      north_america: [
        { id: 'arctic_north', name: 'Arctic North', sites: ['beringia', 'mackenzie', 'nunavut'] },
        { id: 'north_atlantic', name: 'Greenland & Labrador', sites: ['greenland', 'labrador'] },
        { id: 'american_west', name: 'American West', sites: ['prairies', 'great_basin'] },
        { id: 'heartland', name: 'Heartland', sites: ['great_plains', 'appalachia'] },
      ],
      south_america: [
        { id: 'northern_andes', name: 'Gran Colombia', sites: ['colombia', 'orinoco', 'amazonas'] },
        { id: 'andes', name: 'Andes', sites: ['andes', 'bolivia'] },
        { id: 'brazil', name: 'Brazil', sites: ['brazilian_highlands'] },
        { id: 'southern_cone', name: 'Southern Cone', sites: ['pampas', 'patagonia'] },
      ],
      europe: [
        { id: 'atlantic_europe', name: 'Atlantic Europe', sites: ['iceland', 'british_isles', 'iberia', 'france_benelux'] },
        { id: 'middle_europe', name: 'Middle Europe', sites: ['central_europe', 'italy', 'balkans'] },
        { id: 'north_east_europe', name: 'Nordic & Eastern Europe', sites: ['fennoscandia', 'eastern_europe'] },
      ],
      russia: [
        { id: 'european_russia', name: 'European Russia', sites: ['western_russia', 'volga_urals'] },
        { id: 'siberia', name: 'Siberia', sites: ['west_siberia', 'baikal'] },
        { id: 'russian_far_east', name: 'Russian Far East', sites: ['sakha', 'far_east'] },
      ],
      middle_east: [
        { id: 'anatolia_persia', name: 'Anatolia & Persia', sites: ['turkey', 'caucasus', 'persia'] },
        { id: 'arabia_levant', name: 'Arabia & Levant', sites: ['levant', 'arabia'] },
      ],
      central_asia: [
        { id: 'steppe', name: 'Steppe', sites: ['kazakhstan', 'turkestan'] },
        { id: 'hindu_kush_indus', name: 'Hindu Kush & Indus', sites: ['hindu_kush', 'pakistan'] },
      ],
      east_asia: [
        { id: 'china', name: 'China', sites: ['north_china', 'south_china'] },
        { id: 'inner_asia', name: 'Tibet & Mongolia', sites: ['tibet', 'gobi'] },
        { id: 'north_east_asia', name: 'Manchuria, Korea & Japan', sites: ['manchuria', 'korea', 'japan'] },
      ],
      oceania: [
        { id: 'western_australia', name: 'Western Australia', sites: ['western_plateau'] },
        { id: 'queensland_s', name: 'Queensland', sites: ['queensland'] },
        { id: 'south_pacific', name: 'New South Wales & Pacific', sites: ['new_south_wales', 'new_zealand', 'hawaii'] },
      ],
      north_africa: [
        { id: 'maghreb_sahara', name: 'Maghreb & Sahara', sites: ['maghreb', 'sahara'] },
        { id: 'nile_libya', name: 'Nile & Libya', sites: ['libya', 'nile'] },
        { id: 'west_africa_s', name: 'West Africa & Sahel', sites: ['sahel', 'west_africa'] },
      ],
      east_africa: [
        { id: 'sudan_ethiopia', name: 'Sudan & Ethiopia', sites: ['sudan', 'ethiopia'] },
        { id: 'horn_lakes', name: 'Horn & Great Lakes', sites: ['horn', 'great_lakes', 'madagascar'] },
      ],
      southern_africa: [
        { id: 'central_africa', name: 'Congo & Angola', sites: ['congo_basin', 'angola'] },
        { id: 'zambezi', name: 'Zambezi', sites: ['zambia', 'mozambique'] },
        { id: 'south_africa', name: 'Kalahari & Cape', sites: ['kalahari', 'cape'] },
      ],
    },
    // A continent pays `share` of its regions' bonuses again on top.
    continents: [
      { id: 'north_america_c', name: 'North America', regions: ['north_america', 'central_america'], share: 0.5 },
      { id: 'africa', name: 'Africa', regions: ['north_africa', 'east_africa', 'southern_africa'], share: 0.5 },
      { id: 'asia', name: 'Asia', regions: ['central_asia', 'south_asia', 'east_asia', 'southeast_asia'], share: 0.5 },
      { id: 'europe_russia', name: 'Europe & Russia', regions: ['europe', 'russia'], share: 0.5 },
    ],
  },
};
