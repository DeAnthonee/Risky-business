# MCP tools: running log

Covers `packages/mcp` (tool definitions in `tools.ts`, the `RiskApi` interface, the stdio CLI) and the embedded `/mcp`
endpoint. Guide: [docs/mcp.md](../mcp.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

- 2026-10-22 #171 `add_bot` takes `kind: "zerg"` to seat a Zerg (reptile name, no `name`); `RiskApi.addBot(gameId, token, name?, kind?)` returns the seat's `name`
- 2026-10-21 #174 turn timer: `get_state`, `wait_for_turn` and `act` print a `TURN TIMER ... YOU HAVE Ns LEFT` line with the timeout rule, their descriptions warn agents, events show "skipped (timeout)"
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
