# Character league, profiles and rankings

Click a player name in the lobby or the live game's player list to open their profile. The profile shows
wins, losses, win percentage, average placement, points and leaderboard rank. Close it with the Close
button, Escape or the backdrop; watching and the game's connection continue underneath. Home shows
the full leaderboard and refreshes it every 15 seconds. Profile details are fetched when opened.

## Placement points

Everyone starts at **0 points**. Scores never go below zero, including after a loss. Apply each completed
game's points (placement plus kills, below) to the previous total, flooring at zero after that game. This is a
placement ladder, not opponent-strength Elo.

| Lobby size | Points from first to last |
| --- | --- |
| 5 | +2, +1, 0, -1, -2 |
| 6 | +3, +2, +1, -1, -2, -3 |
| 7 | +3, +2, +1, 0, -1, -2, -3 |
| 8 | +4, +3, +2, +1, -1, -2, -3, -4 |
| 9 | +4, +3, +2, +1, 0, -1, -2, -3, -4 |
| 10 | +5, +4, +3, +2, +1, -1, -2, -3, -4, -5 |

**Kills.** Every player you eliminate adds **+1** (`KILL_POINTS` in `packages/engine/src/ranking.ts`) on top of your
placement points for that game. So a runner-up who knocked out three players (+2 +3 = 5 in a six-player game) beats a
winner who finished off only one (+3 +1 = 4). Only eliminations by attack count: surrenders credit nobody, and
neutral armies are never victims. Each record also keeps who you eliminated, so every profile shows total kills and
how many times it has eliminated each other player (`kills` and `victims` in the API, keyed by ranking key). Games
recorded before kills were tracked count as zero kills.

Rank sorts by points, then wins, then kills, then lower average placement, then stable identity key. Only the game's
winner gets a win; other participants get a loss even if still alive at a capital victory. Neutral armies never
participate in rankings. The winner places first. Other survivors rank by territories, then armies, then turn
order; eliminated players rank by reverse elimination order. Games without a winner are not counted.
Positive placements can gain points without a win. Kills and flooring mean the ladder as a whole is not zero-sum.

