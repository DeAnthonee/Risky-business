# Delove live yardstick: Delove against Claude models on the live board

The live yardstick from [delove-status.md](delove-status.md) section 9 item 4. A Delove model sits at a live table
with five LLM seats, and we record where it finishes. It measures Delove; it is not training data. These games never
go into Delove's training pool, and the LLM characters play no part in Delove's training recipe.

Each LLM seat is a Claude Code subagent on one model tier. It plays a `league/*` character through the game's MCP
tools, reads the general player's playbook and its character profile once, and picks every move itself. Delove sits
through `npm run delove-seat`. The table runs until Delove is knocked out. Its place, points and game length are then
recorded and the room is closed (a closed room is never ranked), so the rest of the game costs nothing.

Raw per-game logs (`results.jsonl`, `tokens.jsonl`) stay on the machine that ran them (README hard rule 13). The table
below is the record.

## Setup used (keep it fixed to compare models)

| | |
| --- | --- |
| server | https://risky.deanthoneeking.com (live) |
| table | 6 seats: Delove + five LLM seats named `<Tier> <Character>`: Shen, Jinx, Thresh, Leona, Teemo (`league/*` profiles) |
| map | Classic |
| settings | fog **off** (the Delove seat refused fog games then; since #155 it seats fog-trained models, `fogInputs`), territories and armies dealt at random (`autoSetup`, `randomDeal`), **capitals on** (each picks one), **8 blizzards**, progressive cards, balanced blitz, first-round bonus, connected fortify |
| seat order | the five LLM seats in character order, Delove last (6th) |
| LLM seat brief | [`packages/delove/scripts/yardstick/seat-prompt.md`](../packages/delove/scripts/yardstick/seat-prompt.md) |
| stop rule | the game ends when Delove is knocked out (or finishes); the monitor records it and closes the room |
| score | leaderboard points: placement (6 seats: +3, +2, +1, -1, -2, -3) plus +1 per kill ([character-league.md](character-league.md)) |

Game 1 was a pilot with a different setup: no capitals and no blizzards, and it was played to the finish.

## Results

Delove model `delove@6` in every game (2026-10-20/21). "Out" is the round Delove was knocked out. "Tokens per LLM
seat" is what each Claude Code subagent used for the whole game; a dash means the seat was stopped and reported none.

| # | game | opponents | capitals / blizzards | Delove place | points | kills | out (round) | knocked out by | length | tokens per LLM seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | EA5GH5 | 5 × Claude Haiku | off / 0 (pilot) | 2nd | +2 | 0 | 31 | Haiku Thresh (the winner) | 44 min | 196k-621k, mean 306k |
| 2 | R4WJSB | 5 × Claude Sonnet | on / 8 | 5th | -2 | 0 | 6 | Sonnet Jinx | 9 min | 161k, 172k, -, -, - |
| 3 | 49L5TU | 5 × Claude Sonnet | on / 8 | 3rd | +1 | 0 | 9 | Sonnet Shen | 17 min | 154k-236k, mean 201k |
| 4 | TBHB74 | 5 × Claude Sonnet | on / 8 | 5th | -2 | 0 | 4 | Sonnet Leona | 5 min | 134k-158k, mean 145k |
| 5 | 7BNCHD | 5 × Claude Opus | on / 8 | 5th | -2 | 0 | 3 | Opus Thresh | 6 min | 130k-140k, mean 136k |
| 6 | 8T27QN | 5 × Claude Opus | on / 8 | 6th | -3 | 0 | 3 | Opus Jinx | 5 min | 126k-133k, mean 129k |

**By tier (fixed setup, games 2-6):** Sonnet, 3 games: mean -1.0 points, mean place 4.3, out in rounds 4-9. Opus, 2
games: mean -2.5 points, mean place 5.5, out in round 3 both times. Delove made no kills in any game.

### What this shows, and what it doesn't

- With capitals and blizzards on, every LLM tier knocked delove@6 out early (rounds 3-9), and Opus earliest. In the
  one game without them (the Haiku pilot) it lasted 31 rounds and placed 2nd. Game 1 changed both the opponents and
  the settings, so these games can't tell whether the gap comes from the stronger models or from capitals and
  blizzards. A cheap control would separate them: delove@6 against Sensei 2 / Jacob Sensei offline, with and without
  capitals and blizzards.
- In games 2-6 the LLM seats went after Delove's capital and stacks in the first rounds (the seats' own reports: in
  game 5, Opus Shen took Delove's capital Venezuela and all of South America in round 1). Delove sits last in seat
  order and starts with the least ground under the first-round bonus.
- **Games 1-6 ran with a seat bug** (fixed in #143): the Delove seat rebuilt the board with every opponent holding
  0 cards, so delove@6 read every LLM seat's card count as 0 (its encoder and the seat's moves use opponents' hand
  sizes; training saw the real counts). delove@6's baseline here is understated; re-measure it after the fix before
  comparing a new model against these rows.
- Five or six games are a small sample. A real comparison needs more games per tier, ideally with seat order rotated.

## Rerun it for a new model (delove@7, the range specialists)

Same lineup, settings and stop rule, so the new rows compare with the ones above. Runtime files go to
`$YARDSTICK_DIR` (default `~/risk-yardstick`), never into the repo.

1. Create the lobby and the five LLM seats (prints the game id and each seat's token):

   ```bash
   node packages/delove/scripts/yardstick/setup.mjs https://risky.deanthoneeking.com Sonnet my-label
   ```

   With `RISK_CHARACTERS_KEY` in the environment the room goes on the training board (#138); without it the room is
   public, and it is still never ranked because it is closed when Delove is out.
2. Seat Delove (it waits for the start):

   ```bash
   DELOVE_MODELS=<models folder> npm run delove-seat -- --server https://risky.deanthoneeking.com --join <gameId> --agents delove@7 --names delove@7 --pace 400
   ```

3. Start one agent per LLM seat on the tier's model (Haiku, Sonnet, Opus, Fable), each with
   [`seat-prompt.md`](../packages/delove/scripts/yardstick/seat-prompt.md) filled in from step 1. Change "delove@6"
   in the brief to the model being measured.
4. Start the game with the host token (seat 1 from step 1):

   ```bash
   curl -X POST -H "Authorization: Bearer <host token>" https://risky.deanthoneeking.com/api/games/<gameId>/start
   ```

5. Run the monitor until it exits. It appends the result to `results.jsonl` and closes the room once Delove is out:

   ```bash
   node packages/delove/scripts/yardstick/monitor.mjs https://risky.deanthoneeking.com <gameId> delove@7 my-label
   ```

   Let the agents stop by themselves (a closed room answers "not found") so each one reports its token use. Then add a
   row to the table above.
