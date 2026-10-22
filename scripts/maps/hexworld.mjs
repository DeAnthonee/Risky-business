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
    { id: 'alaska', name: 'Alaska', continent: 'north_america', site: [-152, 64] },
    { id: 'northwest_territory', name: 'Northwest Territory', continent: 'north_america', site: [-120, 64] },
    { id: 'nunavut', name: 'Nunavut', continent: 'north_america', site: [-95, 66] },
    { id: 'greenland', name: 'Greenland', continent: 'north_america', site: [-42, 72] },
    { id: 'western_canada', name: 'Western Canada', continent: 'north_america', site: [-115, 54] },
    { id: 'quebec', name: 'Quebec', continent: 'north_america', site: [-72, 52] },
    { id: 'western_us', name: 'Western US', continent: 'north_america', site: [-116, 40] },
    { id: 'central_us', name: 'Central US', continent: 'north_america', site: [-98, 40] },
    { id: 'eastern_us', name: 'Eastern US', continent: 'north_america', site: [-82, 36] },
    // Central America
    { id: 'mexico', name: 'Mexico', continent: 'central_america', site: [-103, 24] },
    { id: 'central_america', name: 'Central America', continent: 'central_america', site: [-88, 15] },
    { id: 'caribbean', name: 'Caribbean', continent: 'central_america', site: [-78, 21.5], island: true },
    // South America
    { id: 'colombia', name: 'Colombia', continent: 'south_america', site: [-74, 4] },
    { id: 'venezuela', name: 'Venezuela', continent: 'south_america', site: [-63, 6] },
    { id: 'peru', name: 'Peru', continent: 'south_america', site: [-75, -10] },
    { id: 'amazonas', name: 'Amazonas', continent: 'south_america', site: [-62, -5] },
    { id: 'brazil', name: 'Brazil', continent: 'south_america', site: [-45, -12] },
    { id: 'bolivia', name: 'Bolivia & Paraguay', continent: 'south_america', site: [-62, -20] },
    { id: 'argentina', name: 'Argentina', continent: 'south_america', site: [-62, -32] },
    { id: 'patagonia', name: 'Patagonia', continent: 'south_america', site: [-69, -45] },
    // Europe
    { id: 'iceland', name: 'Iceland', continent: 'europe', site: [-18, 65], island: true },
    { id: 'british_isles', name: 'British Isles', continent: 'europe', site: [-2, 53], island: true },
    { id: 'scandinavia', name: 'Scandinavia', continent: 'europe', site: [15, 63] },
    { id: 'iberia', name: 'Iberia', continent: 'europe', site: [-4, 40] },
    { id: 'western_europe', name: 'Western Europe', continent: 'europe', site: [2, 47], cells: [[3.7, 52.2]] },
    { id: 'central_europe', name: 'Central Europe', continent: 'europe', site: [14, 51] },
    { id: 'italy', name: 'Italy', continent: 'europe', site: [13.5, 42], island: true, anchor: [14, 41.9] },
    { id: 'balkans', name: 'Balkans', continent: 'europe', site: [22, 43] },
    { id: 'eastern_europe', name: 'Eastern Europe', continent: 'europe', site: [30, 50] },
    // Russia
    { id: 'western_russia', name: 'Western Russia', continent: 'russia', site: [42, 58] },
    { id: 'ural', name: 'Ural', continent: 'russia', site: [62, 62] },
    { id: 'siberia', name: 'Siberia', continent: 'russia', site: [90, 63] },
    { id: 'yakutsk', name: 'Yakutsk', continent: 'russia', site: [125, 65] },
    { id: 'irkutsk', name: 'Irkutsk', continent: 'russia', site: [112, 54] },
    { id: 'kamchatka', name: 'Kamchatka', continent: 'russia', site: [160, 62] },
    // Middle East
    { id: 'turkey', name: 'Turkey', continent: 'middle_east', site: [34, 39] },
    { id: 'caucasus', name: 'Caucasus', continent: 'middle_east', site: [45, 41] },
    { id: 'levant', name: 'Levant & Iraq', continent: 'middle_east', site: [40, 33] },
    { id: 'arabia', name: 'Arabia', continent: 'middle_east', site: [46, 23] },
    { id: 'persia', name: 'Persia', continent: 'middle_east', site: [54, 32] },
    // Central Asia
    { id: 'kazakhstan', name: 'Kazakhstan', continent: 'central_asia', site: [67, 48] },
    { id: 'turkestan', name: 'Turkestan', continent: 'central_asia', site: [62, 40] },
    { id: 'afghanistan', name: 'Afghanistan', continent: 'central_asia', site: [66, 34] },
    { id: 'pakistan', name: 'Pakistan', continent: 'central_asia', site: [69, 28] },
    // South Asia
    { id: 'india', name: 'India', continent: 'south_asia', site: [77, 19] },
    { id: 'bengal', name: 'Bengal & Himalaya', continent: 'south_asia', site: [88, 25] },
    // East Asia
    { id: 'tibet', name: 'Tibet & Xinjiang', continent: 'east_asia', site: [86, 35] },
    { id: 'china', name: 'China', continent: 'east_asia', site: [112, 35] },
    { id: 'south_china', name: 'South China', continent: 'east_asia', site: [110, 25] },
    { id: 'manchuria', name: 'Manchuria', continent: 'east_asia', site: [126, 46] },
    { id: 'mongolia', name: 'Mongolia', continent: 'east_asia', site: [104, 46] },
    { id: 'korea', name: 'Korea', continent: 'east_asia', site: [127.5, 37] },
    { id: 'japan', name: 'Japan', continent: 'east_asia', site: [138, 36], island: true },
    // Southeast Asia
    { id: 'indochina', name: 'Indochina', continent: 'southeast_asia', site: [102, 16] },
    { id: 'philippines', name: 'Philippines', continent: 'southeast_asia', site: [122, 12], island: true },
    { id: 'sumatra', name: 'Sumatra & Java', continent: 'southeast_asia', site: [102, -2] },
    { id: 'borneo', name: 'Borneo', continent: 'southeast_asia', site: [114, 0] },
    { id: 'new_guinea', name: 'New Guinea', continent: 'southeast_asia', site: [142, -5] },
    // Oceania
    { id: 'western_australia', name: 'Western Australia', continent: 'oceania', site: [122, -25] },
    { id: 'queensland', name: 'Queensland', continent: 'oceania', site: [144, -21] },
    { id: 'new_south_wales', name: 'New South Wales', continent: 'oceania', site: [146, -32] },
    { id: 'new_zealand', name: 'New Zealand', continent: 'oceania', site: [173, -41], island: true },
    { id: 'hawaii', name: 'Hawaii', continent: 'oceania', site: [-157, 20.5], island: true },
    // North Africa
    { id: 'maghreb', name: 'Maghreb', continent: 'north_africa', site: [0, 31] },
    { id: 'libya', name: 'Libya', continent: 'north_africa', site: [17, 27] },
    { id: 'egypt', name: 'Egypt', continent: 'north_africa', site: [29, 26] },
    { id: 'sahara', name: 'Sahara', continent: 'north_africa', site: [-4, 20] },
    { id: 'sahel', name: 'Sahel', continent: 'north_africa', site: [13, 16] },
    { id: 'west_africa', name: 'West Africa', continent: 'north_africa', site: [-4, 10] },
    // East Africa
    { id: 'sudan', name: 'Sudan', continent: 'east_africa', site: [30, 14] },
    { id: 'ethiopia', name: 'Ethiopia', continent: 'east_africa', site: [39, 9] },
    { id: 'horn', name: 'Horn of Africa', continent: 'east_africa', site: [46, 5] },
    { id: 'east_africa', name: 'East Africa', continent: 'east_africa', site: [35, -5] },
    { id: 'madagascar', name: 'Madagascar', continent: 'east_africa', site: [47, -19], island: true },
    // Southern Africa
    { id: 'congo', name: 'Congo', continent: 'southern_africa', site: [20, 0] },
    { id: 'angola', name: 'Angola', continent: 'southern_africa', site: [17, -12] },
    { id: 'zambia', name: 'Zambia', continent: 'southern_africa', site: [28, -13] },
    { id: 'mozambique', name: 'Mozambique', continent: 'southern_africa', site: [36, -17] },
    { id: 'kalahari', name: 'Kalahari', continent: 'southern_africa', site: [19, -23] },
    { id: 'south_africa', name: 'South Africa', continent: 'southern_africa', site: [26, -29] },
  ],
  // Overseas connectors; land borders come from touching hexes.
  seaLanes: [
    ['alaska', 'kamchatka'],
    ['greenland', 'nunavut'], ['greenland', 'quebec'],
    ['iceland', 'british_isles'], ['iceland', 'scandinavia'],
    ['british_isles', 'scandinavia'],
    ['eastern_us', 'caribbean'], ['mexico', 'caribbean'], ['central_america', 'caribbean'], ['caribbean', 'venezuela'],
    ['brazil', 'west_africa'],
    ['italy', 'maghreb'],
    ['east_africa', 'madagascar'], ['mozambique', 'madagascar'],
    ['kamchatka', 'japan'], ['korea', 'japan'],
    ['south_china', 'philippines'], ['philippines', 'borneo'], ['indochina', 'sumatra'], ['borneo', 'new_guinea'],
    ['sumatra', 'western_australia'], ['new_guinea', 'queensland'], ['new_south_wales', 'new_zealand'],
    ['western_us', 'hawaii'], ['hawaii', 'new_zealand'],
  ],
  wrapEdges: [['alaska', 'kamchatka']],
};
