server: - 2026-10-22 #PR scheduled tournaments: a site-wide daily cap on pre-registrations (`RISK_PREREG_PER_DAY`, default 500, a rolling 24 h in memory; 429 past it), since new MCP sessions are free
hosting: - 2026-10-22 #PR new env var `RISK_PREREG_PER_DAY`
docs: - 2026-10-22 #PR tournaments.md, hosting.md, hardening.md item 11 (the daily count resets on restart too)
