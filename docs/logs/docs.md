# Documentation and agent instructions: running log

Covers README.md (the AI guide), CLAUDE.md and the agent pointer files, CONTRIBUTING.md, the PR template and the
docs under `docs/` that have no area of their own. A doc change that belongs to an area (for example a new HTTP route
in `docs/http-api.md`) goes in that area's log instead.

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **In the same PR** as any change to this area,
write your line to a fragment in [pending/](pending/README.md), not to this file (README hard rule 12; folded in by
`npm run logs:fold`).

- 2026-10-22 #243 playing.md: the live globe in the Inception view
- 2026-10-22 #241 tournaments.md: tournament-mode defaults and the thaw rule
- 2026-10-22 #239 docs/delove-fog.md: the oracle control's reading matches its interval ("the sampler, not the search, is what loses")
- 2026-10-22 #234 tournaments.md "Scheduled tournaments", playing.md "Next tournament", http-api.md and mcp.md
- 2026-10-22 #233 hardening items 8 (the open quick-play queue, per-IP cap only) and 9 (the queue is lost on restart)
- 2026-10-22 #229 playing.md: the Inception globe
- 2026-10-22 #227 tournaments.md: `hexworld` as a final board
- 2026-10-22 #221 playing.md: the globe view
- 2026-10-22 #220 maps.md (thirteen boards, Hex Earth row), playing.md, game-settings.md map pool, README count
- 2026-10-22 #218 map-making.md section 8 (hex-globe maps), conventions.md and maps.md on the new map kind; `npm run maps:test` in `npm test`
- 2026-10-22 #213 hardening item 7: anyone can trip the season-archive lockout for 15 minutes (the admin route still works); the per-IP count trusts the proxy's forwarded address
- 2026-10-22 #212 game-records.md lists the decision-note keys the play-by-play reads
- 2026-10-22 #208 game-records.md (play-by-play, records key) and the roadmap (G2)
- 2026-10-22 #206 game-records-roadmap.md: decision notes (G1) in the Done table
- 2026-10-22 #191 README hard rule 10 (owner's wording): the client moves a spectator to another game only when they turned that on, and never moves a player; the one exception is runner generation training matches (`Generation <tag> Match <n>`), which stay automatic. The features that move a spectator (auto-spectate, Generation matches, the nested tournament page's opt-in Follow the action) are described in docs/playing.md ("Features that move a spectator") and docs/tournaments.md
- 2026-10-22 #190 hardening.md item 2: the tournament feed shows every table to anyone, entrants included
- 2026-10-22 #183 hardening.md item 6: tournament entrants cannot be characters yet, so the tournament board ranks by entrant name only
- 2026-10-21 #178 README hard rule 9: procedural boards come only from the seeded engine generator (`procgen.ts`), are never written to `generated/`, and a released generator version never changes its output (owner-approved); docs/maps.md and docs/map-making.md section 8 on generated boards
- 2026-10-21 #195 log lines go in a per-PR fragment, `docs/logs/pending/<branch>.md`, folded into the logs by `npm run logs:fold` (`scripts/fold-logs.mjs`); `npm test` validates fragments (`logs:check`) and tests the fold (`logs:test`); README hard rule 12, the Running logs section, CONTRIBUTING, the PR template, every log header and a table-of-contents line for `docs/logs/pending/README.md`
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
