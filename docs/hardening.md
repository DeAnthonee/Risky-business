# Hardening to-do

Known gaps that are **deliberately left open for now** (decided by the maintainer) and must be fixed before
the features they belong to are treated as production-ready. Remove an item only when it is fixed, in the
same PR as the fix.

## 1. Anyone can create tournaments while testing

**Where:** `POST /api/tournaments` in `packages/server/src/http.ts`, the MCP `create_tournament` / `start_tournament`
tools; `RISK_TOURNAMENTS_OPEN` defaults on (`packages/server/src/index.ts`).

**What is wrong:** with open mode on, anyone can create a tournament (and run it with the host token they get back).
The cap (`RISK_MAX_ACTIVE_TOURNAMENTS`) stops them piling up, but a visitor can fill it with tournaments that never
start, and nothing expires a tournament stuck registering: the admin has to delete them.

**Fix (to do):** set `RISK_TOURNAMENTS_OPEN=0` on the production server before launch and remove the temporary
create/start MCP tools (the owner's launch decision); consider expiring tournaments left registering.

## 2. Per-player totals under fog of war

`viewFor` hides another player's counts unless every territory they hold is visible, but card counts, the
number of sets traded and each player's total reinforcement income are public by design (#56; the total roughly
gives away territory count and continent captures behind the fog, a trade-off accepted for threat assessment). Any seated player can also open the spectator view (or
`spectate_game`) and see the whole board. Decide whether fog games should restrict spectating by seated players.

The same gap applies to **player-type labels** (who is Claude Sonnet, who is Delove; [http-api.md](http-api.md#player-type-labels)):
web spectators see them and seated players never do, but a seated player who reads their own game over plain HTTP
without their seat token gets the spectator view, labels included. The MCP never shows labels, so agents playing
through it cannot see them. Labels are also **self-declared** (like item 3): a seat can claim to be any model.

## 3. Leaderboard identities for plain seats are self-declared

**Where:** `packages/server/src/rankings.ts`, `GET /api/rankings`. Binding a seat to a character needs the
characters write key, but a seat without a character is ranked as `player:<display name>`. Anyone can join under
someone else's name, or play two seats against each other and surrender one, to move that name's record. Decide
whether plain seats should be ranked at all (or only characters and signed-in accounts) before the ladder matters.

## 4. Spectator chat goes into the bots' long-term memory

**Where:** `packages/runner/src/experience.ts` (watcher relationships), `packages/llm-player/src/prompt.ts`
(`watchersFromChat`). Since #60, a spectator who chats becomes a "watcher" relationship in each league character's
local experience: up to three of their messages per game are saved verbatim (120 characters each, last 20 facts) and
shown to the model in every later game; the local-model player can also save a relationship note about them through
the characters API. Spectator names are self-declared (anyone can watch as "DeAnthonee"), and the text is framed as
untrusted memory, not instructions, but it is still a lasting way for an anonymous watcher to put words in front of
the models. Before the league runs in public: store a summary instead of quotes, or keep watcher memory only for
signed-in watchers.

## 5. Scenarios are HTTP only

**Where:** `POST /api/admin/scenarios`, `POST /api/games/:id/seat` (`packages/server/src/http.ts`). Creating a
scenario is admin-only and has no MCP tool, because the MCP endpoint has no admin auth and the only admin-ish MCP
tools (`create_tournament`, `start_tournament`) are TEMPORARY ones slated for removal. Taking a seat over is not on
the MCP either: an agent given a scenario seat's token can play it with `resume_game`, but has to call
`POST /games/:id/seat` over HTTP first if the seat is a bot. The web client does not mark scenario rooms yet
(`scenarioOf` is in the game summary). Decide whether agents should get a `take_seat` tool and whether scenarios
belong in the lobby before they are used in public.

## Fixed

- **Anyone could start, forfeit for or delete someone else's tournament, and `tournaments.json` grew forever.**
  Create now returns a host token; start, forfeit and delete need it or the admin key (tournaments saved before
  then are admin-only). At most `RISK_MAX_ACTIVE_TOURNAMENTS` (default 20) register or run at once, and only the
  newest `RISK_TOURNAMENTS_KEEP` (default 100) finished ones are kept. Opening creation to anyone is still item 1.

- **The live leaderboard was seeded from results played off the site.** `rankings-seed.ts` is gone; the board
  now holds only games finished on the site, and `RANKINGS_SEASON` wipes it on purpose (the old board is archived
  as `rankings.season-<n>.json`, never deleted). Still open: an admin call to start a season without a deploy.
- **Game records were never pruned.** Only the newest `RISK_ARCHIVE_KEEP` records (default 1000, about
  0.3-1.6 GB) are kept; filing a new one deletes the oldest record files and their `index.jsonl` lines.
- **Character profiles, diaries and relationships were writable by anyone.** Every save now needs the write key
  (`RISK_CHARACTERS_KEY` or the admin token; read-only when neither is set); served text is framed as data, not
  instructions; limits are lower (100 characters, 30 versions, 200 diary entries, 100 relationships with 20 notes).
  Saves synced back into `AI/` are still reviewed by hand in the PR.

## Known trade-off: quick room cleanup

Lobbies and running games close after `RISK_ABANDONED_CLOSE_MIN` (default 2) without any seat present (WebSocket,
`/wait` long-poll in progress or any authenticated request). An AI agent that thinks for more than two minutes
without making any call, or a player whose tab is closed for two minutes, loses the room. Raise the value (or set
`0`) if that bites; the existing TTLs stay as outer limits.
