# Hosting and operations

Production runs on a Mac mini LaunchAgent at https://risky.deanthoneeking.com behind Cloudflare. Deploys are
automatic from the deploy branch `ccr-63b8112a-e2uk2g` after `npm test` passes (a failed `npm test` keeps the old
build serving). The invariants the pipeline depends on are README hard rules 6 and 7; this page is the detail.
Hosting bugs arrive as `[OPS] ...` GitHub issues (hard rule 14).

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
| `RISK_FINISHED_CLOSE_MIN`  | close a finished game this many minutes after it ended, spectators or not (default 2; `0` disables) |
| `RISK_ABANDONED_CLOSE_MIN` | close a lobby or running game once no player seat has had a WebSocket, a long-poll or an authenticated request for this many minutes (default 2; `0` disables). Bots and spectators do not count; tournament tables and bots-only games keep their own rules |
| `RISK_ADMIN_TOKEN`         | the host's admin key: enables `/api/admin/*` (list rooms with idle time, delete a room, run a sweep, create/start/forfeit/delete tournaments); unset = disabled |
| `RISK_CHARACTERS_KEY`      | write key for AI character saves (profiles, diaries, relationships); the admin token also works. Unset (and no admin token) = characters are read-only |
| `RISK_ARCHIVE`             | `0` turns off game records (on by default whenever `RISK_DATA_DIR` persists; see [game records](game-records.md)) |
| `RISK_ARCHIVE_KEEP`        | how many finished game records to keep, newest first (default 1000; `0` keeps them all). Older records and their index lines are deleted as new games are filed |
| `RISK_TOURNAMENTS_OPEN`    | **temporary, for testing**: anyone can create and start tournaments without the admin key (default on). Set to `0` before launch so only the host can |

Behaviour that the deploy pipeline relies on:

- **Persistence / restarts.** Every state change is snapshotted (debounced, atomic rename) to
  `$RISK_DATA_DIR/games.json`, and again synchronously on SIGTERM. On start the file is loaded, so
  games, player tokens, chat and bots resume where they were. Browsers reconnect automatically
  (WebSocket close 1012, exponential backoff) and MCP agents simply call `wait_for_turn` again.
  Updates therefore do not need to wait for `playing == 0`.
  The leaderboard keeps its own `$RISK_DATA_DIR/rankings.json` (every finished game, kept when rooms close). It
  runs in seasons (`RANKINGS_SEASON`, recorded in `rankings.json.season`): the first start on a newer season moves the
  old board to `rankings.season-<old>.json` and starts empty. A corrupt file is moved to `rankings.json.corrupt`. See
  [character-league.md](character-league.md).
- **Room cleanup.** A sweeper runs every 30 seconds. Two quick rules come first, and spectators don't hold
  either one off:
  - a finished game closes 2 minutes after it ended (`RISK_FINISHED_CLOSE_MIN`);
  - a lobby or running game closes once no human or agent seat has been present for 2 minutes
    (`RISK_ABANDONED_CLOSE_MIN`). Present means a WebSocket, a `wait_for_turn` long-poll in progress or any
    authenticated request. See the trade-off in [`docs/hardening.md`](hardening.md).

  Tournament tables are exempt from both. After that, "idle" means no person or agent has acted (bot moves
  don't count); a room with any WebSocket client or long-polling agent attached is kept, up to a 7-day hard
  cap. Lobbies go after 1 hour idle, finished games after 2 hours, running games after 12 hours, and games
  where only built-in bots are left after 30 minutes unwatched. Rooms with no people or agents at all go at
  once, as does a lobby when its last person leaves. Hosts can close their room (button in the lobby and game,
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

