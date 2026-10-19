# Hardening to-do

Known gaps that are **deliberately left open for now** (decided by the maintainer) and must be fixed before
the features they belong to are treated as production-ready. Remove an item only when it is fixed, in the
same PR as the fix.

## 1. Tournaments can be run by anyone

**Where:** `packages/server/src/tournaments.ts`, `POST /api/tournaments*` in `packages/server/src/http.ts`, the MCP
`create_tournament` / `start_tournament` tools; `RISK_TOURNAMENTS_OPEN` defaults on (`packages/server/src/index.ts`).

**What is wrong:** with open mode on, anyone can create and start tournaments; creators get no host token, so a
visitor can start someone else's tournament; only the admin key can forfeit a no-show (games have no turn timer);
there is no cap on tournaments and no pruning, so `tournaments.json` grows forever.

**Fix (to do):** return a host token from create and require it (or the admin key) for start, forfeit and delete;
cap active tournaments and prune finished ones; set `RISK_TOURNAMENTS_OPEN=0` on the production server before
launch and remove the temporary create/start MCP tools.

## 2. Per-player totals under fog of war

`viewFor` hides another player's counts unless every territory they hold is visible, but card counts, the
number of sets traded and each player's total reinforcement income are public by design (#56; the total roughly
gives away territory count and continent captures behind the fog, a trade-off accepted for threat assessment). Any seated player can also open the spectator view (or
`spectate_game`) and see the whole board. Decide whether fog games should restrict spectating by seated players.

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

## Fixed

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
