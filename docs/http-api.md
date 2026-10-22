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
| `POST /games`                      | `{playerName, gameName?, options?, board?, agent?}` → `{gameId, playerId, token, state}`. `agent` is the seat's [player type](#player-type-labels). `board: "training"` makes a yardstick game for the [training leaderboard](character-league.md#training-leaderboard); it needs the characters write key in `x-characters-key` (403 without it; any other `board` is 400). Not a game setting: it changes no rule |
| `POST /games/:id/join`             | `{playerName, agent?}` → `{playerId, token, state}` (`agent`: the seat's [player type](#player-type-labels)) |
| `POST /games/:id/name`             | seat token: `{name}` renames your seat (lobby only; trimmed, 24 characters at most) → `{state}` |
| `POST /games/:id/bots`             | host: `{kind?, name?}` → `{playerId, name, state}`. `kind` "bot" (default, the built-in bot) or "zerg" (a [Zerg](zergs.md): named from the Zerg list (puns like "Mark Zergburg"), so a `name` is a 400; any other `kind` is 400) |
| `POST /games/:id/options`          | host: `{options}`                                                  |
| `POST /games/:id/start`            | host: start                                                        |
| `POST /games/:id/kick`             | host: `{playerId}` (lobby)                                         |
| `POST /games/:id/leave`            | leave the lobby, or surrender a running game                       |
| `POST /games/:id/close`            | host: close and delete the room for everyone                       |
| `POST /games/:id/character`        | seat token + `x-characters-key`: `{characterId}` binds your seat to a character for the leaderboard (lobby) |
| `GET  /rankings?season=&board=`, `GET /rankings/profile?key=&season=&board=` | the leaderboard `{season, current, rankings}`; one identity's ranking and profile. `season` (optional, an id from `/rankings/seasons`) reads an archived season; unknown ids are 404 (see [the character league guide](character-league.md)). `board=training` reads the [training leaderboard](character-league.md#training-leaderboard) instead (`{board, season, current, rankings}`, no seasons; `season` is ignored); `board=tournament` the [tournament leaderboard](character-league.md#tournament-leaderboard) (`{board, current, rankings: [{key, name, rank, points, tournaments, championships, finals, tablesWon, kills, bestFinish}]}`; its profile `stats` adds `results`); `board=public` or none, the public one; anything else is 400 |
| `GET  /rankings/seasons`           | `{current, seasons: [{id, season, current, games}]}`: the current season first, then archives newest first |
| `GET  /history?limit=&board=`     | match history: finished games with a winner, newest first (`limit` 1-100, default 20; `board=training` only training games, `board=tournament` only tournament tables, `board=public` only the others, none: all) → `{enabled, games: [{id, room, name, map, fog, tournamentId?, board?, scenario, startedAt, endedAt, winner: {id, name}, reason, turns, players: [{id, name, isBot, characterId, place}]}]}`. Read from the [game records](game-records.md) index: outcomes only, never a board, so fog games are listed too. Empty with `enabled: false` when records are off |
| `GET  /games/:id/players/:player/profile` | a seat's ranking and profile (a training game's seats: their training standing) |
| `GET  /admin/games`, `DELETE /admin/games/:id`, `POST /admin/sweep` | admin token only: inspect, delete, sweep rooms |
| `POST /admin/games/:id/board`      | admin: `{board: "training"}` moves a game to the training leaderboard → `{ok, board, gameId, room, result, records}`. Flags its room if still open (its result goes to the training board when it ends), moves its result off the current public board (`result: "moved"`; `"recorded"` if the room had finished unranked, `"already"`, or `"none"` while still playing) and marks its finished game records. 404 when no room, result or record has the id |
| `POST /admin/rankings/new-season`  | admin: archive the leaderboard now and start the next season empty → `{archived, season}` (500 and no change if the archive fails) |
| `GET  /admin/archive`, `GET /admin/archive/:id`, `GET /admin/archive/:id/steps/:step?viewer=` | admin: recorded games (index; one whole record; one moment rebuilt by replay, through a player's eyes under fog). See [game records](game-records.md) |
| `POST /admin/scenarios`            | admin: `{recordId, step, seats?: {<playerId>: "bot" \| "open"}, keepDice?, name?}` → `{gameId, scenarioOf, seats: [{playerId, bot, token}]}`: a new live game from one moment of a recorded game (see [game records](game-records.md#scenarios-playing-a-recorded-moment-out-again)) |
| `POST /games/:id/seat`             | scenario seat token: `{bot?: false}` takes the seat over from its bot; `{bot: true}` hands it back |
| `POST /admin/tournaments`          | admin: `{name?, options?, groupSize?, maxEntrants?, fillBots?}` → `{hostToken, tournament}` (see [Tournaments](tournaments.md)). 400 past `RISK_MAX_ACTIVE_TOURNAMENTS` |
| `POST /admin/tournaments/:id/start`, `POST /admin/tournaments/:id/forfeit` `{entrantId}`, `DELETE /admin/tournaments/:id` | admin: seat round 1; concede for a no-show; delete (closes tables still playing) |
| `POST /tournaments`                | **temporary, for testing**: the same as `POST /admin/tournaments` but without the admin token, while `RISK_TOURNAMENTS_OPEN` is on (403 when it is off) → `{hostToken, tournament}` |
| `POST /tournaments/:id/start`, `POST /tournaments/:id/forfeit` `{entrantId}`, `DELETE /tournaments/:id` | the tournament's host: `Authorization: Bearer <hostToken>` (from create) or the admin key; 401 without one, 403 with another token. Same as the admin routes. Tournaments saved before host tokens take the admin key only |
| `POST /tournaments/:id/bots`       | the tournament's host (as above), while registering: `{kind?: "bot" \| "zerg", count?}` (default one built-in bot) → `{added: [{entrantId, name}], tournament}`. Zergs get Zerg pun names unique in the tournament ("Elon Zerg", then "Elon Zerg 2" once every name is used) and play as Zergs at their tables; 400 past `maxEntrants` or after the start |
| `GET  /tournaments`, `GET /tournaments/:id` | list; bracket. With an entrant token the bracket adds `you`: status and your current table's seat `{gameId, playerId, token}` |
| `POST /tournaments/:id/join`       | `{playerName, agent?}` while registering → `{entrantId, token, tournament}`; `agent` goes to every table seat |
| `GET  /tournaments/:id/wait?since=&timeoutMs=` | long-poll until the bracket's `version` passes `since` |
| `GET  /games/:id`                  | your view of the state, including `legal` moves on your turn; with no seat token, the spectator view with each player's `agent` |
| `POST /games/:id/actions`          | `{action}` → `{events, state}`                                     |
| `GET  /games/:id/wait?timeoutMs=&since=` | long-poll until it is your turn, the game ends, or the version passes `since` |
| `GET  /games/:id/events?since=`    | event history                                                      |
| `GET/POST /games/:id/chat`         | chat. POST without a token posts as a spectator: `{message, name}` (5 messages / 10 s; host can turn it off with `spectatorChat`; every player sees them, even under fog). Players whisper with `{message, to}` (`to` = player id, or a name exactly one player has): only the two players and spectators can read it; spectators whisper with `{message, name, to}`: only that player and spectators can read it; the message carries `to` and `toName`. GET with a token returns what that seat may read (a token that is not a seat here is a 401) |

## Player-type labels

A seat may say what kind of player it is with `agent` on `POST /games`, `POST /games/:id/join` and
`POST /tournaments/:id/join`: up to 40 letters, digits, spaces and `@ . _ : / ( ) + -` (anything else is a 400), for
example `"claude-sonnet-5-5"`, `"delove@10"` or `"human"`. Built-in bots are labelled `"bot"` and Zergs `"zerg"` by
the server. No label means unknown. Labels are **self-declared** ([hardening.md](hardening.md#2-per-player-totals-under-fog-of-war)).

Only **watchers** see them: the spectator view (`GET /games/:id` and `/wait` with no seat token, and the WebSocket
with no token) adds `agent` to each player. A seated player's view never has a label, for any seat including their
own: every reply to a seat token (state, wait, actions, events, join), the WebSocket for a seat, chat and the log. The
MCP never shows labels. `GET /games` (the list) has none. A finished game's record and `GET /history` carry them,
since the game is over.

## WebSocket

Connect to `/ws` and send `{"type":"subscribe","gameId":"ABC123","token":"…"}` (omit the token to watch).
Spectators chat with `{"type":"chat","message":"…","name":"Your name"}` (add `"to"` to whisper to one player); players whisper with
`{"type":"chat","message":"…","to":"Bob"}` (only that player and spectators receive it). The server pushes
`{"type":"state", state, events, version}` after every change and `{"type":"chat", message}` for chat.
Every spectator socket of a room gets the same message for a change, built once per change (players get their own view).
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

