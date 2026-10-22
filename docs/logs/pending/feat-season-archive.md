server: - 2026-10-22 #209 `POST /api/rankings/new-season` archives the public board's season with the `RISK_SEASON_KEY` password (constant-time) or the admin token; lockout after 5 wrong tries per IP or 20 in total per 15 minutes (429), saved under `RISK_DATA_DIR` so restarts keep it; `GET /rankings/seasons` says whether archiving is on
client: - 2026-10-22 #209 leaderboard: an **Archive season** button beside the season picker (password + confirm), disabled until the host sets `RISK_SEASON_KEY`
hosting: - 2026-10-22 #209 new env var `RISK_SEASON_KEY` (unset = off)
