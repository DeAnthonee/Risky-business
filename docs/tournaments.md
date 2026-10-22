# Tournaments

Knockout tournaments, run by the host. Only the host creates them (with the admin key, `RISK_ADMIN_TOKEN`), except
while they are being tested: with `RISK_TOURNAMENTS_OPEN` on (the default for now) anyone can, no key needed. People
join on the website (the Tournaments list on the home page, or `?tournament=CODE`) and agents with `join_tournament`.

- **Host token.** Creating a tournament returns its `hostToken`, once (it is never in the bracket or the list). That
  token, or the admin key, starts the tournament, forfeits for a no-show and deletes it; nobody else can, not even in
  open mode. Tournaments saved before host tokens existed have none: only the admin key runs them.
- **Limits.** At most `RISK_MAX_ACTIVE_TOURNAMENTS` (default 20) tournaments register or run at once; creating
  another fails until one finishes or is deleted. Only the newest `RISK_TOURNAMENTS_KEEP` (default 100) finished
  tournaments are kept; older ones are pruned from `tournaments.json`.

- **Server bots.** While registering, the host adds built-in bots or **Zergs** as entrants
  (`POST /api/tournaments/:id/bots {kind: "bot" | "zerg", count}`, host token). A Zerg entrant has a Zerg pun name
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
- **Watching.** The bracket page updates live; every table has a Watch button. A nested tournament's page also has
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

## Nested ("Inception") tournaments

`format: "nested"` at create. Every table plays on its own board, and its winner moves up to the table of the next
round; the boards nest inside each other's territories (the map side: [maps.md](maps.md#nested-boards-and-the-planner)).

- **Settings** (create): `finalMap` (an existing board for the final, seating 6+ with a region per seat; default a
  generated one), `territoriesPerSeat` (generated boards' size, 4-6, default 5), `roundMinutes` (a round's deadline,
  1-240, default 30), `finishShare` (default 0.51), `options` (every table's game settings except the map; they are
  checked at create on every table size from 2 to 10 seats), `maxEntrants` (default 128), `botDelayMs` (the bots' pace
  at the tables, 0-2000 ms between moves, default 300). `groupSize` and `fillBots` do not apply.
- **Turn timer on by default.** Unless `options` set `turnTimer`, the tables run a per-move timer of 90 s (the owner's default), so a
  stalled seat cannot hold a round (on timeout the seat is skipped: see [playing.md](playing.md)). Bots and models
  move well inside it.
- **Start.** The engine's `planNest` plans the rounds for the entrants: tables of 3-6, uneven by at most one in a
  round, and a final of 6-10. Zerg entrants are added only when the count fits no plan (11-17 entrants fill to 18; under 6 fill
  the final to 6). A random seed, saved with the tournament, fixes every board (`planToNest`, generated gen1 boards
  sized for each table) and the seating: the planner's filler Zergs are spread first, as the plan shares them out (at
  most one more at any table than at another), then people and agents over the free seats, then the host's own bots
  fill the rest, so a table is all bots only when there are more tables than people. Filler Zergs move up like any
  entrant when they win. **Every round-1 table starts at
  once.**
- **The round clock.** A round ends at the first of: `ceil(finishShare × tables)` tables finished by a win (byes
  count; tables decided on standing do not), no table left playing, or the round's deadline (`roundMinutes` after it
  started; stored as an absolute time). A one-table round (the final) therefore ends only by its win or its deadline.
- **Decided on standing.** When a round ends, every table still playing is frozen (bots and the turn timer stop,
  every move is refused with "This table was decided at the round's end") and ranked by the engine's
  `rankByStanding` (`packages/engine/src/standing.ts`): players still in by territories, then armies, then dice (the
  tied players roll one die each, and those still tied roll again), then the players already out, the last one out
  first. The dice come from the tournament seed, the round and the table, so the result can be replayed. The table's
  status becomes `decided`, its `standing` (entrants in order, and the dice by entrant) is in the bracket, the order is
  posted to the table's chat, and its first place moves on. The game is not finished in the engine (it has no
  adjudicated ending); the room closes like a finished game (`RISK_FINISHED_CLOSE`).
- **Moving up.** The next round is seated at once: each table's winner takes a seat at its parent table, which sits
  on the board whose territories hold the child tables ("portals", one per child, in different regions). The parent
  table starts with every winner **on the portal territory it came up through**: the engine's `startOnSpots` deals as
  usual, then swaps each spot (owner and armies) with a territory its player was dealt, so everyone keeps the same
  share; a blizzard on a spot moves to a territory where the blizzard rule allows one (the open territories stay
  connected and every continent keeps two open), or, with none left, thaws. If that start cannot be built, the table
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

HTTP routes: [http-api.md](http-api.md). Open items (anyone can create while testing): [hardening.md](hardening.md#1-anyone-can-create-tournaments-while-testing).
