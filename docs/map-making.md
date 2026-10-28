# Making a new map

The end-to-end process for a new board: the design rules, tracing a reference picture, building chokepoints,
previewing, registering the map id everywhere it must appear, the workflow from design to deploy, and tracking every
map's state with `npm run maps:status`. It is written from the two boards made this way: Bohemia (`scripts/maps/bohemia.mjs`,
one landmass per region joined at fords) and The Nine Realms (`scripts/maps/nine_realms.mjs`, one landmass with
`walls`). The runnable examples use `bohemia`. Read [CONTRIBUTING.md](../CONTRIBUTING.md#5-maps) for the build commands and [maps.md](maps.md) for the boards that exist.

New original boards use `kind: 'authored'`: hand-drawn outlines in the map's own coordinate space, one `site` per
territory, split by a seeded Voronoi partition (`scripts/authored-map.mjs`). Land adjacency comes from the shapes;
crossings over water are listed in `seaLanes`. Real-geography boards (Natural Earth, US states) follow the same
registration and workflow below but not the tracing and chokepoint sections.

## 1. Design rules

| rule | why |
| --- | --- |
| **Original names only.** No names from games, books, films or other franchises. Real place names are fine (Bohemia uses Czech towns), and so are general real-world area names on real-geography boards (Hex Earth: Great Plains, Andes, Sahel; the owner's ruling, 2026-10-22), but do not copy the classic Risk board's territory list. | The repo is public and the boards are ours. |
| **Chokepoints between regions.** A small region (up to about 5 territories) has 2-3 entry territories; a big one has 3-5. | A bonus is only worth taking if it can be held. A region that borders everything is never held. |
| **Bonuses follow the generator's suggestion** (`npm run build:map` prints `suggested N`, from size and entry points). Go 1 lower for a very defensible region (an island group, a region behind one pass). | Keeps the board balanced; a `<- check` mark means you are more than 1 away from the suggestion: have a reason. |
| **No warnings left.** No `touching but not adjacent`, no `share only N units of border`, no `badges ... are N apart`, no `label of ... runs into the badge`, no site off its land. | Each one is a visible bug: two shapes that look connected but are not, or badges on top of each other. |
| **Every region connected inside itself**, and the whole board connected. | The engine needs it (the build fails if the board is not connected); a split region is unreadable. |
| **A new id for a reworked board.** Never change the territories of an id that has saved games; the old one moves to `LEGACY_MAP_IDS`. | README hard rule 7. |

Badges: the client draws a ring of radius 15 on maps with more than 50 territories (19 otherwise), so anchors need
24 (or 32) units between them. Move a `site`, or give the territory an explicit `anchor`, until the warnings go.

## 2. Tracing a reference picture

When the owner gives a picture (a hand-drawn conquest map, a sketch), trace on the picture's own pixel grid and
scale into the viewBox with one helper, so the coordinates in the file can be read straight off the image:

```js
// The sketch was traced on a 490x745 reference grid; P() scales it into the viewBox.
const P = (pts) => pts.map(([x, y]) => [Math.round((x - 55) * 1.4 + 110), Math.round((y - 25) * 1.4)]);
const at = (x, y) => P([[x, y]])[0]; // one point (territory sites)
```

- Outlines, lakes and sites all go through `P()`; region `label` positions are in viewBox units.
- Choose `size` (the viewBox) with **open sea or margin around the land for the region labels**. The client draws
  them upper-case, centred on `label`, with the bonus after (`HOARLANDS +6`): about 8.5 units per character on
  dense maps (more than 50 territories, 10px), about 9.5 on others (12px). A label must not cross land of another
  region or a badge.
- Islets drawn small on the picture are hard to click: enlarge them about their centre (`grow()` in
  nine_realms.mjs).
- Write the grid and the scale in a comment at the top of the map file, as both boards do.

## 3. Building chokepoints

Voronoi cells on one landmass touch all their neighbours, so a region drawn on open land has many entry points. New
authored maps cut them down with **`walls`** (the main technique); Bohemia's separate landmasses are the alternative.
`walls` is implemented by `cutWalls` in `scripts/authored-map.mjs`.

| technique | how | use it when | example |
| --- | --- | --- | --- |
| **`walls` (main)** | `walls: { width, passWidth, passes: [[a, b], ...] }` in the map definition. The generator cuts every land border between territories of **different regions** with a water channel `width` wide, except the listed `passes`, which keep a land bridge `passWidth` wide in the middle of their border. Borders inside a region are untouched. | Almost always: one continent, regions that meet only where you say, and the passes listed in one place. | `walls` in `scripts/maps/nine_realms.mjs` and `cutWalls()` in `scripts/authored-map.mjs` (both land with The Nine Realms' PR) |
| **One landmass per region, joined at fords** | The whole area minus all waterways is split into pieces; each region's piece is its own landmass (`land: <region>` on its territories). Regions share no land border; every crossing is a `seaLanes` pair, drawn dashed. | Every region border should read as a river you cross at a ford or bridge (the links are drawn as crossings, not land bridges). | `WATERWAYS`, `outlineOf()` and `seaLanes` in `scripts/maps/bohemia.mjs` |

With `walls`:

- A pass must be a real land border between two territories of different regions. If it is not, the build warns
  `pass a/b is not a land border between two regions`: move a site so the two cells touch, or pick another pair.
- Slivers a wall cuts off a territory become water. A wall that splits a territory into real pieces warns
  `walls split <id> into N pieces`: move a site or a pass.
- The Nine Realms uses exactly one pass per pair of neighbouring regions (12 passes; `width` 7
  and `passWidth` 22, the defaults are 7 and 16), and its engine test checks for exactly one link per region pair.
  Start from that and add a second pass between two regions only on purpose.
- Islands and archipelagos stay separate landmasses with `territory: <id>`, reached by `seaLanes`.
- `seaLanes` that duplicate a land border are reported as redundant: remove them.

With separate landmasses (Bohemia): the coast roughening can close a narrow waterway, so set a gentle `coast` and
`densify()` the outlines (bohemia.mjs). Regions can never leak, since they never touch.

### Checking the entry points

List each region's entry territories and the edges that leave it, from the generated JSON (`(LAND)` is a shared
border or pass, `(sea)` a drawn crossing). Every `(LAND)` link between regions should be one of your passes:

```bash
node -e "const m=require('./packages/engine/src/generated/'+process.argv[1]+'.json');const reg=Object.fromEntries(m.territories.map(t=>[t.id,t.continent]));const sea=new Set(m.seaLinks.map(l=>[l.a,l.b].sort().join('|')));for(const c of m.continents){const out=m.edges.filter(([a,b])=>(reg[a]===c.id)!==(reg[b]===c.id)).map(([a,b])=>(reg[a]===c.id?a+'>'+b:b+'>'+a)+(sea.has([a,b].sort().join('|'))?' (sea)':' (LAND)'));console.log(c.id,new Set(out.map(e=>e.split('>')[0])).size,'entries:',out.join(', '))}" bohemia
```

To see where two territories touch (to choose a pass, or to find an unexpected contact), list the points their paths
share:

```bash
node -e "const m=require('./packages/engine/src/generated/'+process.argv[1]+'.json');const pts=id=>new Set(m.territories.find(t=>t.id===id).path.match(/-?[\d.]+,-?[\d.]+/g));const b=pts(process.argv[3]);const s=[...pts(process.argv[2])].filter(p=>b.has(p)).map(p=>p.split(',').map(Number));console.log(s.length?s.length+' shared points, x '+Math.min(...s.map(p=>p[0]))+'..'+Math.max(...s.map(p=>p[0]))+', y '+Math.min(...s.map(p=>p[1]))+'..'+Math.max(...s.map(p=>p[1])):'no shared points')" bohemia sazava lower_meadows
```

The contact is in viewBox units; divide back through `P()` to find it on the sketch grid. Very short contacts (under
`minBorder`, default 8) are not adjacencies but are still reported as warnings: close them too.

## 4. Previewing

`scripts/preview-map.mjs` renders a generated board to a standalone HTML page: territories in region colours,
region outlines, sea links dashed, badges at the anchors, territory names and region labels as the client places
them. It is Node only, has no dependencies and is not part of any build.

```bash
npm run build:map -- bohemia
node scripts/preview-map.mjs bohemia
```

It writes to the OS temp folder (`risky-map-preview/<id>.html`) unless you pass `--out page.html`, and prints the
path and a PNG command. To check the tracing, lay the reference picture under the board, placed in viewBox units
(`P()` of the picture's top-left corner, and its size times the scale; bohemia.mjs traced an 820x1004 grid and its
`P()` only shifts it down 15, so the picture goes at 0, 15, 820x1004):

```bash
node scripts/preview-map.mjs bohemia --ref <picture.png> 0 15 820 1004 --ref-opacity 0.4
```

Rasterize the page with headless Edge (Chrome or Chromium take the same flags) to send the owner a PNG:

```bash
msedge --headless --disable-gpu --hide-scrollbars --window-size=1400,1600 --screenshot=<out.png> file:///<page.html>
```

On Windows `msedge` is `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`. Never commit previews or
reference pictures (README hard rule 13).

## 5. Registering a new map id

Everything a new board touches (as in the Bohemia PR #100).
Replace `<id>` and keep every list in the same order as `MAP_IDS`.

| file | what to add |
| --- | --- |
| `scripts/maps/<id>.mjs` | the map definition |
| `scripts/build-map.mjs` | `<id>` in `MAP_NAMES`; then `npm run build:map -- <id>` and commit `packages/engine/src/generated/<id>.json` |
| `packages/engine/src/maps.ts` | the JSON import, `<id>` in the `MapId` union and `MAP_IDS`, `STARTING_ARMIES.<id>` (usually `{ classicScaled: true }`), the `MAPS` entry |
| `packages/engine/src/types.ts` | `GameOptions['map']` union and its doc comment (territories, player range) |
| `packages/engine/src/options.ts` | `OPTION_SPECS.map` description, and the player ranges in `maxPlayers` |
| `packages/engine/src/rules.ts` | a paragraph on the board (regions with bonuses, how regions connect, wrap or not) and its line in the starting-army table |
| `packages/mcp/src/tools.ts` | the `map` tool's description names the new id |
| `packages/engine/test/engine.test.ts` | the `EXPECTED` row, the `MAP_IDS` list, the starting-army table, the rules-text `labels`, the full-game list if it fits, and a `describe` block: size and bonuses, **a chokepoint test** (each region's exact entry territories), regions connected inside, a full deal at max players |
| `packages/server/test/server.test.ts` | the `GET /api/maps` list, and a create-and-start row |
| `packages/delove-gpu/delove_gpu/fingerprint.py` | the generated JSON in `RULE_FILES` |
| `packages/delove-gpu/tests/matrix.py` | `<id>: maxPlayers` in the rules suite |
| `packages/delove-gpu/README.md` | the map listed as wired in but **not yet verified** |
| `docs/maps.md` | the board count, the sentence naming the hand-drawn boards (for an authored map), and a table row |
| `README.md` | the board count in the table-of-contents line for docs/maps.md |
| `docs/playing.md` | the `map` and `maxPlayers` rows of the options table |
| `docs/game-settings.md` | the map pool row, if it fits the league's table sizes |
| `docs/delove-status.md` | the id in the map list, and an open-work row: re-verify the GPU fingerprint |
| `docs/logs/` | one dated line with the PR number in `maps.md`, `engine.md`, `mcp.md`, `delove-gpu.md`, `delove.md` and `docs.md` |

The option enum, MCP schemas, lobby list and `GET /api/maps` derive from `MAP_IDS` and need nothing more. Do not
touch `packages/delove-gpu/engine-fingerprint.json` in the map PR (section 6).

## 6. Workflow

| step | who | what |
| --- | --- | --- |
| 0. Issue | whoever starts the map | Open a **New map** issue (`.github/ISSUE_TEMPLATE/new-map.md`, label `map`) with the reference or idea and who is making it; tick its steps as they happen |
| 1. Design | map session | Trace, build chokepoints, `npm run build:map -- <id>` with no warnings, render previews (PNG) |
| 2. Approval | **owner** | The owner approves the design (names, regions, bonuses, chokepoints) **before anything else**. Iterate on previews until then; do not register the id yet |
| 3. Register | map session | Section 5; `npm test` and `npm run build` green; `npm run maps:status` shows the map offered, in RULE_FILES and the matrix; open the board in the real client (`npm start`, a lobby on the new map) and look at labels, badges and sea links |
| 4. PR | map session | One PR against the deploy branch, opened ready for review, with the preview and the template's "New map" checklist |
| 5. Review | "Risky Business game PR reviews" session | Reviews the PR; corrections go back to the PR's session, which fixes and asks for re-review until approved |
| 6. Merge | **owner** (or the review session, when the owner allows it) | The approved PR is merged; the deploy branch auto-deploys |
| 7. GPU mirror | coordinator, training PC | Re-verify the fingerprint (`packages/delove-gpu/verify.py`); afterwards `npm run maps:status` shows the map GPU-verified |

The GPU re-verification is **not run per map PR**. Until it runs, the GPU mirror refuses to start (`StaleMirror`),
so it is batched: one `verify.py` run on the training PC after the day's merges covers every merged map, **never
while the GPU is training**, and the new fingerprint lands in its own PR (it also flips the maps to verified in
`packages/delove-gpu/README.md` and closes the open-work row in `docs/delove-status.md`).

Map designs can run in parallel sessions, one board per session and branch. A session in a git worktree runs
`npm ci` in the worktree first: without its own `node_modules`, Node resolves `@risk/*` to the main checkout and the
tests run against whatever board that checkout has. Registration PRs touch the same lines (`MAP_IDS`, the test
lists, the docs tables), so the second one to merge resolves those conflicts by keeping both ids. Verification runs
one at a time.

## 7. Tracking every map

`npm run maps:status` (`scripts/map-status.mjs`) prints one row per board, derived only from the code so it cannot
drift. It reads the built engine and runner, so run `npm run build` (or `npm test`) first.

| column | from |
| --- | --- |
| map, name, terr., players | the engine's `MAPS` |
| registered | `offered` (in `MAP_IDS`) or `legacy` (in `LEGACY_MAP_IDS`: saved games only, never trained on) |
| JSON | `packages/engine/src/generated/<id>.json` exists |
| RULE_FILES | the JSON is listed in `packages/delove-gpu/delove_gpu/fingerprint.py` |
| matrix | the id is in the rules suite of `packages/delove-gpu/tests/matrix.py` |
| GPU-verified | the JSON's hash equals its entry in `packages/delove-gpu/engine-fingerprint.json`, hashed as `fingerprint.py` does (SHA-256, CRLF read as LF) |
| rotation | in the runner's `rotationMaps` (`packages/runner/src/presets.ts`), the pool the league's Gen 5 games draw from (every offered map that seats 5, so not `skirmish`) |

Under the table it lists the offered maps that are not GPU-verified and every other `RULE_FILES` entry changed since
the last verification: any of either means the next `verify.py` run is needed. `--markdown` and `--json` print the
same data for a PR or a script; `--strict` exits 1 when a verification is needed (it is informational, exit 0,
otherwise). CI writes the markdown table to the job summary of every run and adds a warning (never a failure) per
offered map that is not GPU-verified, next to the GPU fingerprint warning.

Where it fits: after registration a new map shows `offered`, `RULE_FILES` yes, matrix yes, GPU-verified no. After the
batched `verify.py` run and its fingerprint PR it shows GPU-verified yes, and the New map issue can be closed.

## 8. Procedural boards

Generated boards (`gen1-s<seed>-p<seats>-t<territories>`, [maps.md](maps.md#generated-boards)) skip this whole
workflow: they have no map file, no registration and no owner approval per board, because the generator itself is
what was approved (hex style, 5 territories per seat, owner decisions of 2026-10-21; 8 per seat since 2026-10-27). Preview them with the same
script, after `npm run build` (it loads the built engine):

```bash
node scripts/preview-map.mjs gen1-s42-p4-t20
node scripts/preview-map.mjs --sheet seats=3,4,6,10 seeds=1-4 tps=5
```

`--sheet` renders a contact sheet of every seat count and seed in one page. Rules for changing the generator:

- `procgen.ts` uses only `createRng`/`nextInt` (`rng.ts`) and integer arithmetic, with fixed iteration orders: no
  `Math.random`, no clocks and no `Math.sin`/`cos`/`sqrt`/`exp` (not bit-identical across JS engines, and the client
  builds the same board in the browser). A test scans the file for them.
- **Never change what a released version outputs.** The golden hashes in `procgen.test.ts` pin gen1. A change that
  moves them is a new version: add `gen2` next to gen1 (its own function, chosen by the id's prefix) and leave gen1
  as it is. Changes that do not move the hashes (speed, comments) are fine.
- `procgen.ts` is not in the GPU mirror's `RULE_FILES`, so changing it needs no `verify.py` run.

## 9. Hex-globe maps

A board with `kind: 'hexglobe'` is the whole world on a sphere tiled by hexagons, for the client's rotatable 3D
globe (Hex Earth, `scripts/maps/hexworld.mjs`; the generator is `scripts/hex-globe.mjs`). It follows the design
rules, the workflow and the registration checklist above; only the way it is drawn differs.

- **The grid.** A Goldberg sphere of `frequency` n has 10n²+2 cells (n = 12: 1442 cells, about 700 km across). All
  are hexagons except 12 pentagons: two sit on the poles under the ice and `spin` (degrees about the polar axis)
  parks the other ten in open ocean.
- **Land.** A cell is land when at least half of its sample points fall on Natural Earth 1:50m land. A strait or
  isthmus narrower than a hex comes out wrong (Panama vanished; the Red Sea, the Black Sea and the Caspian filled
  in), so check the region entries (section 3) and fix single cells with `land`, `sea` or `ice` points ([lon, lat];
  the nearest cell changes). Land beyond `iceLat` and everything beyond `seaIceLat` is ice: drawn, never played.
- **Territories.** Each territory has a `site` [lon, lat]; every land cell goes to the nearest site over land, so a
  territory never jumps the sea. Size territories by hex count, not by the countries: a real-geography layout gives
  Europe one hex per country and Australia a dozen. Islands too small for a hex set `island: true` (their site's
  cell becomes land) and are reached by `seaLanes`. The build warns about land no site reaches and about a
  territory split into pieces.
- **One territory per hexagon** (`cellTerritories: true`, Mega Earth): every land cell becomes its own territory; the
  definition's territories only name and group them ("Beringia 3", in Beringia's region) and each sea lane joins the
  closest pair of their hexes (dropped when those hexes already touch). `autoBonus: true` sets every region's bonus to
  the builder's suggestion; `badgeGap` (units) is the badge spacing the build checks for (Mega Earth: 10).
  `zones` adds layered bonuses over the regions ([maps.md](maps.md), Mega Earth): `micro` (`min`/`max` hexes, `bonus`,
  `busyBonus` for a zone bordering `busyNeighbours` or more others), `sections` (per region, named groups of the
  definition's sites; every site of a sectioned region in exactly one) and `continents` (groups of regions paying
  `share` of their bonuses). The build prints the zone sizes and bonuses; the engine pays them in `zonesOf`.
  `scripts/preview-map.mjs` draws a board of more than 300 territories with small badges and no names. `poleRings:
  true` writes each territory's (and in the globe file, each cell's) ring count from the North and South pole cells,
  sea counted, for closing ice (the engine's `ice.ts`); boards without it are banded by height.
- **Tournament boards** (`TOURNAMENT_MAP_IDS` in `maps.ts`): registered for tournaments only, never offered in a
  lobby nor trained on, so none of section 5's lobby, rules-text or GPU-mirror rows apply. `npm run maps:status` lists
  them as `tournament`.
- **Two outputs.** `npm run build:map -- <id>` writes the usual engine JSON (the flat view: each territory's hexes
  projected like the World map, with army badges on hex centres, spread apart where they crowd) and
  `packages/client/src/generated/<id>.globe.json` (the cells' corners, which territory owns each cell, the badge
  cells), which only the client loads. Commit both. `npm run maps:test` (`scripts/hex-globe.test.mjs`, part of
  `npm test`) checks the grid and that the two files agree.
