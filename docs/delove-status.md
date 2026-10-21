# Delove: status, strategy and coordination brief

**Read this first if you coordinate Delove's training.** It is the one place that says where Delove stands, what
the plan is, why we believe it works, what has been tried (with numbers), how the work is organised and what comes
next. The plan of record is `docs/delove.md`; the per-cycle tables are in `packages/delove/CYCLES.md`; how to run
things is in `packages/delove/README.md` and `packages/delove-gpu/README.md`. Keep this file current: update it in
the same PR as any change to the plan, the best model or the way training runs.

Last updated: 2026-10-20 (current best: `delove@6`; range specialist yardstick and library names added).

---

## 1. The goal

**Delove** is our own base model: a Risk player with **no personality**, trained only to play well. It has no
character, no chat, no diary and no relationships; it reads the board and picks a move. It is a separate path from
the character work (`packages/llm-player`, `packages/runner`, `AI/`), so the two can be compared on the same tables
later, and a character could one day use a Delove model as its move chooser.

What "good" means, decided by the owner:

1. **Strong where we are ranked.** The live leaderboard (`packages/engine/src/ranking.ts`,
   `docs/character-league.md`) scores **placement points plus 1 per kill**, not wins. Six seats: +3, +2, +1, -1, -2,
   -3, then +1 for every player you eliminate. A bot that places 2nd most of the time with kills is a good
   multiplayer bot. Training and gates should value what the leaderboard values.
2. **Every map, 2 to 10 players.** One general model for all maps (the base `delove@N`; the range specialists below
   are split by stage of the game, never by map) (`MAP_IDS` in `packages/engine/src/maps.ts`:
   classic, world, world_large, europe, greater_europe, europe_classic, usa, asia, fantasy, skirmish, bohemia,
   nine_realms). No per-map models unless one map later dominates live play.
3. **Strong one-on-one as well.** Every multiplayer game ends as a duel, and the 1v1 has been Delove's weakest spot.
4. **Fast iteration.** Training should run as much as possible on the training PC's GPU so we can try more ideas per
   day.

**Fog of war is a required milestone** (owner, 2026-10-20): tournaments run with fog on. Today the board encoder sees
the whole board, so the seat player refuses fog games; the plan is `docs/delove-fog.md` (section 9).

**The finished product** (owner, 2026-10-20): three separate specialist networks plus a "housing" that picks which one
plays each decision by the players still alive: **Long Range** (4+ alive: reach the last 3 with the most kills, the
most leaderboard points), **Mid Range** (3 alive: finish top 2 by making someone else the obvious target) and
**Close Range** (the 1v1: win it). The three stay **separate networks, never merged into one**; each is its own line
in the library (`delove-long-range@N`, `delove-mid-range@N`, `delove-close-range@N`, next to `delove@N`) and is always
compared with the base model on its own stage (section 3, "Range specialists: how they are compared"). The final
yardstick is Delove at tables with the Claude and ChatGPT characters on the live server, fog on, scored on
leaderboard points.
For testing parity with live Generation 5 play (including fog/no-fog matrix, blizzards, capitals, and card modes), see **[docs/game-settings.md](game-settings.md)** and config presets in `packages/delove/configs/`.

## 2. How the work is organised

The training PC (Windows 11, i7-14700F with 28 threads, 32 GB RAM, RTX 4060 8 GB) runs everything locally.

- **The coordinator** (one Claude session, the reader of this file): strategy, reading the numbers, choosing the
  next experiment, writing briefs, starting work sessions, checking their results against the repo, and telling the
  review session when a PR is ready. The coordinator keeps its own changes small (docs, configs) and delegates
  the real work.
