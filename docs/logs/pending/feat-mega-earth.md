maps: - 2026-10-28 #PR Mega Earth (`mega_earth`): Hex Earth on a frequency-16 globe, every one of 671 land hexagons a territory, 14 regions, 2-100 players; a tournament board (`TOURNAMENT_MAP_IDS`); builder options `cellTerritories`, `autoBonus`, `badgeGap`; huge-board previews; `maps:status` lists tournament boards
engine: - 2026-10-28 #PR `TOURNAMENT_MAP_IDS` (boards only tournaments seat); `seatColor`: distinct colours for seats past the tenth (first ten unchanged); GPU fingerprint re-verification pending (engine.ts, maps.ts, types.ts)
server: - 2026-10-28 #PR tournament style `mega` (one table of up to 100 on Mega Earth, deadline 240 minutes by default); `POST /admin/schedule/run` runs a schedule entry on demand (roster, Zergs, settings; survives a restart)
mcp: - 2026-10-28 #PR `create_tournament` takes `style` and `minTable`; `leaderboard` style `mega`
client: - 2026-10-28 #PR Mega Earth on the globe and flat map (smaller badges on huge boards); a Style picker on Create tournament; the Mega tourney board on the leaderboard and its line on the Next tournament card
delove: - 2026-10-28 #PR focused view at tables bigger than the network's 10 seat slots (`focus.ts`): the decider and its 9 most relevant opponents, the rest as neutral; used by the net scorer and search
hosting: - 2026-10-28 #PR with the mega entries the seat pool needs about 375 seats (`--max-seats`)
docs: - 2026-10-28 #PR maps.md, map-making.md, tournaments.md (mega style, on-demand runs, the noon and midnight entries), delove-status open work
