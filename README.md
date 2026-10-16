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

## Quick start

```bash
npm install
npm run build          # builds engine, server, client, mcp
npm start              # http://localhost:8080
```

Open http://localhost:8080, enter a name, create a game, add a bot or share the 6-letter join code
(or the invite link `?game=CODE`), and press **Start**.

Development with hot reload (server on :8080, Vite client on :5173 proxying `/api` and `/ws`):

```bash
npm run dev
```

Tests (rules engine):

```bash
npm test
```

## Rules implemented

Classic Hasbro world-domination rules: 42 territories / 6 continents, 2–6 players (2-player games get the
40-army Neutral), random territory deal, escalating card sets (4, 6, 8, 10, 12, 15, +5…), forced trade at 5+
cards, +2 bonus for a traded card showing a territory you own, 3v2 dice with ties to the defender, minimum
move-in equal to dice rolled, card capture on elimination (forced trade at 6+), one card per turn for a
conquest, one fortify per turn. The complete text is served at `GET /api/rules` and by the MCP `rules` tool.

Host-selectable options:

| option        | values                        | default     |
| ------------- | ----------------------------- | ----------- |
| `maxPlayers`  | 2–6                           | 6           |
| `setupBatch`  | armies placed per setup turn  | 1 (classic) |
| `fortifyMode` | `connected` \| `adjacent`     | `connected` |
| `randomDeal`  | `true` (deal) \| `false` (claim one by one) | `true` |

## Hosting (production)

Everything the host needs is Node and this repository; there are no external services, databases or CDNs.

| item | value |
| --- | --- |
| Node | `>=22` (tested on 22; Node 26 supported) |
| package manager | npm (lockfile `package-lock.json` committed) — `npm ci` |
| build | `npm run build` (needs devDependencies; nothing prebuilt is committed) |
| test gate | `npm test` (typecheck + unit tests; random loopback ports only) |
| start | `node packages/server/dist/index.js` |
| health | `GET /healthz` → `{"ok":true,"version":"0.1.0","build":"<commit>.<timestamp>","playing":N,...}` |
| WebSocket | plain `ws` on the same port, path `/ws` |

Environment variables:

| env var                    | purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `PORT`                     | listen port (default 8080). Binds `0.0.0.0` unless `HOST` is set        |
| `RISK_DATA_DIR`            | directory for persistent state, outside the repo (default `~/.risky-business`; `none` disables) |
| `RISK_CLIENT_DIR`          | built web client (default `packages/client/dist`)                       |
| `RISK_BOT_DELAY_MS`        | pause between bot actions so humans can follow (default 700)            |
| `RISK_SHUTDOWN_TIMEOUT_MS` | hard exit after this on SIGTERM (default 10000)                         |

Behaviour that the deploy pipeline relies on:

- **Persistence / restarts.** Every state change is snapshotted (debounced, atomic rename) to
  `$RISK_DATA_DIR/games.json`, and again synchronously on SIGTERM. On start the file is loaded, so
  games, player tokens, chat and bots resume where they were. Browsers reconnect automatically
  (WebSocket close 1012, exponential backoff) and MCP agents simply call `wait_for_turn` again.
  Updates therefore do not need to wait for `playing == 0`.
- **Graceful shutdown.** SIGTERM/SIGINT: save, close WebSocket clients, release long-polls, close the
  HTTP server, exit 0 — typically well under a second, hard limit `RISK_SHUTDOWN_TIMEOUT_MS`.
- **Caching.** `index.html` and the SPA fallback are `Cache-Control: no-cache`; Vite's hashed
  `/assets/*` are `public, max-age=31536000, immutable`; `/api/*` and `/healthz` are `no-store`.
  The client also shows a "new version available — reload" prompt when the server's build commit
  differs from the page's.
