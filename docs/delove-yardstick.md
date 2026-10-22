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
| table | 6 seats: Delove + five LLM seats named `<Tier> <Character>`: Shen, Jinx, Thresh, Leona, Teemo (`league/*` profiles). Since #157 Delove sits as `<Tier> Garen`, a name like the others; before, it sat as `delove@6` / "Delove Search" |
| map | Classic |
| settings | fog **off** in games 1-21 (the Delove seat refused fog games then; since #155 it seats fog-trained models, `fogInputs`), fog **on** in baseline 4 (games 22-27; `setup.mjs ... fog`), territories and armies dealt at random (`autoSetup`, `randomDeal`), **capitals on** (each picks one), **8 blizzards**, progressive cards, balanced blitz, first-round bonus, connected fortify |
| seat order | the five LLM seats join in character order and Delove joins last, but the **turn order is shuffled by the engine at the start** (`startGame`, "highest roll goes first"), so Delove doesn't always move last |
| LLM seat brief | [`packages/delove/scripts/yardstick/seat-prompt.md`](../packages/delove/scripts/yardstick/seat-prompt.md). **Neutral since #157**: it doesn't say which seat is the trained model, and the room name doesn't either. Games 1-12 used a brief naming "one trained bot", and the LLM seats focused that seat in rounds 1-2, so those rows aren't comparable with neutral rows |
| games per model | **2 games per tier** (Haiku, Sonnet, Opus) for each model or preset measured, 6 games in all; report each model's mean points and place per tier |
| stop rule | the game ends when Delove is knocked out (or finishes); the monitor records it and closes the room |
| score | leaderboard points: placement (6 seats: +3, +2, +1, -1, -2, -3) plus +1 per kill ([character-league.md](character-league.md)) |

Game 1 was a pilot with a different setup: no capitals and no blizzards, and it was played to the finish.

## Results

### Baseline 1: bare delove@6 (games 1-6)

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

### Baseline 2: delove@8 + search (JS2, range, h2/m0.02), card counts fixed (games 7-12)

The same lineup, settings, seat brief and stop rule as games 1-6 (game 7 again uses the pilot's settings), played
2026-10-21 by the live search seat "Delove Search" with the settings that are now #154's opt-in `--preset js2-range`
(#154's default became #142's measured setup before merging): branch and score with `delove@8` ranking the moves
(pinned with `DELOVE_BRANCH_RANKER=delove@8`; delove@9 was promoted during the run), Jacob Sensei 2 rollouts,
5 options per decision, the range score, horizon 2 and margin 0.02. The seat reads opponents' real card counts (#143).
"Attacked early" is how many LLM seats attacked Delove in rounds 1-2: from the server's event log for games 9-12
(`monitor.mjs` records it), from the agents' own reports for game 8, not recorded for game 9.

| # | game | opponents | capitals / blizzards | Delove place | points | kills | out (round) | knocked out by | attacked early | length | tokens per LLM seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 37BT64 | 5 × Claude Haiku | off / 0 (pilot) | **1st (won)** | +7 | 4 | won, round 13 | - | 1 | 20 min | 169k-299k, mean 249k |
| 8 | T9JQ3B | 5 × Claude Sonnet | on / 8 | 6th | -3 | 0 | 1 | Sonnet Teemo | 3 | 2 min | 110k-117k, mean 113k |
| 9 | GDSXDR | 5 × Claude Sonnet | on / 8 | 6th | -3 | 0 | 5 | Sonnet Leona | - | 7 min | 149k-167k, mean 157k |
| 10 | E5EMZB | 5 × Claude Sonnet | on / 8 | 6th | -3 | 0 | 2 | Sonnet Leona | 3 | 3 min | 113k-127k, mean 121k |
| 11 | PRNAYU | 5 × Claude Opus | on / 8 | 4th | +1 | 2 | 4 | Opus Teemo | 1 | 6 min | 122k-157k, mean 139k |
| 12 | NWRWR2 | 5 × Claude Opus | on / 8 | **1st (won, every capital)** | +5 | 2 | won, round 8 | - | 2 | 13 min | 152k-233k, mean 175k |

**By tier, against baseline 1:**

| tier | baseline 1 (bare delove@6) | baseline 2 (delove@8 + search) |
| --- | --- | --- |
| Haiku (pilot settings, 1 game) | 2nd, +2, 0 kills | 1st, +7, 4 kills |
| Sonnet (3 games) | mean -1.0 points, place 4.3, 0 kills | mean -3.0, place 6.0, 0 kills |
| Opus (2 games) | mean -2.5 points, place 5.5, 0 kills | mean +3.0, place 2.5, 4 kills |
| kills, all six games | 0 | 8 |

- The Sonnet seats went for Delove at once in every game: three of them attacked it in rounds 1-2 where counted, and it
  was always the first player out (rounds 1-5). Against Opus and Haiku fewer seats attacked early (1-2), Delove
  survived the opening and then won twice, once by taking every capital.
- The seat brief names Delove ("five Claude seats and one trained bot"). It is kept exactly as in games 1-6 so the
  baselines compare; whether naming the bot invites the gang-up is a separate experiment (a neutral brief).
- Two to three games per tier: the swings are large and the sample small.

### Baseline 3: delove@10 + search (js2-range), neutral brief (games 13-18)

Played 2026-10-22 under the **neutral protocol** (#157): Delove sits as "<Tier> Garen" and the brief doesn't say which
seat is the trained model. The seat is the default live seat since #164, branch and score with `delove@10` ranking the
moves (pinned with `DELOVE_BRANCH_RANKER=delove@10`), Jacob Sensei 2 rollouts, 5 options, the range score, horizon 2,
margin 0.02. Two games per tier, **all six with the fixed setup (capitals and 8 blizzards)**, including Haiku: the
Haiku rows here are not directly comparable with games 1 and 7, which used the pilot settings (no capitals, no
blizzards). "Attacked early" is from the server's event log (`monitor.mjs`). All rooms were public; games that finished
(13 and 16) count on public season 4, the owner's call.

| # | game | opponents | Delove place | points | kills | out (round) | knocked out by / winner | attacked early | length | tokens per LLM seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13 | TD7VDM | 5 × Claude Haiku | **1st (won, every capital)** | +7 | 4 | won, round 9 | - | 2 | 15 min | 170k-248k, mean 204k |
| 14 | 8WZ3RC | 5 × Claude Haiku | 5th | -1 | 1 | 7 | Haiku Leona | 3 | 11 min | 128k-197k, mean 177k |
| 15 | KDX7JE | 5 × Claude Sonnet | 4th | -1 | 0 | 5 | Sonnet Jinx | 2 | 10 min | 146k-175k, mean 159k |
| 16 | 7YS96P | 5 × Claude Sonnet | 2nd | +6 | 4 | alive at the end, round 9 | Sonnet Shen won (every capital) | 2 | 15 min | 155k-258k, mean 188k |
| 17 | AFUX5E | 5 × Claude Opus | 6th | -3 | 0 | 5 | Opus Leona | 2 | 9 min | 148k-161k, mean 152k |
| 18 | JBZMBU | 5 × Claude Opus | 6th | -3 | 0 | 2 | Opus Shen | 2 | 5 min | 116k-133k, mean 122k |

**By tier:**

| tier | baseline 2 (delove@8 + search, brief names the bot) | baseline 3 (delove@10 + search, neutral brief) |
| --- | --- | --- |
| Haiku | 1 game, pilot settings: 1st, +7 | 2 games, fixed setup: mean +3.0, place 3.0, 5 kills |
| Sonnet | 3 games: mean -3.0, place 6.0, 0 kills | 2 games: mean +2.5, place 3.0, 4 kills |
| Opus | 2 games: mean +3.0, place 2.5, 4 kills | 2 games: mean -3.0, place 6.0, 0 kills |
| all six games | mean +0.67, place 4.0, 8 kills | mean +0.83, place 4.0, 9 kills |

- The neutral brief did not stop early attacks: two or three LLM seats hit Delove in rounds 1-2 in every game, so the
  gang-up of baseline 2 was at least partly the board (Delove's starting spots and capital), not only the brief.
- Sonnet improved sharply (last in all three baseline-2 games; 4th and 2nd with 4 kills here), Opus went the other way
  (two early exits). With two games per tier and early attacks deciding most games, single games swing by 6-9 points:
  read the tiers together, not one by one.
- Game 16 shows the capitals win: Delove led with 21 territories and 96 armies after taking out four seats, and Sonnet
  Shen won by taking the last capital it was missing.

### Control: jacob-sensei@2 (games 19-20)

Played 2026-10-22 to see whether the early attacks single out Delove's play or hit whoever sits in that seat. The plain
bot `jacob-sensei@2` (hand-coded, no network, no search; `delove-seat --agents jacob-sensei@2`) took Delove's seat as
"Sonnet Garen", with baseline 3's neutral setup (neutral name and brief, capitals and 8 blizzards) against five Sonnet
seats. "Attacked early" is from the server's event log.

| # | game | opponents | Jacob place | points | kills | out (round) | knocked out by / winner | attacked early | length | tokens per LLM seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 19 | 8QT8YB | 5 × Claude Sonnet | 6th | -3 | 0 | 3 | Sonnet Thresh | 3 | 7 min | 136k-146k, mean 140k |
| 20 | FV4JQV | 5 × Claude Sonnet | 3rd | +1 | 0 | alive at the end, round 5 | Sonnet Leona won (every capital) | 1 | 11 min | 155k-176k, mean 163k |

- Against Sonnet, Jacob Sensei 2 averaged -1.0 points (place 4.5, no kills); delove@10 + search averaged +2.5 (place
  3.0, 4 kills) on the same setup (baseline 3).
- The plain bot drew early attacks too (3 seats in game 19, 1 in game 20), so the seat itself gets attacked early: it's
  not Delove's play alone that draws it.
- Two games: a control for the gang-up question, not a strength measurement.

### Baseline 4: delove@12 under fog (games 21-27)

Played 2026-10-22 under the neutral protocol (#157): Delove sits as "<Tier> Garen" and the brief doesn't say which seat
is the trained model. The seat is the default live seat (`js2-range`) with `delove@12` ranking the moves (pinned with
`DELOVE_BRANCH_RANKER=delove@12`), the first live model trained with fog inputs. The setup is the fixed one (capitals and
8 blizzards) with **fog of war on** (`setup.mjs ... fog`), and the seat brief adds the fog lines from
[`seat-prompt.md`](../packages/delove/scripts/yardstick/seat-prompt.md)'s header. Under fog the seat plays its
ranker's top move without search (`fogSafe`, `branch-env.ts`; fog search, `DELOVE_BRANCH_FOG=determinize`, was off),
so the fog rows measure the **bare `delove@12` network**, while baseline 3 measured delove@10 **with search, no fog**:
both the model and the fog setting changed. "Attacked early" comes from the server's event log (`monitor.mjs`), and
the monitor now also saves the whole event stream as `ev-<gameId>.json` next to `results.jsonl`, since a closed room
has no archive record. Every room was public. Games that finished (21, 23, 24, 25) count on public season 4, which was
the owner's call.

Game 21 was played first with fog off, before the fog-on decision. It is an extra no-fog data point (delove@12 with
search) and is not counted in the baseline-4 means.

| # | game | opponents | fog | Delove place | points | kills | out (round) | knocked out by / winner | attacked early | length | tokens per LLM seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | VXWGMU | 5 × Claude Haiku | off | **1st (won)** | +6 | 3 | won, round 11 | - | 2 | 21 min | 184k-247k, mean 219k |
| 22 | KDQZTY | 5 × Claude Haiku | on | 6th | -3 | 0 | 8 | Haiku Shen | 2 | 25 min | 196k-244k, mean 218k |
| 23 | KA6LZJ | 5 × Claude Haiku | on | **1st (won)** | +6 | 3 | won, round 11 | - | 1 | 26 min | 160k-269k, mean 207k |
| 24 | PGZSSX | 5 × Claude Sonnet | on | 3rd | +1 | 0 | alive at the end, round 17 | Sonnet Leona won | 0 | 26 min | 140k-383k, mean 241k |
| 25 | DECAAS | 5 × Claude Sonnet | on | 3rd | +1 | 0 | alive at the end, round 11 | Sonnet Shen won | 1 | 33 min | 209k-329k, mean 241k |
| 26 | DKVVF3 | 5 × Claude Opus | on | 5th | -2 | 0 | 5 | Opus Jinx | 1 | 11 min | 125k-174k, mean 150k |
| 27 | 6XTVBX | 5 × Claude Opus | on | 4th | -1 | 0 | 6 | Opus Thresh | 0 | 15 min | 123k-180k, mean 159k |

**By tier** (fog games 22-27 only):

| tier | baseline 3 (delove@10 + search, no fog) | baseline 4 (bare delove@12, fog on) |
| --- | --- | --- |
| Haiku | mean +3.0, place 3.0, 5 kills | mean +1.5, place 3.5, 3 kills |
| Sonnet | mean +2.5, place 3.0, 4 kills | mean +1.0, place 3.0, 0 kills |
| Opus | mean -3.0, place 6.0, 0 kills | mean -1.5, place 4.5, 0 kills |
| all six games | mean +0.83, place 4.0, 9 kills | mean +0.33, place 3.67, 3 kills |

- Fog cut the early gang-up. In baseline 3, two or three LLM seats hit Delove in rounds 1-2 of every game. Under fog
  it was 0-2 seats (mean 0.8), and two games had none. The LLM seats can't see a strong seat they don't border.
- Delove survives longer under fog but converts less. Its mean place is a little better (3.67 against 4.0), with two
  third places against Sonnet, but it scored only 3 kills, all in its one win. Against Sonnet and Opus it never
  eliminated a seat.
- Opus is still the hardest tier, though it improved from two last places to 5th and 4th. Haiku split: one last place
  and one win.
- Two games per tier, and two variables changed (the model, and search off under fog). Read this as the fog baseline
  for later models, not as delove@12 against delove@10. No fog-search set was played: on the self-play ladder the same
  night, determinized fog search scored below bare delove@12 under fog (-0.26, -0.92 and -0.56 at 2, 4 and 6 seats),
  so the next fog set waits for a stronger model.
- Opus seats used fewer tokens (mean 150k-159k) than Haiku and Sonnet (207k-241k), because Opus games ended sooner
  once Delove was out.

## Rerun it for a new model

Same lineup, settings and stop rule, so the new rows compare with the ones above. Runtime files go to
`$YARDSTICK_DIR` (default `~/risk-yardstick`), never into the repo.

1. Create the lobby and the five LLM seats (prints the game id and each seat's token):

   ```bash
   node packages/delove/scripts/yardstick/setup.mjs https://risky.deanthoneeking.com Sonnet my-label fog
   ```

   The last argument `fog` turns fog of war on, as in baseline 4, the setup to compare fog models against. Leave it
   out for the no-fog setup of baselines 1-3. It uses the fixed settings (capitals and 8 blizzards). For the pilot row's settings, create the room with
   `capitals: false, chooseCapitals: false, blizzards: 0` instead (a copy of the script with those three values).
   With `RISK_CHARACTERS_KEY` in the environment the room goes on the training board (#138); without it the room is
   public: it is ranked only when it finishes with Delove still in, since the monitor closes it when Delove is out.
2. Seat Delove (it waits for the start). Since #154 the seat searches by default; since #164 the default preset is
   `js2-range`, baseline 2's settings (`--preset measured` for #142's). Pin the ranker so a promotion mid-run doesn't change
   the model, and use `--agents delove@N` for the bare network. A fog game needs a ranker trained with fog inputs
   (`fogInputs`, delove@12 on); under fog the seat plays the ranker's top move unless `DELOVE_BRANCH_FOG=determinize`
   turns fog search on (baseline 4 ran without it):

   ```bash
   DELOVE_MODELS=<models folder> DELOVE_BRANCH_RANKER=delove@N npm run delove-seat -- --server https://risky.deanthoneeking.com --join <gameId> --preset js2-range --names "<Tier> Garen" --pace 400
   ```

3. Start one agent per LLM seat on the tier's model (Haiku, Sonnet, Opus, Fable), each with
   [`seat-prompt.md`](../packages/delove/scripts/yardstick/seat-prompt.md) filled in from step 1 (with its header's
   fog lines for a fog game). Don't tell the agents which seat is Delove.
4. Start the game with the host token (seat 1 from step 1):

   ```bash
   curl -X POST -H "Authorization: Bearer <host token>" https://risky.deanthoneeking.com/api/games/<gameId>/start
   ```

5. Run the monitor until it exits. It appends the result to `results.jsonl`, saves the event stream as
   `ev-<gameId>.json` and closes the room once Delove is out:

   ```bash
   node packages/delove/scripts/yardstick/monitor.mjs https://risky.deanthoneeking.com <gameId> "<Tier> Garen" my-label
   ```

   Let the agents stop by themselves (a closed room answers "not found") so each one reports its token use. Then add a
   row to the table above.
