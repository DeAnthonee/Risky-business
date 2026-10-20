// Bohemia: an inland kingdom of fields, forests and castle towns, hand-authored after a hand-drawn conquest map
// (real Czech place names; no franchise names). There is no sea: the kingdom's rectangle is cut into eight regions
// by the Sázava river (from the west edge, around the Sázava valley, to a confluence below Ledeč, then east past
// Rataje and south to the edge) and by forest brooks between the northern regions. Every region is its own
// landmass, so regions never share a land border: they meet only at the named fords and bridges listed in
// `seaLanes`, drawn as dashed crossings. That makes each bonus defensible from two or three entry territories.
// Same geometry pipeline as the fantasy board: see scripts/authored-map.mjs.
//
// The sketch was traced on an 820x1004 grid over the reference picture (kingdom inside x 35..800, y 35..890).
// P() shifts it down to leave a top margin for the region labels.
import pc from 'polygon-clipping';

const P = ([x, y]) => [x, y + 15];

// ---- seeded wiggle for the waterways (same hash/stream idea as authored-map.mjs) ----
function rng(key) {
  let a = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Midpoint displacement of an open polyline: a meandering course that still follows the sketch. */
function meander(pts, key, amount) {
  const r = rng(key);
  const out = [pts[0]];
  const split = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 10) return out.push(b);
    const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const off = (r() * 2 - 1) * amount * len;
    const m = [(a[0] + b[0]) / 2 + n[0] * off, (a[1] + b[1]) / 2 + n[1] * off];
    split(a, m);
    split(m, b);
  };
  for (let i = 1; i < pts.length; i++) split(pts[i - 1], pts[i]);
  return out;
}
/** A polyline thickened into a channel polygon (segment quads plus round-ish joints). */
function channel(pts, width) {
  const h = width / 2;
  const parts = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const n = [(-(b[1] - a[1]) / len) * h, ((b[0] - a[0]) / len) * h];
    parts.push([[[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]], [a[0] + n[0], a[1] + n[1]]]]);
  }
  for (const p of pts) {
    const ring = [];
    for (let k = 0; k <= 8; k++) ring.push([p[0] + h * Math.cos((k * Math.PI) / 4), p[1] + h * Math.sin((k * Math.PI) / 4)]);
    parts.push([ring]);
  }
  return pc.union(...parts);
}
/** Extra points on long edges so the coast roughening stays small and never closes a waterway. */
function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [a, b] = [ring[i], ring[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

// The kingdom (its border is the map edge) and the waterways that cut it into regions.
const KINGDOM = [[35, 38], [250, 34], [420, 40], [600, 34], [800, 38], [804, 300], [798, 600], [802, 888], [600, 893], [380, 886], [200, 892], [35, 888], [31, 600], [36, 300]];
const RIVER = 20, BROOK = 11;
const WATERWAYS = [
  // the Sázava: in from the west edge, past the valley's north side, south to the confluence below Ledeč
  [RIVER, [[10, 335], [90, 338], [165, 350], [230, 385], [300, 390], [345, 398], [335, 460], [325, 530], [332, 600], [350, 655]]],
  // east from the confluence, under Ledeč and its hop gardens, out at the east edge below the Eastern Fields
  [RIVER, [[350, 655], [420, 668], [465, 640], [482, 585], [540, 556], [620, 550], [700, 556], [745, 525], [770, 490], [830, 475]]],
  // south from the confluence between the Vraník forests and Rataje
  [RIVER, [[350, 655], [375, 720], [395, 790], [380, 850], [378, 910]]],
  // the western arm: between the valley and the Vraník forests
  [RIVER, [[5, 652], [90, 655], [170, 650], [250, 660], [350, 655]]],
  // brooks between the northern regions
  [BROOK, [[255, 10], [250, 80], [245, 150], [240, 215]]],
  [BROOK, [[240, 215], [205, 260], [175, 320], [165, 350]]],
  [BROOK, [[240, 215], [300, 230], [380, 245], [460, 240], [545, 225]]],
  [BROOK, [[545, 225], [555, 170], [570, 120], [590, 70], [600, 10]]],
  [BROOK, [[545, 225], [540, 290], [545, 340], [560, 385]]],
  [BROOK, [[345, 398], [420, 395], [490, 385], [560, 385]]],
  [BROOK, [[560, 385], [620, 430], [700, 455], [770, 490]]],
];

const REGIONS = [
  // id, name, bonus, a point inside it (sketch grid), label position (viewBox)
  { id: 'skalice', name: 'Skalice Uplands', bonus: 3, inside: [140, 200], label: [140, 30] },
  { id: 'northern_woods', name: 'Northern Woods', bonus: 3, inside: [400, 150], label: [400, 30] },
  { id: 'talmberk', name: 'Talmberk Marches', bonus: 4, inside: [680, 250], label: [690, 30] },
  { id: 'mrchojedy', name: 'Mrchojedy Lands', bonus: 3, inside: [400, 310], label: [395, 252] },
  { id: 'sazava', name: 'Sázava Valley', bonus: 3, inside: [150, 500], label: [120, 362] },
  { id: 'ledec', name: 'Ledeč Heartland', bonus: 4, inside: [480, 480], label: [470, 410] },
  { id: 'vranik', name: 'Vraník Forests', bonus: 2, inside: [150, 780], label: [150, 925] },
  { id: 'rataje', name: 'Rataje Domain', bonus: 4, inside: [600, 750], label: [600, 925] },
];

const pointIn = ([x, y], ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const water = pc.union(...WATERWAYS.map(([w, pts], i) => channel(meander(pts, `bohemia-water-${i}`, w === RIVER ? 0.2 : 0.15), w)));
const land = pc.difference([[...KINGDOM, KINGDOM[0]]], water);
const outlineOf = (inside) => {
  const poly = land.find((p) => pointIn(inside, p[0]));
  if (!poly) throw new Error(`bohemia: no land around ${inside}`);
  return densify(poly[0], 8).map(P);
};

const T = (id, name, continent, x, y) => ({ id, name, continent, land: continent, site: P([x, y]) });

export default {
  id: 'bohemia',
  kind: 'authored',
  name: 'Bohemia (42)',
  maxPlayers: 6,
  size: [835, 940],
  seed: 'bohemia-1',
  // Gentle edges: the outlines are already dense and the waterways narrow, so the coast barely moves.
  coast: { roughness: 0.25, fine: 0.12, detail: 4, smoothing: 1 },
  // Starting armies per player live in packages/engine/src/maps.ts (STARTING_ARMIES.bohemia).
  continents: REGIONS.map((r) => ({ id: r.id, name: r.name, bonus: r.bonus, label: r.label })),
  landmasses: REGIONS.map((r) => ({ id: r.id, outline: outlineOf(r.inside) })),
  territories: [
    // Skalice Uplands: the yellow north-west
    T('stone_hollow', 'Stone Hollow', 'skalice', 75, 100),
    T('skalice', 'Skalice', 'skalice', 175, 105),
    T('pine_hills', 'Pine Hills', 'skalice', 70, 225),
    T('rovna', 'Rovná', 'skalice', 165, 200),
    T('mill_fields', 'Mill Fields', 'skalice', 130, 292),
    // Northern Woods
    T('charcoal_glen', 'Charcoal Glen', 'northern_woods', 305, 85),
    T('deep_forest', 'Deep Forest', 'northern_woods', 305, 170),
    T('pribyslavice', 'Přibyslavice', 'northern_woods', 425, 100),
    T('hunters_woods', "Hunter's Woods", 'northern_woods', 425, 190),
    T('north_glade', 'North Glade', 'northern_woods', 505, 140),
    // Talmberk Marches: the north-east
    T('uzice', 'Úžice', 'talmberk', 700, 100),
    T('hill_farms', 'Hill Farms', 'talmberk', 625, 175),
    T('uzice_fields', 'Úžice Fields', 'talmberk', 755, 205),
    T('talmberk', 'Talmberk', 'talmberk', 640, 280),
    T('talmberk_woods', 'Talmberk Woods', 'talmberk', 615, 365),
    T('eastern_fields', 'Eastern Fields', 'talmberk', 760, 395),
    // Mrchojedy Lands: the central band
    T('samopse', 'Samopše', 'mrchojedy', 245, 330),
    T('mrchojedy', 'Mrchojedy', 'mrchojedy', 330, 285),
    T('open_fields', 'Open Fields', 'mrchojedy', 430, 345),
    T('ridge_farms', 'Ridge Farms', 'mrchojedy', 485, 295),
    // Sázava Valley: the west, inside the river's bend
    T('west_woodlands', 'West Woodlands', 'sazava', 90, 400),
    T('sazava', 'Sázava', 'sazava', 245, 450),
    T('monastery_fields', 'Monastery Fields', 'sazava', 95, 510),
    T('sazava_hills', 'Sázava Hills', 'sazava', 95, 600),
    T('lower_meadows', 'Lower Meadows', 'sazava', 250, 585),
    // Ledeč Heartland: the centre
    T('wooded_slopes', 'Wooded Slopes', 'ledec', 390, 440),
    T('green_hills', 'Green Hills', 'ledec', 520, 435),
    T('ledec', 'Ledeč', 'ledec', 455, 510),
    T('ledec_fields', 'Ledeč Fields', 'ledec', 385, 545),
    T('south_fields', 'South Fields', 'ledec', 400, 615),
    T('hop_gardens', 'Hop Gardens', 'ledec', 650, 500),
    // Vraník Forests: the south-west
    T('black_pond', 'Black Pond', 'vranik', 270, 710),
    T('vranik', 'Vraník', 'vranik', 125, 730),
    T('vranik_woods', 'Vraník Woods', 'vranik', 175, 840),
    T('river_forests', 'River Forests', 'vranik', 305, 830),
    // Rataje Domain: the south-east
    T('orchard_hills', 'Orchard Hills', 'rataje', 495, 665),
    T('upper_fields', 'Upper Fields', 'rataje', 630, 605),
    T('vineyards', 'Vineyards', 'rataje', 780, 585),
    T('rataje', 'Rataje', 'rataje', 610, 710),
    T('eastern_woods', 'Eastern Woods', 'rataje', 755, 730),
    T('southern_hills', 'Southern Hills', 'rataje', 480, 820),
    T('cattle_fields', 'Cattle Fields', 'rataje', 640, 815),
  ],
  /** Fords and bridges: the only ways from one region into another. */
  seaLanes: [
    ['skalice', 'charcoal_glen'], // Skalice Uplands - Northern Woods
    ['mill_fields', 'samopse'], // Skalice Uplands - Mrchojedy Lands
    ['mill_fields', 'west_woodlands'], // Skalice Uplands - Sázava Valley (Sázava ford)
    ['hunters_woods', 'ridge_farms'], // Northern Woods - Mrchojedy Lands
    ['north_glade', 'hill_farms'], // Northern Woods - Talmberk Marches
    ['ridge_farms', 'talmberk'], // Mrchojedy Lands - Talmberk Marches
    ['samopse', 'sazava'], // Mrchojedy Lands - Sázava Valley (Sázava bridge)
    ['open_fields', 'wooded_slopes'], // Mrchojedy Lands - Ledeč Heartland
    ['sazava', 'wooded_slopes'], // Sázava Valley - Ledeč Heartland (Sázava ford)
    ['lower_meadows', 'black_pond'], // Sázava Valley - Vraník Forests (western arm ford)
    ['eastern_fields', 'hop_gardens'], // Talmberk Marches - Ledeč Heartland
    ['eastern_fields', 'vineyards'], // Talmberk Marches - Rataje Domain (Sázava ford)
    ['south_fields', 'orchard_hills'], // Ledeč Heartland - Rataje Domain (Sázava bridge)
    ['river_forests', 'southern_hills'], // Vraník Forests - Rataje Domain (Sázava ford)
  ],
};
