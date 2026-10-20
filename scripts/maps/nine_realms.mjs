// The Nine Realms: an original board on one long, tall continent (a north-south island kingdom), hand-authored
// (no real geography). A vast frozen north ends at a narrow marshy neck; below it the river heartland meets a
// mountain vale to the east, gold hills to the west and a raider archipelago off the west coast; the crown lands
// and the storm coast hold the east shore, a broad green south runs down to a desert peninsula. Offshore isles
// (a northern rock, a bear-haunted islet, a dragon-shaped rock, a sapphire isle, a vineyard isle) are reached by
// sea lanes. Same geometry pipeline as the fantasy board: see scripts/authored-map.mjs.
//
// The sketch was traced on a 490x745 reference grid; P() scales it into the viewBox, leaving open sea on both
// sides for the region labels. grow() enlarges an islet sketch about its centre so it stays easy to click.
const P = (pts) => pts.map(([x, y]) => [Math.round((x - 55) * 1.4 + 110), Math.round((y - 25) * 1.4)]);
const at = (x, y) => P([[x, y]])[0];
const grow = (pts, k) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
};

/**
 * A barrier (a gorge, river or mountain wall) cut into the land as a thin channel along a sketched polyline, so the
 * territories on either side stop sharing a border. Barriers run along region borders and leave gaps: the gaps are
 * the passes, so every region is entered through a few chokepoints.
 */
const channel = (line, width = 6) => {
  const pts = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  pts.push(line[line.length - 1]);
  const side = (sign) =>
    pts.map((p, i) => {
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      const len = Math.hypot(q[0] - o[0], q[1] - o[1]);
      return [p[0] - (sign * (q[1] - o[1]) * width) / 2 / len, p[1] + (sign * (q[0] - o[0]) * width) / 2 / len];
    });
  return P([...side(1), ...side(-1).reverse()]);
};

const BARRIERS = {
  // the Goldfells' eastern ridge: the only ways east are the coast road (Cragmouth-Seawatch) and Goldenway
  goldfellsRidge: [[170, 400], [176, 414], [186, 436], [184, 455], [189, 468], [192, 474]],
  // the Goldfells' southern scarp: the Verdance is entered from Goldenway alone
  goldfellsScarp: [[80, 545], [130, 546], [165, 546], [178, 535], [198, 530]],
  // the Moon Wall, the Cloudvale's southern front: passes at Bloodgate (to Redford) and Gullhaven (to Clawpoint)
  moonWall: [[234, 403], [240, 410], [260, 413], [274, 408], [282, 398], [296, 398], [306, 404], [310, 416], [318, 428], [333, 440]],
  // cliffs between Skyhold and the claw
  clawCliffs: [[400, 407], [380, 408], [368, 410]],
  // the storm coast's western woods: the Verdance reaches the Galewatch only at Longfield-Rainmarch
  stormwood: [[296, 514], [298, 530], [296, 545], [286, 551], [280, 556], [280, 568]],
  // the Sunmarches' mountains, with three passes: Oldspire-Starcliff, Longfield-Dunmarch and Thornpass-Bonepass
  sunPeaksWest: [[157, 652], [185, 656], [215, 652], [217, 630], [216, 612], [221, 606]],
  sunPeaksMid: [[274, 614], [284, 610], [290, 605], [315, 606]],
  sunPeaksEast: [[338, 655], [344, 649], [349, 645], [360, 641], [378, 636], [396, 633]],
};

const MAINLAND = [
  // the Wall's coast across the top of the north, then the north-east shore
  [232, 64], [255, 54], [285, 50], [315, 48], [340, 56], [350, 72], [358, 95], [368, 120], [372, 148], [380, 175],
  [378, 205], [368, 230], [350, 245],
  // the Bite: a bay between the north and the vale, with the neck on its west side
  [330, 254], [310, 262], [296, 276], [284, 296], [278, 312],
  // the vale's north shore and its eastern capes
  [300, 318], [330, 314], [360, 316], [386, 322], [398, 336], [392, 354], [396, 376], [388, 398], [392, 416],
  // the crown lands' claw-shaped point and the bay below it
  [382, 426], [390, 440], [398, 452], [386, 462], [370, 466], [356, 478], [344, 492],
  // the storm coast
  [356, 504], [372, 500], [384, 512], [380, 535], [388, 556], [378, 576], [380, 596], [368, 612],
  // the desert peninsula's long eastern arm
  [374, 632], [392, 648], [408, 664], [410, 684], [398, 700], [370, 706], [340, 708], [300, 705], [260, 712],
  [220, 708], [185, 700], [160, 705], [140, 692],
  // the green south-west coast
  [120, 690], [104, 672], [88, 650], [80, 626], [88, 600], [96, 575], [92, 550], [96, 530],
  // the gold hills' west coast
  [92, 510], [85, 490], [100, 470], [95, 450], [110, 430], [120, 412], [138, 400], [154, 390], [162, 372], [168, 348],
  // the hooked western cape of the north
  [160, 326], [130, 322], [102, 316], [86, 302], [94, 286], [116, 280], [140, 276],
  // the north-west coast up to the Wall
  [128, 264], [108, 252], [98, 232], [96, 208], [102, 184], [112, 160], [126, 146], [146, 136], [166, 124], [188, 112],
  [206, 100], [220, 82],
];

