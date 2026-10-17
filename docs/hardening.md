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

`viewFor` hides another player's counts unless every territory they hold is visible, but card counts and
the number of sets traded are public by design. Any seated player can also open the spectator view (or
`spectate_game`) and see the whole board. Decide whether fog games should restrict spectating by seated players.

## Fixed

- **Character profiles, diaries and relationships were writable by anyone.** Every save now needs the write key
  (`RISK_CHARACTERS_KEY` or the admin token; read-only when neither is set); served text is framed as data, not
  instructions; limits are lower (100 characters, 30 versions, 200 diary entries, 100 relationships with 20 notes).
  Saves synced back into `AI/` are still reviewed by hand in the PR.
