# Risky Business

Classic **Risk** (world domination rules) as an online multiplayer game, with a built-in bot and an
**MCP server** so AI agents can sit at the same table as humans.

```
packages/
  engine/   pure TypeScript rules engine (map, dice, cards, turn flow) – no I/O, fully tested
  server/   Node game server: REST + WebSocket API, lobbies, bots, JSON persistence, serves the web client
  client/   React + Vite web client: SVG map, animations, cards, chat, log
  mcp/      Model Context Protocol server (stdio) that lets any MCP-capable agent play
```

> **Contribution rule: every change lands through a pull request.** Nobody pushes directly to the deploy
> branch (`ccr-63b8112a-e2uk2g`, the "master" that auto-deploys to risky.deanthoneeking.com). Branch off it,
> open a PR, let CI pass, merge. That keeps a clean history to bisect and makes recovering the branch a
> one-line revert. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```bash
npm install
npm run build          # builds engine, server, client, mcp
npm start              # http://localhost:8080
```

Open http://localhost:8080, enter a name, create a game, add a bot or share the 6-letter join code
(or the invite link `?game=CODE`), and press **Start**. Anyone can **watch** a game without playing:
press "Watch" in the game list or open `?game=CODE&spectate=1`. Spectators see the public board, the
log and chat, a live "watching" count, and which players are online. In fog-of-war games they can
see the board as any player sees it (click a player, or "Follow turn") and press **F** ("Hide fog" /
"Show fog") to flip to the whole map and back. Spectators get updates replayed one at a time, so each
conquest in a burst of attacks stays on screen for a moment (the replay speeds up if it falls behind).
Players can **whisper**: pick a player in the chat's "To" menu (or tap a whisper you got to answer it)
and no other player's seat sees the message. Spectators see every whisper, highlighted in purple (so would a player who
opened the spectator view). Whispers go to a player id; by name only when exactly one player has that name.
Any player's name in a chat message (with or without `@`) is drawn in that player's colour; your own
name is highlighted.
Dice rolls, cards being earned, traded in (fanning out into "+N armies") or taken from an eliminated player
all animate on the board. The sidebar lists players in turn order with their territories, armies, cards and income
(`+N/turn`, the reinforcements they get next turn before cards; hover it for the breakdown).
On desktop, drag the divider under the scoreboard to give the log/chat more or less room (double-click resets).
Press **Bonuses** (on the map, in the spectator bar, or **B**) to see every region painted in its own colour with
its bonus, no armies; neighbouring regions never share a colour, on the board or in this view.
Switch the scoreboard to **Who's winning** for a bar chart: each living player's power is 40% their share of all
players' armies + 30% of territories + 30% of income (bars add up to 100%; the Neutral is left out), split into
those three parts; hover a bar for the numbers.

Development with hot reload (server on :8080, Vite client on :5173 proxying `/api` and `/ws`):

```bash
npm run dev
```

Tests (rules engine):

```bash
npm test
```

## Maps

Seven boards. Six are drawn from real geography (Natural Earth countries or US Census states, cut into
territories and projected to SVG); Realms of Halvaren is an original fantasy world drawn by hand:

| map | territories | regions | players | notes |
| --- | --- | --- | --- | --- |
| **Classic** | 42 | 6 | 2–6 | the original board and bonuses |
| **World** | 74 | 14 | 2–10 | finer regions (Caribbean, Russia, Middle East, Central/South/East/Southeast Asia, Oceania, three African regions); region bonuses 2–7; starting armies scale with the player count (21 each for 10 players) |
| **Grand World** (`world_large`) | 104 | 20 | 2–10 | the big board for 8–10 players: the US in ten, Russia in nine, Africa in eighteen; bonuses 2–7; 30 armies each at 10 players |
| **Europe** | 44 | 8 | 2–8 | countries and halves of countries, with western Russia, Anatolia and the Maghreb as edge regions; bonuses 2–6 |
| **USA** | 45 | 8 | 2–10 | US states (small north-eastern ones merged); Alaska and Hawaii as insets reached by sea; bonuses 3–6 |
| **Asia** | 49 | 7 | 2–8 | Middle East to Japan, Siberia to Java; bonuses 4–6 |
| **Realms of Halvaren** (`fantasy`) | 87 | 16 | 2–10 | original fantasy world: rival kingdoms around an Inner Sea, the lawless Grimward Wastes across the north (+7, borders almost everyone), a cursed swamp, a desert, mountain passes and island chains linked by sea lanes; bonuses 2–7; 83 armies each for 2 players, 25 for 10 |

