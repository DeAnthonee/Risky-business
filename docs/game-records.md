# Game records

Every game the server plays is recorded move by move, so the AI can study what was played, learn which moves
worked, and rebuild any moment of a game as a scenario to play out again. Under fog of war each record also keeps
what every player could see next to what was really on the board.

Code: the format, builder and replay are in `packages/engine/src/record.ts` (pure, so self-play or any tool can
use them); the server writes records in `packages/server/src/archive.ts`.

## Where they are

Under `RISK_DATA_DIR/archive/` (persistence on; set `RISK_ARCHIVE=0` to turn recording off):

| path | what |
| ---- | ---- |
| `live/<id>.jsonl` | the journal of a game still being played: one line per move, appended as it happens, so it survives restarts and deploys |
| `games/<yyyy-mm>/<id>.json` | a finished record (`GameRecord`), written when the game is won or its room closes |
| `index.jsonl` | one line per finished record: map, fog, players and characters, placings, winner, turn and step counts, and the record's file |

A game is recorded from the moment it starts; lobbies that never start leave nothing. A game whose room is closed
before anyone wins is still filed, with `outcome.finished: false` and `endedBecause`. Records hold every hand and
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

## The format (`RECORD_VERSION` 1)

Boards are compact. `territories` lists the territory ids once; a board is an array in that order with one
`[owner, armies]` cell per territory, where `owner` is an index into `players` (`-1` = nobody, e.g. a blizzard).
A **seen** board is the same, with `null` where the territory was hidden from that player by fog.

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
      "events": [{ "type": "battle", "attackerDice": [6, 5, 2], "defenderDice": [4, 3], "...": "..." }] }
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

## Replaying and scenarios

The engine has the start state, the dice seed and every action, so a record replays exactly:

```ts
import { stateAtStep, observeStep, verifyRecord } from '@risk/engine';
verifyRecord(record);                        // null when every step rebuilds the board it recorded
const state = stateAtStep(record, 120);      // the full game just before step 120: a scenario to play out
const { view } = observeStep(record, 120, record.steps[120].player);  // the same moment through that player's eyes
```

Starting a live game from a recorded moment is not built yet; `stateAtStep` gives the state such a game would begin from.

## Changing the format

Adding an optional field needs no version change. Anything that would break a reader (renaming, removing, changing a
field's meaning or the board encoding) bumps `RECORD_VERSION` in `record.ts` and updates this page.
