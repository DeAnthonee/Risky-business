// Four Crowns: a small, fast original board for up to 4 players (24 territories, 6 regions).
// Four corner kingdoms of 4 territories ring a central Heartland; four lone Waystone isles sit between
// the kingdoms and carry the sea lanes from one kingdom to the next. Each kingdom has one gate to the
// Heartland and two harbours toward its neighbours, so no corner is a safe turtle and games stay short.
// The corners are mirror images of one sketch (each coast is roughened with its own seed, so they still
// look different). Same geometry pipeline as the fantasy board: see scripts/authored-map.mjs.
const W = 900, H = 640;
const mirror = (pts, mx, my) => pts.map(([x, y]) => [mx ? W - x : x, my ? H - y : y]);

// North-west kingdom sketch; the other three corners are its mirror images.
const CORNER = [[60, 80], [110, 52], [170, 62], [230, 45], [285, 72], [304, 128], [284, 182], [302, 222], [252, 246], [190, 236], [130, 252], [74, 228], [48, 172], [64, 126]];
// Sites in the corner sketch: interior, east harbour, south harbour, Heartland gate.
const SITES = { inner: [112, 118], east: [248, 94], south: [116, 208], gate: [238, 190] };
const CENTER = [[350, 250], [402, 232], [452, 246], [505, 228], [556, 254], [566, 310], [548, 360], [560, 402], [500, 414], [450, 398], [395, 410], [344, 390], [334, 330], [352, 294]];
const ISLE_N = [[408, 58], [432, 40], [472, 44], [500, 62], [492, 90], [456, 102], [416, 92]];
const ISLE_W = [[58, 282], [90, 268], [116, 290], [120, 330], [106, 364], [74, 372], [52, 340]];

const KINGDOMS = [
  // id, name, mirror x, mirror y, territory names [inner, east-or-west harbour, north-or-south harbour, gate], label
  { id: 'frostmarch', name: 'Frostmarch', mx: false, my: false, names: ['Whitepeak', 'Glacier Bay', 'Snowfield', 'Coldharbor'], label: [175, 30] },
  { id: 'emberreach', name: 'Emberreach', mx: true, my: false, names: ['Ashcrown', 'Cinder Bay', 'Scorchfield', 'Forgegate'], label: [725, 30] },
  { id: 'mossvale', name: 'Mossvale', mx: false, my: true, names: ['Deepwood', 'Willowmere', 'Fernwatch', 'Mossgate'], label: [240, 628] },
  { id: 'sunhollow', name: 'Sunhollow', mx: true, my: true, names: ['Dunecrest', 'Amber Coast', 'Saltpan', 'Sungate'], label: [660, 628] },
];
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '_');

const kingdomTerritories = KINGDOMS.flatMap((k) =>
  ['inner', 'east', 'south', 'gate'].map((role, i) => ({
    id: slug(k.names[i]),
    name: k.names[i],
    continent: k.id,
    land: k.id,
    site: mirror([SITES[role]], k.mx, k.my)[0],
  })),
);
const t = (kingdom, role) => slug(KINGDOMS.find((k) => k.id === kingdom).names[['inner', 'east', 'south', 'gate'].indexOf(role)]);

export default {
  id: 'skirmish',
  kind: 'authored',
  name: 'Four Crowns (24)',
  maxPlayers: 4,
  size: [W, H],
  seed: 'four-crowns-1',
  // Starting armies per player live in packages/engine/src/maps.ts (STARTING_ARMIES.skirmish).
  continents: [
    ...KINGDOMS.map((k) => ({ id: k.id, name: k.name, bonus: 2, label: k.label })),
    { id: 'heartland', name: 'The Heartland', bonus: 4, label: [450, 222] },
    { id: 'waystones', name: 'The Waystones', bonus: 3, label: [450, 150] },
  ],
  landmasses: [
    ...KINGDOMS.map((k) => ({ id: k.id, outline: mirror(CORNER, k.mx, k.my) })),
    { id: 'heartland', outline: CENTER },
    { id: 'isle_n', territory: 'stormwatch', outline: ISLE_N },
    { id: 'isle_s', territory: 'tidewatch', outline: mirror(ISLE_N, false, true) },
    { id: 'isle_w', territory: 'lantern_isle', outline: ISLE_W },
    { id: 'isle_e', territory: 'beacon_isle', outline: mirror(ISLE_W, true, false) },
  ],
  territories: [
    ...kingdomTerritories,
    { id: 'crownhold', name: 'Crownhold', continent: 'heartland', land: 'heartland', site: [398, 284] },
    { id: 'highmarket', name: 'Highmarket', continent: 'heartland', land: 'heartland', site: [506, 280] },
    { id: 'kingsfield', name: 'Kingsfield', continent: 'heartland', land: 'heartland', site: [394, 364] },
    { id: 'riverhall', name: 'Riverhall', continent: 'heartland', land: 'heartland', site: [508, 360] },
    { id: 'stormwatch', name: 'Stormwatch', continent: 'waystones' },
    { id: 'tidewatch', name: 'Tidewatch', continent: 'waystones' },
    { id: 'lantern_isle', name: 'Lantern Isle', continent: 'waystones' },
    { id: 'beacon_isle', name: 'Beacon Isle', continent: 'waystones' },
  ],
  /** Crossings over water. Land borders are found from the shapes. */
  seaLanes: [
    // Kingdom gates into the Heartland
    [t('frostmarch', 'gate'), 'crownhold'], [t('emberreach', 'gate'), 'highmarket'],
    [t('mossvale', 'gate'), 'kingsfield'], [t('sunhollow', 'gate'), 'riverhall'],
    // The Waystones link each kingdom to the next
    [t('frostmarch', 'east'), 'stormwatch'], ['stormwatch', t('emberreach', 'east')],
    [t('mossvale', 'east'), 'tidewatch'], ['tidewatch', t('sunhollow', 'east')],
    [t('frostmarch', 'south'), 'lantern_isle'], ['lantern_isle', t('mossvale', 'south')],
    [t('emberreach', 'south'), 'beacon_isle'], ['beacon_isle', t('sunhollow', 'south')],
  ],
};