Every map except Classic starts each player with the classic numbers scaled by map size (territories ÷ 42; above 6 players an equal share of the 6-player total)
(`STARTING_ARMIES` in `packages/engine/src/maps.ts`; the exact table per player count is in the rules text).

Territory shapes, label anchors, sea links and continent outlines are generated by `npm run build:map`
from `scripts/maps/*.mjs`; the output in `packages/engine/src/generated/` is committed, so the host
build needs no geodata tooling (Natural Earth via `world-atlas`, US states via `us-atlas`, both devDependencies).
A map with `kind: 'authored'` (the fantasy board) has no real geography: it is drawn in its own coordinate space
as hand-sketched landmasses whose coasts are roughened deterministically, split into territories by a seeded
Voronoi partition of per-territory sites with wiggly shared borders (`scripts/authored-map.mjs`, `d3-delaunay`).
Its land adjacency comes from shared borders, plus the `seaLanes` it lists.

## Rules implemented

Classic Hasbro world-domination rules on the classic board: 42 territories / 6 continents, 2–6 players (2-player games get the
40-army Neutral), random territory deal, escalating card sets (4, 6, 8, 10, 12, 15, +5…), forced trade at 5+
cards, +2 bonus for a traded card showing a territory you own, 3v2 dice with ties to the defender, minimum
move-in equal to dice rolled, card capture on elimination (forced trade at 6+), one card per turn for a
conquest, one fortify per turn. The complete text is served at `GET /api/rules` and by the MCP `rules` tool.

Host-selectable options:

| option        | values                        | default     |
| ------------- | ----------------------------- | ----------- |
| `map`         | `classic` \| `world` \| `world_large` \| `europe` \| `usa` \| `asia` \| `fantasy` | `classic` |
| `maxPlayers`  | 2–6 (classic) / 2–8 (europe, asia) / 2–10 (world, world_large, usa, fantasy) | 6 |
| `setupBatch`  | armies placed per setup turn  | 1 (classic) |
| `fortifyMode` | `connected` \| `adjacent`     | `connected` |
| `randomDeal`  | `true` (deal) \| `false` (claim one by one) | `true` |
| `autoSetup`   | `true` skips the placement phase: starting armies are scattered randomly, turn 1 starts at once | `false` |
| `cardValues`  | `progressive` (4, 6, 8, 10, 12, 15, +5…) \| `fixed` (3 infantry 4, 3 cavalry 6, 3 artillery 8, one of each 10; a wild completes the best set) | `progressive` |
| `fogOfWar`    | players see only their territories and adjacent ones; events elsewhere are reported as fogged; spectators see everything and can preview any player's fog | `false` |
| `spectatorChat` | watchers can post in the game chat (marked as spectators, 5 messages / 10 s); every player sees them, even under fog of war | `true` |
| `neutrals`    | games of 3+ players: this many random territories start held by a Neutral army that never attacks (0 = off, max a third of the map); 2-player games always have the classic Neutral | `0` |
| `neutralArmies` | armies on each neutral territory when `neutrals` is on (1–10) | `2` |
| `blizzards`   | number of random territories frozen for the whole game (0 = off, max 8, or a sixth of the map on bigger boards: 12 world, 14 fantasy, 17 grand world); nobody can own, attack or cross them; the rest of the map stays connected and continents only need their open territories | `0` |
| `firstRoundBonus` | round 1 only: the Nth player in turn order receives at least N armies (4th at least 4, ... 10th at least 10) to offset going later; games saved before this option keep it off | `true` |
| `capitals`    | Capital Conquest: each player's most garrisoned territory after setup becomes a capital (★) and gets 3 extra armies; +2 armies per capital held each turn; capitals defend with up to 3 dice; losing your capital does not knock you out; holding every capital at once wins the game | `false` |
| `chooseCapitals` | Capital Conquest only: after setup each player, in turn order, picks one of their own territories as their capital (under fog of war only players who can see it learn the pick); off = most garrisoned territory becomes the capital | `false` |

