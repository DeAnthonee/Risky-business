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
| health | `GET /healthz` → `{"ok":true,"version":"0.1.0","build":"<commit>.<timestamp>","playing":N,...,"loopLagMs":N}`. `persistence` is `"disk"` or `"disabled"`, never the data dir path (the startup log prints the path). `loopLagMs` is the event loop's 99th-percentile delay over the last full minute (the current minute until one has passed): a few ms when idle, and it climbs under load |
| WebSocket | plain `ws` on the same port, path `/ws` |
| MCP | Streamable HTTP on the same port, path `/mcp` (JSON + SSE responses; do not buffer) |

Environment variables:

| env var                    | purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `PORT`                     | listen port (default 8080). Binds `0.0.0.0` unless `HOST` is set        |
| `RISK_DATA_DIR`            | directory for persistent state, outside the repo (default `~/.risky-business`; `none` disables) |
| `RISK_CLIENT_DIR`          | built web client (default `packages/client/dist`)                       |
| `RISK_AI_DIR`              | folder the server reads `AI/` (characters, general player, model docs) from (default the repo's `AI/`) |
| `RISK_BOT_DELAY_MS`        | pause between bot actions so humans can follow (default 700)            |
| `RISK_SHUTDOWN_TIMEOUT_MS` | hard exit after this on SIGTERM (default 10000)                         |
| `RISK_PUBLIC_URL`          | public URL shown to MCP agents in the server instructions (optional)    |
| `RISK_MCP_SESSION_IDLE_MS` | drop a `/mcp` session idle this long (default 21600000 = 6 h)           |
| `RISK_LOBBY_TTL_MIN`       | delete a lobby nobody is connected to after this many idle minutes (default 60) |
| `RISK_GAME_TTL_MIN`        | delete a running game nobody is connected to after this many idle minutes (default 720) |
| `RISK_BOTS_ONLY_TTL_MIN`   | delete a running game with only built-in bots left and no watchers (default 30) |
| `RISK_FINISHED_TTL_MIN`    | delete a finished game nobody is connected to (default 120) |
| `RISK_FINISHED_CLOSE_MIN`  | close a finished game this many minutes after it ended, spectators or not (default 2; `0` disables) |
| `RISK_ABANDONED_CLOSE_MIN` | close a lobby or running game once no player seat has had a WebSocket, a long-poll or an authenticated request for this many minutes (default 2; `0` disables). Bots and spectators do not count; tournament tables and bots-only games keep their own rules |
| `RISK_PLAYER_KEYS`         | `0` turns off issuing player keys (`POST /api/players` answers 403); keys already issued keep working. Default on. Players and the hashes of their keys are saved in `$RISK_DATA_DIR/player-keys.json` (never a key itself), with the last day's issues for the limits below, so a restart keeps them |
| `RISK_PLAYER_KEYS_PER_IP_DAY` | player keys issued to one client IP in any 24 h (default 3); past it, 429 with `Retry-After`. Behind a proxy the IP comes from `trust proxy` (see [hardening #11](hardening.md#11-player-key-limits-trust-the-proxys-client-address)) |
| `RISK_PLAYER_KEYS_PER_DAY` | player keys issued in total in any 24 h (default 100) |
| `RISK_SEASON_KEY`          | set to a value of your choice to show the leaderboard's **Archive season** button: that password (or the admin key) archives the public board's season from the site ([leaderboard-seasons.md](leaderboard-seasons.md)). Wrong tries lock out (5 per IP, 20 in total, 15 minutes), saved in `$RISK_DATA_DIR/season-key-lockout.json` so restarts keep them. Unset = the button shows disabled and the route answers 403 (no default password) |
| `RISK_ADMIN_TOKEN`         | the host's admin key: enables `/api/admin/*` (list rooms with idle time, delete a room, run a sweep, create/start/forfeit/delete tournaments); unset = disabled |
| `RISK_CHARACTERS_KEY`      | write key for AI character saves (profiles, diaries, relationships); the admin token also works. Unset (and no admin token) = characters are read-only |
| `RISK_RECORDS_KEY`         | read-only key for full game records (`GET /api/records/:id`, `/api/records/:id/playbyplay`, header `x-records-key`; the admin token also works). Records hold every hand and the hidden board, so the owner keeps this value private: no session generates, reads or prints it. Unset = those routes are off (403) |
| `RISK_ARCHIVE`             | `0` turns off game records (on by default whenever `RISK_DATA_DIR` persists; see [game records](game-records.md)) |
| `RISK_ARCHIVE_KEEP`        | how many finished game records to keep, newest first (default `0`: keep them all, owner 2026-10-22). Records are gzipped on disk (`archive/games/<yyyy-mm>/<id>.json.gz`, about a tenth of their JSON size: roughly 2 GB a year of JSON is near 0.2 GB on disk); plain `.json` records from before still load. Above 0, older records and their index lines are deleted as new games are filed |
| `RISK_TOURNEY_ADMIN_CODE`  | the owner's **admin hosting code**: creates tournaments without a daily limit and starts any tournament ([tournaments.md](tournaments.md#hosting-codes-and-caps)). The owner sets the value; no session writes, prints or logs it. Setting it (or the limited code) makes creating need a code |
| `RISK_TOURNEY_LIMITED_CODE` | the owner's **limited hosting code**: `RISK_TOURNEY_LIMITED_PER_DAY` creates per UTC day; starts the tournaments made with it, in open mode, or before the codes. Same secrecy as the admin code |
| `RISK_DISCONNECT_TIMEOUTS` / `RISK_DISCONNECT_IDLE_S` | disconnected tournament seats ([tournaments.md](tournaments.md#disconnected-seats)): turn-timer timeouts in a row (default 1; `0` = never drop) and the idle floor in seconds (default 90; the window is max(the move timer, this)) before a Zerg takes the seat over ("<name>-Zerg") |
| `RISK_TOURNEY_STRICT`      | `1` = the launch levers (the caps' strict defaults below and the wrong-code lockout). Unset or anything else = **testing mode** (the default for now): no wrong-code lockout, and the defaults below in brackets [testing]. Each variable below wins in either mode |
| `RISK_TOURNEY_ATTEMPTS_PER_IP` / `RISK_TOURNEY_ATTEMPTS_GLOBAL` | wrong hosting codes before a lockout: per IP within 15 minutes (then 1 h), and from anyone within an hour (defaults 5 / 50 strict, 0 / 0 testing; `0` = that lockout off) |
| `RISK_TOURNEY_LIMITED_PER_DAY` | creates per UTC day with the limited code (default 5 [testing 50]) |
| `RISK_TOURNEY_CREATES_PER_DAY` | creates per UTC day, site-wide, by code or open mode (default 20 [testing 200]) |
| `RISK_TOURNEY_MAX_ACTIVE`  | tournaments registering or running at once, site-wide, for a create by code or open mode (default 2 [testing 10]; every tournament counts toward it) |
| `RISK_TOURNEY_MAX_ACTIVE_LIMITED` | of those, at most this many made with the limited code or in open mode at once (default 1 [testing 5]) |
| `RISK_TOURNEY_SEATS_ADMIN` / `RISK_TOURNEY_SEATS_LIMITED` | most entrants per tournament with the admin code (default 128 [testing 256]) / the limited code or open mode (default 64 [testing 256]) |
| `RISK_TOURNEY_MAX_LIVE_SEATS` | most entrant seats (`maxEntrants`) reserved by all tournaments registering or running (default 200 [testing 1000]) |
| `RISK_TOURNEY_DELOVE_ADMIN` / `RISK_TOURNEY_DELOVE_LIMITED` / `RISK_TOURNEY_DELOVE_AT_ONCE` | Delove seats per tournament with the admin code or key / the limited code or open mode, and held by open seat requests at once (defaults 40 / 16 / 48 [testing 256 / 256 / 1000]; `0` = no cap) |
| `RISK_TOURNEY_DELOVE_SEARCH_AT_ONCE` | of those, how many may run search at once (fog-off tables only; default 20); the rest play the bare network |
| `RISK_SEAT_POOL_KEY`       | the Delove seat-pool daemon's key for `/api/seat-requests` (header `x-seat-pool-key`; [tournaments.md](tournaments.md#delove-seats-on-request)). The owner sets the value; no session writes, prints or logs it. Unset = Delove seats on request off. The requests and the wrong-key lockout are saved as `seat-requests.json` and `seat-pool-lockout.json` under `RISK_DATA_DIR`. The [house roster](tournaments.md#the-house-roster) (names bound to Delove models: the answer key, admin only) is `roster.json` there too, and needs no env var |
| `RISK_TOURNEY_LAG_BRAKE_MS` | creates answer 503 while the last full minute's event-loop p99 lag is above this (default 100; `0` = off) |
| `RISK_TOURNEY_EXPIRE_HOURS` / `RISK_TOURNEY_SCHEDULED_EXPIRE_HOURS` | a tournament never started is called off this many hours after creation (default 24) / a scheduled one this many hours after its start (default 2); `0` = never |
| `RISK_TOURNAMENTS_OPEN`    | open mode: anyone can create tournaments without a code (within the caps); each creator gets that tournament's host token. Unset: on while no hosting code is set, off once one is. `0` off, `1` on. Wrong codes, the day's counts and each code-made tournament's kind are kept in `tournament-access.json` under `RISK_DATA_DIR` (never a code) |
| `RISK_QUICKPLAY_WAIT_S` | quick play: how long a waiting table waits for more entrants after its first one before it starts with whoever is there, the empty seats filled with Zergs (seconds, 1-600, default 60) |
| `RISK_QUICKPLAY_TIMER_S` | quick play: the per-move turn timer of a quick-play game (seconds, 5-600, default 60) |
| `RISK_QUICKPLAY_MAX_ROOMS` | quick play: most quick-play rooms at once, running games plus tables waiting to start (default 20; `0` turns quick play off). Joining for a new table past the cap answers 503. A running quick-play room with a living Zerg is not closed by `RISK_ABANDONED_CLOSE_MIN`: its turn timer skips absent seats and the Zergs finish the game; a table of people alone is closed as usual (the other limits still apply) |
| `RISK_MAX_ACTIVE_TOURNAMENTS` | most tournaments registering or running at once, any creator, the admin key and the schedule included (default 20; `0` = no cap). Creating another answers 400 until one finishes or is deleted. Creates by code are held to the tighter `RISK_TOURNEY_MAX_ACTIVE` |
| `RISK_REACTIONS`           | big-move pop-ups in games (a sweep, a knockout, a capital: `big_move` over the WebSocket). **Off by default** (the owner turned them off, 2026-10-22: too frequent, they blocked the board); `1` turns them back on, and the game screen then shows them and the 💬 Reactions toggle |
| `RISK_TOURNAMENT_SCHEDULE` | scheduled nested tournaments, as JSON: one entry or a list, e.g. `[{"at":"20:00","name":"Nightly Nest","finalMap":"hexworld"}]` (`at` is `"HH:MM"` daily or `"Mon,Thu HH:MM"`, **UTC**; also `signupMinutes`, default 60 and up to 7 days, `checkinMinutes`, default 10, `minEntrants`, default 2, and any nested setting; see [tournaments.md](tournaments.md#scheduled-tournaments)). Unset = no schedule (the default). An invalid schedule is logged and stays off; the server still starts. The slots' state is saved in `tournament-schedule.json` under `RISK_DATA_DIR` |
| `RISK_PREREG_PER_JOINER`   | scheduled tournaments: open registrations one joiner may hold (an IP over HTTP, an MCP session over `/mcp`; default 4, `0` = no cap). Pre-registration needs no code, so this keeps one client from filling a tournament ([tournaments.md](tournaments.md#scheduled-tournaments)) |
| `RISK_PREREG_PER_DAY`      | scheduled tournaments: registrations site-wide in any 24 h (default 500, `0` = no cap); past it a join answers 429. Kept in memory |
| `RISK_TOURNAMENT_SCHEDULE_FILE` | the same schedule from a JSON file (a path), easier to edit; read at startup, so restart after a change. `RISK_TOURNAMENT_SCHEDULE` wins when both are set |
| `RISK_TOURNAMENTS_KEEP`    | how many finished tournaments to keep in `tournaments.json`, newest first (default 100, at least 1). Older ones are pruned when another finishes and on startup |

Behaviour that the deploy pipeline relies on:

- **Persistence / restarts.** Every state change is snapshotted (debounced, atomic rename) to
  `$RISK_DATA_DIR/games.json`, and again synchronously on SIGTERM. The debounce is 0.5 s, and 2 s while more than
  10 games are being played (each save stringifies every room). A tournament table saves only its newest 500
  history entries (its game record keeps every move); it keeps the full history in memory until it closes. On start the file is loaded, so
  games, player tokens, chat and bots resume where they were. Browsers reconnect automatically
  (WebSocket close 1012, exponential backoff) and MCP agents simply call `wait_for_turn` again.
  Updates therefore do not need to wait for `playing == 0`.
  The leaderboard keeps its own `$RISK_DATA_DIR/rankings.json` (every finished game, kept when rooms close). It
  runs in seasons (recorded in `rankings.json.season`): `POST /api/admin/rankings/new-season` (admin token), or the
  first start on a newer `RANKINGS_SEASON` in code, moves the old board to `rankings.season-<old>.json` (kept and
  still readable) and starts empty; the higher of the code and saved seasons wins. A corrupt file is moved to `rankings.json.corrupt`. See
  [character-league.md](character-league.md). Training games (model-vs-model yardsticks) are ranked apart in
  `$RISK_DATA_DIR/rankings-training.json` (no seasons).
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
  `/assets/*` are `public, max-age=31536000, immutable`; `/api/*` and `/healthz` are `no-store`. The link-preview
  picture is served outside `/api`, at `GET /og/game/:id.png`, as `public, max-age=60` so link crawlers can keep it
  (its URL in the page carries the game version, so a new move is a new URL).
- **Link previews.** The SPA fallback serves `index.html` with Open Graph and Twitter tags for `/?game=ID`,
  `/?tournament=ID` and the home page (still `no-cache`); absolute URLs come from the request's protocol and host
  (`trust proxy` is on, so `X-Forwarded-Proto` counts), never a hard-coded name. The board picture is rendered by
  `@resvg/resvg-wasm` (WASM, no native binary; loaded on the first picture, so startup and memory stay lean) and kept
  in memory per game version (the 100 most recent games), one render per move at most.
  The client also shows a "new version available — reload" prompt when the server's build commit
  differs from the page's.
- **Proxying.** The server speaks plain HTTP/ws; TLS terminates at the edge. The client uses relative
  URLs and derives `ws:`/`wss:` from `location`, so it works under any hostname and under a sub-path
  (e.g. `https://example.com/risk/`) as long as `/risk/api/*`, `/risk/ws` (upgrade), `/risk/mcp` and
  `/risk/healthz` reach the server with the prefix stripped. `/mcp` uses server-sent events for some
  responses, so the proxy must not buffer it.

