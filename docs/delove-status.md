# Delove: status, strategy and coordination brief

**Read this first if you coordinate Delove's training.** It is the one place that says where Delove stands, what
the plan is, why we believe it works, what has been tried (with numbers), how the work is organised and what comes
next. The plan of record is `docs/delove.md`; the per-cycle tables are in `packages/delove/CYCLES.md`; how to run
things is in `packages/delove/README.md` and `packages/delove-gpu/README.md`. Keep this file current: update it in
the same PR as any change to the plan, the best model or the way training runs.

Last updated: 2026-10-20 (current best: `delove@3`; all-maps GPU path in PR #82).

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
2. **Every map, 2 to 10 players.** One general model for all maps (`MAP_IDS` in `packages/engine/src/maps.ts`:
   classic, world, world_large, europe, greater_europe, europe_classic, usa, asia, fantasy, skirmish, nine_realms). No per-map
   models unless one map later dominates live play.
3. **Strong one-on-one as well.** Every multiplayer game ends as a duel, and the 1v1 has been Delove's weakest spot.
4. **Fast iteration.** Training should run as much as possible on the training PC's GPU so we can try more ideas per
   day.

Fog of war is out of scope for now: the board encoder sees the whole board, so the seat player refuses fog games.
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

**Current best: `delove@3`.** It's a graph network over the map, hidden size 192, 6 message-passing rounds, about
2.4M parameters. The map's adjacency is an input, so one model plays every map. It scores every legal candidate
(policy) and predicts the outcome (value). It came from cycle 4: a fresh network trained on every branch-and-score
decision collected so far.

| model | how it was made | key results |
| --- | --- | --- |
| `delove-teacher@1` ("Sensei 1") | hand-coded heuristics (continents, cards, attack odds, border defence) | beats the built-in `risky@1` 0.94 (2p), 0.83 (4p), 0.955 (World) |
| `delove@1` | network (128 / 4 rounds, 808k params) copying Sensei 1, 20k games | 0.95 vs `risky@1`; even with Sensei 1 (0.525) |
| `delove-teacher@2` ("Sensei 2") | Sensei 1's 28 judgement numbers tuned by self-play evolution | 0.608 vs Sensei 1 over 1,000 two-player games (+76 Elo); even at 4-6p |
| `delove@2` | copying Sensei 2 (2p) + Sensei 1 (multiplayer), from `delove@1` | vs `delove@1`: 0.593 (2p), 0.555 (4p), 0.60 (6p) |
| **`delove@3`** | fresh larger net on branch-and-score decisions (cycle 4) | vs `delove@2`: **0.541** (2p, 800 games, 95% 0.513-0.569), **0.600** (4p), **0.610** (6p); 0.560 vs Sensei 2 |
| `jacob-sensei@1` ("Jacob Sensei", #98) | Sensei 2's numbers plus tunable terms from `AI/general-player/risk-learnings.md` (hunt weak players, late-game ramp, leader pressure), tuned with a self-play length penalty | 0 of 960 self-play games hit the turn limit (Sensei 2: up to 100% on big boards); vs Sensei 2: 0.521 Classic 2p, 0.504 World 2p (1,000 games each), 0.64-0.83 at 4-10p. Candidate rollout teacher (`DELOVE_BRANCH_TEACHER=jacob-sensei@1`); not on the GPU yet |

Chained, roughly: `delove@3` is about +95 Elo over `delove@1` at 2 players, +110 at 4 and +150 at 6. That's
about +600 Elo over the built-in bot at 2 players. The gains are largest in multiplayer, which used to be the weak spot.

Scores are win shares in mirrored ladder matches (0.5 = even). With 4 or 6 players it's the share of games won by
either of the candidate's seats. **Promotion rule:** at least 200 games, score at least 0.55 and the 95% interval
above 0.5, at 2 players. `delove@3` was promoted by the owner at 0.541 (statistically better everywhere, just under
the bar).

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

Things that did **not** help: learning from whole-game wins, the one-move value lookahead, blending the value head
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
- **How to get the speed:**
  - **Run many games at once.** The GPU steps all games in lockstep, and a step costs far less than in proportion
    to its games, so thousands of games in flight beat hundreds. Make GPU steps large, or run several steps' worth
    at once. `GPU_GB` sizes the batches (2,048 Greater Europe 10-player games fit in 1.44 GB).
  - **Long games are the tail.** Games running to the turn limit step alone at the end (384 of 400 Greater Europe
    games did). Fixing Sensei's stalling (section 9) speeds the GPU up as well as improving the data.
  - **The first run of a new map / table size / settings compiles for 40-60 s**, then it's cached in `_cache/`.
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

- Delove is separate from the character models and named `delove` everywhere, so it never collides with a
  collaborator's model.
- Train toward leaderboard points (placement plus kills), not wins.
- One general model for every map and 2-10 players. Per-map fine-tunes only later, if one map dominates.
- Move as much training as possible onto the GPU. Big maps on the GPU are a priority.
- `delove@3` promoted at 0.541 (just under the automatic 0.55 bar).
- Work happens in separate sessions with their own context; one coordinator; one reviewer.

## 8. Open work (as of 2026-10-20)

| what | who | state |
| --- | --- | --- |
| GPU rules, teacher and branch-and-score for every map, 2-10 seats and every setting; points arrays from the GPU; `cycle.sh` GPU steps for any step | session "GPU engine for every map and 2-10 players" | done, **PR #82** merged |
| Jacob Sensei, a teacher that doesn't stall (section 9 item 1) | session "Jacob Sensei" | **PR #98**; port to `delove_gpu/teacher.py` still to do |
| all-map strength data | coordinator | 147 of 296 chunks (about 5k games, 5 maps), stopped to free the machine; finish on the GPU |
| #39 tournament Earth map | other work | on hold (owner) |

## 9. What comes next, and why

In order. Each step has a measurable bar.

1. **Fix Sensei's stalling in big games first.** 384 of 400 Greater Europe 10-player games and about 15% of 4-player
   games hit the turn limit. A stalling rollout teacher teaches stalling, wastes the GPU's tail, and every stall now
   scores last place's points. Resume the Sensei 3 tuner (`runs/delove/tune/teacher3.json`, `src/tune.ts --from`
   with the stall penalty and `lateRound` / `lateRamp`) on a mix of 4-10 player tables and big maps, now
   affordable on the GPU (teacher-only games run 12-1,600x faster there). Bar: turn-limit games under ~2% at every
   table size, and no loss at 2 players against Sensei 2.
   **Bar met in self-play by Jacob Sensei (`jacob-sensei@1`, #98)**, a new teacher rather than a Sensei 3: 0 of 960
   self-play games hit the limit, and no loss at 2 players. Left: port it to the GPU mirror (`delove_gpu/teacher.py`,
   then add `src/jacob.ts` to `RULE_FILES` and re-run `verify.py`) so cycles can use it there; tables that seat
   Sensei 2 as an opponent still stall on big boards (Greater Europe 25-34%). Details: `packages/delove/README.md`.
2. **Points cycles on all maps, mostly on the GPU** (#82 merged). Branch and score on a mix of every map and 2-10 players, trained with
   `--value-target points`, gated by **mean leaderboard points** at 4-10 players (the ladder already reports them)
   and by win share at 2 players.
   *Why:* trains for what is ranked, on the maps that are played.
3. **A duel specialist and a table specialist, with a router.** From `delove@3`:
   - one network trained on 1v1 (Classic 2p, Four Crowns, and the endgames of multiplayer games once 2 players
     remain);
   - one on 3-10 players, trained on points;
   - a router picks by opponents still alive: one opponent → duel, more → table.
   *Why:* 1v1 is the weakest spot (+29 Elo vs +70-78 at 4-6p), and every multiplayer game ends as a duel. Bar: the
   routed pair beats `delove@3` at every table size.
4. **Turn-window credit.** Use the strength meter's change over short windows (e.g. turns 17 to 20, for me and for
   each opponent) as extra per-move credit in training.
   *Why:* long games become many short, clearly judged pieces. Make it potential-based (the change in strength), so
   it can't pull Delove away from playing to win.
5. **A stronger branch teacher.** Now affordable on the GPU:
   - more options per decision;
   - more dice copies;
   - Delove itself (not Sensei) playing the rollouts once the network is fast enough there;
   - resuming the Sensei 3 tuner for multiplayer (`runs/delove/tune/teacher3.json`; Sensei 2 stalls at 4+
     players, so stall penalties and a late-game aggression ramp were added).
   *Why:* the student is bounded by its teacher. Each step up in the teacher has been the step up in Delove.
6. **Merge the specialists into one network** (distil both into a single model) once both clearly win.
7. **Later:** a live "power bar" for spectators from the strength meter; per-map fine-tunes if one map dominates;
   fog of war (needs a seat-view encoder); seating Delove in character-league tables for direct comparison.
   Fog of war plan (seat-view encoder, fog dropout, determinized branch teacher, GPU, gates): `docs/delove-fog.md`.

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