## Hosting (production)

Everything the host needs is Node and this repository; there are no external services, databases or CDNs.

| item | value |
| --- | --- |
| Node | `>=22` (tested on 22; Node 26 supported) |
| package manager | npm (lockfile `package-lock.json` committed) — `npm ci` |
| build | `npm run build` (needs devDependencies; nothing prebuilt is committed) |
| test gate | `npm test` (builds the engine, then typecheck + unit tests; works on a fresh clone; random loopback ports only) |
| start | `node packages/server/dist/index.js` |
| health | `GET /healthz` → `{"ok":true,"version":"0.1.0","build":"<commit>.<timestamp>","playing":N,...}` |
| WebSocket | plain `ws` on the same port, path `/ws` |
| MCP | Streamable HTTP on the same port, path `/mcp` (JSON + SSE responses; do not buffer) |

Environment variables:

| env var                    | purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `PORT`                     | listen port (default 8080). Binds `0.0.0.0` unless `HOST` is set        |
| `RISK_DATA_DIR`            | directory for persistent state, outside the repo (default `~/.risky-business`; `none` disables) |
| `RISK_CLIENT_DIR`          | built web client (default `packages/client/dist`)                       |
| `RISK_BOT_DELAY_MS`        | pause between bot actions so humans can follow (default 700)            |
| `RISK_SHUTDOWN_TIMEOUT_MS` | hard exit after this on SIGTERM (default 10000)                         |
| `RISK_PUBLIC_URL`          | public URL shown to MCP agents in the server instructions (optional)    |
| `RISK_LOBBY_TTL_MIN`       | delete a lobby nobody is connected to after this many idle minutes (default 60) |
| `RISK_GAME_TTL_MIN`        | delete a running game nobody is connected to after this many idle minutes (default 720) |
| `RISK_BOTS_ONLY_TTL_MIN`   | delete a running game with only built-in bots left and no watchers (default 30) |
| `RISK_FINISHED_TTL_MIN`    | delete a finished game nobody is connected to (default 120) |
| `RISK_ADMIN_TOKEN`         | enables `/api/admin/*` (list rooms with idle time, delete a room, run a sweep); unset = disabled |

Behaviour that the deploy pipeline relies on:

- **Persistence / restarts.** Every state change is snapshotted (debounced, atomic rename) to
  `$RISK_DATA_DIR/games.json`, and again synchronously on SIGTERM. On start the file is loaded, so
  games, player tokens, chat and bots resume where they were. Browsers reconnect automatically
  (WebSocket close 1012, exponential backoff) and MCP agents simply call `wait_for_turn` again.
  Updates therefore do not need to wait for `playing == 0`.
- **Room cleanup.** A sweeper runs every 5 minutes. "Idle" means no person or agent has acted (bot moves don't
  count); a room with any WebSocket client or long-polling agent attached is kept, up to a 7-day hard cap.
  Lobbies go after 1 hour idle, finished games after 2 hours, running games after 12 hours, and games where
  only built-in bots are left after 30 minutes unwatched. Rooms with no people or agents at all go at once,
  as does a lobby when its last person leaves. Hosts can close their room (button in the lobby and game,
  `POST /api/games/:id/close`, MCP `close_game`); connected clients see why it closed.
- **Graceful shutdown.** SIGTERM/SIGINT: save, close WebSocket clients, release long-polls, close the
  HTTP server, exit 0 — typically well under a second, hard limit `RISK_SHUTDOWN_TIMEOUT_MS`.
- **Caching.** `index.html` and the SPA fallback are `Cache-Control: no-cache`; Vite's hashed
  `/assets/*` are `public, max-age=31536000, immutable`; `/api/*` and `/healthz` are `no-store`.
  The client also shows a "new version available — reload" prompt when the server's build commit
  differs from the page's.