The server records outcomes directly from finished room states. Its independent rankings.json is stored
beside games.json under RISK_DATA_DIR, survives room deletion/restarts, and ignores already recorded game
IDs. Multiple lobbies share this single server writer. A corrupt rankings file does not stop the server:
it is moved aside to rankings.json.corrupt (and logged) and the ladder restarts empty, so restore it from a
backup. The board holds only games finished on the site. It runs in **seasons** (season 3 since the wipe in #119;
season 2 ran from #107). The season in force is written to `rankings.json.season`. Starting a new season moves the
old board to `rankings.season-<old>.json` (kept, never deleted, never over an existing archive: a second archive of
the same season becomes `rankings.season-<old>-2.json`) and the new season starts empty. Past seasons stay readable:
`GET /api/rankings/seasons` lists them, `GET /api/rankings?season=<id>` reads one, the web leaderboard has a season
picker (current by default) and the MCP `leaderboard` tool takes an optional `season`. A game is counted in exactly
one season, never again in a later one.

Step-by-step guide, including what not to touch: [leaderboard-seasons.md](leaderboard-seasons.md).

**Archiving the board now** (no code change, no deploy): with the admin token,

```bash
curl -X POST -H "Authorization: Bearer $RISK_ADMIN_TOKEN" https://risky.deanthoneeking.com/api/admin/rankings/new-season
```

answers `{"archived": N, "season": N+1}`. It is atomic against games finishing at the same moment: each lands wholly
in the archived season or in the new one. If the archive cannot be made it answers 500 and nothing changes.

**Archiving on a deploy:** bump `RANKINGS_SEASON` in `packages/server/src/rankings.ts`; the first start on it
archives the same way (if the move fails the season file is not updated and it is retried on the next start). The
season in force is the **higher** of the code constant and the saved season: after admin archives have moved the
saved season past the constant, a deploy changes nothing until the constant is bumped above the saved number. Both
ways go through the same code (`Rankings.archiveTo`). Every row
has its own display name (`uniqueBoardNames` in the engine): the identity that reached the board first keeps
"Darius", later ones with the same name (any case) show as "Darius2", "Darius3" and so on. Keys and points do not
change. A failed save is logged without failing the move that ended the game. Back up RISK_DATA_DIR with
normal server backups.

Character identity is selected in the lobby using POST /api/games/:id/character with the seat's Bearer token
and {"characterId":"league/shen"}, plus the characters write key in the x-characters-key header (the same
key as character saves: RISK_CHARACTERS_KEY or the admin token), since it credits the character on the
public leaderboard. The profile must exist on the server. One identity per table, multiple tables per
identity. The runner does this when given --characters-key; without it seats play unranked by name. MCP exposes select_character, leaderboard and
ranked_profile. Plain seats aggregate by normalized display name (built-in bots have a separate prefix);
these are self-declared identities, not authenticated user accounts.

GET /api/rankings returns the ordered standings. GET /api/rankings/profile?key=league%2Fshen returns a
ranking/profile pair. GET /api/games/:id/players/:player/profile resolves a live seat to that same record.
An unplayed profile is unranked with zero games and points. Existing snapshots remain readable; old finished
rooms can be backfilled on startup, but records for deleted historical rooms cannot be reconstructed.
Historical runner results stay local and are not silently imported into the public server leaderboard.

## Training leaderboard

A second board, apart from the public one, for **model-vs-model yardstick games**: Delove (our self-play model) against
Claude seats (Haiku, Sonnet, Opus, Fable tiers), or any other models we measure against each other. A training game
never moves the public leaderboard. It uses the same scoring (placement plus kills) and ranks seats the same way: plain
seats by their **seat name** (so name each seat after its model, e.g. `delove@6`, `Claude Haiku 1`), bound characters
by their key. It has no seasons.

- **Making one:** `POST /api/games` with `"board": "training"` and the characters write key in `x-characters-key`
  (RISK_CHARACTERS_KEY or the admin token; 403 without it), or MCP `create_game` with `board: "training"` and `key`.
  It is a flag on the room (saved in its snapshot; rooms saved before it load as public), not a game setting.
- **Moving one played on the public board:** `POST /api/admin/games/<id>/board` `{"board": "training"}` with the
  admin token. It flags the room if it is still open, moves the result off the current public season to the training
  board if it is already ranked, and marks its game records. Running it again changes nothing.

  ```bash
  curl -X POST -H "Authorization: Bearer $RISK_ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"board":"training"}' https://risky.deanthoneeking.com/api/admin/games/EA5GH5/board
  ```
- **Reading it:** `GET /api/rankings?board=training`, `GET /api/rankings/profile?key=&board=training`, the MCP
  `leaderboard` and `ranked_profile` tools with `board: "training"`, and the **Training** toggle beside the season
  picker on the web leaderboard. Match history (`GET /api/history`) and `GET /api/games` mark these games
  `board: "training"`; `?board=training` on `/history` lists only them.
- **Stored** in `$RISK_DATA_DIR/rankings-training.json` (never in `rankings.json`). Its game records carry
  `room.board: "training"` (and their `index.jsonl` line `board`), so they are never pooled into Delove's training
  data by mistake.

## Tournament leaderboard

A third board, apart from the public and training ones, for **tournaments** (owner, decisions 16, 18 and 20). A
tournament table never ranks on the public board (or the training one); when the tournament finishes, every entrant
gets one result on this board. **This changed in #183:** before it, knockout tables were ranked on the public board one
game at a time. Results already there stay; new tables no longer add to it.

- **Scoring** (per tournament, `packages/server/src/tournament-scoring.ts`, never the engine's `ranking.ts`), with `L`
  the number of rounds:
  - placement: out in round `r` before the final = `3 × (r − 1)`; place `p` of `F` in the final =
    `3 × (L − 1) + 2 × (F − p)`; the champion gets **+6** on top;
  - **+2 per table won**, every round including the final (**+1** when a table is decided on standing rather than
    played out; nested tournaments only, knockouts are always played out);
  - **+1 per player eliminated** at your tables (surrenders and forfeits credit nobody).

  Example: 4 entrants at tables of 2 (`L = 2`, a final of 2): the champion scores 3 + 2 + 6 = 11 for placement plus 2
  tables × 2 = 15 before kills; the runner-up 3 + 2 = 5; round-1 exits 0 plus kills.
- **Who is on it:** people only (owner's decision). No server bot gets a row, neither built-in fill bots nor Zergs
  (planner fillers or added by the host with `POST /tournaments/:id/bots`). Bots are still scored: their results stay
  in `rankings-tournament.json` flagged `bot` (with `kind` "zerg" or "bot") for bot stats. It is keyed off the entrant
  being a server bot, never its name, so a person called "Bot 1" ranks. The public board's live Zerg seats are not
  affected.
- **The board** sums results over tournaments: points, tournaments played, championships, finals reached, tables won,
  kills and best finish, sorted by points, then championships. Identities are the entrant names, as on the other
  boards (`bot:<name>` for bots and Zergs, `player:<name>` otherwise), with the self-declared caveat of
  [hardening #3](hardening.md#3-leaderboard-identities-for-plain-seats-are-self-declared). Entrants cannot be bound to
  a character yet, so this board never has character rows
  ([hardening #6](hardening.md#6-tournament-entrants-cannot-be-characters-yet)).
- **The House** (owner, 2026-10-22): the server's bots (fill bots and Zergs) are scored like everyone but never get a
  row; their fun numbers show in **The House**, a widget on the home page, "The Swarm" (Zergs) against "The Machines"
  (fill bots), never a ranking (`GET /api/house-bots`, read from the tournament results):
  - totals per side: different bots, entries, tables played and won, eliminations made, times knocked out, rounds
    survived (every round won; a champion got through them all), finals, championships, armies lost, enemy armies
    destroyed, conquests;
  - the best finish (who, where);
  - a hall of fame with names: most kills in a tournament, deepest run (rounds), biggest army, most conquests in a
    tournament, longest survival at a table (turns), most armies lost at one table.

  The table numbers are gathered from each table's moves while it is played, so a table already being played when
  the server restarts counts only from the restart on. Results saved before this have the counts but no table
  numbers; a result with no `kind` counts as a fill bot.
- **Reading it:** `GET /api/rankings?board=tournament` (`{board, current, rankings}`), `GET /api/rankings/profile?key=&board=tournament`
  (`stats` adds the entrant's `results`: each tournament, finish and points), the MCP `leaderboard` and
  `ranked_profile` tools with `board: "tournament"`, and the **Tournament** toggle beside **Training** on the web
  leaderboard. `?board=tournament` on `/history` lists only tournament tables (and `?board=public` leaves them out).
- **Stored** in `$RISK_DATA_DIR/rankings-tournament.json` (never `rankings.json`). Each table's final placings and
  kills are saved on the bracket when the table ends (`order`, `kills` in `tournaments.json`), so a restart loses
  nothing; on start, a finished tournament that was not recorded yet is recorded. Tournaments that finished before
  this board existed have no table scores and are not backfilled. No seasons yet.

## Persistent personality and relationships

Use one runner process with --lobbies 2 and --games 0 for two concurrent tables and a shared Ollama queue.
All lobbies use the same learnings directory. Per-game plans, chat and alliances remain separate. A character
loads a fresh snapshot of its base personality, personal lessons, evolving playstyle and relationship history
before each game. It also receives the shared leaderboard: its own wins/losses, win percentage, points/rank,
and the other characters above and below it. On older servers, the runner uses its local results ledger.

Each character remembers accepted deal outcomes, who broke an agreement, games together, wins/losses
against each opponent, and higher/lower placements. Observed opponent breaches lower rapport by 25;
agreements completed without an observed breach add 8. Rapport stays within -100..100. No forced grudge,
alliance or retaliation is imposed: these memories inform the personality's choices. Model reflections can
evolve personal tactics and form or reconsider impressions of an opponent's playstyle, explicitly labeled as
subjective. They cannot invent factual betrayal incidents or change rapport. A failed reflection keeps prior
style and saves the observed facts. Base personality files are never rewritten by the learning loop.

Under --learnings-dir, characters/<universe>/<name>/memory.md stores per-game notes; experience.json
stores the evolving style, relationship histories and processed game IDs. The last 6,000 characters of
personal notes and bounded recent relationship details enter prompts. Global advice remains in the protected
bot section of RISK_LEARNINGS.md. A cross-process lock serializes each complete post-game transaction;
live owners never expire simply because the local model takes a long time. Use a local disk and one host
for this shared directory. Separate runner processes have separate Ollama queues; prefer --lobbies.

The UI also draws each bonus outline above territory fills, clipped inside that region. Inland borders
between bonuses remain visible in region colors, with a dark separator, regardless of territory ownership.

## Private tactical memory within each game

Each seat keeps its own event ledger for this game only, available to both commander and diplomat. It
records observed attack attempts (including failed attacks), casualties, captured territories and the first
conquest breaking a held bonus. Event versions deduplicate replayed polls; recapturing land does not erase
attack totals. Events carry their actual round when a turn marker is available, otherwise the memory says
"observed by round N" rather than inventing an exact attack time. Fogged events are never reconstructed
from a spectator view. Recent incidents are bounded; per-opponent totals last throughout the game.

An accepted truce or border at the observed attack is distinguished from ordinary aggression without an
alliance. Even a failed attack can break the relevant accepted truce; replayed old events cannot break a
newer agreement. Passing-through claims are recorded only from seated senders and only if received before
the incident, lasting the current and next round. A notice is not consent or immunity. Missing a notice
does not prove the opponent never sent one. Spectator accusations do not become attack facts.

Leader facts identify the biggest observable territory holder and army. With three or more survivors,
a rival at >=40% of observable land or >=45% of observable armies prompts a coalition assessment and
suggests potential partners. Under fog these are explicitly estimates, not proof of the global leader.
The model evaluates existing deals, borders and its own win path; a coalition is not imposed. Diplomatic
opening whispers can approach a possible partner against that rival. Current round and individual turn
are restated separately. The post-game reflection also receives this seat's tactical summary, so relevant
observations can inform its persistent personality and relationship memories.

On runner startup, older completed local results and per-seat write-ups are restored into character memory and head-to-head records, once per game ID. No missing historical alliance or betrayal facts are invented. This preserves the finishing old runner game's personal lessons when the upgraded process restarts.
