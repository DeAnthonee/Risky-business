// Hex Earth: the whole world on a rotatable globe tiled by hexagons. A Goldberg sphere of 1442 cells
// (frequency 12); cells over real land (Natural Earth 1:50m) are land, grouped into territories of
// roughly equal size (4-5 hexes), each territory the land cells nearest its `site` (lon, lat) over
// land. Island territories (`island: true`) make their site's cell land even where the coast is too
// small for a hex. Antarctica and the far Arctic are ice: drawn, never played. Two of the twelve
// pentagon cells sit at the poles and `spin` parks the other ten in open ocean. Up to 10 players.
// Built by scripts/hex-globe.mjs; the flat view uses the World map's projection.
export default {
  id: 'hexworld',
  name: 'Hex Earth',
  kind: 'hexglobe',
  maxPlayers: 10,
  frequency: 12,
  spin: 50,
  projection: { type: 'naturalEarth1', rotate: [-10, 0] },
  // Straits and seas narrower than a hex: keep the Panama isthmus as land, and the Red Sea, the
  // Black Sea and the Caspian as water, so the real chokepoints survive.
  land: [[-94, 19], [-82.2, 9.9], [-76.6, 10.3]],
  sea: [[38.5, 20.5], [40.5, 16.5], [34.5, 43.3], [50.5, 41.5], [51, 38.5], [49.5, 44.5]],
  // Arctic islets too far from any territory to reach over land: ice.
  ice: [[-94, 80.7], [-78, 72.5]],
  continents: [
    { id: 'north_america', name: 'North America', bonus: 6, label: [-110, 16] },
    { id: 'central_america', name: 'Central America', bonus: 2, label: [-112, 10] },
    { id: 'south_america', name: 'South America', bonus: 4, label: [-28, -32] },
    { id: 'europe', name: 'Europe', bonus: 7, label: [-32, 52] },
    { id: 'russia', name: 'Russia', bonus: 5, label: [95, 76] },
    { id: 'middle_east', name: 'Middle East', bonus: 5, label: [60, 12] },
    { id: 'central_asia', name: 'Central Asia', bonus: 4, label: [70, 53] },
    { id: 'south_asia', name: 'South Asia', bonus: 2, label: [72, 8] },
    { id: 'east_asia', name: 'East Asia', bonus: 6, label: [150, 28] },
    { id: 'southeast_asia', name: 'Southeast Asia', bonus: 4, label: [105, -11] },
    { id: 'oceania', name: 'Oceania', bonus: 3, label: [152, -38] },
    { id: 'north_africa', name: 'North Africa', bonus: 5, label: [-22, 22] },
    { id: 'east_africa', name: 'East Africa', bonus: 5, label: [58, -8] },
    { id: 'southern_africa', name: 'Southern Africa', bonus: 4, label: [-2, -28] },
  ],
  territories: [
    // North America
    { id: 'beringia', name: 'Beringia', continent: 'north_america', site: [-152, 64] },
    { id: 'mackenzie', name: 'Mackenzie', continent: 'north_america', site: [-120, 64] },
    { id: 'nunavut', name: 'Nunavut', continent: 'north_america', site: [-95, 66] },
    { id: 'greenland', name: 'Greenland', continent: 'north_america', site: [-42, 72] },
    { id: 'prairies', name: 'Prairies', continent: 'north_america', site: [-115, 54] },
    { id: 'labrador', name: 'Labrador', continent: 'north_america', site: [-72, 52] },
    { id: 'great_basin', name: 'Great Basin', continent: 'north_america', site: [-116, 40] },
    { id: 'great_plains', name: 'Great Plains', continent: 'north_america', site: [-98, 40] },
    { id: 'appalachia', name: 'Appalachia', continent: 'north_america', site: [-82, 36] },
    // Central America
    { id: 'mexico', name: 'Mexico', continent: 'central_america', site: [-103, 24] },
    { id: 'isthmus', name: 'Isthmus', continent: 'central_america', site: [-88, 15] },
    { id: 'caribbean', name: 'Caribbean', continent: 'central_america', site: [-78, 21.5], island: true },
    // South America
    { id: 'colombia', name: 'Colombia', continent: 'south_america', site: [-74, 4] },
    { id: 'orinoco', name: 'Orinoco', continent: 'south_america', site: [-63, 6] },
    { id: 'andes', name: 'Andes', continent: 'south_america', site: [-75, -10] },
    { id: 'amazonas', name: 'Amazonas', continent: 'south_america', site: [-62, -5] },
    { id: 'brazilian_highlands', name: 'Brazilian Highlands', continent: 'south_america', site: [-45, -12] },
    { id: 'bolivia', name: 'Bolivia & Paraguay', continent: 'south_america', site: [-62, -20] },
    { id: 'pampas', name: 'Pampas', continent: 'south_america', site: [-62, -32] },
    { id: 'patagonia', name: 'Patagonia', continent: 'south_america', site: [-69, -45] },
    // Europe
    { id: 'iceland', name: 'Iceland', continent: 'europe', site: [-18, 65], island: true },
    { id: 'british_isles', name: 'British Isles', continent: 'europe', site: [-2, 53], island: true },
    { id: 'fennoscandia', name: 'Fennoscandia', continent: 'europe', site: [15, 63] },
    { id: 'iberia', name: 'Iberia', continent: 'europe', site: [-4, 40] },
    { id: 'france_benelux', name: 'France & Benelux', continent: 'europe', site: [2, 47], cells: [[3.7, 52.2]] },
    { id: 'central_europe', name: 'Central Europe', continent: 'europe', site: [14, 51] },
    { id: 'italy', name: 'Italy', continent: 'europe', site: [13.5, 42], island: true, anchor: [14, 41.9] },
    { id: 'balkans', name: 'Balkans', continent: 'europe', site: [22, 43] },
    { id: 'eastern_europe', name: 'Eastern Europe', continent: 'europe', site: [30, 50] },
    // Russia
    { id: 'western_russia', name: 'Western Russia', continent: 'russia', site: [42, 58] },
    { id: 'volga_urals', name: 'Volga & Urals', continent: 'russia', site: [62, 62] },
    { id: 'west_siberia', name: 'West Siberia', continent: 'russia', site: [90, 63] },
    { id: 'sakha', name: 'Sakha', continent: 'russia', site: [125, 65] },
    { id: 'baikal', name: 'Baikal', continent: 'russia', site: [112, 54] },
    { id: 'far_east', name: 'Far East', continent: 'russia', site: [160, 62] },
    // Middle East
    { id: 'turkey', name: 'Turkey', continent: 'middle_east', site: [34, 39] },
    { id: 'caucasus', name: 'Caucasus', continent: 'middle_east', site: [45, 41] },
    { id: 'levant', name: 'Levant & Iraq', continent: 'middle_east', site: [40, 33] },
    { id: 'arabia', name: 'Arabia', continent: 'middle_east', site: [46, 23] },
    { id: 'persia', name: 'Persia', continent: 'middle_east', site: [54, 32] },
    // Central Asia
    { id: 'kazakhstan', name: 'Kazakhstan', continent: 'central_asia', site: [67, 48] },
    { id: 'turkestan', name: 'Turkestan', continent: 'central_asia', site: [62, 40] },
    { id: 'hindu_kush', name: 'Hindu Kush', continent: 'central_asia', site: [66, 34] },
    { id: 'pakistan', name: 'Pakistan', continent: 'central_asia', site: [69, 28] },
    // South Asia
    { id: 'deccan', name: 'Deccan', continent: 'south_asia', site: [77, 19] },
    { id: 'bengal', name: 'Bengal & Himalaya', continent: 'south_asia', site: [88, 25] },
    // East Asia
    { id: 'tibet', name: 'Tibet & Xinjiang', continent: 'east_asia', site: [86, 35] },
    { id: 'north_china', name: 'North China Plain', continent: 'east_asia', site: [112, 35] },
    { id: 'south_china', name: 'South China', continent: 'east_asia', site: [110, 25] },
    { id: 'manchuria', name: 'Manchuria', continent: 'east_asia', site: [126, 46] },
    { id: 'gobi', name: 'Gobi', continent: 'east_asia', site: [104, 46] },
    { id: 'korea', name: 'Korea', continent: 'east_asia', site: [127.5, 37] },
    { id: 'japan', name: 'Japan', continent: 'east_asia', site: [138, 36], island: true },
    // Southeast Asia
    { id: 'indochina', name: 'Indochina', continent: 'southeast_asia', site: [102, 16] },
    { id: 'philippines', name: 'Philippines', continent: 'southeast_asia', site: [122, 12], island: true },
    { id: 'sumatra', name: 'Sumatra & Java', continent: 'southeast_asia', site: [102, -2] },
    { id: 'borneo', name: 'Borneo', continent: 'southeast_asia', site: [114, 0] },
    { id: 'new_guinea', name: 'New Guinea', continent: 'southeast_asia', site: [142, -5] },
    // Oceania
    { id: 'western_plateau', name: 'Western Plateau', continent: 'oceania', site: [122, -25] },
    { id: 'queensland', name: 'Queensland', continent: 'oceania', site: [144, -21] },
    { id: 'new_south_wales', name: 'New South Wales', continent: 'oceania', site: [146, -32] },
    { id: 'new_zealand', name: 'New Zealand', continent: 'oceania', site: [173, -41], island: true },
    { id: 'hawaii', name: 'Hawaii', continent: 'oceania', site: [-157, 20.5], island: true },
    // North Africa
    { id: 'maghreb', name: 'Maghreb', continent: 'north_africa', site: [0, 31] },
    { id: 'libya', name: 'Libya', continent: 'north_africa', site: [17, 27] },
    { id: 'nile', name: 'Nile', continent: 'north_africa', site: [29, 26] },
    { id: 'sahara', name: 'Sahara', continent: 'north_africa', site: [-4, 20] },
    { id: 'sahel', name: 'Sahel', continent: 'north_africa', site: [13, 16] },
    { id: 'west_africa', name: 'West Africa', continent: 'north_africa', site: [-4, 10] },
    // East Africa
    { id: 'sudan', name: 'Sudan', continent: 'east_africa', site: [30, 14] },
    { id: 'ethiopia', name: 'Ethiopia', continent: 'east_africa', site: [39, 9] },
    { id: 'horn', name: 'Horn of Africa', continent: 'east_africa', site: [46, 5] },
    { id: 'great_lakes', name: 'Great Lakes', continent: 'east_africa', site: [35, -5] },
    { id: 'madagascar', name: 'Madagascar', continent: 'east_africa', site: [47, -19], island: true },
    // Southern Africa
    { id: 'congo_basin', name: 'Congo Basin', continent: 'southern_africa', site: [20, 0] },
    { id: 'angola', name: 'Angola', continent: 'southern_africa', site: [17, -12] },
    { id: 'zambia', name: 'Zambia', continent: 'southern_africa', site: [28, -13] },
    { id: 'mozambique', name: 'Mozambique', continent: 'southern_africa', site: [36, -17] },
    { id: 'kalahari', name: 'Kalahari', continent: 'southern_africa', site: [19, -23] },
    { id: 'cape', name: 'Cape', continent: 'southern_africa', site: [26, -29] },
  ],
  // Overseas connectors; land borders come from touching hexes.
  seaLanes: [
    ['beringia', 'far_east'],
    ['greenland', 'nunavut'], ['greenland', 'labrador'],
    ['iceland', 'british_isles'], ['iceland', 'fennoscandia'],
    ['british_isles', 'fennoscandia'],
    ['appalachia', 'caribbean'], ['mexico', 'caribbean'], ['isthmus', 'caribbean'], ['caribbean', 'orinoco'],
    ['brazilian_highlands', 'west_africa'],
    ['italy', 'maghreb'],
    ['great_lakes', 'madagascar'], ['mozambique', 'madagascar'],
    ['far_east', 'japan'], ['korea', 'japan'],
    ['south_china', 'philippines'], ['philippines', 'borneo'], ['indochina', 'sumatra'], ['borneo', 'new_guinea'],
    ['sumatra', 'western_plateau'], ['new_guinea', 'queensland'], ['new_south_wales', 'new_zealand'],
    ['great_basin', 'hawaii'], ['hawaii', 'new_zealand'],
  ],
  wrapEdges: [['beringia', 'far_east']],
};
