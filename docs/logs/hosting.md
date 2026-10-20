# Hosting, CI and ops: running log

Covers deploy behaviour (`/healthz`, caching, SIGTERM, `RISK_DATA_DIR`, room cleanup, env vars), the CI workflow
(`.github/workflows/ci.yml`), the test gate and `[OPS]` issue fixes. Guide: [docs/hosting.md](../hosting.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

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
