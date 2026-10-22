# Documentation and agent instructions: running log

Covers README.md (the AI guide), CLAUDE.md and the agent pointer files, CONTRIBUTING.md, the PR template and the
docs under `docs/` that have no area of their own. A doc change that belongs to an area (for example a new HTTP route
in `docs/http-api.md`) goes in that area's log instead.

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12).

- 2026-10-22 #PR README hard rule 10: one more exception to "the client never moves a spectator": a nested tournament page's opt-in **Follow the action** switch (off by default) moves a watcher's view between that tournament's tables on that page, never for a viewer holding a seat in it (owner, decision 19)
- 2026-10-21 #178 README hard rule 9: procedural boards come only from the seeded engine generator (`procgen.ts`), are never written to `generated/`, and a released generator version never changes its output (owner-approved); docs/maps.md and docs/map-making.md section 8 on generated boards
- 2026-10-21 #165 new [docs/zergs.md](../zergs.md): the Zerg hordes design (open and stealth modes), with its table-of-contents line
- 2026-10-20 #137 game-records.md: starting positions for training (`npm run selfplay -- positions`)
- 2026-10-20 #119 new docs/leaderboard-seasons.md (archive the board with one admin call or a `RANKINGS_SEASON` bump, view past seasons, never touch `ranking.ts` or `RULE_FILES`); README table of contents line; conventions.md server pointer
- 2026-10-20 #102 README table of contents counts twelve boards; CONTRIBUTING section 5 notes `walls` for chokepoints; docs/map-making.md no longer says `walls` is pending
- 2026-10-20 #101 how to make a new map (`docs/map-making.md`: design rules, `walls` chokepoints, previews, registration checklist, workflow, map status tracker), `scripts/preview-map.mjs`, `npm run maps:status` (`scripts/map-status.mjs`), the New map issue template and the PR template's New map checklist; pointers in CONTRIBUTING, conventions and the README table of contents
- 2026-10-20 #100 README table of contents: docs/maps.md covers eleven boards (Bohemia added)
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
