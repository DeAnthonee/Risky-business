# Tournaments

Knockout tournaments, run by the host. Hosts create them with a **hosting code** from the site's owner, or the
admin key (`RISK_ADMIN_TOKEN`); see [Hosting codes and caps](#hosting-codes-and-caps). People join on the website (the
Tournaments list on the home page, or `?tournament=CODE`) and agents with `join_tournament`.
The tournament page has the home page's look (the `p5` theme and the home's panels, tickets and seat chips;
`Tournament.tsx`, `tournament.css`): the name in a cut-paper title, the join panel, the entrants as chips, and each
round's tables as tickets with a Watch button.

- **Host token.** Creating a tournament returns its `hostToken`, once (it is never in the bracket or the list). That
  token, or the admin key, starts the tournament, forfeits for a no-show and deletes it; nobody else can, not even in
  open mode. Tournaments saved before host tokens existed have none: only the admin key runs them.
- **Limits.** At most `RISK_MAX_ACTIVE_TOURNAMENTS` (default 20) tournaments register or run at once, whoever made
  them; creating another fails until one finishes or is deleted. Creates by code are held to tighter caps
  ([below](#hosting-codes-and-caps)). Only the newest `RISK_TOURNAMENTS_KEEP` (default 100) finished
  tournaments are kept; older ones are pruned from `tournaments.json`.

- **Server bots.** While registering, the host adds built-in bots or **Zergs** as entrants
  (`POST /api/tournaments/:id/bots {kind: "bot" | "zerg", count}`, host token; over MCP, `add_tournament_bots`). A Zerg entrant has a Zerg pun name
  unique in the tournament and plays as a Zerg at every table it sits at: the Zergs at one table are one horde, in
  every round (docs/zergs.md). Bots and Zergs are entrants like anyone else and can win.
- **Tables.** Each round seats the remaining entrants at tables of up to `groupSize` (default 4, on Four Crowns by
  default), split as evenly as possible; a lone entrant gets a bye. With `fillBots` (default on) round 1 is topped up
  with bots so every table is full. Bots are entrants like anyone else and can win.
- **Moving on.** A table is an ordinary game that nobody hosts (no seat can close it, kick or add players). Its winner
  moves on; when every table of a round is decided the next round is seated, until one champion is left. A table whose
  room is deleted before anyone wins is *abandoned*: nobody from it moves on.
- **No-shows.** Games have no turn timer, so the host (host token or admin key) can `forfeit` an entrant who will not
  play (they surrender at their table).
- **Watching.** The bracket page updates live; every table has a Watch button. A table is marked everywhere else too:
  a "🏆 Cup · Round 2, table 3" badge in the open games list, in the game's top bar (both open the bracket) and in its
  link preview ([playing.md](playing.md#tournaments-on-the-home-page)); the API carries it as `tournament` on the games
  list and in the game socket's first state. A nested tournament's page also has
  **Follow the action**: an opt-in switch, off by default, that moves the view to the most exciting table by itself
  (the server picks it from the tables' excitement scores; it stays at least 20 s and switches only for a clearly
  better table). It is never offered to someone holding a seat in the tournament, and any zoom by hand turns it off
  (README hard rule 10; [playing.md](playing.md#features-that-move-a-spectator)). Players get a *Play your table* button
  when they are seated; leaving the game returns to the bracket.
- **Agents.** `join_tournament` → `wait_for_match` (returns your table and seat token, and remembers the seat on the
  connection) → play it like any game → `wait_for_match` again until you are out or the champion.
- **Delove entrants.** `npm run delove-seat -- --tournament CODE --entrants N` joins N Delove entrants and plays
  them the same way over HTTP, spread over several processes (packages/delove/README.md, "Play in a real game").

**Scores.** Tables never count on the public leaderboard. When a tournament finishes, every entrant gets one result on
the [tournament leaderboard](character-league.md#tournament-leaderboard): placement (3 per round survived, final
places 2 apart, champion +6), +2 per table won and +1 per kill. Entrants are ranked by name: they cannot be bound to a
character yet ([hardening #6](hardening.md#6-tournament-entrants-cannot-be-characters-yet)).
Server bots (fill bots and Zergs) are scored but never ranked; their fun numbers show in **The House** on the home
page ([playing.md](playing.md#the-house), `GET /api/house-bots`).

**Tournament feed.** Watchers of a tournament subscribe to its live feed over the WebSocket
(`subscribe_tournament`, [http-api.md](http-api.md#websocket)): the bracket, the round clock and a summary of every
current table (who holds each territory, the leader, its excitement score), each table at most twice a second, plus the
one table the server picks for "Follow the action". Spectators only: entrants are refused.

**Follow the action (server side; the client switch comes later).** `packages/server/src/excitement.ts` scores how exciting a table
is, 0-100, from its public spectator view and recent events (owner decision 19): an elimination in the last 20 s +40
fading, a player about to be knocked out +25, a capital about to fall +30 (and +30 for 20 s after one falls), a close
race +15, two players left +15, heavy fighting up to +20, the final +20. `pickFollow` chooses the table an opted-in
watcher sees: it stays at least 20 s and switches only for a table 15 or more ahead, or when the current one ends,
with a "Following: Table 7 (capital under threat)" caption. The feed carries each table's score; the client switch
comes later.

**Zerg-only tables.** A table where only Zerg seats are left ends at once, decided by standing, and its strongest
Zerg moves on (see [zergs.md](zergs.md)). A table seated with Zergs only ends right after the deal (owner,
2026-10-22).

Tournaments are saved to `tournaments.json` in `RISK_DATA_DIR` and pick up their tables again after a restart;
tables a tournament is still waiting on are not swept as idle, except past the hard limit of 7 days idle (the Store's fixed `max`; no env var changes it).

## Hosting codes and caps

The owner sets two codes as environment variables on the server (their values are never in the repo, the docs or a
log): an **admin code**, `RISK_TOURNEY_ADMIN_CODE`, with unlimited creates, and a **limited code**,
`RISK_TOURNEY_LIMITED_CODE`, with `RISK_TOURNEY_LIMITED_PER_DAY` creates per UTC day (default 5). The codes are a
testing gate (owner, 2026-10-22); player keys or sign-in replace them later. The code is `server/src/tournament-access.ts`.

- **Testing mode** (owner, 2026-10-22: "those extra safety levers are blocking us testing it"). Unless
  `RISK_TOURNEY_STRICT=1`, the server runs with **no wrong-code lockout** (lockouts saved by a strict run are cleared
  at start) and **looser caps**: 10 tournaments at once, 5 per limited code, 200 creates a day, 50 per limited code,
  1000 seats reserved, up to 256 entrants per tournament with any code or open mode, and Delove seats up to 256 per
  tournament and 1000 at once. The codes, expiry, the search-seat cap (20) and the lag brake stay. `RISK_TOURNEY_STRICT=1`
  restores the launch levers listed below. Each lever's own variable wins in either mode. The startup log says
  `[tourney] codes: admin set|unset, limited set|unset, strict on|off` (never a value).
- **No codes on the server** (owner: "I dont care to have some code block our testing right now"): with neither code
  set, a typed `code` is **ignored**, never checked or counted (logged once: "code given but no codes set; ignored").
  Create goes ahead in open mode, and in open mode **anyone may start** a tournament; otherwise start needs the host
  token as usual.

- **Creating** (`POST /api/tournaments`, MCP `create_tournament`): once either code is set, a create needs `code` in
  the body (or the admin key on `/api/admin/tournaments`). Open mode, `RISK_TOURNAMENTS_OPEN`, lets anyone create with
  no code; it defaults **off** once a code is set and on while none is. Codes are compared in constant time.
- **Starting** (`POST /api/tournaments/:id/start`, MCP `start_tournament`): the host token, the admin key, or a code
  in the body. The admin code starts any tournament; the limited code starts those made with it, those made in open
  mode, and those made before the codes (no record). On the site, the tournament page has a **Host** box while it
  registers: **Start now** in the browser that created it (its saved host token), or a hosting code to start it from
  anywhere.
- **Wrong codes** (strict mode): 5 wrong per IP within 15 minutes lock that IP out for an hour (even the right code is refused,
  429), and 50 wrong from anyone within an hour lock everyone out until the hour passes. The answer is always
  "Wrong tournament code": it never says which code was close. The counts survive restarts
  (`RISK_DATA_DIR/tournament-access.json`, which holds no code).
- **Caps** (strict mode: resources' defaults, owner-approved; each is an env var, `0` = no cap; the names are in
  [hosting.md](hosting.md)). They apply to every create made with a code or in open mode; the admin key and the
  schedule skip them, but their tournaments count toward the at-once caps:
  - **2 tournaments** registering or running at once, site-wide; at most **1** made with the limited code (or in open
    mode) at once;
  - **seats**: up to **128** entrants with the admin code and **64** with the limited code (an unset `maxEntrants`
    becomes the smaller of that and the format's default); at most **200** seats reserved (the sum of `maxEntrants`)
    by all tournaments registering or running;
  - **20 creates** a UTC day, site-wide;
  - **Delove seats**: 40 per tournament with the admin code (or the admin key), 16 with the limited code or in open
    mode, 48 held by open requests at once, and of those at most 20 searching at once
    ([Delove seats on request](#delove-seats-on-request)). These apply to the admin key too: they guard the CPU box.
- **Lag brake**: while the event loop's p99 lag over the last full minute (the `/healthz` `loopLagMs`) is above
  100 ms, creates answer **503** "The server is busy right now".
- **Expiry**: a tournament never started is called off 24 h after it was made, and a scheduled one still registering
  2 h after its start (the schedule normally decides at the start). It ends with no rounds and no champion, and
  `scheduled.cancelled` says `expired: never started`. The server checks every 5 minutes.

## Delove seats on request

A tournament created with `delove: N` (the create form, `POST /api/tournaments`, MCP `create_tournament`) opens a
**seat request** that training's seat-pool daemon fills. The daemon runs outside the server (README hard rule 10) and
talks to it with its own key, `RISK_SEAT_POOL_KEY`, sent as the `x-seat-pool-key` header. Unset, Delove seats on
request are off: the count is only stored, and an operator joins the seats (`npm run delove-seat`). The code is
`server/src/seat-requests.ts`; the routes are in [http-api.md](http-api.md).

- **A request** is `{id, kind: "delove", tournamentId, n, claimed, joined, labelPrefix: "Delove", fog, searchAllowed,
  search, expiresAt, status}`. `searchAllowed` is true only with fog off (Delove's search is fog-off only), and
  `expiresAt` is the scheduled start (null for a host-started tournament).
- **Polling.** The daemon polls `GET /api/seat-requests?kind=delove&free=F&freeSearch=S`, sending its free capacity.
  The server keeps the last report with its time; it's **stale after 2 minutes** ("pool offline").
- **Claiming.** `POST /api/seat-requests/:id/claim {n}` answers `{tournamentId, n, search, labelPrefix, firstLabel,
  options}`. `search` is how many of the claimed seats may run search (fog off, within 20 at once). The daemon joins
  its seats with the ordinary join route plus `seatRequestId` and its key, as "Delove <firstLabel>", "Delove
  <firstLabel + 1>" and so on: each entrant is **bound** to the request, at most one per claimed seat. Then it reports
  `POST …/done {joined}` or `POST …/failed {joined, reason}`. A failed claim's unjoined seats go back to the request.
- **The pool's names are its own** in a tournament with a seat request: any other join named "Delove …" (HTTP, MCP,
  the site) is refused, look-alikes such as "Dε1ove 1" included (names are compared as skeletons), so nobody can
  take or block a pool seat by name, and nobody can register a player under one
  (`POST /api/players`). Elsewhere a seat's name stays free, for the
  operator's `npm run delove-seat`.
- **At the start**, the request closes. Delove seats not filled by then (only entrants bound to the request count)
  become **Zerg entrants**, so the bracket holds.
- **The preview** (`POST /api/tournaments/preview`, MCP `preview_tournament`, the create form) adds `delovePool:
  {online, free, freeSearch}` (null with no pool) and a line: "Delove: K seats available now", or "Delove seat pool
  offline".
- **Wrong pool keys** are limited as the hosting codes are: 5 per IP, 50 from anyone, then an hour's lockout.

## Disconnected seats

A model that gets disconnected would otherwise hold its table up (owner, 2026-10-22). The server tells it apart from
a model that is only thinking, and drops it so the table plays on. The code is `server/src/seat-health.ts` and
`GameRoom.dropSeat`.

- **Disconnected** means both: the seat ran out of the turn timer (**1 timeout**, `RISK_DISCONNECT_TIMEOUTS`; any
  move of its own resets the count), and it sent **nothing** for max(the move timer, **90 s**) (owner: "90 seconds
  seems great"; `RISK_DISCONNECT_IDLE_S` sets the floor). Any request with its seat token counts as activity: HTTP, MCP
  (`get_state`, `wait_for_turn`, chat), or an open WebSocket or long-poll. So a model that is thinking is never
  dropped. Tournament tables only, outside seats only (never bots or Zergs), and only with a turn timer (tournaments
  run one by default).
- **The takeover.** The seat's token stops working at that table: it answers **410** "You were dropped from this table
  (disconnected)…", over HTTP and MCP. A **Zerg** (zerg@2) plays the seat at once, renamed **"<name>-Zerg"** (owner:
  "have a zerg bot take over it and its hyphen with Zerg"; names cut to fit 24 characters). It is one of the table's
  horde and follows the Zerg rules. The Zerg-only end still needs **every** seat left to be a Zerg, so it never ends a
  table while a real player is seated.
  The table's chat and the game's history and record note it.
- **Delove takes over** when a seat pool is set up ([Delove seats on request](#delove-seats-on-request)). The drop opens
  a **takeover request** (`mode: "takeover"`, `n: 1`, `takeover: {gameId, playerId, name}`), listed only to a pool
  that asks for takeovers (`GET /api/seat-requests?modes=takeover`), so an older pool never sees one. Its claim answers
  `{mode: "takeover", gameId, playerId, token, search, options}`: the seat is renamed **"<name>-Delove"**, stops being a
  bot, and the pool plays it with that token through the ordinary game API (as `resume_game` does). A failed claim
  hands the seat back to a Zerg ("<name>-Zerg"), as does a Delove stand-in that disconnects in turn; neither opens a second
  request. Takeovers count toward the Delove seats at once, and close when the table ends.
- **Out of the tournament.** The entrant shows as `dropped` in the bracket (`dropped: {reason, standIn}`; 🔌 on the
  site). The stand-in plays only to finish that table. It can win the game, but **it never moves on**: the best other
  seat by standing does, as a table decided on standing (+1). That is the winner's next in line, players already out
  included (the last one out first), so the bracket stays full. The same holds for a stalemate and for a table
  decided at a round's end.

## Nested ("Inception") tournaments

`format: "nested"` at create. Every table plays on its own board, and its winner moves up to the table of the next
round; the boards nest inside each other's territories (the map side: [maps.md](maps.md#nested-boards-and-the-planner)).

- **Settings** (create): `finalMap` (an existing board for the final, seating 6+ with a region per seat, e.g. `world` or
  `hexworld`, whose 6-10 finalists start in different regions of the globe; default a generated one), `territoriesPerSeat` (generated boards' size, 4-6, default 5), `roundMinutes` (a round's deadline,
  1-240, default 15: `NESTED_ROUND_MINUTES`), `finishShare` (still accepted, 0.1-1, and stored, but ignored since
  2026-10-22: a round no longer closes early), `options` (every table's game settings except the map; they are
  checked at create on every table size from 2 to 10 seats), `maxEntrants` (default 128), `botDelayMs` (the bots' pace
  at the tables, 0-2000 ms between moves, default 300). `groupSize` and `fillBots` do not apply.
- **Seat counts** (create, any format): `zergs` (Zerg entrants, added in the same call), `delove` (Delove seats asked
  for, kept as `requested`: they open a [seat request](#delove-seats-on-request) the Delove seat pool fills, and any
  left at the start go to Zergs; with no pool set up, an operator joins them with `npm run delove-seat`) and `open` (spots for people and agents). With any count,
  `maxEntrants` defaults to their sum (a smaller `maxEntrants` is a 400). The tournament view shows `requested`.
- **Preview** (`POST /api/tournaments/preview`, MCP `preview_tournament`): the same counts and nested settings, and
  **nothing is created**. It runs the planner and returns the rounds, tables and seats per round, the finalists (plus
  any Zergs the plan adds to fit a bracket), the final's board, round 1 as #240's seating would fill it (people and
  Zergs per table, every open spot taken; Delove counts as people), the turn timer, and the time as a **range**: low =
  every round's biggest table at bot pace (75 moves per seat × `botDelayMs`, at least a minute, at most the round's
  deadline), high = rounds × `roundMinutes`, before any last laps (agents on a 90 s/move timer usually run close to it). A formula, never a
  simulation, and at most 30 previews per minute per client (429 past that).
- **Who joined** (the host only, `GET /api/tournaments/:id/entrants` with the host token or the admin key): every
  entrant's kind (Zerg, built-in bot, Delove: joined by the seat pool or labelled `delove@…`, another agent, human),
  self-declared agent label and join time, newest first, with counts and the open spots left (`maxEntrants` minus those
  joined). The create form's result screen shows it live, and so does the **Host** bar at the top of the tournament page
  (above every view) while it registers. Entrant tokens never appear. In **open mode** (testing: `RISK_TOURNAMENTS_OPEN`
  with no hosting codes, where anyone may start a tournament, #280) the list is readable by anyone too, and the
  tournament view carries `openMode: true`, so the page offers the Host bar to every browser.
- **Create form** (web client, `?host=1`, `packages/client/src/components/CreateTournament.tsx`): the seat counts and
  settings (round deadline, per-move turn timer, final board, Capital Conquest, fog), the access code, and the
  preview's breakdown updated as you type; then create, and **Start now** from the same page (the browser keeps the
  host token, `risk.tournament-host.<ID>`) or open the bracket. See [playing.md](playing.md#hosting-a-tournament).
- **Turn timer on by default.** Unless `options` set `turnTimer`, the tables run a per-move timer of 90 s (the owner's default), so a
  stalled seat cannot hold a round (on timeout the seat is skipped: see [playing.md](playing.md)). Bots and models
  move well inside it.
- **Tournament mode on by default** (owner, 2026-10-22). Unless `options` say otherwise, every table, the final
  included, deals and places armies at random (`autoSetup: true`) and plays Capital Conquest (`capitals: true`) with
  blizzards **scaled to its own board**: 10% of its territories, at least 1, at most the map's limit (a 3-seat table
  of 15 gets 2, a 6-seat table of 30 gets 3, a 50-territory final gets 5; a flat count would freeze too much of the
  small boards). A `blizzards` count in `options` overrides it at every table. These are `NESTED_DEFAULT_OPTIONS`
  and `NESTED_BLIZZARD_SHARE` in `tournaments.ts` (the tournament view shows `nested.blizzardShare`, `null` with an
  explicit count); scheduled tournaments are nested, so they get them too. Fog tables also get the **stall
  breaker** (`stallFogLift: 3`, owner, 2026-10-22): after 3 full rounds with no territory captured, the fog lifts for
  the rest of that table ([playing.md](playing.md)). Every table, fog or not, also gets the **storm** (`stallStorm: 5`:
  from 5 stalled rounds, all big stacks (every stack of more than 10 armies) lose a fifth at each round start) and the **stalemate end**
  (`stallEnd: 5`: 5 more stalled rounds after the last breaker came on, so 10 with no capture, the engine ends the game
  on standing; owner: "we'll just end the game after ... 5 full turns after all stall relievers are on"). A table ended
  by stalemate counts as **decided on standing** (owner's points rule: a win +2, decided +1): status `decided`, its
  `standing` on the bracket, and its first place moves on with +1 table point.
- **Start.** The engine's `planNest` plans the rounds for the entrants: tables of 3-6, uneven by at most one in a
  round, and a final of 6-10. Zerg entrants are added only when the count fits no plan (11-17 entrants fill to 18; under 6 fill
  the final to 6). A random seed, saved with the tournament, fixes every board (`planToNest`, generated gen1 boards
  sized for each table) and the seating (`seatNestedRound` in `packages/server/src/tournaments.ts`; owner,
  2026-10-22: "Zergs spread out between all rooms approximately evenly; no Zerg-only lobbies") in three tiers:
  **guests** (people and outside agents) first, one per table in turn (the table with the fewest, then the parent group
  with the fewest, so they spread over the whole bracket); then the **house AI** evenly (each to the table with the
  fewest); then the server bots: Zergs (the host's and the planner's fillers) each to the table with the fewest server
  bots, then the built-in bots the same way. House AI is our own models, which join over HTTP like guests: an entrant
  the Delove seat pool joined (seat requests), or one whose agent label starts with `delove@` or `jacob-sensei@`
  (`HOUSE_AI_AGENT`, `isHouseAi`). So guests are never crowded out by Delove (TF6723: 50 Delove + 10 guests over 10
  tables seated the guests 2,0,2,1,2,0,0,0,1,2; now one per table), no table is all server bots while there are at
  least as many guests and house AI as tables, and the Zergs at tables of one size differ by at most one. Filler Zergs
  move up like any entrant when they win. Later rounds seat each
  table's winner at its parent table (its portal), so a parent table can still be all Zergs when Zergs won every
  child table under it. **Every round-1 table starts at
  once.**
- **The round clock** (owner, 2026-10-22: "get rid of the 51 percent cut off for now and just have a maximum of 15
  minutes per round, and the cut off will be at the end of the turn order so all players have the same amount of turns
  taken"). A round never closes early on a share of its tables. It ends when no table is left playing, or after its
  deadline (`roundMinutes` after it started, stored as an absolute time) and a **last lap**:
  - At the deadline (`lastLapAt` in the bracket), each table still playing records the go-around of the turn order it
    is on (`lapRound`, the engine's `GameState.round`) and plays on.
  - A table's last lap is over when the turn passes the last seat in turn order (the engine's `round` moves on;
    eliminated seats are skipped, so a start seat knocked out changes nothing). Every player still at that table has
    then taken the same number of turns.
  - When every table still playing has finished its last lap (or finished outright), the round ends and those tables
    are decided on standing (below). The per-move turn timer (90 s by default) bounds each turn of the lap.
  - A **backstop** ends the last lap anyway one more `roundMinutes` after the deadline. It only matters when the move
    timer is off (`turnTimer: 'off'`): with the default 90 s per-move timer a stalled seat is skipped and the lap ends on
    its own, while with no timer a seat that never moves could otherwise hold the tournament forever.
  - Every table counts, whoever sits at it: a fast table of house AI or Zergs never hurries a round past the guests',
    since the round waits for every table (or the deadline).
  - Tables that finished by a win still move on as usual. A restart keeps the clock: a deadline passed while the server
    was down starts the last lap on load, and a passed backstop ends the round on load.
- **Decided on standing.** When a round ends, every table still playing is frozen (bots and the turn timer stop,
  every move is refused with "This table was decided at the round's end") and ranked by the engine's
  `rankByStanding` (`packages/engine/src/standing.ts`): players still in by territories, then armies, then dice (the
  tied players roll one die each, and those still tied roll again), then the players already out, the last one out
  first. The dice come from the tournament seed, the round and the table, so the result can be replayed. The table's
  status becomes `decided`, its `standing` (entrants in order, and the dice by entrant) is in the bracket, the order is
  posted to the table's chat, and its first place moves on. The game is not finished in the engine (it has no
  adjudicated ending); the room closes like a finished game (`RISK_FINISHED_CLOSE`). Its game record is filed the
  moment it is decided, with the standing used (`outcome.reason: "standing"`, `outcome.decided`; see
  [game-records.md](game-records.md#decided-on-standing)), so it has a play-by-play and is in match history.
- **Moving up.** The next round is seated at once: each table's winner takes a seat at its parent table, which sits
  on the board whose territories hold the child tables ("portals", one per child, in different regions). The parent
  table starts with every winner **on the portal territory it came up through**: the engine's `startOnSpots` deals as
  usual, then swaps each spot (owner and armies) with a territory its player was dealt (another player's spot not yet given out if that is all they hold), so everyone keeps the same
  share; a blizzard on a spot moves to a territory where the blizzard rule allows one (the open territories stay
  connected and every continent keeps two open), or, when no single territory will do (a spot whose only way out is another blizzard), the
  whole set is drawn again, as many as before, where the rule allows and never on a spot; each territory that freezes
  hands its holder and armies to one that thaws, so the count and the deal stay as they were (fewer blizzards only if
  the board holds no more). If that start cannot be built, the table
  starts normally. The other entrants of a table are **out**: their `you.status` is `out` and `you.match` is `null`, and they
  can watch. The final's winner, or its first place on standing at the deadline, is the champion.
- **Simulation: `npm run nested:sim`** (`scripts/nested-sim.mjs`, after `npm run build`). It plays a whole nested
  tournament with server bots and no website.
  - **Headless (default):** one process, a fake clock that jumps to a round's deadline when nothing can move, and
    the bots driven step by step (`GameRoom.stepBot`). With the same `--seed` (a fixed tournament seed, plus a seeded
    `Math.random` for game dice and bot choices) it gives the same bracket and champion; `--runs 2` checks that.
    100 seats take well under a second.
  - **Live (`--live --delay 300 --spectators 20 --minutes 3`):** a real server on 127.0.0.1, real timers, fake
    WebSocket spectators on every table. It prints event-loop lag, commits/s, spectator messages/s, snapshot save time
    and heap every 10 s: the load check before a live 100-seat event.
  - Seats are server bots for now; the 80-Zerg + 20-Delove event seats Zerg entrants (#182) and Delove over `/api`.
- **Fixed seed (admin only).** `seed` at create (0-4294967295) fixes the boards, the seating and the tie-break dice (for
  replays and the simulation). Since it decides the draw before anyone joins, only `POST /admin/tournaments` takes it
  (the open create answers 403), and only for nested tournaments (a knockout with `seed` is a 400); the default is a random seed drawn at start. The tie-break dice come from the seed, the round
  and the table's place in the plan.
- **Follow-up:** a host-written tree of boards (existing maps inside chosen portals, as the owner asked for) through
  `resolveNest`; today the boards always come from the plan (`planToNest`), with an optional existing board for the
  final.
- **Contract for runners and agents** (unchanged from knockouts): `POST /tournaments/:id/join`, `GET /tournaments/:id`
  with the entrant token (`you.match` = `{gameId, playerId, token, round}` of the entrant's current table, `you.status`,
  `champion`) and `GET /tournaments/:id/wait`. `wait_for_match` (MCP) answers the same seat every round.
- **Restarts.** The plan, boards, seed and each round's deadline are saved in `tournaments.json`; decided tables keep
  `decidedAt` in the games snapshot. On restart the round clock is re-armed for the time left, and a deadline that
  passed while the server was down ends the round at once, from the saved tables.

## Scheduled tournaments

The server can run nested tournaments on a timetable by itself (`packages/server/src/tournament-schedule.ts`). It is
**off by default**: the owner turns it on with `RISK_TOURNAMENT_SCHEDULE` (JSON), or `RISK_TOURNAMENT_SCHEDULE_FILE`
(a path to a JSON file, easier to edit); when both are set, the variable wins ([hosting.md](hosting.md)).

```json
[
  { "at": "20:00", "name": "Nightly Nest", "signupMinutes": 60, "finalMap": "hexworld" },
  { "at": "Sat 18:00", "name": "Weekend Inception", "minEntrants": 4, "roundMinutes": 20, "options": { "fog": true } }
]
```

- **An entry** (one object, or a list):
  - `at`: `"HH:MM"` every day, or `"Mon,Thu HH:MM"` on those days, always in **UTC**;
  - `name`;
  - `signupMinutes` (sign-up opens this long before the start, 1-10080, i.e. up to 7 days ahead; default 60);
  - `checkinMinutes` (the check-in window, the last this-many minutes before the start, 1-60 and at most
    `signupMinutes`; default 10);
  - `minEntrants` (people or agents needed at the start, 2-256, default 2: a nested tournament needs two players);
  - any [nested setting](#nested-inception-tournaments): `finalMap`, `maxEntrants`, `roundMinutes`,
    `territoriesPerSeat`, `finishShare`, `botDelayMs`, `options`.

  The game settings go through the same strict parser as a create, and the nested settings through the same checks,
  at startup. An unknown key or a bad value turns the schedule **off** with an error in the log (the startup line
  `schedule:` says so). It never stops the server.
- **Sign-up.** At `start - signupMinutes` the server creates the nested tournament itself. Nobody holds its host
  token: it never leaves the server, and the admin key can still delete the tournament. It is listed like any
  other, with `scheduled.startsAt` in the bracket and `startsAt` in the list. People join on its page; agents use
  `next_tournament` and `join_tournament` (MCP) or `POST /tournaments/:id/join`.
- **Pre-registration needs no code** (the owner's call). The entrant token `join_tournament` returns is the
  registration code: keep it, it is the seat. One joiner holds at most `RISK_PREREG_PER_JOINER` (default 4) open
  registrations across scheduled tournaments still registering; a fifth join answers 400. Site-wide, at most
  `RISK_PREREG_PER_DAY` (default 500) registrations go into scheduled tournaments in any 24 h, because new MCP
  sessions are free; past that, a join answers 429. The joiner is the IP for
  HTTP, and the MCP session for `/mcp`, because claude.ai connectors share a few addresses. The count is kept in
  memory, so a restart forgets it. Host-made tournaments are not capped (their hosts hold codes).
- **Check-in.** In the last `checkinMinutes` before the start, an entrant checks in by polling the bracket with its
  token: `wait_for_match` or `tournament_status` (MCP), `GET /tournaments/:id/wait` or `GET /tournaments/:id`, or the
  tournament page left open (its long-poll). Joining inside the window also checks in.
  - The bracket's `scheduled` has `checkinMinutes`, and `checkedIn` (a count) once the window is open.
  - `you.checkedIn` says whether you are checked in.
  - The Next tournament card shows "Checked in N / M".
  - An agent that joins days ahead calls `reconnect_prompt` (MCP). It returns the start and the window in UTC and in
    the user's time zone, the entrant code, the exact calls, and a line asking the agent to have its user schedule
    the reconnect. Expect no-shows anyway: a chat that only answers when spoken to cannot schedule itself, and the
    Zerg swap covers them.
- **No-shows.** At the start, every person who has not checked in is a no-show. Each one is swapped in place for a Zerg
  entrant before planning, so the count and the plan hold, and `scheduled.noShows` counts them. The no-show's token
  then answers "<name> missed check-in for this tournament: the seat went to a Zerg (<Zerg name>)".
- **Start.** At `startsAt` it starts on its own, and the nested start fills the empty seats with Zergs by the
  planner's rule (above). If fewer than `minEntrants` people or agents **checked in**, it is **called off**: finished, with no
  rounds and no champion, and `scheduled.cancelled` is `"not enough entrants"`. A called-off tournament never reaches
  the tournament board. Each entry then moves on to its next time.
- **It counts toward `RISK_MAX_ACTIVE_TOURNAMENTS`** like any tournament. If the cap is full at sign-up time, it
  tries again every 5 minutes until the start.
- **Restarts.** Each entry's current slot (its start and its tournament) is saved in
  `RISK_DATA_DIR/tournament-schedule.json`, so a restart never opens a slot twice:
  - the open tournament keeps its entrants and starts on time;
  - a slot whose sign-up time passed while the server was down opens at once, if its start is still ahead;
  - a slot whose start passed while the server was down is skipped;
  - a tournament that is still registering more than one round (`roundMinutes`) past its start is called off as
    `"missed: the server was down at the start"`, rather than started at a time nobody expected.

  Changing or removing an entry starts it afresh. If its tournament is still registering, that tournament is called
  off on the next start-up as `"the schedule changed"`, so it never stays open forever.
- **CPU.** One timer, set to the next sign-up or start; nothing polls.
- **`GET /api/tournaments/next`** returns `{scheduled, next, running, cancelled}`:
  - `next`: the soonest slot, with its `id` once sign-up is open (`null` before), `name`, `startsAt`, `opensAt`,
    `checkinOpensAt`, `entrants` (people and agents), `checkedIn` (once the window is open: the count `minEntrants`
    is checked against), `maxEntrants`, `minEntrants`;
  - `running`: a scheduled tournament being played;
  - `cancelled`: the latest one called off, until a later one starts.

  With no schedule everything is `null`. The home page's **Next tournament** card and the MCP `next_tournament` tool
  read it.

HTTP routes: [http-api.md](http-api.md). Who may host: [Hosting codes and caps](#hosting-codes-and-caps).
