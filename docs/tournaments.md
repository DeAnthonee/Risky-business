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

- **Tables.** Each round seats the remaining entrants at tables of up to `groupSize` (default 4, on Four Crowns by
  default), split as evenly as possible; a lone entrant gets a bye. With `fillBots` (default on) round 1 is topped up
  with bots so every table is full. Bots are entrants like anyone else and can win.
- **Moving on.** A table is an ordinary game that nobody hosts (no seat can close it, kick or add players). Its winner
  moves on; when every table of a round is decided the next round is seated, until one champion is left. A table whose
  room is deleted before anyone wins is *abandoned*: nobody from it moves on.
- **No-shows.** Games have no turn timer, so the host (host token or admin key) can `forfeit` an entrant who will not
  play (they surrender at their table).
- **Watching.** The bracket page updates live; every table has a Watch button. Players get a *Play your table* button
  when they are seated; leaving the game returns to the bracket.
- **Agents.** `join_tournament` → `wait_for_match` (returns your table and seat token, and remembers the seat on the
  connection) → play it like any game → `wait_for_match` again until you are out or the champion.

**Follow the action (server side, not wired yet).** `packages/server/src/excitement.ts` scores how exciting a table
is, 0-100, from its public spectator view and recent events (owner decision 19): an elimination in the last 20 s +40
fading, a player about to be knocked out +25, a capital about to fall +30 (and +30 for 20 s after one falls), a close
race +15, two players left +15, heavy fighting up to +20, the final +20. `pickFollow` chooses the table an opted-in
watcher sees: it stays at least 20 s and switches only for a table 15 or more ahead, or when the current one ends,
with a "Following: Table 7 (capital under threat)" caption. The tournament feed and the client switch come later.

Tournaments are saved to `tournaments.json` in `RISK_DATA_DIR` and pick up their tables again after a restart;
tables a tournament is still waiting on are not swept as idle, except past the hard limit (`RISK_MAX_IDLE`, 7 days).

## Nested ("Inception") tournaments

`format: "nested"` at create. Every table plays on its own board, and its winner moves up to the table of the next
round; the boards nest inside each other's territories (the map side: [maps.md](maps.md#nested-boards-and-the-planner)).

- **Settings** (create): `finalMap` (an existing board for the final, seating 6+ with a region per seat; default a
  generated one), `territoriesPerSeat` (generated boards' size, 4-6, default 5), `roundMinutes` (a round's deadline,
  1-240, default 30), `finishShare` (default 0.51), `options` (every table's game settings except the map; they are
  checked at create on every table size from 2 to 10 seats), `maxEntrants` (default 128). `groupSize` and `fillBots`
  do not apply.
- **Start.** The engine's `planNest` plans the rounds for the entrants: tables of 3-6, uneven by at most one in a
  round, and a final of 6-10. Bots are added only when the count fits no plan (11-17 entrants fill to 18; under 6 fill
  the final to 6). A random seed, saved with the tournament, fixes every board (`planToNest`, generated gen1 boards
  sized for each table) and the seating: people and agents are spread over the round-1 tables first, then bots fill
  the rest, so a table is all bots only when there are more tables than people. **Every round-1 table starts at
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
- **Moving up.** The next round is seated at once: each table's winner takes a seat at its parent table (in portal
  order). For now the parent table starts like any game on its board; starting each winner on its portal
  (`startOnSpots`) comes next. The final's winner, or its first place on standing at the deadline, is the champion.
- **Contract for runners and agents** (unchanged from knockouts): `POST /tournaments/:id/join`, `GET /tournaments/:id`
  with the entrant token (`you.match` = `{gameId, playerId, token, round}` of the entrant's current table, `you.status`,
  `champion`) and `GET /tournaments/:id/wait`. `wait_for_match` (MCP) answers the same seat every round.
- **Restarts.** The plan, boards, seed and each round's deadline are saved in `tournaments.json`; decided tables keep
  `decidedAt` in the games snapshot. On restart the round clock is re-armed for the time left, and a deadline that
  passed while the server was down ends the round at once, from the saved tables.

HTTP routes: [http-api.md](http-api.md). Open items (anyone can create while testing): [hardening.md](hardening.md#1-anyone-can-create-tournaments-while-testing).
