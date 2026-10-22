# Hosting, CI and ops: running log

Covers deploy behaviour (`/healthz`, caching, SIGTERM, `RISK_DATA_DIR`, room cleanup, env vars), the CI workflow
(`.github/workflows/ci.yml`), the test gate and `[OPS]` issue fixes. Guide: [docs/hosting.md](../hosting.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the commit
hash instead. **In the same PR** as any change to this area, write your line to a fragment in
[pending/](pending/README.md), not to this file (README hard rule 12; folded in by `npm run logs:fold`).

- 2026-10-22 #234 new env vars `RISK_TOURNAMENT_SCHEDULE` and `RISK_TOURNAMENT_SCHEDULE_FILE` (default off); state file `tournament-schedule.json` under `RISK_DATA_DIR`
- 2026-10-22 #231 new server dependency `@resvg/resvg-wasm` 2.6.2 (WASM, no native build); `/og/game/:id.png` (outside /api) is cacheable for 60 s
- 2026-10-22 #209 new env var `RISK_SEASON_KEY` (unset = off)
- 2026-10-22 #208 new env var `RISK_RECORDS_KEY`: read-only access to full game records; the owner sets it and keeps it private
- 2026-10-21 #195 `npm test` also runs `logs:check` (validates `docs/logs/pending/` fragments, writes nothing) and `logs:test` (the fold script's tests)
- 2026-10-21 #194 docs drift: hosting.md env table lists `RISK_AI_DIR` and `RISK_MCP_SESSION_IDLE_MS`
- 2026-10-21 #179 `/healthz` adds `loopLagMs` (event-loop p99 over the last minute); the healthz shape only gains a field
- 2026-10-21 #186 `/healthz` `persistence` is `"disk"` or `"disabled"` instead of the save-file path (it named a folder on the host); the field stays
- 2026-10-20 #107 the first start after deploy archives `rankings.json` as `rankings.season-1.json` and the leaderboard restarts empty
- 2026-10-20 #101 CI writes the map status table (`scripts/map-status.mjs --markdown`) to the job summary and warns (never fails) per offered map not GPU-verified
- 2026-10-19 #78 SPA fallback served with a root so dot-folder checkouts work
- 2026-10-19 #73 CI warns (never fails) when the GPU mirror's engine fingerprint is stale
- 2026-10-19 #68 `RISK_ARCHIVE_KEEP` prunes game records (default 1000)
- 2026-10-19 #67 `RISK_ARCHIVE`: game records under `RISK_DATA_DIR/archive/`
- 2026-10-18 #61 LF checkouts everywhere (`.gitattributes`)
- 2026-10-18 #50 `RISK_FINISHED_CLOSE_MIN` / `RISK_ABANDONED_CLOSE_MIN`: close finished and abandoned rooms after 2 minutes
- 2026-10-17 #49 `RISK_CHARACTERS_KEY` write key for character saves
- 2026-10-17 #40 `RISK_TOURNAMENTS_OPEN` (temporary, default on)
- 2026-10-17 #5 idle room sweeper and `RISK_ADMIN_TOKEN` admin routes
- 2026-10-17 8e42d2c contributor flow: CONTRIBUTING.md, PR template, CI on pull requests
- 2026-10-16 daaee79 `npm test` works on a fresh clone by building the engine first
- 2026-10-16 c938373 `/mcp` served over Streamable HTTP for claude.ai connectors
- 2026-10-16 a423ede deploy-ready server: health, graceful SIGTERM, data dir, cache headers
