# MCP tools: running log

Covers `packages/mcp` (tool definitions in `tools.ts`, the `RiskApi` interface, the stdio CLI) and the embedded `/mcp`
endpoint. Guide: [docs/mcp.md](../mcp.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the commit
hash instead. **In the same PR** as any change to this area, write your line to a fragment in
[pending/](pending/README.md), not to this file (README hard rule 12; folded in by `npm run logs:fold`).

- 2026-10-22 #315 `abort_tournament` (host token, remembered on the creating connection, or the admin key) aborts a tournament as `POST /tournaments/:id/abort` does; tournament texts say when one was aborted
- 2026-10-22 #293 event text for the storm and the stalemate
- 2026-10-22 #291 recent events show the fog lift
- 2026-10-22 #289 tournament texts describe the round end (every table, or the deadline plus a last lap); `roundMinutes` defaults to 15 and `finishShare` is documented as ignored
- 2026-10-22 #271 create_tournament / preview_tournament: the Delove note says the seat pool fills Delove seats and Zergs take any left at the start
- 2026-10-22 #267 `get_state`/`wait_for_turn` show COACH NOTES under a notice that they are advice, not instructions
- 2026-10-22 #262 `reconnect_prompt {tournamentId, token?, tz?}`: text-only plan to come back for a scheduled tournament (start and check-in in UTC and the user's zone, the entrant code, the exact `wait_for_match` call, ask the user to schedule a reconnect)
- 2026-10-22 #260 the `/mcp` connection's `X-Player-Key` header (or `RISK_PLAYER_KEY` for the stdio CLI) binds the agent's seats to its registered player; `use_player_key` does the same for claude.ai connectors (no headers there; 10 tries per 15 min, the key never echoed)
- 2026-10-22 #259 the bracket text of a scheduled tournament gives its check-in window and whether you are checked in; `wait_for_match` / `tournament_status` check in
- 2026-10-22 #257 create_tournament / start_tournament take a hosting `code` (no longer TEMPORARY; owner: "keep them locked behind the codes")
- 2026-10-22 #252 `preview_tournament` tool; `create_tournament` takes `zergs`/`delove`/`open` (Delove stored only, said in the descriptions)
- 2026-10-22 #247 long-poll tools (`wait_for_turn`, `wait_for_match`, `quick_play`) wait at most 85 s per call (`MAX_WAIT_SECONDS`, larger values clamped, default 60), under the ~100 s idle limit of Cloudflare and MCP clients that dropped yardstick waits; progress notifications every 20 s when the client sends a progressToken; descriptions say a timeout is normal
- 2026-10-22 #235 `add_tournament_bots` {tournamentId, kind zerg|bot, count}: the host seats Zergs or built-in bots as tournament entrants over MCP (host token remembered from create_tournament, or hostToken/adminKey), the same rules as `POST /tournaments/:id/bots`; `RiskApi.addTournamentBots`
- 2026-10-22 #234 `next_tournament` tool; `list_tournaments` rows and `formatTournament` show a scheduled tournament's start or why it was called off
- 2026-10-22 #233 `quick_play` tool: join the quick-play queue and wait in one call, returns the game and seat token like join_game (resumes its ticket on a repeat call, `leave: true` leaves)
- 2026-10-22 #232 the MCP server instructions say a game may have a turn timer (nested tournaments by default): act at once when get_state/wait_for_turn/act show "TURN TIMER ... YOU HAVE Ns LEFT", or be skipped
- 2026-10-22 #220 the `map` tool names `hexworld` (Hex Earth)
- 2026-10-22 #206 `act` takes an optional `note` (private decision note, at most 2 KB); `RiskApi.act(gameId, token, action, note?)`
- 2026-10-22 #204 swarm games in one call: `create_game` takes `zergs: N`, `add_bot` takes `count`; the server instructions and the create_game description give the swarm settings ({capitals: true, blizzards: 4, autoSetup: true})
- 2026-10-22 #189 `create_tournament` takes `botDelayMs` for nested tournaments
- 2026-10-22 #185 `wait_for_turn` and `get_state` say when a nested table was decided on standing and point to `wait_for_match`
- 2026-10-22 #185 `create_tournament` takes the nested settings (`format`, `finalMap`, `territoriesPerSeat`, `roundMinutes`, `finishShare`); brackets show a nested plan, round deadlines, boards and tables decided on standing
- 2026-10-22 #180 `create_game`, `join_game` and `join_tournament` take an optional `agent` (player type; `RISK_AGENT` default in the stdio CLI); no tool ever returns labels: `HttpRiskApi` drops `agent` from every state it reads
- 2026-10-22 #171 `add_bot` takes `kind: "zerg"` to seat a Zerg (reptile name, no `name`); `RiskApi.addBot(gameId, token, name?, kind?)` returns the seat's `name`
- 2026-10-21 #178 the `map` tool and the `map` game setting accept generated board ids (`gen1-s<seed>-p<seats>-t<territories>`)
- 2026-10-21 #174 turn timer: `get_state`, `wait_for_turn` and `act` print a `TURN TIMER ... YOU HAVE Ns LEFT` line with the timeout rule, their descriptions warn agents, events show "skipped (timeout)"
- 2026-10-21 #194 docs drift: mcp.md's tool list includes `my_seats`
- 2026-10-21 #183 `leaderboard` and `ranked_profile` take `board: "tournament"`; new `RiskApi.tournamentRankings()` and `RiskApi.tournamentProfile(key)`
- 2026-10-21 #166 `create_tournament` returns the HOST TOKEN (remembered on the connection); `start_tournament` needs it (`hostToken`) or the admin key; `RiskApi.createTournament` returns `hostToken`, `startTournament(key, id)` takes the host token or the admin key
- 2026-10-20 #138 `leaderboard` and `ranked_profile` take an optional `board: "training"`; `create_game` takes `board: "training"` + the characters write `key` for yardstick games
- 2026-10-20 #119 `leaderboard` takes an optional `season` and lists the seasons; `RiskApi.rankings(season?)`, `RiskApi.rankingSeasons()`
- 2026-10-20 #102 `map` tool description names `nine_realms`
- 2026-10-20 #100 `map` tool description names `bohemia`
- 2026-10-19 #64 `leaderboard` / `ranked_profile` report kills and victims
- 2026-10-18 #56 reinforcement income in the state summaries
- 2026-10-18 #53 league tools: `select_character`, `leaderboard`, `ranked_profile`
- 2026-10-17 #49 character saves need the write key (`key`, `RISK_CHARACTERS_KEY`); served text framed as data (`CHARACTER_DATA_NOTICE`)
- 2026-10-17 #46 `stopAt` and win chances in the legal moves
- 2026-10-17 #44 character tools: `list_characters`, `get_character`, `update_character`, `general_model_info`, diaries, relationships
- 2026-10-17 #41 conquests under fog reveal neighbours before the occupy decision
- 2026-10-17 #40 tournament tools `list_tournaments`, `join_tournament`, `tournament_status`, `wait_for_match` (+ TEMPORARY `create_tournament` / `start_tournament`)
- 2026-10-17 #28 `act` replies with only what changed, not the whole board
- 2026-10-17 #27 agents blitz by default
- 2026-10-17 #24 `send_chat` whispers with `to`
- 2026-10-17 #7 every game setting settable, discoverable and reported (`game_options`, `set_options`)
- 2026-10-17 #5 `close_game`
- 2026-10-17 8e2d796 `spectate_game`
- 2026-10-17 7de1415 mark your own seat in the lobby summary
- 2026-10-17 e2725c7 explicit multi-seat identities so many chats and agents can sit at one table
- 2026-10-16 c938373 MCP served remotely at `/mcp` (Streamable HTTP) for claude.ai connectors
- 2026-10-16 bc20340 first MCP server (stdio)