- **Work sessions**: one task each, their own git worktree, branch and PR, so each builds its own context. Two
  sessions never edit the same files at once. Sessions that time things need a quiet machine: don't overlap
  heavy CPU/GPU jobs with a session that is measuring speed (three timing attempts on #80 were spoiled this way).
- **The review session** ("PR review and README updates", a cloud session): reviews and merges PRs into the deploy
  branch. Message it when a PR is ready. It cannot reply to other sessions; its answers show in its own chat.
- **Repo rules** (the hard rules in README.md, CONTRIBUTING.md): never push to the deploy branch `ccr-63b8112a-e2uk2g`; feature
  branch, PR, `npm test` green. Game rules live in `packages/engine` only. The one exception is
  `packages/delove-gpu`, a training-only mirror that must replay the engine exactly (section 6).

Where the training data lives (never in git):

| what | where |
| --- | --- |
| models (`delove@N`, candidates, tuned teachers) | `<training PC>\Projects\Risky-business-stage2\models\delove` (copies of the bests also in the main clone's `models\delove`, used by the live seat player) |
| exported training arrays | `<training PC>\Projects\Risky-business-stage2\data\delove` |
| game logs, cycle outputs, tuner state | `<training PC>\Projects\Risky-business-stage2\runs\delove` |
| Python with CUDA PyTorch | `<training PC>\Projects\Risky-business\.venv` (Python 3.12, torch 2.11 + cu128) |

`<training PC>` stands for the owner's user folder on the training PC; the real locations are on that machine (not
written here because the repo is public).

## 3. Where we are

**Current best: `delove@6`** (cycle 9, promoted 2026-10-20; published in the private models repo). It's a graph
network over the map, hidden size 192, 6 message-passing rounds, about 2.4M parameters. The map's adjacency and the
game settings are inputs, so one model plays every map and mode. It scores every legal candidate (policy) and predicts
the leaderboard outcome (value). Lineage: `delove@3` (cycle 4's fresh network) → `delove@4` (cycle 6: Jacob Sensei as
teacher, league settings) → `delove@5` (cycle 8: half the big boards on cloud GPUs) → `delove@6` (cycle 9: every game
on 10 cloud GPUs).

| model | how it was made | key results |
| --- | --- | --- |
| `delove-teacher@1` ("Sensei 1") | hand-coded heuristics (continents, cards, attack odds, border defence) | beats the built-in `risky@1` 0.94 (2p), 0.83 (4p), 0.955 (World) |
| `delove@1` | network (128 / 4 rounds, 808k params) copying Sensei 1, 20k games | 0.95 vs `risky@1`; even with Sensei 1 (0.525) |
| `delove-teacher@2` ("Sensei 2") | Sensei 1's 28 judgement numbers tuned by self-play evolution | 0.608 vs Sensei 1 over 1,000 two-player games (+76 Elo); even at 4-6p |
| `delove@2` | copying Sensei 2 (2p) + Sensei 1 (multiplayer), from `delove@1` | vs `delove@1`: 0.593 (2p), 0.555 (4p), 0.60 (6p) |
| **`delove@3`** | fresh larger net on branch-and-score decisions (cycle 4) | vs `delove@2`: **0.541** (2p, 800 games, 95% 0.513-0.569), **0.600** (4p), **0.610** (6p); 0.560 vs Sensei 2 |
| `jacob-sensei@1` ("Jacob Sensei", #98) | Sensei 2's numbers plus tunable terms from `AI/general-player/risk-learnings.md` (hunt weak players, late-game ramp, leader pressure), tuned with a self-play length penalty | 0 of 960 self-play games hit the turn limit (Sensei 2: up to 100% on big boards); vs Sensei 2: 0.521 Classic 2p, 0.504 World 2p (1,000 games each), 0.64-0.83 at 4-10p. **vs `delove@3`:** 0.440 Classic 2p, 0.575 Classic 4p, 0.735 World 6p, 0.76 Fantasy 6p, 0.82 World 10p (+0.5 to +1.2 points per seat at 4-10p). Cycle 6's teacher; on the GPU mirror since #110 (verified by replay). Published in the private models repo |
| **`delove@6`** | `delove@5` fine-tuned on cycle 9 (40,000 games on 10 rented GPUs, `delove@5` ranking) | vs `delove@5`: **0.529** at 2p (95% 0.501-0.558), **about +0.16 points per seat pooled over 9 multiplayer tables (+0.05 to +0.27)**, World 6p +0.63; 0.613 vs Sensei 2; 0.355 vs Jacob Sensei (World 6p) |
| `delove@5` | `delove@4` fine-tuned on cycle 8 (40,000 games, every map incl. Bohemia and Nine Realms, `delove@4` ranking the search) | vs `delove@4`: **about +0.27 points per seat pooled over 9 multiplayer tables (95% +0.15 to +0.39)**: Bohemia +0.81, Nine Realms +0.41, World 6p +0.35; even at 2p (0.507); 0.608 vs Sensei 2; 0.315 vs Jacob Sensei (World 6p) |
| `c7` range specialists (not promoted) | Long / Mid / Close Range fine-tuned from `delove@4` on cycles 5-6 split by players alive, routed | even with `delove@4` (2p 0.501, 4-10p even) |
| `delove@4` | `delove@3` fine-tuned on cycle 6 (30,000 games, every map 2-10p, league settings, Jacob Sensei teacher, search-weighted lessons) | vs `delove@3`: **0.532** (2p, 800 games, 95% 0.503-0.562; +0.20 points per seat), **0.728 / 0.645 / 0.698 at league settings** (+0.74 / +0.44 / +1.19 points per seat), 0.595 World 6p, even at default Classic 4-6p; 0.600 vs Sensei 2; 0.330 vs Jacob Sensei (World 6p) |
| `c5-candidate` (not promoted) | `delove@3` fine-tuned on cycle 5 (37,600 games on six maps, 2-10 players, points value target) | vs `delove@3`: 0.502 (2p, 800 games, 95% 0.475-0.530), even at 4-6p, **-0.57 / -0.55 points per seat at World 10p / 6p**; 0.574 vs Sensei 2. Why: 83% of its labels were Sensei 2's own move, weaker than `delove@3` in multiplayer (`CYCLES.md`) |

Chained, roughly: `delove@3` is about +95 Elo over `delove@1` at 2 players, +110 at 4 and +150 at 6. That's
about +600 Elo over the built-in bot at 2 players. The gains are largest in multiplayer, which used to be the weak spot.

Scores are win shares in mirrored ladder matches (0.5 = even). With 4 or 6 players it's the share of games won by
either of the candidate's seats. Since cycle 5 the gate table also reports mean leaderboard points per seat for each
side and their difference with a 95% interval.

**Promotion rule (owner, 2026-10-20):** ranking high in every match is what counts, so a candidate is promoted to
the next `delove@N` when it is clearly better on mean leaderboard points at 4-10 players (points-difference intervals
above 0 at most table sizes, none clearly below) and not significantly worse at 2 players (800+ mirrored games); or
when it is statistically better at 2 players and not worse on points. The coordinator promotes and publishes to the
private models repo (`DeAnthonee/delove-models`) without waiting. `delove@3` was promoted at 0.541 (2 players).

### Range specialists: how they are compared

Each specialist is measured against the **current base `delove@N` on its own stage**, never only in full games, with
the stage yardstick `npm run delove:stages` (`packages/delove/README.md`, "The yardstick"):

| specialist | start positions (fixed, seeded, reached by Jacob Sensei) | decides on | size of a call |
| --- | --- | --- | --- |
| Long Range | turn 1 of 6-10 player tables (Classic 6, World 6, Asia 8, World 10) | mean leaderboard points per seat (placement + kills); P(top 3) reported | 200 positions (400 games) |
| Mid Range | first turn with exactly 3 alive (Classic 4/5, World 4/6) | P(finish top 2) | 300 positions (600 games) |
| Close Range | first turn with exactly 2 alive, plus fresh duels | win rate | 400 positions (**800 mirrored games**, section 10) |
| routed trio | full games from the deal, Classic 2/4/6, World 6/10 | mean leaderboard points per seat | 200 positions (400 games) |

Every position is played twice with the seats swapped on the same seed; the specialist plays only while the game is
in its stage (the base plays the candidate's seats outside it). Results are the candidate's and the base's metric and
their difference with a 95% interval over positions. Keep the seed, tables and settings the same across a line's
comparisons and record them with the result.

**Promotion rule for a specialist** (owner, 2026-10-20): a specialist becomes the next `@N` of its line
(`delove-long-range@N`, `delove-mid-range@N`, `delove-close-range@N`) when it is **statistically better than the
current base `delove@N` on its own stage metric** (the difference's 95% interval above 0) **and the routed trio
(the new specialist with the current best of the other two lines) is not worse than the base on full-game points**
(the interval not below 0). The coordinator publishes it to the private models repo next to `delove@N`, with a
`delove-range@N.json` routes file for the new trio (models repo README, "The range specialists").

**Each specialist is its own line** (owner, 2026-10-21): a specialist improves on *itself*, never restarts as a copy
of the newest base. `delove-<range>-range@1` is fine-tuned from the base of its day (`delove@6` for the first lines);
every later candidate starts from the **current best of its own line** (`--init delove-<range>-range@N.pt`) and trains
on the newest shared pool of games. What a new base learns still reaches the specialists through those games (the
base generates and ranks them), not through its weights. The bar stays the current base on the specialist's stage,
so a line that stops beating new bases shows up at its next comparison; re-seeding a line from a new base is a
deliberate owner decision, recorded here, never a default step of a cycle.

## 4. The training flow, and why we think each part works

A **cycle** turns "a stronger teacher" into "a stronger student", then makes the student the next teacher's
helper. One cycle, as `packages/delove/scripts/cycle.sh` runs it:

### Step 1: micro games (1v1 on Four Crowns, the 24-territory `skirmish` map)
Short games, about 18 turns, so every decision weighs more in the result.
**Why:** credit assignment. In a 150-move game, the final result says almost nothing about any one move. Short games
make each move's effect visible, and the skills (battle odds, card timing, chokepoints) carry over because the
network reads the map as an input.

### Step 2-3: scenario games (Classic, 2 and 4 players; more maps next)
Real positions at every decision, against Sensei 2, the current best and `risky@1`.
**Why:** the student has to learn from the positions it will actually meet, at the table sizes it will play.

### The player in those games: branch and score (`delove-branch@1`, `src/branch.ts`)
At each important decision, the options are Sensei 2's move plus the network's next favourites (3 in total). Each
option is played on copies of the board:
- 6 copies per option, each with its own dice and deck order;
- the *same* copies for every option (common random numbers), so the only difference between branches is the
  decision itself;
- each copy plays 1 round forward (cycles 3-4; 2 before) with Sensei 2 in every seat.

Each copy is then scored from the decider's side: won 1, lost or eliminated 0, otherwise its share against the
players still alive of armies (0.3), income (0.3), territories (0.15), cards (0.15) and continents (0.1). The best
option is played if it beats Sensei's own move by at least 0.01.
**Why:** this is the owner's "split the game at each decision and see which path did better" idea. Comparing
branches on the same dice removes most of the luck, and it judges the move, not the whole game. It produces a
teacher stronger than any single bot: it beats `delove@2` 0.56-0.57 at 2 players over 2,000 games, and won 70% of
4-player tables in cycle 1.

### Step 4: train
The network learns the branch player's choices (policy) and the game results (value), starting from the current
best (or fresh, when the network grows), on this cycle's data plus earlier cycles'. Sensei 2's 2-player games are
added as an anchor.
**Why:** distillation. The student copies a stronger teacher, then plays without the slow search.

### Step 5: ladder gate
The candidate plays the current best (800 two-player games, 200 at 4 and 6 players, 200 on Four Crowns), plus
Sensei 2 and older versions. It's promoted only under the rule in section 3.
**Why:** noise. A 96-game result once read 0.688 and then measured 0.530 over 2,000 games. Only large mirrored
matches decide.

### Then repeat
The new best ranks the branch options next cycle, so each cycle's teacher starts from a stronger network.

## 5. What we tried, what it showed

Full tables: `packages/delove/CYCLES.md`. Summary, oldest first:

| round / cycle | idea | games | result vs best | lesson |
| --- | --- | --- | --- | --- |
| Stage 0-1 | hand-coded Sensei, then copy it | 20k | `delove@1` = Sensei level | copying works |
| round 2 | self-play, learn mostly from winners | 22k | even (0.465 2p) | a whole game's result is too noisy per move |
| round 3 | 1-move value lookahead + advantage weighting | 3k tests | even (0.49-0.52) | the value head isn't sharp enough to search with |
| round 4 | pure self-play with advantage weighting | 30k | even (0.473) | self-play alone plateaus at our scale |
| tuning | evolve Sensei's 28 numbers through self-play | ~85k | Sensei 2: +76 Elo | **a stronger teacher is the lever** |
| round 5 | copy Sensei 2 | 10k + 10k | **`delove@2`** (+65 Elo) | ✓ |
| cycle 1 | branch and score as teacher | 5.2k, 9.2M sims | 2p even, 4-6p +45-67 | branching works, strongest in multiplayer |
| speedups (#71) | faster engine state copy, cheaper branching, `cycle.sh` | | cycle 90 min → 20 min | engine moves identical (57 recorded games) |
| cycle 2 | all branch data | 5.6k | 2p even, 4-6p +53-58 | |
| branch tests | value blend, horizon, margin (2,000 games each) | 12k | horizon 1 as strong as 2 at half the cost; horizon 3 worse; value blend no help | **short horizons beat long ones** (Sensei's mistakes pile up in long rollouts) |
| cycle 3 | horizon 1, 4x the 2-player data | 7.8k | 2p 0.525 | the student matched the teacher only 62-71% of the time |
| cycle 4 | fresh, larger network | 7.8k | **`delove@3`** | **network size was the 2-player bottleneck** |
| strength meter (#79) | fit share weights to final points (4.7k games, 5 maps) | | hand weights order players best (58% vs 56%) | share-based meters top out around 65%; richer signals needed |
| cycle 9 | cycle 8's recipe one step on (`delove@5` ranking), every game on 10 cloud GPUs, the faster big-table search | 40k, 46 turn-limit | **`delove@6`**: 2p 0.529, +0.16 points per seat pooled at 4-10p | **steady compounding**: each new model ranking the next cycle's search adds a little; 1 h 33 min a cycle with the cloud |
| cycle 8 | `delove@4` as ranker, Jacob Sensei, league settings, Bohemia and Nine Realms; small boards at home on 4 GPU lanes, huge boards on 8 rented RTX 4090s | 40k, 34 turn-limit | **`delove@5`**: +0.27 points per seat pooled at 4-10p, even at 2p | **new lessons beat re-splitting old ones**; the cloud played 7,500 huge-board games in 33 min for $5.45, bit-identical to home |
| cycle 7 | range specialists (Long / Mid / Close Range) fine-tuned from `delove@4` on cycles 5-6 split by players alive, routed in one player | 0 new | even with `delove@4` (2p 0.501; +0.53 points at one league table) | **a split of the same lessons teaches little new**: specialists need phase-specific lessons |
| cycle 6 | Jacob Sensei teacher, league settings, search-weighted lessons, cycle 5 as value-only data, AMP, 2 GPU lanes | 30k, 47.5M sims | **`delove@4`**: 2p 0.532, **league settings 0.65-0.73 (+0.4 to +1.2 points per seat)** | **train on the settings that are played**: the defaults-only cycles had a blind spot. 6.7 h: the 10-player huge boards took 5.9 h of generation |
| cycle 5 | all maps 2-10p, mostly on the GPU (37.6k games, 70M sims), points value target, from `delove@3` | 37.6k | 2p 0.502, 4-6p even, **World -0.55 points per seat** | **83% of branch labels are the teacher's own move**: with Sensei 2 weaker than the student in multiplayer, more data copied a weaker player. The branch player itself won ~3x its share at big tables |
| Jacob Sensei (#98) | learnings-based teacher, tuned with a length/stall penalty | ~100k | vs `delove@3` 0.58-0.82 at 4-10p, 0.44 at 2p; never stalls | a plain head-to-head fitness rewarded sitting back; penalise slow games when tuning |

Things that did **not** help: copying the teacher's unsearched moves when the teacher is weaker than the student
(cycle 5), learning from whole-game wins, the one-move value lookahead, blending the value head
into branch scores (no gain, 60% slower), 3-round rollouts, fitted share weights, and more cards or continents on
their own. Each of these alone predicts a slightly *worse* finish.

## 6. Infrastructure

**Packages.** `packages/delove` holds the teacher, network player, branch player, tuner, seat player, trainer and
cycle scripts. `packages/delove-gpu` is the GPU mirror. `packages/selfplay` is the headless harness, ladder and
exporter. None of them is imported by the server or the character code.

**Self-play log format v3** (#79):
- every game records each seat's placement, kills and leaderboard points (engine `finalPlacements` / `gamePoints`,
  the same functions the server ranks with);
- a turn-limit game gives every seat last place's points, so stalling never pays;
- `export` writes `points.npy` and `points01.npy`, and `train.py --value-target points` trains on them;
- ladder results report mean points, placement and kills per game.

**The GPU mirror** (`packages/delove-gpu`, #72/#73/#76/#77/#80):
- **What it is:** a PyTorch/CUDA copy of the rules, the teacher and branch-and-score that plays thousands of games
  at once. It's verified step for step against the TypeScript engine by replaying logged games: board, cards,
  phase, legal moves and the teacher's choices must all match.
- **Coverage** (#82): every map, 2-10 seats and every setting except fog of war, with branch, teacher and network
  seats. It mirrors #79's leaderboard points (elimination order, `finalPlacements`, `gamePoints`), and `generate.py`
  writes `points.npy` / `points01.npy` bit-identical to `export`. Verified with 0 mismatches over 3,895,342 replay
  steps. Not on the GPU: fog of war, `risky@1` and `-explore` seats in `generate.py`, and `DELOVE_BRANCH_VALUE`.
- **Speed of a branch-and-score cycle step, games to training arrays** (RTX 4060 vs 27 CPU processes, warm
  kernels, `delove@3` ranking, horizon 1):

  | step | games | CPU | GPU | speedup |
  | --- | --- | --- | --- | --- |
  | Four Crowns micro, 1v1 | 1,200 | 45 s | 17 s | 2.6x |
  | Classic 2-player | 3,000 | 223 s | 68 s | 3.3x |
  | Classic 4-player | 600 | 325 s | 186 s | 1.7x |
  | Greater Europe 10-player, 512 games at once | 400 | 0.066 games/s | 0.31 games/s | 4.7x |
  | **Greater Europe 10-player, 2,048 games at once** | 2,048 | 0.066 games/s | **1.06 games/s** | **16x** |

  Teacher-only games run 12-1,600x faster; random play 384x.
- **Big tables since the lane groups** (#117, `packages/delove-gpu` README, "Big tables: lane groups"): a rollout copy is
  played by 16 GPU lanes that score its candidate moves in parallel, with the same moves bit for bit. Cycle 6's tables
  run 2.6x (Classic 4-player) to 5.1x (Grand World 10-player) faster. Fewer rollouts or options save only 16-28% of
  the rollout time but change 4-14% of the branched moves, so the defaults stay.
- **How to get the speed:**
  - **Run many games at once.** The GPU steps all games in lockstep, and a step costs far less than in proportion
    to its games, so thousands of games in flight beat hundreds. Make GPU steps large, or run several steps' worth
    at once. `GPU_GB` sizes the batches (2,048 Greater Europe 10-player games fit in 1.44 GB).
  - **Long games are the tail.** Games running to the turn limit step alone at the end (384 of 400 Greater Europe
    games did). Fixing Sensei's stalling (section 9) speeds the GPU up as well as improving the data.
  - **The first run of a new map / table size / settings compiles for 40-60 s**, then it's cached in `_cache/`.
  - **Rented GPUs:** `REMOTE_GPUS=N` plays a cycle's GPU steps on N RunPod GPUs (`packages/delove-gpu/cloud/`,
    "Cloud workers" in its README): split by configuration, merged back into the same data, pods always terminated,
    a hard GPU-hour cap. The floor is the slowest configuration (Greater Europe 6p: 47 minutes on the 4060).
  - **`cycle.sh` runs GPU steps alongside the CPU pool:** `gpu_steps=(...)` in the config (or `all`), overridden by
    `GPU_STEPS`. Give the GPU the big-map and Classic 2-player steps; let the CPU keep small ones if both are busy.
- **The rule:** whenever `packages/engine` or the self-play files it mirrors change, re-run
  `python packages/delove-gpu/verify.py --models <dir>`. Until then CI warns and the GPU tools refuse to run
  (`engine-fingerprint.json`).
- **Why it matters:** a cycle is mostly simulation. More games per hour means more training data, a branch search
  that can afford more options, and big maps / 10-player tables become practical. On the CPU, Greater Europe with
  8 players crawled.

**Running a cycle:**
```bash
DELOVE_BRANCH_RANKER=<best> DELOVE_BRANCH_HORIZON=1 DELOVE_BRANCH_MARGIN=0.01 \
  PYTHON="<training PC>/Projects/Risky-business/.venv/Scripts/python" \
  bash packages/delove/scripts/cycle.sh packages/delove/scripts/cycles/<cN>.cycle
```
A cycle config names its steps (jobs files), the training data mix and the gates. Re-running resumes. Output goes
to `runs/delove/<name>/cycle.md`.
- **The CPU path:** about 17-20 minutes on 27 threads (45 with a fresh large network).
- **The GPU path:** `gpu_steps=(classic2 ...)` or `gpu_steps=(all)` in the config (#77/#80/#82); any step, any map.
  Before the first GPU cycle after any engine or self-play change, run `verify.py --models <dir>`.
- **Training on points:** add `--value-target points` to the config's `train_args`; gate multiplayer on the ladder's
  mean points.

**Live games & benchmarking:**
```bash
npm run delove-seat -- --server https://risky.deanthoneeking.com --join <CODE> --agents delove@3,delove-teacher@2 --names "Delove@3,Sensei@2"
```
Fog of war off (enforced by `delove-seat`); one seat per agent. For full environment parity options (random fog 50/50, blizzards, capitals, progressive/fixed/exponential cards), see **[docs/game-settings.md](game-settings.md)**.

## 7. Decisions made by the owner

- The finished product is three separate specialists plus a housing that routes by players alive; fog of war is
  required (2026-10-20).
- Cloud split (2026-10-20): games on about 10 rented RunPod pods, training and gates on the home PC. Cloud training
  (#129's `REMOTE_TRAIN` with a network volume) was declined as not worth it (about 10 minutes saved a cycle); it stays
  merged but off.
- Promotions: better on multiplayer leaderboard points and not worse at 2 players; the coordinator promotes and
  publishes to the private models repo (`DeAnthonee/delove-models`). Cloud GPUs up to about $20/day.
- Delove is separate from the character models and named `delove` everywhere, so it never collides with a
  collaborator's model.
- Train toward leaderboard points (placement plus kills), not wins.
- One general model for every map and 2-10 players. Per-map fine-tunes only later, if one map dominates.
- The range specialists are three separate networks plus a router, never merged into one; each is its own line
  (`delove-long-range@N`, `delove-mid-range@N`, `delove-close-range@N`) next to `delove@N` in the private models
  repo, and each is compared with the base on its own stage (section 3) (2026-10-20).
- Move as much training as possible onto the GPU. Big maps on the GPU are a priority.
- `delove@3` promoted at 0.541 (just under the automatic 0.55 bar).
- Work happens in separate sessions with their own context; one coordinator; one reviewer.

## 8. Open work (as of 2026-10-20)

| what | who | state |
| --- | --- | --- |
| GPU rules, teacher and branch-and-score for every map, 2-10 seats and every setting; points arrays from the GPU; `cycle.sh` GPU steps for any step | session "GPU engine for every map and 2-10 players" | done, **PR #82** merged |
| cycle 5: all maps 2-10p on the GPU, points target; gate table with points; live dashboard (`scripts/dashboard.mjs`); `train.py --amp` and `#F` fractions | coordinator | done, not promoted (section 3); PR #105 |
| Jacob Sensei on the GPU mirror (teacher kernel, per-seat teacher versions, verified by replay) | session "Port Jacob Sensei to the GPU mirror" | done, **PR #110**: 0 mismatches (verify.py on the pre-Bohemia engine, fingerprint at `da9ec34`; matrix `jacob` suite 118/118) |
| cycle 6: Jacob Sensei as teacher, league settings, branch-tag weighted training (`branch_tag.npy`, `--branch-weights`), cycle 5 big tables as value-only data, `GPU_LANES=N` | coordinator | done: **`delove@4`** (section 3); this PR |
| faster big-table branch search on the GPU (lane groups: each rollout copy on 16 lanes, the main games' teacher seats on 8) | session "Faster big-table branch search on the GPU" | done, **PR #117**: cycle 6's tables 2.6-5.1x faster, same games bit for bit (matrix branch and jacob suites replayed identical) |
| a full `verify.py --models` run that covers #117's `teacher.py` / `branch.py` (the fingerprint hashes only the TS rule files, so it does not flag mirror changes) | session "Verify the GPU mirror after #117" | closed without a run (2026-10-20): verify.py replays through `k_teacher` (1 lane) and `k_branch_sim` (16 lanes), and #117 already replayed verify.py's matrix suites on its own code (jacob 128/128, branch 18/18 with points and kills); `k_teacher_run`'s 8 lanes run only in `generate.py`, which no verify.py step replays, and rest on #117's before/after runs (7 cycle 6 tables, same games and stream hashes). The fingerprint hashes still match; see the delove-gpu README, "Big tables: lane groups" |
| cloud GPU workers (RunPod; cycle steps split by cost over N rented GPUs, merged back) | sessions "Cloud GPU workers", "Guided RunPod setup" | done: #115, fixes #118 #121 #125 #126; first test bit-identical; cycle 8 played its huge boards on 8 RTX 4090s (7,500 games, 33 min, $5.45). 4 processes on one 4090 give only 1.4x: scale with more single-process pods (10 is the sweet spot, about $7 a cycle) |
| points-aware branch score (kills and placement in the rollout score, opt-in), mirrored and verified on the GPU | session "Points-aware branch score" | done in #112, opt-in (`DELOVE_BRANCH_SCORE=points\|kills`): points loses at 4p (-0.51 ± 0.39 points/game, World), kills no different (Classic 4p), 2p no different; cycle 7 keeps share |
| cycle 8: `delove@4` ranker, Bohemia and Nine Realms, part A at home (4 GPU lanes) and part B on the cloud; `cycle.sh GENERATE_ONLY` | coordinator | done: **`delove@5`** (section 3); PR #127 |
| cycle 9: every game on 10 cloud GPUs (`REMOTE_GPUS=10`), training and gates at home | coordinator | done: **`delove@6`** (section 3); PR #131 |
| range specialists (4+ alive / 3 alive / 1v1, routed by players alive) | coordinator | tooling in **#114**; stage yardstick (`npm run delove:stages`: fixed start positions per stage, specialist vs base, the routed trio in full games, 95% intervals) and the library names in this PR; **cycle 7** trained Delove Long / Mid / Close Range from `delove@4` on cycles 5-6 split by players alive: the routed trio is even with `delove@4` (2p 0.501, 4-10p even, +0.53 points at league Classic 6p only), not promoted. Next try needs different lessons per phase (more 3-player endgames, a duel-focused search), not a split of the same ones; **cycle 7**trained Delove Long / Mid / Close Range from `delove@4` on cycles 5-6 split by players alive: the routed trio is even with `delove@4` (2p 0.501, 4-10p even, +0.53 points at league Classic 6p only), not promoted. Next try needs different lessons per phase (more 3-player endgames, a duel-focused search), not a split of the same ones |
| range objectives: each specialist its own value target and credit from the same pool (`train.py --range long\|mid\|close`, `python/targets.py`; `placement.npy` / `kills.npy` from `delove_gpu.generate`) | session "Range objectives" | built (this PR), smoke-trained only: ~600 steps from `delove@5` on cycle 8 Classic, the target alone (same batches) changes 3.0 / 3.0 / 3.7% of top moves on each range's own positions vs a cycle-7-style control (Mid's seed-to-seed noise: 4.3%), so the policy effect is unproven until a full train and gates; the estimated top 2 for exports without `placement.npy` matched the exact one on 97.6-98.7% of 3-alive decisions (Classic 6p, World 5p) |
| stage games for Mid / Close Range (section 9 item 2): games recorded only from 3 or 2 players alive | session "Stage-focused data" | built (**#137**): `LEAD>STAGE` tables (a lead-in to N alive, then the stage agents; `packages/delove/scripts/stage/mid.jobs`, `close.jobs`) and `pos:FILE>...` from game-record positions (`npm run selfplay -- positions`), on the CPU and the GPU, identical (`tests/stage_check.py`, in `verify.py`). Home 4060: about 25k 3-alive and 39k 2-alive games an hour, about 75 recorded decisions each. Not yet trained on |
| Jacob Sensei, a teacher that doesn't stall (section 9 item 1) | session "Jacob Sensei" | done, **PR #98** merged; GPU port (`delove_gpu/teacher.py`) done in **#110** (closes #99) |
| all-map strength data | coordinator | 147 of 296 chunks (about 5k games, 5 maps), stopped to free the machine; finish on the GPU |
| #39 tournament Earth map | other work | on hold (owner) |
| re-verify the GPU fingerprint for the new `bohemia` (#100) and `nine_realms` (#102) maps | session "Points-aware branch score" | done in **#112** (4,764,579 steps identical; covers both maps, Jacob and the new branch scores) |

## 9. What comes next, and why

The owner's target (section 1): three separate specialists plus a housing that routes by players alive, strong at
tables with LLM characters, with fog of war on. In order:

1. **A stronger teacher.** Every real jump came from a stronger teacher (Sensei 2, Jacob Sensei with search) or a
   bigger network (cycle 4); more of the same games (cycle 5) or the same games re-split (cycle 7) did not. Jacob
   Sensei still beats `delove@5` 0.69 at World 6p. Next: Delove itself playing the branch rollouts instead of the
   hand-coded teacher, more options per decision and more dice copies, affordable now on cloud GPUs (`REMOTE_GPUS`).
   Bar: the new branch player beats Jacob-rollout branch play at 4-10 players on points.
2. **Stage-focused games for the specialists.** Generate positions where 3 players or 2 players remain (from
   cycle games and from saved game records, which can start a game from a position), so Mid Range and Close Range
   learn from lessons aimed at their stage, not a slice of the old ones (cycle 7's lesson). Test each specialist on
   its own stage, then the routed trio in full games against the single best model, on points
   (`npm run delove:stages`, section 3).
   **Each specialist now has its own objective** (`train.py --range`, packages/delove/README.md "Range specialists"):
   Long Range learns leaderboard points, Mid Range finishing top 2 plus a threat credit (the strongest rival's armies
   facing the third player, not us), Close Range the sole win; each copies most the moves that went better than its
   own value expected for *its* target (range credit), so the same games teach three different lessons. Cycle 7's
   specialists all learned points with plain copying.
   **Stage games** (#137) give Mid and Close Range more lessons from their own stage: stage tables
   (`packages/delove-gpu` README, "Stage games"; `scripts/stage/mid.jobs` and `close.jobs`, 4,300 games each,
   cycle 8's maps and table sizes, league settings). Next: a cycle that generates them and trains Mid / Close Range
   on them plus the old split. Watch the stage length: after a Jacob Sensei lead-in the 3-alive part lasts 7 turns
   (median; 2-alive: 4), as one player has usually run away by then; if the specialists need closer positions,
   filter positions by balance (as the yardstick's capture does) or add lead-ins by stronger, more even seats.
   **Ratio scenarios** (#PR) are the closer positions: synthetic boards where 2 survivors hold the board 50/50,
   60/40, 40/60, 70/30 or 30/70, or 3 hold it 34/33/33 or a turn order of 50/25/25, 40/40/20, 60/20/20, as contiguous
   regions with armies, turn, trades and hands drawn from real stage starts (`scripts/stage/split-close.jobs` and
   `split-mid.jobs`, about 10,000 games a ratio on the 6-10 seat tables, branch player vs `delove@6`). Drawn from the
   game seed, they run on the cloud pods. Train on them mixed with the real stage games, not instead of them.
3. **Fog of war, started early, in parallel** (`docs/delove-fog.md`): fog dropout first (train on normal games with the
   unseen territories blanked out, so Delove stops leaning on information a fogged player lacks), then the seat-view
   encoder, a determinized branch teacher and fog gates.
4. **The real yardstick.** Seat Delove at live tables with the Claude and ChatGPT characters (fog on once item 3
   lands), and track its leaderboard points per game. Started 2026-10-21 with Claude subagent seats
   ([delove-yardstick.md](delove-yardstick.md)): with capitals and blizzards on, `delove@6` averaged -1.0 points against
   Sonnet (3 games) and -2.5 against Opus (2 games), knocked out by round 3-9 with no kills; 2nd against Haiku in a
   pilot without capitals or blizzards. Rerun the same lineup for every new model.
5. **Faster cycles** (no strength change): the faster big-table search (#117, 2.5-5x, merged), 10 cloud pods for a
   whole cycle's generation (about 47 minutes, about $7), and a training pod fed directly by the generation pods
   through a RunPod network volume (`REMOTE_TRAIN=1`, built, not yet run for pay: about 10 minutes and $0.40-0.50 a
   cycle, plus about $3.50 a month of volume; packages/delove-gpu README "Cloud training"). Budget: about $20/day.
6. **Later:** turn-window credit (the strength meter's change over short windows as extra per-move credit); a live
   "power bar" for spectators.

## 10. Pitfalls we hit (don't repeat them)

- **Small matches lie.** Use at least 800 two-player games for a promotion call, and both seat orders on the same
  seeds.
- **Sensei 2 stalls at 4+ players.** About 15% of its 4-player self-play games hit the turn limit; its tuning only
  ever saw 2- and 4-player tables capped at 300 turns. Check turn-limit counts in every step table.
- **Overlapping heavy jobs** wreck timings and slow everything. One heavy CPU/GPU job at a time when measuring.
- **Chunk sizes:** a few big chunks leave most threads idle. `cycle.sh` sizes chunks automatically; for
  `generate.sh` set `CHUNK`.
- **Shell quoting:** job lines carrying JSON options must not go through `xargs` word-splitting (`generate.sh`
  passes them NUL-separated).
- **Windows line endings:** a CRLF checkout broke a server test; `.gitattributes` keeps files LF.
- **Changing defaults:** keep the behaviour lock green. `scripts/golden.mjs` records 57 seeded games; pin old
  settings to compare.
- **Mirrors go stale:** every engine or self-play change needs `delove-gpu/verify.py` re-run.
- **Deleting data:** never `rm -rf` a folder that may hold a Windows junction into another worktree's data; remove
  junctions with `cmd /c rmdir`.
- **Don't start from scratch on a small dataset.** Fresh networks need every branch decision collected so far
  (cycle 4 used about 6M).

## 11. Glossary

- **Sensei 1 / 2:** the hand-coded teachers `delove-teacher@1` / `delove-teacher@2`.
- **Jacob Sensei:** the hand-coded teacher for big tables, `jacob-sensei@1` (`src/jacob.ts`, #98).
- **Branch and score:** the decision-by-decision search player (`delove-branch@1`).
- **Candidate:** a trained model awaiting its ladder gate (`rNN-candidate`, `cN-candidate`). Only promoted models
  get the next `delove@N`.
- **Ladder / gate:** mirrored-seed matches between two versions (`npm run delove -- ladder`).
- **Points:** leaderboard points, placement points plus kills (`gamePoints`).
- **Score:** win share in a ladder match (0.5 = even).
- **Elo:** a strength difference; +35 ≈ 0.55, +70 ≈ 0.60.
- **GPU mirror:** `packages/delove-gpu`, verified against the engine by replay.

## 12. Starting a coordinator session

Once #82 has merged, start a new chat with:

> You're the Delove training coordinator. Read `docs/delove-status.md` first, then `packages/delove/CYCLES.md` and
> `packages/delove-gpu/README.md`. Goal: the strongest possible Delove on leaderboard points, on every map and 2-10
> players, using the GPU as much as possible. Start by fixing Sensei's stalling in big games, then run training
> cycles on all maps with the points target, each step on whichever of GPU or CPU runs it faster. Do the heavy work
> in separate sessions, report each cycle's stats table, and promote only through the ladder gate.

Its first job is writing the all-maps points cycle config: all maps, 2-10 players, big GPU steps,
`--value-target points`, and gates on mean points at 4-10 players and win share at 2.

