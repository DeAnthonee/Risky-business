# Game records: what we have and what comes next

The goal: every game played on the server becomes material for training our AI players. They should learn which
moves work, what to expect behind fog of war, and how to handle positions we pick and play out again as scenarios.

This page tracks that work. How records work today (format, API, scenarios) is in
[game-records.md](game-records.md); open risks are in [hardening.md](hardening.md).

## Done

| PR | What it added |
| -- | ------------- |
| [#67](https://github.com/DeAnthonee/Risky-business/pull/67) | **Recording.** Every game that starts is journalled move by move under `RISK_DATA_DIR/archive/` and filed as one `GameRecord` when it ends. Unfinished games are kept, marked as such. Each step records who acted, when, the action, the true board before it, the player's hand and every event (dice, losses, conquests, eliminations). Under fog it also records what the acting player saw, and each turn records what every living player saw. Records replay exactly (`stateAtStep`, `verifyRecord`, `observeStep`). Admin-only API: `GET /api/admin/archive...`. |
| [#68](https://github.com/DeAnthonee/Risky-business/pull/68) | **Retention.** Only the newest 1000 records are kept (`RISK_ARCHIVE_KEEP`; `0` = all), about 0.3-1.6 GB. |
| [#69](https://github.com/DeAnthonee/Risky-business/pull/69) | **Scenarios.** `POST /api/admin/scenarios` starts a new live game from any moment of a record. It gets new dice (or the original dice), and bot seats that token holders can take over with `POST /api/games/:id/seat`. The new game is recorded too, with `scenarioOf` pointing back at its source. |
| [#206](https://github.com/DeAnthonee/Risky-business/pull/206) | **Decision notes** (play-by-play part G1). `act` takes an optional private `note` (a string or JSON, at most 2 KB) that is saved with its move: `decisionNote` on the room's history entry, and `note` on the record step. It is never shown during the game (`eventsSince` strips it from every live output), and the admin reads it in `GET /api/admin/archive/:id`. The field is optional, so `RECORD_VERSION` stays 1. |
| [#208](https://github.com/DeAnthonee/Risky-business/pull/208) | **G2: records key and play-by-play.** `RISK_RECORDS_KEY` (read-only, `x-records-key`; the admin token also works; unset = off) opens `GET /api/records/:id` and `/api/records/:id/playbyplay`. `narrate(record)` tells a game turn by turn, with decision notes inline once G1 adds them. `npm run records:playbyplay` does the same from a file or an id. |

So today, for any recorded game, we can:
- list games with their players, characters and placings;
- see the true board and each player's fog view at any move;
- replay the game exactly;
- start a new game from any moment of it.

What we can't do yet is **learn** from records: nothing in the training pipeline reads them.

## Next steps

In order. Each step says what "done" means.

### 1. Turn records into training data (next)

`packages/selfplay` trains on its own decision logs only. Add a converter (e.g. `npm run selfplay -- records
--in <archive copy> --out <dir>`) that turns each record step into one example from the acting player's side:

- **Input:** the board they saw (`seen`; the true board when fog was off), their hand, the game settings.
- **Targets:** the action they took; the true board (`board`), so a model learns what fog hides; outcome labels
  (final placing, won or not, turns until elimination or the end).
- **Metadata:** record id, step, player, `characterId`, `isBot`, map, fog.
- **Filters:** map, fog only, skip built-in bots, finished games only. Records that fail `verifyRecord` are skipped
  with a warning.

It reuses the features in `encode.ts` (bump `ENCODER_VERSION` if they change), writes a versioned output format, and
reads archive copies taken off the host, never the live server.

**Done when:** one command turns a folder of records into training-ready files, with fog view and truth side by
side, tested on a small recorded game.

### 2. A fog model: predict what is behind the fog

With step 1 in place, train a model that takes what a player saw (plus the game so far) and predicts the hidden
territories: owner and army counts. Players then plan against a best guess instead of a blank map.

- **Data:** `seen` vs `board` pairs from fog games. Later turns also show how good a guess was once the fog lifted.
- **Where it plugs in:** Delove ([delove.md](delove.md)) and the character players can use the prediction as an extra
  input.

**Done when:** a measured prediction accuracy on held-out games beats a simple baseline (e.g. spreading unseen armies
evenly).

### 3. Judge moves by playing them out (scenario evaluation)

To learn which moves are *good*, not just which moves were made, use scenarios as experiments:
1. Take a moment from a record.
2. Try several candidate moves from there.
3. Play each one out many times with fixed bots or Delove.
4. Compare win rates.

Run it headless, the way self-play does, not on the live server: the engine's `scenarioState` plus self-play's
seeded runner, so results stay deterministic.

**Done when:** a command reports, for a recorded moment, the win rate after each candidate move. A batch over many
moments yields labelled "better / worse move" data for training.

### 4. A scenario library

Interesting moments are worth keeping beyond the 1000-record window: comebacks, continent fights, a last stand.
Save a moment as a named scenario that outlives retention: its start state, the source record and step, and a short
description. It can then be started by name, used in tournaments, or used as a fixed benchmark for comparing model
versions.

**Done when:** scenarios can be saved, listed and started by name, and are kept even after their source record is
pruned.

### 5. Access for agents and spectators

These are the gaps listed in `hardening.md` item 5, plus viewing:

- A `take_seat` MCP tool, so an agent can claim a scenario seat without an extra HTTP call.
- Deciding whether agents may *start* scenarios (today admin-only).
- Mark scenario rooms in the web client (`scenarioOf` is already in the game summary).
- A replay viewer for spectators: step through a record, with the true board next to any player's fog view.

### 6. Archive housekeeping

- **Smarter retention:** keep fog and AI/character games longer than bots-only games, which self-play can make
  in bulk anyway.
- **Off-host copies:** a regular sync of `archive/` from the Mac mini to where training runs, so records survive
  retention.
- **Compression:** gzip filed records, which are highly repetitive JSON.
- **One format for self-play:** have self-play write the same `GameRecord` format, so steps 1-3 read one kind of
  file.

## Open questions

- **Which games count for training?** All of them, or only fog, character, or human games? Bot-vs-bot games are
  cheap to make with self-play, so server games matter most when real agents or people play.
- **How much history should a model see?** The current turn only, or the moves since the last turn (what an
  opponent just did in view)?
- **Should `seen` include what a player remembers?** Under fog, a territory seen a few turns ago and now hidden is
  `null`. Records keep the full history, so "last seen" boards could be derived during export rather than recorded.
- **Privacy:** records hold every hand and the hidden board, and stay admin-only. Before sharing a dataset
  outside the project, decide what to strip (names, chat is not recorded today).
