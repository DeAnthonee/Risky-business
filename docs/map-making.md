# Making a new map

The end-to-end process for a new board: the design rules, tracing a reference picture, building chokepoints,
previewing, registering the map id everywhere it must appear, and the workflow from design to deploy. It is written
from the two boards made this way, The Nine Realms (`scripts/maps/nine_realms.mjs`, one landmass cut by barriers) and
Bohemia (`scripts/maps/bohemia.mjs`, one landmass per region joined at fords). Read
[CONTRIBUTING.md](../CONTRIBUTING.md#5-maps) for the build commands and [maps.md](maps.md) for the boards that exist.

New original boards use `kind: 'authored'`: hand-drawn outlines in the map's own coordinate space, one `site` per
territory, split by a seeded Voronoi partition (`scripts/authored-map.mjs`). Land adjacency comes from the shapes;
crossings over water are listed in `seaLanes`. Real-geography boards (Natural Earth, US states) follow the same
registration and workflow below but not the tracing and chokepoint sections.

## 1. Design rules

| rule | why |
| --- | --- |
| **Original names only.** No names from games, books, films or other franchises. Real place names are fine (Bohemia uses Czech towns). | The repo is public and the boards are ours. |
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

- Outlines, lakes, barriers and sites all go through `P()`; region `label` positions are in viewBox units.
- Choose `size` (the viewBox) with **open sea or margin around the land for the region labels**. The client draws
  them upper-case, centred on `label`, with the bonus after (`HOARLANDS +6`): about 8.5 units per character on
  dense maps (more than 50 territories, 10px), about 9.5 on others (12px). A label must not cross land of another
  region or a badge.
- Islets drawn small on the picture are hard to click: enlarge them about their centre (`grow()` in
  nine_realms.mjs).
- Write the grid and the scale in a comment at the top of the map file, as both boards do.

## 3. Building chokepoints

Voronoi cells on one landmass touch all their neighbours, so a region drawn on open land has many entry points. Two
ways to cut it down:

| technique | how | use it when | example |
| --- | --- | --- | --- |
| **(a) Barriers cut into one landmass** | Each barrier is a polyline turned into a thin channel polygon (`channel(line, width)`) and subtracted as a lake. Barriers run **along region borders** and stop short of each other: the gaps are the passes. | The picture is one continent with mountains, rivers or gorges between regions, and some regions should still share open land borders. | `BARRIERS` + `channel()` in `scripts/maps/nine_realms.mjs` |
| **(b) One landmass per region, joined at fords** | The whole area minus all waterways is split into pieces; each region's piece is its own landmass (`land: <region>` on its territories). Regions share no land border at all; every crossing is a `seaLanes` pair, drawn dashed. | Every region border is a river or wall, and you want exact control: the entry territories are exactly the `seaLanes` ends. | `WATERWAYS`, `outlineOf()` and `seaLanes` in `scripts/maps/bohemia.mjs` |

(a) keeps the look of one continent and lets neighbouring regions share long land borders where you want them; it
needs a few rounds of moving barrier ends to close leaks. (b) cannot leak (regions never touch) and the fords are
listed in one place, but every link between two regions is a drawn crossing. Islands and archipelagos are separate
landmasses with `territory: <id>` in either case.

Tips that came out of both boards:

- A channel 6 units wide (in sketch units, before `P()`) is enough to separate two cells; the coast roughening can
  close a narrow channel, so on (b) boards set a gentle `coast` and `densify()` the outlines (bohemia.mjs).
- A gap that should be a pass needs the two territories on each side of it to actually share a border at that gap:
  put their sites close to it.
- A lake inside a region (the Sunken Eye in nine_realms.mjs) is another way to keep two particular cells apart.
- `seaLanes` that duplicate a land border are reported as redundant: remove them.

### Finding leaks

A leak is a land border between two regions you meant to separate. List each region's entry territories and the
edges that leave it from the generated JSON (`(LAND)` is a shared border, `(sea)` a drawn crossing):

```bash
node -e "const m=require('./packages/engine/src/generated/'+process.argv[1]+'.json');const reg=Object.fromEntries(m.territories.map(t=>[t.id,t.continent]));const sea=new Set(m.seaLinks.map(l=>[l.a,l.b].sort().join('|')));for(const c of m.continents){const out=m.edges.filter(([a,b])=>(reg[a]===c.id)!==(reg[b]===c.id)).map(([a,b])=>(reg[a]===c.id?a+'>'+b:b+'>'+a)+(sea.has([a,b].sort().join('|'))?' (sea)':' (LAND)'));console.log(c.id,new Set(out.map(e=>e.split('>')[0])).size,'entries:',out.join(', '))}" nine_realms
```

Then find where two territories touch: the points their paths share are the contact. Extend the barrier over that
spot (or move a site) and rebuild:

```bash
node -e "const m=require('./packages/engine/src/generated/'+process.argv[1]+'.json');const pts=id=>new Set(m.territories.find(t=>t.id===id).path.match(/-?[\d.]+,-?[\d.]+/g));const b=pts(process.argv[3]);const s=[...pts(process.argv[2])].filter(p=>b.has(p)).map(p=>p.split(',').map(Number));console.log(s.length?s.length+' shared points, x '+Math.min(...s.map(p=>p[0]))+'..'+Math.max(...s.map(p=>p[0]))+', y '+Math.min(...s.map(p=>p[1]))+'..'+Math.max(...s.map(p=>p[1])):'no shared points')" nine_realms cragmouth seawatch
```

The contact is in viewBox units; divide back through `P()` to find it on the sketch grid. Very short contacts (under
`minBorder`, default 8) are not adjacencies but are still reported as warnings: close them too.

## 4. Previewing

`scripts/preview-map.mjs` renders a generated board to a standalone HTML page: territories in region colours,
region outlines, sea links dashed, badges at the anchors, territory names and region labels as the client places
them. It is Node only, has no dependencies and is not part of any build.

```bash
npm run build:map -- nine_realms
node scripts/preview-map.mjs nine_realms
```

It writes to the OS temp folder (`risky-map-preview/<id>.html`) unless you pass `--out page.html`, and prints the
path and a PNG command. To check the tracing, lay the reference picture under the board, placed in viewBox units
(`P()` of the picture's top-left corner, and its size times the scale; for nine_realms.mjs, `P([[0, 0]])` is
`[33, -35]` and 490x745 times 1.4 is 686x1043):

```bash
node scripts/preview-map.mjs nine_realms --ref <picture.png> 33 -35 686 1043 --ref-opacity 0.4
```

Rasterize the page with headless Edge (Chrome or Chromium take the same flags) to send the owner a PNG:

```bash
msedge --headless --disable-gpu --hide-scrollbars --window-size=1400,1600 --screenshot=<out.png> file:///<page.html>
```

On Windows `msedge` is `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`. Never commit previews or
reference pictures (README hard rule 13).

## 5. Registering a new map id

Everything a new board touches (as in the Bohemia PR #100 and the Nine Realms branch `feat/map-nine-realms`).
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
| `docs/maps.md` | the board count and a table row |
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
| 1. Design | map session | Trace, build chokepoints, `npm run build:map -- <id>` with no warnings, render previews (PNG) |
| 2. Approval | **owner** | The owner approves the design (names, regions, bonuses, chokepoints) **before anything else**. Iterate on previews until then; do not register the id yet |
| 3. Register | map session | Section 5; `npm test` and `npm run build` green; open the board in the real client (`npm start`, a lobby on the new map) and look at labels, badges and sea links |
| 4. PR | map session | One PR against the deploy branch, opened ready for review, with the preview |
| 5. Review | "Risky Business game PR reviews" session | Reviews the PR; corrections go back to the PR's session, which fixes and asks for re-review until approved |
| 6. Merge | **owner** | The owner merges; the deploy branch auto-deploys |
| 7. GPU mirror | coordinator, training PC | Re-verify the fingerprint (`packages/delove-gpu/verify.py`) |

The GPU re-verification is **not run per map PR**. Until it runs, the GPU mirror refuses to start (`StaleMirror`),
so it is batched: one `verify.py` run on the training PC after the day's merges covers every merged map, **never
while the GPU is training**, and the new fingerprint lands in its own PR (it also flips the maps to verified in
`packages/delove-gpu/README.md` and closes the open-work row in `docs/delove-status.md`).

Map designs can run in parallel sessions, one board per session and branch. A session in a git worktree runs
`npm ci` in the worktree first: without its own `node_modules`, Node resolves `@risk/*` to the main checkout and the
tests run against whatever board that checkout has. Registration PRs touch the same lines
(`MAP_IDS`, the test lists, the docs tables), so the second one to merge resolves those conflicts by keeping both
ids. Verification runs one at a time.
