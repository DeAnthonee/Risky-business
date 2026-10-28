engine: - 2026-10-28 #333 layered bonus zones (Mega Earth only): `MapDef.zones`, `zonesOf`, `income.zones` and `PlayerView.zones`; micro zones, sections and continents stack on the region bonuses; rules text
maps: - 2026-10-28 #333 Mega Earth gets 103 micro zones (5-9 hexes, +2/+3), 32 hand-named sections (+3 to +9) and 4 continents (half their regions again); `zones` in the map definition, built by `build-map.mjs`
server: - 2026-10-28 #333 `GET /api/map` lists a board's bonus zones (Mega Earth)
mcp: - 2026-10-28 #333 the `map` tool describes Mega Earth's layered bonus zones
client: - 2026-10-28 #333 bonuses view draws Mega Earth's sections and micro zones (flat and globe); income tooltip and player card show held zones
