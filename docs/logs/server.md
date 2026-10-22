# Server and HTTP API: running log

Covers `packages/server` (rooms, `/api`, `/ws`, persistence, bots, tournaments, rankings, game archive, scenarios),
except character saves ([characters.md](characters.md)) and deploy behaviour ([hosting.md](hosting.md)). Guides:
[docs/http-api.md](../http-api.md), [docs/tournaments.md](../tournaments.md), [docs/game-records.md](../game-records.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

- 2026-10-22 #180 player-type labels: `agent` on `POST /games`, `/games/:id/join` and `/tournaments/:id/join` (self-declared; bots `"bot"`, Zergs `"zerg"`), stored per room (`agents` in snapshots, optional); only the spectator view (no seat token: `GET /games/:id`, `/wait`, WebSocket) carries them, never a seat's reply, chat, the log or `/games`; finished records (`room.agents`), the archive index and `/history` include them
- 2026-10-22 #171 Zerg seats: `POST /games/:id/bots` takes `kind: "zerg"` (default "bot"); a Zerg seat (id `zerg_...`, a reptile name from `ZERG_NAMES`, no repeats in a room) plays `chooseZergAction` (zerg@1 with its default `ZERG_1_PARAMS`, so it follows zerg@1's endgame rules) with every Zerg seat in the room as its horde, through `GameRoom.commit`; ranked like any bot seat; no snapshot change
- 2026-10-21 #166 tournament host token: create (`POST /api/tournaments`, `/api/admin/tournaments`) returns `hostToken`; host routes `POST /tournaments/:id/start` (no longer open to anyone), `POST /tournaments/:id/forfeit` and `DELETE /tournaments/:id` need it or the admin key; old `tournaments.json` entries (no token) are admin-only; `RISK_MAX_ACTIVE_TOURNAMENTS` caps open ones (default 20), `RISK_TOURNAMENTS_KEEP` prunes finished ones (default 100)
- 2026-10-20 #138 training leaderboard: a room flag `board: "training"` (`POST /api/games` with the characters write key; saved in snapshots, old ones load as public) ranks into `rankings-training.json`, never `rankings.json`; `?board=training` on `/rankings` and `/rankings/profile`; `/games`, `/history` (+ `?board=`) and game records carry `board`; admin `POST /api/admin/games/:id/board` moves a game (room, ranked result, records) onto it
- 2026-10-20 #135 leaderboard season 4: `RANKINGS_SEASON` 3 → 4 archives production's board on deploy (season 3 becomes `rankings.season-3.json`), season 4 starts empty
- 2026-10-20 #122 match history: public `GET /api/history?limit=` lists finished games from the game-records index (outcomes only, never a board), newest first
- 2026-10-20 #119 leaderboard seasons without a deploy: `POST /api/admin/rankings/new-season` archives the board (same path as the `RANKINGS_SEASON` bump; higher of code and saved season wins), `GET /api/rankings/seasons`, `?season=` on `/rankings` and `/rankings/profile`; archived game ids never count again; `RANKINGS_SEASON` 2 → 3 wipes production's board on deploy
- 2026-10-20 #107 leaderboard wiped: the Gen 5 seed is removed, `RANKINGS_SEASON` 2 archives the old board, every row gets a unique display name
- 2026-10-20 #93 hardening item 6: the leaderboard seeded from off-site results (how it behaves, planned seasons fix)
- 2026-10-20 #92 seed rankings with Generation 5 tournament results and replace obsolete pre-seed data
- 2026-10-19 #79 rankings: the points Delove training uses as its value target
- 2026-10-19 #75 store support for spectator auto-redirect
- 2026-10-19 #69 scenarios: `POST /api/admin/scenarios` starts a live game from a recorded moment; `POST /games/:id/seat`
- 2026-10-19 #68 game archive keeps only the newest `RISK_ARCHIVE_KEEP` (default 1000) records
- 2026-10-19 #67 game archive: every game journalled to `RISK_DATA_DIR/archive/`; admin routes to read records
- 2026-10-19 #64 leaderboard rewards kills and tracks who eliminated whom
- 2026-10-18 #55 spectators can whisper to any player
- 2026-10-18 #50 close finished and abandoned rooms after 2 minutes
- 2026-10-17 #47 the server uses the engine's `chooseBotAction`
- 2026-10-17 #46 blitz `stopAt` over the API
- 2026-10-17 #40 host-run knockout tournaments (`tournaments.ts`, `/api/tournaments`, `/api/admin/tournaments`)
- 2026-10-17 #29 placement bursts for spectators
- 2026-10-17 #24 whispers (spectators see them) and player mentions
- 2026-10-17 #16 spectator chat reaches every player, even under fog
- 2026-10-17 #8 spectators can chat
- 2026-10-17 #7 strict settings parsing from `OPTION_SPECS` (unknown keys are errors)
- 2026-10-17 #5 idle room sweeper, host close, admin cleanup routes
- 2026-10-17 8e2d796 spectate mode: watch any game, live presence, watch links
- 2026-10-17 752d202 player name is part of creating and joining; rename in the lobby
- 2026-10-16 bc20340 first multiplayer server: REST, WebSocket, bots, JSON persistence
