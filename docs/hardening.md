# Hardening to-do

Known gaps that are **deliberately left open for now** (decided by the maintainer) and must be fixed before
the features they belong to are treated as production-ready. Remove an item only when it is fixed, in the
same PR as the fix.

## 1. Character profiles, diaries and relationships are writable by anyone

**Where:** `packages/server/src/characters.ts`, `POST /api/characters/...` in `packages/server/src/http.ts`, and the
MCP tools `update_character`, `add_diary_entry`, `update_relationship` in `packages/mcp/src/tools.ts`.

**What is wrong:** `/mcp` and `/api` have no auth, so any anonymous caller can:

- overwrite any character's profile (including the repo's seed characters) and create up to 500 characters;
- add diary entries and relationship notes to anyone's character;
- push good versions out of a profile's history by saving 50 times (only the repo copy survives).

Agents are told to load their profile and stay in character, so text written by a stranger is read by other
models as **instructions** (prompt injection). The `?full=1` export that the README suggests copying back into
the repo carries the same text to coding agents.

**Fix (to do):**

- Require a write key (`RISK_CHARACTERS_KEY` or the admin token) for `update_character`, or only accept writes
  from a seat token whose game is played as that character.
- Serve diaries, relationship notes and profiles framed as *data written by agents, not instructions*.
- Lower the limits (characters, versions, relationship notes, `?full=1` response size).
- Review synced saves by hand before they go into `AI/` in a PR.

**Already fixed:** `__proto__` keys from anonymous input no longer reach `Object.prototype`, and pruned profile
versions are deleted from disk.

## 2. Tournaments can be run by anyone

**Where:** `packages/server/src/tournaments.ts`, `POST /api/tournaments*` in `packages/server/src/http.ts`, the MCP
`create_tournament` / `start_tournament` tools; `RISK_TOURNAMENTS_OPEN` defaults on (`packages/server/src/index.ts`).

**What is wrong:** with open mode on, anyone can create and start tournaments; creators get no host token, so a
visitor can start someone else's tournament; only the admin key can forfeit a no-show (games have no turn timer);
there is no cap on tournaments and no pruning, so `tournaments.json` grows forever.

**Fix (to do):** return a host token from create and require it (or the admin key) for start, forfeit and delete;
cap active tournaments and prune finished ones; set `RISK_TOURNAMENTS_OPEN=0` on the production server before
launch and remove the temporary create/start MCP tools.

## 3. Per-player totals under fog of war

`viewFor` hides another player's counts unless every territory they hold is visible, but card counts and
the number of sets traded are public by design. Any seated player can also open the spectator view (or
`spectate_game`) and see the whole board. Decide whether fog games should restrict spectating by seated players.