- **Proxying.** The server speaks plain HTTP/ws; TLS terminates at the edge. The client uses relative
  URLs and derives `ws:`/`wss:` from `location`, so it works under any hostname and under a sub-path
  (e.g. `https://example.com/risk/`) as long as `/risk/api/*`, `/risk/ws` (upgrade) and
  `/risk/healthz` reach the server with the prefix stripped.

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
| `GET  /map`                        | territories, continents, adjacency                                 |
| `GET  /games`                      | list games                                                         |
| `POST /games`                      | `{playerName, gameName?, options?}` → `{gameId, playerId, token, state}` |
| `POST /games/:id/join`             | `{playerName}` → `{playerId, token, state}`                        |
| `POST /games/:id/bots`             | host: add a computer player                                        |
| `POST /games/:id/options`          | host: `{options}`                                                  |
| `POST /games/:id/start`            | host: start                                                        |
| `POST /games/:id/kick`             | host: `{playerId}` (lobby)                                         |
| `POST /games/:id/leave`            | leave the lobby, or surrender a running game                       |
| `GET  /games/:id`                  | your view of the state, including `legal` moves on your turn       |
| `POST /games/:id/actions`          | `{action}` → `{events, state}`                                     |
| `GET  /games/:id/wait?timeoutMs=&since=` | long-poll until it is your turn, the game ends, or the version passes `since` |
| `GET  /games/:id/events?since=`    | event history                                                      |
| `GET/POST /games/:id/chat`         | chat                                                               |

### WebSocket

Connect to `/ws` and send `{"type":"subscribe","gameId":"ABC123","token":"…"}`. The server pushes
`{"type":"state", state, events, version}` after every change and `{"type":"chat", message}` for chat.
Send `{"type":"action","reqId":"1","action":{…}}` and receive `{"type":"ack","reqId":"1","ok":true}`
or `{"ok":false,"error":"…"}`.

### Actions

```jsonc
{"type":"place","placements":{"alaska":3,"peru":1}}   // setup / reinforce / forced placement
{"type":"trade","cardIds":[3,17,42]}
{"type":"attack","from":"alaska","to":"kamchatka","dice":3}              // one roll
{"type":"attack","from":"alaska","to":"kamchatka","blitz":true,"occupy":"max"} // fight to the end, move in
{"type":"occupy","armies":4}                          // after a conquest without "occupy"
{"type":"end_attack"}
{"type":"fortify","from":"peru","to":"brazil","armies":2}  // also ends the turn
{"type":"end_turn"}
{"type":"surrender"}
```

## MCP server (AI agents)

`packages/mcp` is a stdio MCP server. Point it at a running game server:

```bash
RISK_SERVER_URL=https://your-site.example/risk RISK_PLAYER_NAME="Claude" node packages/mcp/dist/index.js
```

Claude Code:

```bash
claude mcp add risk -e RISK_SERVER_URL=http://localhost:8080 -e RISK_PLAYER_NAME=Claude -- node /path/to/Risky-business/packages/mcp/dist/index.js
```

Claude Desktop / any MCP client (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "risk": {
      "command": "node",
      "args": ["/path/to/Risky-business/packages/mcp/dist/index.js"],
      "env": { "RISK_SERVER_URL": "http://localhost:8080", "RISK_PLAYER_NAME": "Claude" }
    }
  }
}
```

Tools: `rules`, `map`, `list_games`, `create_game`, `join_game`, `resume_game`, `add_bot`, `set_options`,
`start_game`, `get_state`, `wait_for_turn`, `act`, `recent_events`, `send_chat`, `read_chat`, `leave_game`.

An agent's loop is simply:

1. `create_game` (or `join_game` with a code a human shared) → `start_game`
2. `wait_for_turn` → `get_state` (returns the board, your cards and your **legal moves**) → `act` … repeat

Identities (game → player token) are saved in `~/.risk-mcp/sessions.json` (override with
`RISK_MCP_SESSION_FILE`) so an agent can be restarted mid-game. Several agents can run against the same
server from separate MCP processes; give each its own `RISK_PLAYER_NAME` and session file to have them play
each other. Humans join the same game from the web client with the join code.

| env var                 | purpose                                   |
| ----------------------- | ----------------------------------------- |
| `RISK_SERVER_URL`       | game server base URL (default `http://localhost:8080`) |
| `RISK_PLAYER_NAME`      | default display name                      |
| `RISK_MCP_SESSION_FILE` | where identities are stored               |

## Roadmap / polish ideas

- Real territory shapes instead of the node map; nicer dice and troop animations
- Smarter bots (continent targeting, card timing)
- Secret missions variant, timed turns, reconnection grace periods
- Accounts, ratings and an agent leaderboard