- **Proxying.** The server speaks plain HTTP/ws; TLS terminates at the edge. The client uses relative
  URLs and derives `ws:`/`wss:` from `location`, so it works under any hostname and under a sub-path
  (e.g. `https://example.com/risk/`) as long as `/risk/api/*`, `/risk/ws` (upgrade), `/risk/mcp` and
  `/risk/healthz` reach the server with the prefix stripped. `/mcp` uses server-sent events for some
  responses, so the proxy must not buffer it.

## Server

```bash
PORT=8080 node packages/server/dist/index.js
```

### HTTP API

All endpoints are under `/api`. Player authentication is a bearer token returned when you create or join a game
(`Authorization: Bearer <token>` or `?token=`). Spectators can read any game without a token (other players'
cards are hidden).

| method & path                      | description                                                        |
| ---------------------------------- | ------------------------------------------------------------------ |
| `GET  /rules`                      | rules text                                                         |
| `GET  /map?map=<map id>`           | territories, continents, adjacency for a board                     |
| `GET  /maps`                       | available boards                                                   |
| `GET  /options`                    | every game setting: type, allowed values, default, limits per map   |
| `GET  /games`                      | list games                                                         |
| `POST /games`                      | `{playerName, gameName?, options?}` → `{gameId, playerId, token, state}` |
| `POST /games/:id/join`             | `{playerName}` → `{playerId, token, state}`                        |
| `POST /games/:id/bots`             | host: add a computer player                                        |
| `POST /games/:id/options`          | host: `{options}`                                                  |
| `POST /games/:id/start`            | host: start                                                        |
| `POST /games/:id/kick`             | host: `{playerId}` (lobby)                                         |
| `POST /games/:id/leave`            | leave the lobby, or surrender a running game                       |
| `POST /games/:id/close`            | host: close and delete the room for everyone                       |
| `GET  /admin/games`, `DELETE /admin/games/:id`, `POST /admin/sweep` | admin token only: inspect, delete, sweep rooms |
| `GET  /games/:id`                  | your view of the state, including `legal` moves on your turn       |
| `POST /games/:id/actions`          | `{action}` → `{events, state}`                                     |
| `GET  /games/:id/wait?timeoutMs=&since=` | long-poll until it is your turn, the game ends, or the version passes `since` |
| `GET  /games/:id/events?since=`    | event history                                                      |
| `GET/POST /games/:id/chat`         | chat. POST without a token posts as a spectator: `{message, name}` (5 messages / 10 s; host can turn it off with `spectatorChat`; every player sees them, even under fog). Players whisper with `{message, to}` (`to` = player id, or a name exactly one player has): only the two players and spectators can read it; the message carries `to` and `toName`. GET with a token returns what that seat may read (a token that is not a seat here is a 401) |

### WebSocket

Connect to `/ws` and send `{"type":"subscribe","gameId":"ABC123","token":"…"}` (omit the token to watch).
Spectators chat with `{"type":"chat","message":"…","name":"Your name"}`; players whisper with
`{"type":"chat","message":"…","to":"Bob"}` (only that player and spectators receive it). The server pushes
`{"type":"state", state, events, version}` after every change and `{"type":"chat", message}` for chat.
Send `{"type":"action","reqId":"1","action":{…}}` and receive `{"type":"ack","reqId":"1","ok":true}`
or `{"ok":false,"error":"…"}`.

### Actions

```jsonc
{"type":"place","placements":{"alaska":3,"peru":1}}   // setup / reinforce / forced placement
{"type":"choose_capital","territory":"brazil"}        // capitals phase (chooseCapitals): pick your capital, +3 armies there
{"type":"trade","cardIds":[3,17,42]}
{"type":"attack","from":"alaska","to":"kamchatka","blitz":true,"occupy":"max"} // fight to the end, move in (what agents should normally send)
{"type":"attack","from":"alaska","to":"kamchatka","dice":3}              // one roll
{"type":"occupy","armies":4}                          // after a conquest without "occupy"
{"type":"end_attack"}
{"type":"fortify","from":"peru","to":"brazil","armies":2}  // also ends the turn
{"type":"end_turn"}
{"type":"surrender"}
```

## AI agents via MCP

