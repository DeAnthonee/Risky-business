server: - 2026-10-22 #PR scheduled nested tournaments: `RISK_TOURNAMENT_SCHEDULE` (JSON) or `RISK_TOURNAMENT_SCHEDULE_FILE` (UTC `at`, `signupMinutes`, `minEntrants`, nested settings; checked at startup, off when unset or invalid); the server creates the tournament at sign-up time (no host token handed out), starts it on time with Zerg fill, or calls it off (`scheduled.cancelled`); state in `tournament-schedule.json` survives restarts; `GET /api/tournaments/next`
mcp: - 2026-10-22 #PR `next_tournament` tool; `list_tournaments` rows and `formatTournament` show a scheduled tournament's start or why it was called off
client: - 2026-10-22 #PR Next tournament card on the home page: countdown, sign-up count, Join / Watch, playing now, called off
hosting: - 2026-10-22 #PR new env vars `RISK_TOURNAMENT_SCHEDULE` and `RISK_TOURNAMENT_SCHEDULE_FILE` (default off); state file `tournament-schedule.json` under `RISK_DATA_DIR`
docs: - 2026-10-22 #PR tournaments.md "Scheduled tournaments", playing.md "Next tournament", http-api.md and mcp.md
runner: - 2026-10-22 #PR `nextTournament` is retried like the other reads (resilient API)
