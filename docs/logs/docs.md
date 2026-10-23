# Documentation and agent instructions: running log

Covers README.md (the AI guide), CLAUDE.md and the agent pointer files, CONTRIBUTING.md, the PR template and the
docs under `docs/` that have no area of their own. A doc change that belongs to an area (for example a new HTTP route
in `docs/http-api.md`) goes in that area's log instead.

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **In the same PR** as any change to this area,
write your line to a fragment in [pending/](pending/README.md), not to this file (README hard rule 12; folded in by
`npm run logs:fold`).

- 2026-10-22 #314 playing.md "Registering for a tournament", tournaments.md, http-api.md
- 2026-10-22 #313 tournaments.md "The house roster", http-api.md routes and labels, game-records.md room.roster, hosting.md roster.json, hardening.md item 16 (blind by name only)
- 2026-10-22 #311 tournaments.md (the daily tournament, `daily`/`tz`/`signupDays`/`roster`), hosting.md, playing.md
- 2026-10-22 #309 tournaments.md and hosting.md: the new disconnect defaults
- 2026-10-22 #304 tournaments.md and hosting.md: the Zerg stand-in
- 2026-10-22 #302 tournaments.md (Delove takes over), http-api.md (takeover requests and claims)
- 2026-10-22 #301 tournaments.md "Disconnected seats", hosting.md (RISK_DISCONNECT_*)
- 2026-10-22 #300 playing.md, http-api.md, hosting.md: reactions off by default
- 2026-10-22 #298 `docs/zergs.md` §7: the owner's decision on the reveal (spectators see which seats are Zergs during the game, players learn who they were when it ends; where stealth Zergs may sit is still open), and the learned Zerg's stage 0-1 status
- 2026-10-22 #295 `docs/zergs.md` §7: the learned Zerg (chat and deduction) replaces the stealth-mode "learned offset signature" handshake, a shared secret the owner ruled out: allies are a belief from chat and behaviour (listening and speaking heads), a team-spirit reward allows a little infighting, impostors are allowed, and the endgame stays rule-based (end by standing)
- 2026-10-22 #291 playing.md (the stallFogLift setting), tournaments.md (the tournament default)
- 2026-10-22 #290 playing.md: find an entrant on the globe
- 2026-10-22 #288 playing.md: the seat count and the start confirm
- 2026-10-22 #282 hardening #15: in open mode anyone, entrants included, reads player-type labels before play (the host's Who joined list); #2: a host who also enters sees opponents' labels; Entrant.agent comment fixed
- 2026-10-22 #280 hardening.md item 15: tournament hosting runs in testing mode by default; set the codes, RISK_TOURNEY_STRICT=1 and open mode off before launch
- 2026-10-22 #280 tournaments.md: no codes on the server means a typed code is ignored and open mode lets anyone start
- 2026-10-22 #279 tournaments.md (testing mode, no-codes error, who may start), hosting.md (RISK_TOURNEY_STRICT, RISK_TOURNEY_ATTEMPTS_*, testing defaults), playing.md (the Host box)
- 2026-10-22 #271 hardening.md item 14: anyone can lock the Delove seat pool out for an hour with wrong keys (as item 10 for the hosting codes)
- 2026-10-22 #271 tournaments.md "Delove seats on request", http-api.md (seat-request routes, preview delovePool), hosting.md (RISK_SEAT_POOL_KEY, RISK_TOURNEY_DELOVE_SEARCH_AT_ONCE), mcp.md, playing.md
- 2026-10-22 #270 playing.md: the player key button on the home page
- 2026-10-22 #267 hardening #2: the coach could pass fog-hidden information (the coach page serves the seat's view; honour plus friction)
- 2026-10-22 #266 tournaments.md, hosting.md, hardening.md item 13 (the daily count resets on restart too)
- 2026-10-22 #263 hardening #12: the player key in the browser's localStorage (XSS)
- 2026-10-22 #262 mcp.md and tournaments.md: reconnect_prompt
- 2026-10-22 #261 hardening.md item 10: the global wrong-code lock (50 an hour) also refuses the right hosting code for an hour, so anyone can trip it; the admin key still works (review note on #257)
- 2026-10-22 #260 hardening #3 partly fixed by player keys; new hardening #11 (player-key limits trust the proxy's address)
- 2026-10-22 #259 tournaments.md (pre-registration, check-in, no-shows), mcp.md, playing.md, http-api.md; hardening.md item 13 (the per-joiner cap resets on restart) and its README line
- 2026-10-22 #258 hardening.md item 2: the tournament feed shows owners and armies; inception.css comment names LiveGlobe
- 2026-10-22 #257 tournaments.md "Hosting codes and caps", hosting.md env vars, http-api.md, mcp.md, conventions.md; hardening #1 removed (README TOC)
- 2026-10-22 #256 playing.md: the live globe's Hex Earth final
- 2026-10-22 #255 playing.md "Tournaments on the home page" (the home-order line moved out of The House), http-api.md (`tournament` on games and the socket), tournaments.md
- 2026-10-22 #254 http-api.md feed fields; playing.md live globe
- 2026-10-22 #251 tournaments.md: the tournament page's look
- 2026-10-22 #250 playing.md: the live globe's round change
- 2026-10-22 #249 delove-status.md: the owner's 2026-10-21 decision that yardstick games stay on the public board (section 7), baseline 4 in section 9 item 4
- 2026-10-22 #246 playing.md: tournaments come first on the home page
- 2026-10-22 #245 delove-yardstick.md: baseline 4, the bare delove@12 network under fog (games 22-27; 2 per tier: Haiku mean +1.5, Sonnet +1.0, Opus -1.5) plus one no-fog delove@12 game (21); rerun steps for fog
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
