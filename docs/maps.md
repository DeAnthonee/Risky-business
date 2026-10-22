# Maps

Thirteen boards. Nine are drawn from real geography (Natural Earth countries or US Census states, cut into
territories and projected to SVG, or Natural Earth land under a hexagon grid for Hex Earth); Realms of Halvaren, Four Crowns, Bohemia and The Nine Realms are original boards drawn by hand:

| map | territories | regions | players | notes |
| --- | --- | --- | --- | --- |
| **Classic** | 42 | 6 | 2–6 | the original board and bonuses |
| **World** | 74 | 14 | 2–10 | finer regions (Caribbean, Russia, Middle East, Central/South/East/Southeast Asia, Oceania, three African regions); region bonuses 2–7; starting armies scale with the player count (21 each for 10 players) |
| **Grand World** (`world_large`) | 104 | 20 | 2–10 | the big board for 8–10 players: the US in ten, Russia in nine, Africa in eighteen; bonuses 2–7; 30 armies each at 10 players |
| **Europe** | 44 | 8 | 2–8 | countries and halves of countries, with western Russia, Anatolia and the Maghreb as edge regions; bonuses 2–6 |
| **Greater Europe** (`greater_europe`) | 116 | 15 | 2–10 | a large, detailed Europe for up to 10 players: Iceland to the Urals, historical regions and provinces (Brittany, Bavaria, Lapland, Wallachia, Galatia ...), the Maghreb, Libya and Egypt, Anatolia, the Levant and the Caucasus; sea crossings over the Channel, North Sea, Baltic, Gibraltar, Sicily–Tunisia, Corsica/Sardinia, the Aegean, the Bosporus and Kerch; bonuses 2–7; 110 armies each for 2 players, 55 for 6, 33 for 10 |
| **Europe Advanced** (`europe_classic`) | 84 | 14 | 2–6 | the region layout, territory counts and bonuses of the "Europe Advanced" board: Iceland (3, +2), British Empire (4, +3), Scandinavia (5, +3), Western Europe (5, +4), Central Europe (6, +5), Dinaric Alps (3, +4), Southern Europe (5, +4), South Western Europe (6, +4), South Eastern Europe (4, +4), Eastern Europe (8, +8), Russian Empire (9, +7), Orient (11, +6), West Africa (10, +6), North Africa (5, +3); our own shapes on a flat (equirectangular) projection; 80 armies each for 2 players, 40 for 6 |
| **USA** | 45 | 8 | 2–10 | US states (small north-eastern ones merged); Alaska and Hawaii as insets reached by sea; bonuses 3–6 |
| **Asia** | 49 | 7 | 2–8 | Middle East to Japan, Siberia to Java; bonuses 4–6 |
| **Realms of Halvaren** (`fantasy`) | 87 | 16 | 2–10 | original fantasy world: rival kingdoms around an Inner Sea, the lawless Grimward Wastes across the north (+7, borders almost everyone), a cursed swamp, a desert, mountain passes and island chains linked by sea lanes; bonuses 2–7; 83 armies each for 2 players, 25 for 10 |
| **Four Crowns** (`skirmish`) | 24 | 6 | 2–4 | small, fast original board: four corner kingdoms (+2 each: one gate to the Heartland, two harbours) ring the Heartland (+4); four lone Waystone isles (+3) carry the sea lanes between neighbouring kingdoms; 17 armies each for 4 players |
| **Bohemia** (`bohemia`) | 42 | 8 | 2–6 | an inland kingdom with no sea, drawn after a hand-drawn conquest map (real Czech place names). Every region is its own landmass: the Sázava river (in from the west, south to a confluence below Ledeč, then east past Rataje and south to the edge) and forest brooks separate them, so regions never share a land border and meet only at 14 fords and bridges (`seaLanes`, drawn dashed). Each region has two or three entry territories: Skalice Uplands (+3, 5), Northern Woods (+3, 5), Talmberk Marches (+4, 6), Mrchojedy Lands (+3, 4), Sázava Valley (+3, 5), Ledeč Heartland (+4, 6), Vraník Forests (+2, 4, the safe corner with two fords), Rataje Domain (+4, 7). The waterways are cut out of the kingdom in `scripts/maps/bohemia.mjs` (`channel()`); classic starting armies (42 territories): 40 each for 2 players, 20 for 6 |
| **The Nine Realms** (`nine_realms`) | 58 | 9 | 2–8 | original tall board (760×990): one long north-south continent built around chokepoints: water cuts every border between two regions except one narrow pass per pair of neighbouring regions (`walls` in the map definition), so each region has 2–5 entry territories. The frozen Hoarlands (+6, 14 territories) leave the north only by the Neck (Bogneck–Twinford) and by sea; below them the Fordlands (+5, the crossroads) and the mountain Cloudvale (+4), the Goldfells (+3, two gates) in the west with the raider Rustcrag Isles (+2) offshore, the Throneland (+3) and Galewatch (+3) on the east shore, the broad Verdance (+5) and the desert Sunmarches (+3, two passes) in the south; lone isles reached by sea lanes; 55 armies each for 2 players, 28 for 6, 21 for 8 |
| **Hex Earth** (`hexworld`) | 80 | 14 | 2–10 | the real world on a globe of 1442 hexagons that viewers can spin (a flat view too): each territory a cluster of hexes sized by hex count rather than by country, so Africa has 17 territories and Europe 9; North America +6, Central America +2, South America +4, Europe +7, Russia +5, Middle East +5, Central Asia +4, South Asia +2, East Asia +6, Southeast Asia +4, Oceania +3 (with Hawaii), North, East and Southern Africa +5/+5/+4; land borders are touching hexes, with Panama kept as land and the Red Sea, Black Sea and Caspian kept as water; 25 sea links cross the oceans, including a Pacific route Western US → Hawaii → New Zealand; Antarctica and the far Arctic are ice, not played; 76 armies each for 2 players, 38 for 6, 23 for 10 |

