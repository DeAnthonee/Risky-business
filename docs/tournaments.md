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
- **Watching.** The bracket page updates live; every table has a Watch button. Players get a *Play your table* button
  when they are seated; leaving the game returns to the bracket.
- **Agents.** `join_tournament` → `wait_for_match` (returns your table and seat token, and remembers the seat on the
  connection) → play it like any game → `wait_for_match` again until you are out or the champion.

**Scores.** Tables never count on the public leaderboard. When a tournament finishes, every entrant gets one result on
the [tournament leaderboard](character-league.md#tournament-leaderboard): placement (3 per round survived, final
places 2 apart, champion +6), +2 per table won and +1 per kill. Entrants are ranked by name: they cannot be bound to a
character yet ([hardening #6](hardening.md#6-tournament-entrants-cannot-be-characters-yet)).

**Follow the action (server side, not wired yet).** `packages/server/src/excitement.ts` scores how exciting a table
is, 0-100, from its public spectator view and recent events (owner decision 19): an elimination in the last 20 s +40
fading, a player about to be knocked out +25, a capital about to fall +30 (and +30 for 20 s after one falls), a close
race +15, two players left +15, heavy fighting up to +20, the final +20. `pickFollow` chooses the table an opted-in
watcher sees: it stays at least 20 s and switches only for a table 15 or more ahead, or when the current one ends,
with a "Following: Table 7 (capital under threat)" caption. The tournament feed and the client switch come later.

Tournaments are saved to `tournaments.json` in `RISK_DATA_DIR` and pick up their tables again after a restart;
tables a tournament is still waiting on are not swept as idle, except past the hard limit of 7 days idle (the Store's fixed `max`; no env var changes it).

**Coming: nested ("Inception") tournaments.** A table of a later round seats the winners of the tables inside its
territories, each starting on their own territory (their "portal"). The engine's `startOnSpots`
(`packages/engine/src/nest-start.ts`) builds that start: the normal start and random deal, then each spot is swapped
(owner and armies together) with a territory its player was dealt elsewhere, so every player keeps the same number of
territories and armies. A blizzard on a spot moves to a territory where the blizzard rule allows one (the open
territories stay connected and every continent keeps two open), or, with none left, thaws. Rounds end when 51% of the
tables finish or a deadline passes; a table still playing is then decided on standing by the engine's `rankByStanding`
(`packages/engine/src/standing.ts`): players still in by territories, then armies, then dice (the tied players roll one
die each, and those still tied roll again), then the players already out, the last one out first. Built so far: those
two functions; the rounds come next.

HTTP routes: [http-api.md](http-api.md). Open items (anyone can create while testing): [hardening.md](hardening.md#1-anyone-can-create-tournaments-while-testing).
