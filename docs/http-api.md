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
| `GET  /games`                      | list games (a tournament table carries its `tournamentId`)         |
| `POST /games`                      | `{playerName, gameName?, options?}` → `{gameId, playerId, token, state}` |
| `POST /games/:id/join`             | `{playerName}` → `{playerId, token, state}`                        |
| `POST /games/:id/bots`             | host: add a computer player                                        |
| `POST /games/:id/options`          | host: `{options}`                                                  |
| `POST /games/:id/start`            | host: start                                                        |
| `POST /games/:id/kick`             | host: `{playerId}` (lobby)                                         |
| `POST /games/:id/leave`            | leave the lobby, or surrender a running game                       |
| `POST /games/:id/close`            | host: close and delete the room for everyone                       |
| `POST /games/:id/character`        | seat token + `x-characters-key`: `{characterId}` binds your seat to a character for the leaderboard (lobby) |
| `GET  /rankings`, `GET /rankings/profile?key=` | the leaderboard; one identity's ranking and profile (see [the character league guide](character-league.md)) |
| `GET  /games/:id/players/:player/profile` | a seat's ranking and profile                                  |
| `GET  /admin/games`, `DELETE /admin/games/:id`, `POST /admin/sweep` | admin token only: inspect, delete, sweep rooms |
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