Every map except Classic starts each player with the classic numbers scaled by map size (territories ÷ 42; above 6 players an equal share of the 6-player total)
(`STARTING_ARMIES` in `packages/engine/src/maps.ts`; the exact table per player count is in the rules text).

Legacy board: `europe_advanced` (the 99-territory "Europe Advanced" for 2–6 players, now shown as
"Europe (legacy, 99)") is no longer offered for new games and is not listed by `GET /api/maps`, but stays
registered so games saved on it keep loading and playing. A map id never changes its territories under saved
games: a reworked board gets a new id (Greater Europe replaced it as `greater_europe`) and the old one moves to
`LEGACY_MAP_IDS` in `packages/engine/src/maps.ts`.

Territory shapes, label anchors, sea links and continent outlines are generated by `npm run build:map`
from `scripts/maps/*.mjs`; the output in `packages/engine/src/generated/` is committed, so the host
build needs no geodata tooling (Natural Earth via `world-atlas`, US states via `us-atlas`, both devDependencies).
A map with `kind: 'authored'` (the fantasy board) has no real geography: it is drawn in its own coordinate space
as hand-sketched landmasses whose coasts are roughened deterministically, split into territories by a seeded
Voronoi partition of per-territory sites with wiggly shared borders (`scripts/authored-map.mjs`, `d3-delaunay`).
Its land adjacency comes from shared borders, plus the `seaLanes` it lists. An authored map can also set `walls: {width, passWidth, passes}`: every land border between territories of different regions is then cut by a water channel, except the listed `passes`, which keep a narrow land bridge, so regions meet only at chokepoints (The Nine Realms uses this).

A map with `kind: 'hexglobe'` (Hex Earth) tiles the whole sphere with hexagons over real land for the client's
rotatable 3D globe (`scripts/hex-globe.mjs`; [map-making.md](map-making.md#9-hex-globe-maps)). Besides the engine JSON
(the flat view) it has a globe file, `packages/client/src/generated/<id>.globe.json`, that only the client loads.

## Generated boards

Besides the twelve boards, a game can be played on a **generated board**: a hex board built by the seeded generator
in `packages/engine/src/procgen.ts` from its id alone, for nested ("Inception") tournaments and anywhere a fresh board
is wanted. `gen1-s42-p4-t20` is the board made from seed 42 for up to 4 players with 20 territories; `-r<n>` sets the
number of regions (default about one per 5 territories) and `-c2` gives two passes between linked regions (default
one). `genMapId({ seed, seats, territoriesPerSeat })` makes the id; the default is **5 territories per seat** (4 to 6
allowed): 15 for 3 players, 20 for 4, 30 for 6, 50 for a 10-player final.

- `getMap(id)` builds the board on first use (a few milliseconds; the last 64 are cached). Nothing is stored: the
  same id is the same board on every machine and in every browser, so saved games and records reload it. Ids are
  canonical (defaults are never written out), and a malformed or out-of-range id is a `RuleError`.
- Generated boards are not in `MAP_IDS`: the lobby does not offer them and `GET /api/maps` does not list them. Pass
  the id as the `map` setting over the API or MCP; `GET /api/map?map=<id>` and the MCP `map` tool return the board.
- How a board is made: a land blob grown from the middle of a hex grid, split into regions, a one-cell water channel
  cut along every border between regions except one land pass per linked pair (two for a region with one neighbour,
  or with `-c2`), then territories grown inside each region. Every board passes checks before it is returned (the
  board and each region connected, 1-3 entry territories for a region of up to 5, up to 5 for a bigger one, few dead
  ends, bonuses from the same formula `npm run build:map` suggests); an attempt that fails is retried from a derived
  seed, so the result is still fixed by the id.
- `pickStartSpots(map, n, seed)` picks n start territories, one per region in n different regions, spread as far apart
  as possible, on a generated or an existing board (the portals of a nested board).
- **gen1 is frozen.** Golden hashes in `packages/engine/test/procgen.test.ts` fail on any change to a gen1 board. A
  better or different generator is a new version (`gen2-...`) beside it, so every gen1 id ever saved keeps loading.
  Making boards and previewing them: [map-making.md](map-making.md#8-procedural-boards).

How to add or change a map (data in `scripts/maps/*.mjs`, `npm run build:map`): [conventions.md](conventions.md#maps) and
[CONTRIBUTING.md](../CONTRIBUTING.md#5-maps).
