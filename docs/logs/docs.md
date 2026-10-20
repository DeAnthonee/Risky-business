# Documentation and agent instructions: running log

Covers README.md (the AI guide), CLAUDE.md and the agent pointer files, CONTRIBUTING.md, the PR template and the
docs under `docs/` that have no area of their own. A doc change that belongs to an area (for example a new HTTP route
in `docs/http-api.md`) goes in that area's log instead.

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12).

- 2026-10-20 #101 how to make a new map (`docs/map-making.md`: design rules, chokepoints, previews, registration checklist, workflow) and `scripts/preview-map.mjs`; pointers in CONTRIBUTING, conventions and the README table of contents
- 2026-10-20 #97 audit of unreviewed PRs: runner README room names (#95), hosting.md rankings.json and seed (#92), log fixes
- 2026-10-20 #96 hard rule 10: spectators also move on from runner generation training matches
- 2026-10-20 #91 README table of contents lists every doc (game-settings, general-player and model docs); `docs/game-settings.md` corrected against the engine
- 2026-10-20 #89 Gen 5 game settings specification and test configs (docs/game-settings.md)
- 2026-10-20 #84 README becomes the AI guide (table of contents + hard rules); details moved to `docs/`; running logs in `docs/logs/`; CLAUDE.md imports README
- 2026-10-19 #70 game records roadmap (`docs/game-records-roadmap.md`)
- 2026-10-19 #65 README: the leaderboard tools report kills since #64
- 2026-10-18 #62 docs for #60: `@all` pings; spectator text in bot memory
- 2026-10-18 #58 docs: total reinforcement income is public under fog since #56
- 2026-10-18 #54 point every AI coding agent at the project's context files (AGENTS.md, GEMINI.md, Copilot, Cursor, Windsurf, Cline)
- 2026-10-18 #51 README: the 2-minute room cleanup from #50
- 2026-10-17 #2 PR-only change policy, spectator-first note
- 2026-10-17 8e42d2c CONTRIBUTING.md and the PR template