// Islet sketches, and how much each is enlarged (the Rustcrag three sit close together, so less).
const ISLES = {
  skarn: [[372, 40], [385, 28], [398, 35], [396, 55], [388, 70], [376, 62]],
  ursholm: [[148, 90], [160, 82], [174, 88], [172, 102], [158, 106]],
  rustcrag: [[98, 372], [110, 366], [122, 372], [120, 386], [106, 390]],
  saltholm: [[132, 368], [146, 362], [156, 370], [152, 384], [138, 384]],
  blackbrine: [[110, 346], [124, 340], [134, 348], [130, 360], [116, 360]],
  wyrmrock: [[398, 458], [408, 450], [418, 460], [412, 474], [400, 472]],
  bluestone: [[402, 568], [412, 564], [418, 584], [414, 604], [404, 600]],
  vintners_isle: [[84, 702], [100, 692], [116, 700], [112, 716], [92, 718]],
};

const RUSTCRAG = ['rustcrag', 'saltholm', 'blackbrine'];

const T = (id, name, continent, x, y) => ({ id, name, continent, land: 'mainland', site: at(x, y) });

export default {
  id: 'nine_realms',
  kind: 'authored',
  name: 'The Nine Realms (58)',
  maxPlayers: 8,
  size: [760, 990],
  seed: 'nine-realms-1',
  // Starting armies per player live in packages/engine/src/maps.ts (STARTING_ARMIES.nine_realms).
  continents: [
    { id: 'hoarlands', name: 'Hoarlands', bonus: 6, label: [110, 200] },
    { id: 'cloudvale', name: 'Cloudvale', bonus: 4, label: [680, 450] },
    { id: 'fordlands', name: 'Fordlands', bonus: 5, label: [90, 440] },
    { id: 'rustcrag', name: 'Rustcrag Isles', bonus: 2, label: [85, 548] },
    { id: 'goldfells', name: 'Goldfells', bonus: 3, label: [75, 640] },
    { id: 'throneland', name: 'Throneland', bonus: 3, label: [690, 585] },
    { id: 'galewatch', name: 'Galewatch', bonus: 3, label: [690, 760] },
    { id: 'verdance', name: 'Verdance', bonus: 5, label: [70, 830] },
    { id: 'sunmarches', name: 'Sunmarches', bonus: 4, label: [680, 880] },
  ],
  landmasses: [
    {
      id: 'mainland',
      outline: P(MAINLAND),
      lakes: [
        // a black tarn in the northern forest
        P([[176, 196], [186, 192], [194, 200], [190, 212], [178, 212]]),
        // the Sunken Eye, in the river heartland: it keeps the Throneland's Mirewood off Cinderhall and Trident Fork
        P([[244, 446], [258, 437], [276, 438], [292, 446], [300, 459], [288, 469], [270, 470], [252, 466]]),
        ...Object.values(BARRIERS).map((line) => channel(line)),
      ],
    },
    ...Object.entries(ISLES).map(([id, outline]) => ({ id, territory: id, outline: P(grow(outline, RUSTCRAG.includes(id) ? 1.2 : 1.6)) })),
  ],
  territories: [
    // The Hoarlands: the frozen north
    T('rimewall', 'Rimewall', 'hoarlands', 262, 80),
    T('hearthcold', 'Hearthcold', 'hoarlands', 325, 92),
    T('pinecrest', 'Pinecrest', 'hoarlands', 182, 130),
    T('greywood', 'Greywood', 'hoarlands', 130, 200),
    T('wintermere', 'Wintermere', 'hoarlands', 212, 172),
    T('bleakhold', 'Bleakhold', 'hoarlands', 275, 145),
    T('stormfang', 'Stormfang', 'hoarlands', 345, 155),
    T('silverquay', 'Silverquay', 'hoarlands', 318, 222),
    T('barrowdowns', 'Barrowdowns', 'hoarlands', 225, 238),
    T('stonereach', 'Stonereach', 'hoarlands', 122, 252),
    T('gullhook', 'Gullhook Cape', 'hoarlands', 118, 300),
    T('bogneck', 'Bogneck', 'hoarlands', 228, 292),
    { id: 'skarn', name: 'Skarn', continent: 'hoarlands' },
    { id: 'ursholm', name: 'Ursholm', continent: 'hoarlands' },
    // The Cloudvale: mountains and high valleys in the east
    T('fingerstrand', 'Fingerstrand', 'cloudvale', 290, 332),
    T('mistcliffs', 'Mistcliffs', 'cloudvale', 352, 334),
    T('moonpeaks', 'Moonpeaks', 'cloudvale', 300, 375),
    T('skyhold', 'Skyhold', 'cloudvale', 366, 376),
    T('gullhaven', 'Gullhaven', 'cloudvale', 340, 410),
    T('bloodgate', 'Bloodgate', 'cloudvale', 262, 398),
    // The Fordlands: the river heartland
    T('twinford', 'Twinford', 'fordlands', 218, 340),
    T('seawatch', 'Seawatch', 'fordlands', 178, 380),
    T('redford', 'Redford', 'fordlands', 212, 402),
    T('cinderhall', 'Cinderhall', 'fordlands', 244, 432),
    T('stonyford', 'Stonyford', 'fordlands', 226, 470),
    T('tridentfork', 'Trident Fork', 'fordlands', 300, 436),
    // Rustcrag Isles: the raider archipelago
    { id: 'rustcrag', name: 'Rustcrag', continent: 'rustcrag' },
    { id: 'saltholm', name: 'Saltholm', continent: 'rustcrag' },
    { id: 'blackbrine', name: 'Blackbrine', continent: 'rustcrag' },
    // The Goldfells: mines and harbours in the west
    T('cragmouth', 'Cragmouth', 'goldfells', 150, 418),
    T('gildhaven', 'Gildhaven', 'goldfells', 112, 474),
    T('deepgold', 'Deepgold', 'goldfells', 160, 465),
    T('redcliff', 'Redcliff', 'goldfells', 128, 520),
    T('goldenway', 'Goldenway', 'goldfells', 180, 505),
    // The Throneland: the crown's seat on the east shore
    T('throneport', 'Throneport', 'throneland', 322, 470),
    T('clawpoint', 'Clawpoint', 'throneland', 368, 440),
    T('mirewood', 'Mirewood', 'throneland', 280, 488),
    { id: 'wyrmrock', name: 'Wyrmrock', continent: 'throneland' },
    // The Galewatch: the storm coast
    T('oakwold', 'Oakwold', 'galewatch', 330, 522),
    T('galehold', 'Galehold', 'galewatch', 364, 562),
    T('rainmarch', 'Rainmarch', 'galewatch', 312, 572),
    T('thornpass', 'Thornpass', 'galewatch', 348, 604),
    { id: 'bluestone', name: 'Bluestone Isle', continent: 'galewatch' },
    // The Verdance: the broad green south-west
    T('rushwater', 'Rushwater', 'verdance', 222, 512),
    T('goldmeadow', 'Goldmeadow', 'verdance', 270, 535),
    T('highbloom', 'Highbloom', 'verdance', 128, 565),
    T('vinehollow', 'Vinehollow', 'verdance', 188, 560),
    T('longfield', 'Longfield', 'verdance', 250, 582),
    T('bloomkeep', 'Bloomkeep', 'verdance', 118, 618),
    T('applemere', 'Applemere', 'verdance', 182, 615),
    T('oldspire', 'Oldspire', 'verdance', 120, 665),
    { id: 'vintners_isle', name: "Vintner's Isle", continent: 'verdance' },
    // The Sunmarches: the desert peninsula
    T('dunmarch', 'Dunmarch', 'sunmarches', 245, 640),
    T('bonepass', 'Bonepass', 'sunmarches', 305, 640),
    T('starcliff', 'Starcliff', 'sunmarches', 180, 682),
    T('redsands', 'Redsands', 'sunmarches', 252, 685),
    T('brimwater', 'Brimwater', 'sunmarches', 322, 680),
    T('suncrest', 'Suncrest', 'sunmarches', 384, 684),
  ],
  /** Crossings over water. Land borders are found from the shapes. */
  seaLanes: [
    // the northern isles
    ['skarn', 'hearthcold'], ['skarn', 'stormfang'],
    ['ursholm', 'pinecrest'], ['ursholm', 'greywood'], ['ursholm', 'rimewall'],
    // the Rustcrag Isles and their raiding lanes
    ['rustcrag', 'saltholm'], ['rustcrag', 'blackbrine'], ['saltholm', 'blackbrine'],
    ['blackbrine', 'gullhook'], ['saltholm', 'seawatch'], ['rustcrag', 'cragmouth'],
    // across the Bite
    ['silverquay', 'mistcliffs'],
    // Wyrmrock off the claw
    ['wyrmrock', 'clawpoint'], ['wyrmrock', 'throneport'],
    // Bluestone Isle off the storm coast
    ['bluestone', 'galehold'], ['bluestone', 'suncrest'],
    // Vintner's Isle off the south-west cape
    ['vintners_isle', 'oldspire'],
  ],
};
