# HTTP API, WebSocket and actions

The game server's public interface. Start it with:

```bash
PORT=8080 node packages/server/dist/index.js
```

## HTTP API

All endpoints are under `/api`. Player authentication is a bearer token returned when you create or join a game
(`Authorization: Bearer <token>` or `?token=`). Spectators can read any game without a token (other players'
cards are hidden).

| method & path                      | description                                                        |
| ---------------------------------- | ------------------------------------------------------------------ |
| `GET  /rules`                      | rules text                                                         |
| `GET  /map?map=<map id>`           | territories, continents, adjacency for a board                     |
| `GET  /maps`                       | available boards                                                   |
| `GET  /options`                    | every game setting: type, allowed values, default, limits per map   |
| `GET  /games`                      | list games (a tournament table carries its `tournamentId`, a training game `board: "training"`) |
| `POST /games`                      | `{playerName, gameName?, options?, board?}` → `{gameId, playerId, token, state}`. `board: "training"` makes a yardstick game for the [training leaderboard](character-league.md#training-leaderboard); it needs the characters write key in `x-characters-key` (403 without it; any other `board` is 400). Not a game setting: it changes no rule |
| `POST /games/:id/join`             | `{playerName}` → `{playerId, token, state}`                        |
| `POST /games/:id/bots`             | host: `{kind?, name?}` → `{playerId, name, state}`. `kind` "bot" (default, the built-in bot) or "zerg" (a [Zerg](zergs.md): named from the reptile list, so a `name` is a 400; any other `kind` is 400) |
| `POST /games/:id/options`          | host: `{options}`                                                  |
| `POST /games/:id/start`            | host: start                                                        |
| `POST /games/:id/kick`             | host: `{playerId}` (lobby)                                         |
| `POST /games/:id/leave`            | leave the lobby, or surrender a running game                       |
| `POST /games/:id/close`            | host: close and delete the room for everyone                       |
| `POST /games/:id/character`        | seat token + `x-characters-key`: `{characterId}` binds your seat to a character for the leaderboard (lobby) |
| `GET  /rankings?season=&board=`, `GET /rankings/profile?key=&season=&board=` | the leaderboard `{season, current, rankings}`; one identity's ranking and profile. `season` (optional, an id from `/rankings/seasons`) reads an archived season; unknown ids are 404 (see [the character league guide](character-league.md)). `board=training` reads the [training leaderboard](character-league.md#training-leaderboard) instead (`{board, season, current, rankings}`, no seasons; `season` is ignored); `board=public` or none, the public one; anything else is 400 |
| `GET  /rankings/seasons`           | `{current, seasons: [{id, season, current, games}]}`: the current season first, then archives newest first |
| `GET  /history?limit=&board=`     | match history: finished games with a winner, newest first (`limit` 1-100, default 20; `board=training` only training games, `board=public` only the others, none: all) → `{enabled, games: [{id, room, name, map, fog, tournamentId?, board?, scenario, startedAt, endedAt, winner: {id, name}, reason, turns, players: [{id, name, isBot, characterId, place}]}]}`. Read from the [game records](game-records.md) index: outcomes only, never a board, so fog games are listed too. Empty with `enabled: false` when records are off |
| `GET  /games/:id/players/:player/profile` | a seat's ranking and profile (a training game's seats: their training standing) |
| `GET  /admin/games`, `DELETE /admin/games/:id`, `POST /admin/sweep` | admin token only: inspect, delete, sweep rooms |
| `POST /admin/games/:id/board`      | admin: `{board: "training"}` moves a game to the training leaderboard → `{ok, board, gameId, room, result, records}`. Flags its room if still open (its result goes to the training board when it ends), moves its result off the current public board (`result: "moved"`; `"recorded"` if the room had finished unranked, `"already"`, or `"none"` while still playing) and marks its finished game records. 404 when no room, result or record has the id |
| `POST /admin/rankings/new-season`  | admin: archive the leaderboard now and start the next season empty → `{archived, season}` (500 and no change if the archive fails) |
| `GET  /admin/archive`, `GET /admin/archive/:id`, `GET /admin/archive/:id/steps/:step?viewer=` | admin: recorded games (index; one whole record; one moment rebuilt by replay, through a player's eyes under fog). See [game records](game-records.md) |
| `POST /admin/scenarios`            | admin: `{recordId, step, seats?: {<playerId>: "bot" \| "open"}, keepDice?, name?}` → `{gameId, scenarioOf, seats: [{playerId, bot, token}]}`: a new live game from one moment of a recorded game (see [game records](game-records.md#scenarios-playing-a-recorded-moment-out-again)) |
| `POST /games/:id/seat`             | scenario seat token: `{bot?: false}` takes the seat over from its bot; `{bot: true}` hands it back |
| `POST /admin/tournaments`          | admin: `{name?, options?, groupSize?, maxEntrants?, fillBots?}`, or for a nested tournament `{format: "nested", name?, options?, maxEntrants?, finalMap?, territoriesPerSeat?, roundMinutes?, finishShare?}` → `{hostToken, tournament}` (see [Tournaments](tournaments.md)). 400 past `RISK_MAX_ACTIVE_TOURNAMENTS` |
| `POST /admin/tournaments/:id/start`, `POST /admin/tournaments/:id/forfeit` `{entrantId}`, `DELETE /admin/tournaments/:id` | admin: seat round 1; concede for a no-show; delete (closes tables still playing) |
| `POST /tournaments`                | **temporary, for testing**: the same as `POST /admin/tournaments` but without the admin token, while `RISK_TOURNAMENTS_OPEN` is on (403 when it is off) → `{hostToken, tournament}` |
| `POST /tournaments/:id/start`, `POST /tournaments/:id/forfeit` `{entrantId}`, `DELETE /tournaments/:id` | the tournament's host: `Authorization: Bearer <hostToken>` (from create) or the admin key; 401 without one, 403 with another token. Same as the admin routes. Tournaments saved before host tokens take the admin key only |
| `GET  /tournaments`, `GET /tournaments/:id` | list; bracket. With an entrant token the bracket adds `you`: status and your current table's seat `{gameId, playerId, token, round}`. Nested brackets add `format`, `nested` (settings and the plan's table sizes), each round's `deadline`/`endedAt`, and each table's `map` and, when decided on standing, `standing` |
| `POST /tournaments/:id/join`       | `{playerName}` while registering → `{entrantId, token, tournament}` |
| `GET  /tournaments/:id/wait?since=&timeoutMs=` | long-poll until the bracket's `version` passes `since` |
| `GET  /games/:id`                  | your view of the state, including `legal` moves on your turn. Every state (here, in `/wait`, `/actions` and over the WebSocket) has `timer`: `null` when the game has no turn timer, else `{mode: "move"\|"turn", seconds, player, deadline, secondsLeft}` (`player`/`deadline`/`secondsLeft` are `null` while no human or agent clock runs; `deadline` is epoch ms on the server's clock, so count down from `secondsLeft`). On a timeout the server makes the player's moves itself: they arrive as ordinary events, the first one `{type: "timeout", player, scope}`, and `/events` history entries carry `timeout: true` |
| `POST /games/:id/actions`          | `{action}` → `{events, state}`                                     |
| `GET  /games/:id/wait?timeoutMs=&since=` | long-poll until it is your turn, the game ends, or the version passes `since` |
| `GET  /games/:id/events?since=`    | event history                                                      |
| `GET/POST /games/:id/chat`         | chat. POST without a token posts as a spectator: `{message, name}` (5 messages / 10 s; host can turn it off with `spectatorChat`; every player sees them, even under fog). Players whisper with `{message, to}` (`to` = player id, or a name exactly one player has): only the two players and spectators can read it; spectators whisper with `{message, name, to}`: only that player and spectators can read it; the message carries `to` and `toName`. GET with a token returns what that seat may read (a token that is not a seat here is a 401) |

## WebSocket

Connect to `/ws` and send `{"type":"subscribe","gameId":"ABC123","token":"…"}` (omit the token to watch).
Spectators chat with `{"type":"chat","message":"…","name":"Your name"}` (add `"to"` to whisper to one player); players whisper with
`{"type":"chat","message":"…","to":"Bob"}` (only that player and spectators receive it). The server pushes
`{"type":"state", state, events, version}` after every change and `{"type":"chat", message}` for chat.
Send `{"type":"action","reqId":"1","action":{…}}` and receive `{"type":"ack","reqId":"1","ok":true}`
or `{"ok":false,"error":"…"}`.

**Tournament feed** (for watchers of a tournament page). Send `{"type":"subscribe_tournament","tournamentId":"TAB12C"}`
(no token: a socket that passes one of the tournament's entrant tokens is refused, since entrants follow their own
table). The reply is an ack, then `{"type":"tournament_feed", tournamentId, tournament, tables}`: the bracket (as
`GET /tournaments/:id`) and a summary of every current table. After that, `{"type":"tournament_table", tournamentId,
table}` whenever a table moves, **at most every 500 ms per table** (a burst is coalesced and its last change always
arrives), and `{"type":"tournament", tournamentId, tournament}` when the bracket changes (a table settles, a round
begins: the new round's tables follow). A table summary is `{gameId, name, round, status, phase, turn, currentPlayer,
players: [{id, name, color, alive, territories, armies}], final, excitement: {score, signals: [{kind, points, label}]},
version}`, from the public spectator view only (no cards, tokens or player-type labels). `excitement` is the 0-100
"Follow the action" score (`packages/server/src/excitement.ts`). `{"type":"unsubscribe_tournament"}` leaves the feed;
a socket can hold one tournament feed and one game subscription at once.

## Actions

```jsonc
{"type":"place","placements":{"alaska":3,"peru":1}}   // setup / reinforce / forced placement
{"type":"choose_capital","territory":"brazil"}        // capitals phase (chooseCapitals): pick your capital, +3 armies there
{"type":"trade","cardIds":[3,17,42]}
{"type":"attack","from":"alaska","to":"kamchatka","blitz":true,"occupy":"max"} // fight to the end, move in (what agents should normally send; under fog of war leave out "occupy")
{"type":"attack","from":"alaska","to":"kamchatka","dice":3}              // one roll
{"type":"attack","from":"alaska","to":"kamchatka","stopAt":10}            // blitz, but stop once alaska is down to 10 (10 always stay home)
{"type":"occupy","armies":4}                          // after a conquest without "occupy" (under fog the conquest has already revealed its neighbours, capitals tagged)
{"type":"end_attack"}
{"type":"fortify","from":"peru","to":"brazil","armies":2}  // also ends the turn
{"type":"end_turn"}
{"type":"surrender"}
```

