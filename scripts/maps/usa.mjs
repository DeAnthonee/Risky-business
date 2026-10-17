// USA: 45 territories (US states, small north-eastern states merged), 8 regions, up to 10 players.
// Shapes come from us-atlas (US Census state boundaries). Alaska and Hawaii are drawn as insets in
// the empty space off the Pacific coast and reach the mainland by sea.
// part = state name (or FIPS code) | { c: name, box: [lonMin, lonMax, latMin, latMax] }
export default {
  id: 'usa',
  name: 'USA (45)',
  maxPlayers: 10,
  source: 'us-states',
  minArea: 0.1,
  simplify: 0.002,
  projection: { type: 'conicEqualArea', rotate: [96, 0], parallels: [29.5, 45.5] },
  continents: [
    { id: 'pacific', name: 'Pacific', bonus: 3, label: [-119.6, 30.9] },
    { id: 'rockies', name: 'Rockies', bonus: 4, label: [-111, 50] },
    { id: 'southwest', name: 'Southwest', bonus: 4, label: [-107, 29] },
    { id: 'great_plains', name: 'Great Plains', bonus: 6, label: [-97, 50] },
    { id: 'great_lakes', name: 'Great Lakes', bonus: 3, label: [-86, 48.6] },
    { id: 'south', name: 'Deep South', bonus: 4, label: [-91, 28.2] },
    { id: 'southeast', name: 'Southeast', bonus: 4, label: [-76, 30] },
    { id: 'northeast', name: 'Northeast', bonus: 3, label: [-75.5, 46.3] },
  ],
  territories: [
    // Pacific
    {
      id: 'alaska', name: 'Alaska', continent: 'pacific', anchor: [-151, 64],
      inset: { from: [-152, 63], to: [-124, 55.5], scale: [0.36, 0.4] },
      parts: [{ c: 'Alaska', box: [-180, -129, 50, 72] }],
    },
    {
      id: 'hawaii', name: 'Hawaii', continent: 'pacific', anchor: [-155.5, 19.6],
      inset: { from: [-157.5, 20.5], to: [-114.5, 28.6], scale: 1.3 },
      parts: ['Hawaii'],
    },
    { id: 'washington', name: 'Washington', continent: 'pacific', anchor: [-120.5, 47.4], parts: ['Washington'] },
    { id: 'oregon', name: 'Oregon', continent: 'pacific', anchor: [-120.6, 43.9], parts: ['Oregon'] },
    { id: 'california', name: 'California', continent: 'pacific', anchor: [-120, 37], parts: ['California'] },
    // Rockies
    { id: 'idaho', name: 'Idaho', continent: 'rockies', anchor: [-114.6, 43.9], parts: ['Idaho'] },
    { id: 'montana', name: 'Montana', continent: 'rockies', anchor: [-109.6, 47], parts: ['Montana'] },
    { id: 'wyoming', name: 'Wyoming', continent: 'rockies', anchor: [-107.5, 43], parts: ['Wyoming'] },
    { id: 'utah', name: 'Utah', continent: 'rockies', anchor: [-111.6, 39.3], parts: ['Utah'] },
    { id: 'colorado', name: 'Colorado', continent: 'rockies', anchor: [-105.5, 39], parts: ['Colorado'] },
    // Southwest
    { id: 'nevada', name: 'Nevada', continent: 'southwest', anchor: [-116.8, 39.4], parts: ['Nevada'] },
    { id: 'arizona', name: 'Arizona', continent: 'southwest', anchor: [-111.7, 34.3], parts: ['Arizona'] },
    { id: 'new_mexico', name: 'New Mexico', continent: 'southwest', anchor: [-106.1, 34.4], parts: ['New Mexico'] },
    { id: 'texas', name: 'Texas', continent: 'southwest', anchor: [-99.3, 31.3], parts: ['Texas'] },
    { id: 'oklahoma', name: 'Oklahoma', continent: 'southwest', anchor: [-97.4, 35.5], parts: ['Oklahoma'] },
    // Great Plains
    { id: 'north_dakota', name: 'North Dakota', continent: 'great_plains', anchor: [-100.5, 47.4], parts: ['North Dakota'] },
    { id: 'south_dakota', name: 'South Dakota', continent: 'great_plains', anchor: [-100.3, 44.4], parts: ['South Dakota'] },
    { id: 'nebraska', name: 'Nebraska', continent: 'great_plains', anchor: [-99.8, 41.5], parts: ['Nebraska'] },
    { id: 'kansas', name: 'Kansas', continent: 'great_plains', anchor: [-98.4, 38.5], parts: ['Kansas'] },
    { id: 'minnesota', name: 'Minnesota', continent: 'great_plains', anchor: [-94.4, 46], parts: ['Minnesota'] },
    { id: 'iowa', name: 'Iowa', continent: 'great_plains', anchor: [-93.4, 42], parts: ['Iowa'] },
    { id: 'missouri', name: 'Missouri', continent: 'great_plains', anchor: [-92.5, 38.4], parts: ['Missouri'] },
    // Great Lakes
    { id: 'wisconsin', name: 'Wisconsin', continent: 'great_lakes', anchor: [-89.8, 44.6], parts: ['Wisconsin'] },
    { id: 'michigan', name: 'Michigan', continent: 'great_lakes', anchor: [-84.7, 43.4], parts: ['Michigan'] },
    { id: 'illinois', name: 'Illinois', continent: 'great_lakes', anchor: [-89.2, 40.2], parts: ['Illinois'] },
    { id: 'indiana', name: 'Indiana', continent: 'great_lakes', anchor: [-86.2, 39.8], parts: ['Indiana'] },
    { id: 'ohio', name: 'Ohio', continent: 'great_lakes', anchor: [-82.7, 40.3], parts: ['Ohio'] },
    // Deep South
    { id: 'arkansas', name: 'Arkansas', continent: 'south', anchor: [-92.4, 34.8], parts: ['Arkansas'] },
    { id: 'louisiana', name: 'Louisiana', continent: 'south', anchor: [-92.4, 31.1], parts: ['Louisiana'] },
    { id: 'mississippi', name: 'Mississippi', continent: 'south', anchor: [-89.7, 32.6], parts: ['Mississippi'] },
    { id: 'alabama', name: 'Alabama', continent: 'south', anchor: [-86.7, 32.7], parts: ['Alabama'] },
    { id: 'tennessee', name: 'Tennessee', continent: 'south', anchor: [-86.9, 35.75], parts: ['Tennessee'] },
    { id: 'kentucky', name: 'Kentucky', continent: 'south', anchor: [-84.6, 37.7], parts: ['Kentucky'] },
    // Southeast
    { id: 'georgia', name: 'Georgia', continent: 'southeast', anchor: [-83.7, 32.4], parts: ['Georgia'] },
    { id: 'florida', name: 'Florida', continent: 'southeast', anchor: [-81.6, 28.3], parts: ['Florida'] },
    { id: 'south_carolina', name: 'South Carolina', continent: 'southeast', anchor: [-80.5, 33.65], parts: ['South Carolina'] },
    { id: 'north_carolina', name: 'North Carolina', continent: 'southeast', anchor: [-79.2, 35.65], parts: ['North Carolina'] },
    { id: 'virginia', name: 'Virginia', continent: 'southeast', anchor: [-77.8, 37.2], parts: ['Virginia'] },
    { id: 'west_virginia', name: 'West Virginia', continent: 'southeast', anchor: [-80.9, 38.9], parts: ['West Virginia'] },
    // Northeast
    { id: 'pennsylvania', name: 'Pennsylvania', continent: 'northeast', anchor: [-77.8, 40.9], parts: ['Pennsylvania'] },
    { id: 'new_york', name: 'New York', continent: 'northeast', anchor: [-75.7, 42.8], parts: ['New York'] },
    { id: 'new_jersey', name: 'New Jersey', continent: 'northeast', anchor: [-73.4, 40.35], parts: ['New Jersey'] },
    { id: 'maryland', name: 'Maryland & Delaware', continent: 'northeast', anchor: [-74.1, 38.1], parts: ['Maryland', 'Delaware', 'District of Columbia'] },
    { id: 'southern_new_england', name: 'Southern New England', continent: 'northeast', anchor: [-70.7, 41.9], parts: ['Massachusetts', 'Connecticut', 'Rhode Island'] },
    { id: 'northern_new_england', name: 'Northern New England', continent: 'northeast', anchor: [-69.4, 45.2], parts: ['Maine', 'New Hampshire', 'Vermont'] },
  ],
  edges: [
    // Pacific
    ['alaska', 'washington'], ['hawaii', 'california'],
    ['washington', 'oregon'], ['washington', 'idaho'],
    ['oregon', 'california'], ['oregon', 'idaho'], ['oregon', 'nevada'],
    ['california', 'nevada'], ['california', 'arizona'],
    // Rockies
    ['idaho', 'montana'], ['idaho', 'wyoming'], ['idaho', 'utah'], ['idaho', 'nevada'],
    ['montana', 'wyoming'], ['montana', 'north_dakota'], ['montana', 'south_dakota'],
    ['wyoming', 'south_dakota'], ['wyoming', 'nebraska'], ['wyoming', 'colorado'], ['wyoming', 'utah'],
    ['utah', 'colorado'], ['utah', 'nevada'], ['utah', 'arizona'],
    ['colorado', 'nebraska'], ['colorado', 'kansas'], ['colorado', 'oklahoma'], ['colorado', 'new_mexico'],
    // Southwest
    ['nevada', 'arizona'], ['arizona', 'new_mexico'],
    ['new_mexico', 'texas'], ['new_mexico', 'oklahoma'],
    ['texas', 'oklahoma'], ['texas', 'arkansas'], ['texas', 'louisiana'],
    ['oklahoma', 'kansas'], ['oklahoma', 'missouri'], ['oklahoma', 'arkansas'],
    // Great Plains
    ['north_dakota', 'south_dakota'], ['north_dakota', 'minnesota'],
    ['south_dakota', 'minnesota'], ['south_dakota', 'nebraska'], ['south_dakota', 'iowa'],
    ['nebraska', 'iowa'], ['nebraska', 'kansas'], ['nebraska', 'missouri'],
    ['kansas', 'missouri'],
    ['minnesota', 'iowa'], ['minnesota', 'wisconsin'],
    ['iowa', 'wisconsin'], ['iowa', 'illinois'], ['iowa', 'missouri'],
    ['missouri', 'illinois'], ['missouri', 'kentucky'], ['missouri', 'tennessee'], ['missouri', 'arkansas'],
    // Great Lakes
    ['wisconsin', 'michigan'], ['wisconsin', 'illinois'],
    ['illinois', 'indiana'], ['illinois', 'kentucky'],
    ['indiana', 'michigan'], ['indiana', 'ohio'], ['indiana', 'kentucky'],
    ['michigan', 'ohio'],
    ['ohio', 'pennsylvania'], ['ohio', 'west_virginia'], ['ohio', 'kentucky'],
    // Deep South
    ['arkansas', 'louisiana'], ['arkansas', 'mississippi'], ['arkansas', 'tennessee'],
    ['louisiana', 'mississippi'],
    ['mississippi', 'alabama'], ['mississippi', 'tennessee'],
    ['alabama', 'tennessee'], ['alabama', 'georgia'], ['alabama', 'florida'],
    ['tennessee', 'kentucky'], ['tennessee', 'georgia'], ['tennessee', 'north_carolina'], ['tennessee', 'virginia'],
    ['kentucky', 'west_virginia'], ['kentucky', 'virginia'],
    // Southeast
    ['georgia', 'florida'], ['georgia', 'south_carolina'], ['georgia', 'north_carolina'],
    ['south_carolina', 'north_carolina'], ['north_carolina', 'virginia'],
    ['virginia', 'west_virginia'], ['virginia', 'maryland'],
    ['west_virginia', 'maryland'], ['west_virginia', 'pennsylvania'],
    // Northeast
    ['pennsylvania', 'new_york'], ['pennsylvania', 'new_jersey'], ['pennsylvania', 'maryland'],
    ['new_york', 'new_jersey'], ['new_york', 'southern_new_england'], ['new_york', 'northern_new_england'],
    ['new_jersey', 'maryland'],
    ['southern_new_england', 'northern_new_england'],
  ],
};