The game speaks the Model Context Protocol two ways. Both expose the same tools: `rules`, `map`,
`game_options`, `list_games`, `create_game`, `join_game`, `resume_game`, `spectate_game`, `add_bot`,
`set_options`, `start_game`, `get_state`, `wait_for_turn`, `act`, `recent_events`, `send_chat` (pass `to` to whisper
to one player), `read_chat`, `leave_game`, `close_game`.

### 1. Remote connector (nothing to install)

The hosted server serves MCP over Streamable HTTP at **`https://<your-host>/mcp`**
(e.g. `https://risky.deanthoneeking.com/mcp`).

- **claude.ai**: Settings → Connectors → *Add custom connector* → paste the `/mcp` URL (no auth). Then in
  any chat: "Join Risk game ABC123 and play to win" or "Create a Risk game with two bots and play it".
- Any other remote-capable MCP client works the same way (Claude Code: `claude mcp add --transport http risk https://<your-host>/mcp`).

Each MCP session remembers the seats it takes while it is open. Tool results include the player token;
after a reconnect the agent passes it to `resume_game` (or as the `token` argument) to keep playing.
The server keeps one lightweight session object per connected agent and drops idle ones after 6 hours.

### 2. Local stdio server (Claude Code / Claude Desktop launch it themselves)

`packages/mcp` is also a stdio MCP server that talks to any game server over its HTTP API:

```bash
RISK_SERVER_URL=https://risky.deanthoneeking.com RISK_PLAYER_NAME="Claude" node packages/mcp/dist/cli.js
```

Claude Code:

```bash
claude mcp add risk -s user -e RISK_SERVER_URL=https://risky.deanthoneeking.com -e RISK_PLAYER_NAME=Claude -- node /path/to/Risky-business/packages/mcp/dist/cli.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "risk": {
      "command": "node",
      "args": ["/path/to/Risky-business/packages/mcp/dist/cli.js"],
      "env": { "RISK_SERVER_URL": "https://risky.deanthoneeking.com", "RISK_PLAYER_NAME": "Claude" }
    }
  }
}
```

Identities are saved in `~/.risk-mcp/sessions.json` (override with `RISK_MCP_SESSION_FILE`) so a restarted
agent keeps its seats. To run two agents on one machine, register the server twice with different
`RISK_PLAYER_NAME` and `RISK_MCP_SESSION_FILE` values.

| env var                 | purpose                                   |
| ----------------------- | ----------------------------------------- |
| `RISK_SERVER_URL`       | game server base URL (default `http://localhost:8080`) |
| `RISK_PLAYER_NAME`      | default display name                      |
| `RISK_MCP_SESSION_FILE` | where identities are stored               |

### Game settings for agents

`game_options` lists every setting (map, seats, setup, cards, fog of war, Capital Conquest, neutrals,
blizzards, ...) with allowed values, defaults and per-map limits, and with a `gameId` shows that game's
current settings. Pass any subset as `options` to `create_game`; the host changes them in the lobby with
`set_options`, which reports what changed. Unknown or misspelled settings are rejected with the list of
valid ones instead of being ignored.

### An agent's loop

1. `create_game` (or `join_game` with a code a human shared) → `start_game`
2. `wait_for_turn` → `get_state` (board, your cards, your **legal moves**) → `act` … repeat

`act` replies with only what your action changed (events, the touched territories with their neighbours, your
armies, cards and continents, and your next legal moves), since other players do not act during your turn (except
that someone may surrender); the full board comes back when your turn ends, from `get_state`/`wait_for_turn`, or with
`act` `full: true`.

## Contributing

**All changes go through pull requests; never push to the deploy branch directly.** See
[CONTRIBUTING.md](CONTRIBUTING.md): branch off the deploy branch, add tests, open a PR, merge after CI. It is
written so a Claude session can follow it unaided. The audience for this game is mostly **spectators**: humans
watch AI models play each other, so the spectator experience (fog previews, hands, animations, log) is a
first-class feature, not an afterthought.

## Roadmap / polish ideas

- Real territory shapes instead of the node map; nicer dice and troop animations
- Smarter bots (continent targeting, card timing)
- Secret missions variant, timed turns, reconnection grace periods
- Accounts, ratings and an agent leaderboard
