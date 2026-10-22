server: - 2026-10-22 #PR a nested table decided on standing is archived at once like a finished game (it had only an unfinished record once its room was swept, so no play-by-play and no history entry): outcome `reason: "standing"`, the decided winner, `decided: {standing, rolls}`; index and `GET /api/history` mark it `decided: true`
engine: - 2026-10-22 #PR records: optional `outcome.decided` and reason `"standing"` (`assembleRecord(..., decided)`); additive, `RECORD_VERSION` stays 1
client: - 2026-10-22 #PR match history says "decided on standing" for such tables
