# Game records

Every game the server plays is recorded move by move, so the AI can study what was played, learn which moves
worked, and rebuild any moment of a game as a scenario to play out again. Under fog of war each record also keeps
what every player could see next to what was really on the board.

Code: the format, builder and replay are in `packages/engine/src/record.ts` (pure, so self-play or any tool can
use them); the server writes records in `packages/server/src/archive.ts`. What has been built so far and what comes
next (training export, a fog model, judging moves with scenarios): [game-records-roadmap.md](game-records-roadmap.md).

## Where they are

Under `RISK_DATA_DIR/archive/` (persistence on; set `RISK_ARCHIVE=0` to turn recording off):

| path | what |
| ---- | ---- |
| `live/<id>.jsonl` | the journal of a game still being played: one line per move, appended as it happens, so it survives restarts and deploys |
| `games/<yyyy-mm>/<id>.json` | a finished record (`GameRecord`), written when the game is won or its room closes |
| `index.jsonl` | one line per finished record: map, fog, players and characters, placings, winner, turn and step counts, and the record's file |

A game is recorded from the moment it starts; lobbies that never start leave nothing. A game whose room is closed
before anyone wins is still filed, with `outcome.finished: false` and `endedBecause`. A nested tournament table
**decided on standing** at its round's end is filed the moment it is decided, like a finished game: see
[Decided on standing](#decided-on-standing). Records hold every hand and
the hidden board, so they are only served to the admin. A game takes roughly 0.3 MB (2 players) to 1.6 MB (6 players).

Only the newest 1000 records are kept (`RISK_ARCHIVE_KEEP`; `0` keeps them all), so the archive stays around
0.3-1.6 GB. Each time a game is filed, the oldest records beyond that are deleted with their `index.jsonl` lines.
Copy the archive off the host to keep more.

## Getting them

With `RISK_ADMIN_TOKEN` (as `Authorization: Bearer <token>`):

- `GET /api/admin/archive?limit=100`: the index, newest first.
- `GET /api/admin/archive/:id`: one whole record.
- `GET /api/admin/archive/:id/steps/:step?viewer=<playerId>`: one moment, rebuilt by replay. Returns `state`
  (the exact full game state just before step `step`, ready to be used as a scenario), `view` (what `viewer` saw
  then, fog applied, legal moves included; without `viewer`, the spectator's view) and `events` (that step's
  results as they were shown to the viewer).

Or copy `RISK_DATA_DIR/archive/` off the host.

**Read-only, with the records key** (`RISK_RECORDS_KEY`, set by the owner and kept private; header
`x-records-key`; the admin token also works): `GET /api/records/:id` (the whole record) and
`GET /api/records/:id/playbyplay`. Without the key set on the server those routes are off (403).

## Play-by-play

`narrate(record)` (`packages/server/src/playbyplay.ts`, pure) tells a recorded game turn by turn:
- a header: room, map, players, winner;
- setup totals;
- each turn's reinforcements, placements, card trades, attacks, occupations, fortifies, capital picks, knockouts,
  surrenders and timeouts, with lines such as "Bob attacks Glacier Bay (Cat) from Stormwatch, 5 vs 1: 1 roll, loses
  0, kills 1, conquers";
- the game's end.

A step's decision note (`step.note`: a string or any JSON the seat sent, no schema enforced) is shown inline under its
step. A string is shown as is. An object is rendered from these keys when present:
- `text`;
- `chose` or `chosen`;
- `score`;
- `alternatives` or `top`: candidates as strings, or as objects with a label (`label`, `move` or `name`) and a score
  (`score`, `p` or `q`);
- `value`;
- `model` and `preset`.

Any other keys follow as compact JSON, and a note with none of these keys is shown as JSON. For example: "↳ Delove
(delove@11, js2-range) chose Peru (.62) over Chile (.58), value .41". `narrate(record, { summary })`
takes extra header lines, for the Zerg report once that lands.

- **Over HTTP**, with the records key: `GET /api/records/:id/playbyplay` as text, or `?format=json` for the lines.
- **From the command line:** `npm run records:playbyplay -- <record.json>` narrates a local record file, and
  `npm run records:playbyplay -- <record id>` fetches it from `RISK_SERVER_URL` with `RISK_RECORDS_KEY` from the
  environment, never printed. Both need the built server (`npm run build`).

## The format (`RECORD_VERSION` 1)

Boards are compact. `territories` lists the territory ids once; a board is an array in that order with one
`[owner, armies]` cell per territory, where `owner` is an index into `players` (`-1` = nobody, e.g. a blizzard).
A **seen** board is the same, with `null` where the territory was hidden from that player by fog.

When a game is filed, `room.agents` maps each seat to its self-declared [player type](http-api.md#player-type-labels)
(only seats that declared one, plus `"bot"` and `"zerg"` seats); the `index.jsonl` line has it as each player's
`agent`. It is written only when the game is over, never into the live journal. Optional, so `RECORD_VERSION` is
unchanged.

A game with [house roster](tournaments.md#the-house-roster) seats also gets `room.roster`: `{<playerId>: {id,
model}}`, the roster id and the Delove model each of those seats played. It is the answer key, so it is only in the
full record (records key or admin); `room.agents` and the `index.jsonl` line show those seats as `"AI agent"`. Also
written only when the game is filed, and optional (`RECORD_VERSION` unchanged).

A training game ([training leaderboard](character-league.md#training-leaderboard)) has `"board": "training"` in
`room` and on its `index.jsonl` line: leave these out of Delove's training data unless you mean to use them.

```jsonc
{
  "format": "risky-game-record", "version": 1,
  "id": "K7QX2M-mf3k2a1", "room": { "id": "K7QX2M", "name": "Friday night" },
  "map": "classic", "fog": true, "options": { /* every game setting */ }, "seed": 123456,
  "startedAt": 1760812345678, "endedAt": 1760815345678,
  "territories": ["alaska", "northwest_territory", "..."],
  "players": [{ "index": 0, "id": "p_ab12", "name": "Iron Man", "color": "#e33", "isBot": false, "isNeutral": false, "characterId": "marvel/iron-man" }],
  "start": { "state": { /* full GameState right after the start: deck order and dice seed included */ }, "events": [] },
  "turns": [
    { "turn": 1, "round": 1, "player": "p_ab12", "at": 1760812346000, "reinforcements": 3,
      "firstStep": 12, "lastStep": 20,
      "board": [[0, 3], [1, 2]],                 // the truth as the turn began
      "seen": { "p_ab12": [[0, 3], null], "p_cd34": [null, [1, 2]] } }  // fog only: each living player's picture
  ],
  "steps": [
    { "i": 14, "at": 1760812347000, "turn": 1, "round": 1, "phase": "attack", "player": "p_ab12",
      "action": { "type": "attack", "from": "alaska", "to": "kamchatka", "blitz": true, "occupy": "max" },
      "board": [[0, 3], [1, 2]],                 // the truth just before the action
      "seen": [[0, 3], null],                    // fog only: what the acting player saw when choosing it
      "hand": [{ "id": 4, "kind": "cavalry", "territory": "peru" }],
      "events": [{ "type": "battle", "attackerDice": [6, 5, 2], "defenderDice": [4, 3], "...": "..." }],
      "note": { "why": "take the weak border before Kamchatka reinforces" } }  // only if the player sent one (act's
                                                // `note`, at most 2 KB): their own reasoning, never shown during the game
    // A move the server made because the turn timer ran out has "timeout": true, and the first of them
    // starts its events with { "type": "timeout", "player": "p_ab12", "scope": "turn" }. It replays like any move.
  ],
  "outcome": { "finished": true, "winner": "p_ab12", "reason": "domination",
    "eliminations": [{ "player": "p_cd34", "by": "p_ab12", "turn": 31, "step": 402 }],
    "placings": ["p_ab12", "p_cd34"], "board": [[0, 5], [0, 1]] }
}
```

Every step is one action by one player, in the order they were played. For training, a step is an example on its
own: what the player could see (`seen`), what was really there (`board`), what they held (`hand`), what they did
(`action`), what it led to (`events`), and how the game ended for them (`outcome.placings`). The gap between `seen`
and `board` is what fog hid; comparing what the player saw with what the next turns revealed is how a model learns
what to expect behind the fog.

`outcome.placings` lists the real seats only, winner first, then the survivors by territories held, then the
eliminated players from last out to first out. The neutral army is never placed, including one that came into the game
mid-way when a player surrendered (its territories go to a neutral). `outcome.eliminations` still lists that neutral
when it is wiped out. Records filed before #124 can carry an extra `"neutral"` id in `placings` after a surrender;
read places by seat (the archive index's `players[].place`) or by finishing order rather than by position.

### Coach notes

A quick-play game whose seats were coached through the live coach channel carries the notes as private notes in an
optional top-level `coach`: `[{player, at, version, text}]`, in the order sent (`version` is the game state's version
when the note was sent). Additive: `RECORD_VERSION` stays 1. Like everything in a record, they are served to the admin
and the records key only, never in `/history` or anywhere public.

### Decided on standing

A nested tournament table still playing when its round ends is stopped and decided on standing
([tournaments.md](tournaments.md)). Its record is filed at that moment (not when the room is swept later), in the same
format, with the game left where it stopped (`finished: false`: the engine never ended it) and the result the
tournament used:

```jsonc
"outcome": { "finished": false, "endedBecause": "decided on standing at its round's end",
  "winner": "p_ab12", "reason": "standing",
  "decided": { "standing": ["p_ab12", "p_ef56", "p_cd34"], "rolls": { "p_ab12": [5], "p_ef56": [2] } },
  "eliminations": [], "placings": ["p_ab12", "p_ef56", "p_cd34"], "board": [[0, 5], [0, 1]] }
```

`decided.standing` is the order `rankByStanding` gave (territories, then armies, then tie-break dice, then the
players already out); `rolls` holds the dice of the tied players, when there were any. `winner` is its first and
`placings` follows it. The steps replay exactly like any record (`verifyRecord`). The archive index marks such a
record `decided: true`, and match history (`GET /api/history`) lists it with `reason: "standing"`. This is
additive (a new optional field and a new `reason` value), so `RECORD_VERSION` stays 1: a reader that treats
`finished: false` as "no result" keeps working, and one that wants the decided result reads `decided`.

A game the **engine** ends as a stalemate (the `stallEnd` stall breaker, [playing.md](playing.md)) is different: it
is finished in the engine (`finished: true`; the server ends it with a system commit, which adds no step), so the
record's outcome has `reason: "stalemate"`, the winner first in the standing, `placings` in standing order and
`decided` with that standing and its dice (from the final state's `stall.stalemate`). Also additive: `RECORD_VERSION`
stays 1.

## Replaying and scenarios

The engine has the start state, the dice seed and every action, so a record replays exactly:

```ts
import { stateAtStep, observeStep, verifyRecord } from '@risk/engine';
verifyRecord(record);                        // null when every step rebuilds the board it recorded
const state = stateAtStep(record, 120);      // the full game just before step 120: a scenario to play out
const { view } = observeStep(record, 120, record.steps[120].player);  // the same moment through that player's eyes
```

### Scenarios: playing a recorded moment out again

The admin can start a new live game from any moment of a recorded game, so bots, agents or people play that
position out differently:

```http
POST /api/admin/scenarios
Authorization: Bearer <RISK_ADMIN_TOKEN>

{ "recordId": "K7QX2M-mf3k2a1", "step": 120, "seats": { "p_ab12": "open" }, "keepDice": false, "name": "What if?" }
```

- The new room (fresh room code) begins in the exact state just before step `step` (`scenarioState` in
  `record.ts`: `stateAtStep` under a new id and start time). `step` runs from 0 to the last step; a moment after the
  game was won is refused.
- Players keep their ids, names, colours, cards and armies, so the new game lines up with the original record.
- **Seats** default to built-in bots. `seats` maps a player id to `"bot"` or `"open"`; an open seat is played by
  whoever holds its token. The response returns every seat's token
  (`{gameId, name, scenarioOf, seats: [{playerId, name, alive, bot, token}], game}`), and a token holder can take a
  bot seat over at any time with `POST /api/games/:id/seat` (body `{}`; `{"bot": true}` hands it back). After that,
  the seat plays over the normal API (`/games/:id/actions`, `/wait`, WebSocket) like any other.
- **Dice:** a new seed by default, so the dice differ from the original. `keepDice: true` keeps the recorded dice
  state, so replaying the recorded moves reproduces the original game exactly. The deck's order is part of the
  state and is kept either way.
- Nobody hosts the room (only the admin closes it, with `DELETE /api/admin/games/:id`). A scenario played by bots
  alone is not swept at once like other bots-only rooms; it follows the bots-only idle rule (30 minutes by default).
  Open seats follow the usual rule for absent seats (closed after `RISK_ABANDONED_CLOSE_MIN` with no seat present).
- Its result is not ranked on the leaderboard: the position was someone else's.
- It is recorded like any game. Its record's `start.state` is the scenario's first state, and its header, its
  `index.jsonl` line, the room's snapshot and its game summary (`GET /api/games`) all carry
  `scenarioOf: { recordId, step }`. A scenario of a scenario works the same way, so chains can be followed back.

Scenarios have no MCP tools yet (see `docs/hardening.md`).

### Starting positions for training

`npm run selfplay -- positions --records <archive>/games --out positions.jsonl --alive 3,2` turns records into
self-play starting positions: for each record, the state just after the elimination that left 3 (and 2) players,
with the seats renamed `s0..sN-1`, fog switched off and the order players went out. Delove's stage games play from
them (`pos:FILE>...` agents; `packages/selfplay/README.md`, "Stage games").

## Changing the format

Adding an optional field needs no version change. Anything that would break a reader (renaming, removing, changing a
field's meaning or the board encoding) bumps `RECORD_VERSION` in `record.ts` and updates this page.
