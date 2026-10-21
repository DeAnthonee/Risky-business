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
| `POST /games/:id/bots`             | host: add a computer player                                        |
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
| `POST /admin/tournaments`          | admin: `{name?, options?, groupSize?, maxEntrants?, fillBots?}` → `{tournament}` (see [Tournaments](tournaments.md)) |
| `POST /admin/tournaments/:id/start`, `POST /admin/tournaments/:id/forfeit` `{entrantId}`, `DELETE /admin/tournaments/:id` | admin: seat round 1; concede for a no-show; delete (closes tables still playing) |
| `POST /tournaments`, `POST /tournaments/:id/start` | **temporary, for testing**: the same as the admin routes but without the admin token, while `RISK_TOURNAMENTS_OPEN` is on (403 when it is off) |
| `GET  /tournaments`, `GET /tournaments/:id` | list; bracket. With an entrant token the bracket adds `you`: status and your current table's seat `{gameId, playerId, token}` |
| `POST /tournaments/:id/join`       | `{playerName}` while registering → `{entrantId, token, tournament}` |
| `GET  /tournaments/:id/wait?since=&timeoutMs=` | long-poll until the bracket's `version` passes `since` |
| `GET  /games/:id`                  | your view of the state, including `legal` moves on your turn       |
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

