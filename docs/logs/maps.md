# Maps: running log

Covers `scripts/maps/*.mjs`, `scripts/build-map.mjs`, `scripts/authored-map.mjs`, `packages/engine/src/generated/`
and the map registry in `packages/engine/src/maps.ts`. Guide: [docs/maps.md](../maps.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the commit
hash instead. **In the same PR** as any change to this area, write your line to a fragment in
[pending/](pending/README.md), not to this file (README hard rule 12; folded in by `npm run logs:fold`).

- 2026-10-22 #220 Hex Earth (`hexworld`, 80 territories, 14 regions, 2-10 players) registered: offered for new games, in the league rotation; 28 territories renamed to general real-world area names (Beringia, Great Plains, Andes, Gobi ...) so the board does not copy the classic Risk list (owner ruling)
- 2026-10-22 #218 Hex-globe maps (`kind: 'hexglobe'`, `scripts/hex-globe.mjs`): a Goldberg hex sphere over Natural Earth land, territories grown from sites over land, sea lanes, a flat-view JSON plus a client globe file; Hex Earth (`hexworld`, 80 territories, 14 regions) generated for the owner's review, not registered yet
- 2026-10-21 #181 Nested boards (`packages/engine/src/nest.ts`): `planNest` (rounds and tables for N players: tables 3-6, final 6-10, Zergs only for 11-17 and under 6), `NestSpec`/`resolveNest` (boards inside portals, existing or generated, seeds from the root seed and path), `planToNest`
- 2026-10-21 #178 Generated boards: a seeded hex-board generator (`packages/engine/src/procgen.ts`, ids `gen1-s<seed>-p<seats>-t<territories>`, 5 territories per seat by default) built on demand by `getMap`, frozen by golden hashes; `pickStartSpots`; `scripts/preview-map.mjs` previews gen ids and contact sheets (`--sheet`)
- 2026-10-20 #102 The Nine Realms (`nine_realms`): 58 territories, 9 regions, 2-8 players, a tall original single-continent board; authored maps can set `walls` (water on every border between regions except the listed passes)
- 2026-10-20 #100 Bohemia (`bohemia`): 42 territories, 8 regions, 2-6 players, an inland kingdom whose regions meet only at 14 river fords and bridges
- 2026-10-17 #40 Four Crowns (`skirmish`): 24 territories for 2-4 players
- 2026-10-17 #33 Europe Advanced (`europe_classic`): 84 territories, 14 regions, 2-6 players
- 2026-10-17 #32 Greater Europe takes the id `greater_europe` and grows to 116 territories; `europe_advanced` becomes legacy
- 2026-10-17 #30 Greater Europe board (116 territories, 15 regions, 2-10 players)
- 2026-10-17 #20 starting armies scaled from the classic numbers by map size (`STARTING_ARMIES`)
- 2026-10-17 #18 Realms of Halvaren, the first hand-authored board (`kind: 'authored'`, `scripts/authored-map.mjs`)
- 2026-10-17 #12 Grand World, Europe, USA and Asia boards
- 2026-10-17 ebee4b1 backfill the map option for games saved before maps existed
- 2026-10-16 636a40f real-geography boards from Natural Earth: classic 42 and World 74
