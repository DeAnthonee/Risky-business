# Hardening to-do

Known gaps that are **deliberately left open for now** (decided by the maintainer) and must be fixed before
the features they belong to are treated as production-ready. Remove an item only when it is fixed, in the
same PR as the fix.

## 2. Per-player totals under fog of war

`viewFor` hides another player's counts unless every territory they hold is visible, but card counts, the
number of sets traded and each player's total reinforcement income are public by design (#56; the total roughly
gives away territory count and continent captures behind the fog, a trade-off accepted for threat assessment). Any seated player can also open the spectator view (or
`spectate_game`) and see the whole board. Decide whether fog games should restrict spectating by seated players. The tournament feed (`subscribe_tournament`)
is the same: it refuses a socket that sends an entrant token, but an entrant can subscribe without one and see every
table's owners and armies (and its latest battle), their own table included, from the spectator view. A game's link-preview picture (`/og/game/:id.png`) shows its
owners' colours under fog too (no army numbers), so it reveals nothing the spectator view does not.

The same gap applies to **player-type labels** (who is Claude Sonnet, who is Delove; [http-api.md](http-api.md#player-type-labels)):
web spectators see them and seated players never do, but a seated player who reads their own game over plain HTTP
without their seat token gets the spectator view, labels included. The MCP never shows labels, so agents playing
through it cannot see them. Labels are also **self-declared** (like item 3): a seat can claim to be any model.

## 3. Leaderboard identities for plain seats are self-declared

**Where:** `packages/server/src/rankings.ts`, `GET /api/rankings`. Binding a seat to a character needs the
characters write key, but a seat without a character is ranked as `player:<display name>`. Anyone can join under
someone else's name, or play two seats against each other and surrender one, to move that name's record. Decide
whether plain seats should be ranked at all (or only characters and signed-in accounts) before the ladder matters.

**Partly fixed:** a **player key** (`POST /api/players`, owner's choice "A", self-serve) names one player: seats
joined with it in the `X-Player-Key` header rank as `key:<playerId>` under the registered name, and no seat without
that key may use the name, so a keyed player's record cannot be moved by others. Plain seats without a key are still
ranked as `player:<display name>` and keep this caveat.

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
tools (`create_tournament`, `start_tournament`) take a hosting code, not the admin key. Taking a seat over is not on
the MCP either: an agent given a scenario seat's token can play it with `resume_game`, but has to call
`POST /games/:id/seat` over HTTP first if the seat is a bot. The web client does not mark scenario rooms yet
(`scenarioOf` is in the game summary). Decide whether agents should get a `take_seat` tool and whether scenarios
belong in the lobby before they are used in public.

## 6. Tournament entrants cannot be characters yet

**Where:** `packages/server/src/tournament-scoring.ts` (`entrantKey`), `POST /api/tournaments/:id/join`, the MCP
`join_tournament` tool, `Store.createTable`.

**What is wrong:** a tournament table is started right after its seats are filled, and `GameRoom.bindCharacter` only
works in the lobby, so no tournament entrant is ever bound to a character. The tournament leaderboard therefore ranks
everyone by entrant name (`player:<name>`, `bot:<name>`), never by character key: a league character that plays a
tournament gets a name row, not its character row, and the name is self-declared (as in item 3).

**Fix (to do):** `join` takes an optional `characterId`, checked with the characters write key like `bindCharacter`,
stored on the `Entrant` and bound on every table seat; `entrantKey` then keys it by the character, as `Rankings.record`
does.

## 7. Anyone can trip the season-archive lockout

**Where:** `packages/server/src/season-key.ts` (`SeasonKeyGuard`), `POST /api/rankings/new-season`.

**What is wrong:** the guard's global cap (20 wrong tries within 15 minutes from anyone) lets any visitor lock the
**Archive season** button for everyone for 15 minutes by sending wrong passwords. Also, the per-IP limit trusts the
client IP behind the proxy (`trust proxy`), so it can be dodged with spoofed forwarding headers; the global cap is
then the real limit, which is why the key should be long. The admin route (`POST /api/admin/rankings/new-season`,
admin token) is never locked, so the host can always archive.

**Fix (to do):** if it is ever abused, key the per-IP count on the proxy's real client address only, and make the
global lockout per-IP-bucket instead of site-wide (or require a session from the admin first).

## 8. Anyone can fill the quick-play queue

**Where:** `packages/server/src/quick-play.ts` (`QuickPlayQueue`), `POST /api/queue`, the MCP `quick_play` tool.

**What is wrong:** joining the queue needs no account and has no per-client limit. One visitor can open a ticket for
every map, seat count and fog setting, so the waiting tables plus the running games reach `RISK_QUICKPLAY_MAX_ROOMS`
and everyone else gets "Quick play is full" until those games end (the Zergs finish them quickly, since a seat that
never moves is skipped by the turn timer). Each such game also costs the server a table of Zergs.

**Partly done:** a client IP may hold at most 3 waiting tickets (429 past that), and a ticket nobody polls is dropped
when its table starts. The IP comes from the proxy (`trust proxy`), so spoofed forwarding headers can dodge the
per-IP cap; the room cap is then the real limit.

**Fix (to do):** if it is abused, key the cap on the proxy's real client address only and cap quick-play seats per
client as well.

## 9. The quick-play queue is lost on restart

**Where:** `packages/server/src/quick-play.ts` (`QuickPlayQueue`, in memory only).

**What is wrong:** waiting tickets and the tables waiting to start are not saved. A deploy or restart forgets them:
clients get 404 on their next poll and must join again (games already started are saved like any room).

**Fix (to do):** save waiting buckets next to `games.json` and restart their windows on load, if restarts during
busy hours make this matter.

## 10. Anyone can trip the hosting-code lockout

**Where:** `packages/server/src/tournament-access.ts` (`TournamentAccess.checkCode`), `POST /api/tournaments`,
`POST /api/tournaments/:id/start` and the MCP `create_tournament` / `start_tournament` tools.

**What is wrong:** after 50 wrong hosting codes from anyone within an hour, every code check is refused (429) until
the hour passes, the **right** code included, because the lock is checked first. So any visitor can stop every code
holder from creating or starting tournaments for an hour by sending wrong codes from several addresses. The per-IP
limit (5 per 15 minutes, then 1 h) trusts the client IP behind the proxy (`trust proxy`), as item 7 does, so it can be
dodged and the global cap is the real limit. The admin key (`POST /api/admin/tournaments`, the host token routes)
is never locked, so the owner can always create and start.

**Fix (to do):** if it is ever abused, key the per-IP count on the proxy's real client address only, and keep the
global cap for wrong tries without refusing a right code (or let a right code through while only wrong tries are
counted). The codes are a testing gate that player keys or sign-in replace later (owner, 2026-10-22).

## 11. Player key limits trust the proxy's client address

**Where:** `packages/server/src/player-keys.ts` (`PlayerKeyStore.issue`), `POST /api/players`.

**What is wrong:** issuing keys is limited per client IP (`RISK_PLAYER_KEYS_PER_IP_DAY`, default 3 a day) and in
total (`RISK_PLAYER_KEYS_PER_DAY`, default 100). The IP comes from express's `trust proxy`, so forwarded headers can
spoof it and dodge the per-IP limit; the total cap is then the real limit, and one client can use it up for everyone
for a day (names are first come, first served, so it can also squat names). Keys already issued keep working.

**Fix (to do):** if it is abused, key the per-IP count on the proxy's real client address only, add a proof of work
or a captcha-free challenge to issuing, or move to sign-in (M4).

## 12. A player key on the browser can be read by any script on the page

**Where:** `packages/client/src/session.ts` (`risk.playerKey` in localStorage), the **Your player key** page.

**What is wrong:** the web client keeps the player key in localStorage so it can send it when you take a seat. Any
script running on the site (an XSS bug, a bad dependency, a browser extension) can read it and play as you, and it
stays until you forget it. The key only names a player on the leaderboard (no money, no other data), and the page has
**Forget the key on this browser** and **Get a new key** (rotation stops a leaked key at once).

**Fix (to do):** if keys come to matter more, move the browser side to an HttpOnly, SameSite cookie set by the server
(the header stays for agents), or to sign-in (M4).

## Fixed

- **Anyone could create tournaments while testing (was item 1).** Creating now needs a hosting code once the owner
  sets one (`RISK_TOURNEY_ADMIN_CODE` / `RISK_TOURNEY_LIMITED_CODE`; open mode, `RISK_TOURNAMENTS_OPEN`, is then off by
  default), wrong codes are limited per IP and site-wide, caps bound tournaments, seats and creates per day, creates
  pause while the server lags, and tournaments left registering expire ([tournaments.md](tournaments.md#hosting-codes-and-caps)).
  The MCP create/start tools stay, behind the codes (owner, 2026-10-22). The codes are a testing gate; player keys or
  sign-in replace them later.
- **Anyone could start, forfeit for or delete someone else's tournament, and `tournaments.json` grew forever.**
  Create now returns a host token; start, forfeit and delete need it or the admin key (tournaments saved before
  then are admin-only). At most `RISK_MAX_ACTIVE_TOURNAMENTS` (default 20) register or run at once, and only the
  newest `RISK_TOURNAMENTS_KEEP` (default 100) finished ones are kept. Opening creation to anyone was item 1, fixed above.

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
