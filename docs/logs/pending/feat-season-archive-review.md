server: - 2026-10-22 #213 season archive (review of #209): the wrong-try counts and lockouts are saved in `$RISK_DATA_DIR/season-key-lockout.json`, so a restart does not reset them (IPs, counts and times only, never a password)
client: - 2026-10-22 #213 leaderboard: the Archive season button shows disabled (with a reason) when the host has not set `RISK_SEASON_KEY`
server: - 2026-10-22 #213 the season-key guard forgets IPs once their window has passed (in memory and in the lockout file)
docs: - 2026-10-22 #213 hardening item 7: anyone can trip the season-archive lockout for 15 minutes (the admin route still works); the per-IP count trusts the proxy's forwarded address
