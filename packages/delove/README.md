# @risk/delove

**Delove**, our base model: a Risk player with no personality, trained only to win. The plan is in
[docs/delove.md](../../docs/delove.md). This package is never imported by the game server or the character code
(`llm-player`, `runner`, `AI/`); it plugs into the self-play harness (`packages/selfplay`) as player versions.

Everything here is named `delove` (`delove-teacher@1`, `delove@1`, ...) so it never collides with a collaborator's
model on the ladder.

## Run

```bash
npm ci && npm run build
npm run delove -- agents                       # risky@1, random@1, delove-teacher@1, delove@N, delove@N-explore
npm run delove -- ladder --best risky@1 --candidate delove-teacher@1 --games 200
```

`npm run delove` is the self-play CLI (every `play` / `ladder` / `export` option works) with Delove's players
registered first (`node --import ./packages/delove/dist/register.js`): the teacher, and every
`models/delove/delove@N.onnx` (or `DELOVE_MODELS=<dir>`) as `delove@N` (plays its top move) and `delove@N-explore`
(samples, temperature `DELOVE_TEMPERATURE`, default 1, for training games).

## Play in a real game

`npm run delove-seat` seats Delove versions in a real game through the server's HTTP API (the same client the MCP
uses). It doesn't chat and has no character: it waits for its turn, rebuilds the board from its seat's view, picks a
move like in self-play and sends it.

```bash
# join a game someone created (the host starts it); one seat per version
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123 --agents delove@3,delove-teacher@2
# or create one: Delove hosts, adds 2 built-in bots and starts; watch it at <server>/?game=<code>
npm run delove-seat -- --server http://localhost:8080 --create --agents delove@1,delove-teacher@1 --bots 2
```

`--pace 400` (ms between moves, so spectators can follow), `--names "A,B"`, `--options '{"capitals":true}'`,
`--no-start`. Fog of war games are refused for now: Delove was trained on the full board.
`--agents` takes `delove-teacher@1`, every tuned teacher in the models folder (`delove-teacher@N.json`, e.g.
`delove-teacher@2`), and every `delove@N.onnx`. `sensei` / `sensei@1` and `sensei@2` are aliases for the two teachers,
and their seats are named "Sensei 1" and "Sensei 2" unless `--names` says otherwise (#88). `jacob-sensei@1` (alias `jacob`)
sits as "Jacob Sensei".

The seat rebuilds the board from its view (`stateFromView`): each opponent's hand gets its real size (`cardCount`),
the deck and discard theirs, dealt at random from the cards the seat can't see. Before #143 the rebuilt board gave
every opponent an empty hand, so the network and Jacob Sensei read every opponent's card count as 0 in live games
(training saw the real counts).

**Search at play time** (`--agents delove-branch`, seat name "Delove Search"): the seat plays branch and score
(`src/branch.ts`, the same player that makes the training data) instead of the bare network: at each important
decision it tries the network's favourites on copies of the board and keeps the best. It is configured by the same
`DELOVE_BRANCH_*` variables as self-play (`src/branch-env.ts`); for live tables use the cycle settings with more
options (#141 measured 4-5 options at +0.23 / +0.28 points per game over 3):

```bash
DELOVE_BRANCH_RANKER=delove@6 DELOVE_BRANCH_TEACHER=jacob-sensei@1 DELOVE_BRANCH_OPTIONS=5 DELOVE_BRANCH_HORIZON=1 \
  DELOVE_BRANCH_MARGIN=0.01 npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123 --agents delove-branch
```

Every strong game AI searches when it plays (AlphaGo, Pluribus, Cicero); in Delove's own cycles the branch player
wins several times its seat share at the big tables where the network it trains still trails Jacob Sensei. It
thinks for longer per move (rollouts on the CPU), which matters little at tables with language-model seats.

### Generation 5 Testing & Environment Parity

To evaluate Delove models on the exact game options used in Generation 5 live league play, see [`docs/game-settings.md`](../../docs/game-settings.md) and pre-built configs in `packages/delove/configs/`:

- `packages/delove/configs/gen5-nofog.json` (baseline Gen 5 options with `fogOfWar: false`)
- `packages/delove/configs/gen5-randomfog.json` (standard league options with `fogOfWar: true`)
- `packages/delove/configs/gen5-fixedcards.json` (options with fixed card trade values)

## Train a version (Stage 1: learn from the teacher)

One-time Python setup (Windows, from the repo root; `.venv/` is ignored):

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/python -m pip install -r packages/delove/python/requirements.txt
```

Then, with `runs/`, `data/` and `models/` all ignored by git:

```bash
# 1. 20,000 teacher games over 20 processes (about 1 minute)
for i in $(seq 0 19); do npm run delove -- play --agents delove-teacher@1,delove-teacher@1 --games 1000   --start $((i*1000)) --seed 101 --log runs/delove/teacher-01/p$i & done; wait
# 2. training arrays (about 4 minutes, 33 GB for 5.8M decisions)
npm run delove -- export --log $(ls -d runs/delove/teacher-01/p* | sort -V | paste -sd,) --out data/delove/teacher-01
# 3. train on the GPU (about 11 minutes on an RTX 4060), then export for Node
cd packages/delove/python
../../../.venv/Scripts/python train.py --data ../../../data/delove/teacher-01/classic --out ../../../models/delove/delove@1 --epochs 2
../../../.venv/Scripts/python export_onnx.py ../../../models/delove/delove@1
cd ../../.. && npm run delove -- ladder --best delove-teacher@1 --candidate delove@1 --games 400
```

`train.py` writes `<out>.pt` (weights), `<out>.json` (settings and validation history) and the log; `--init` starts
from an earlier version's weights. The network (`python/delove_model.py`) is a graph network over the map: the
adjacency is an input, so one model plays every map. It scores each candidate (policy) and predicts the win chance
(value). In Node it runs through `onnxruntime-node` in a worker thread (`src/net-worker.ts`), since self-play agents
answer synchronously.

## Players

| id | what | status |
| --- | --- | --- |
| `delove-teacher@1` | hand-coded teacher (`src/teacher.ts`), Stage 0: Delove's first version learns from it | done |
| `delove@1` | network distilled from the teacher (Stage 1), loaded from `models/delove/` (ignored by git) | done |
| `delove@2` | distilled from the tuned teacher delove-teacher@2 (round 5) | done |
| `delove@3` | fresh hidden-192 / 6-round network on branch-and-score decisions (cycle 4, `CYCLES.md`): 0.541 / 0.600 / 0.610 against delove@2 at 2 / 4 / 6 players | current best |
| `jacob-sensei@1` | Jacob Sensei: hand-coded teacher for big tables (`src/jacob.ts`, below); never stalls in self-play, even with Sensei 2 at 2 players, far ahead at 4-10 | candidate rollout teacher |

`delove-teacher@1` picks only from the self-play candidates (never off-list), so every decision is a clean training
label, and it is deterministic from the seed. Against `risky@1` (`--seed 3`):

| setup | games | score | Elo |
| --- | --- | --- | --- |
| Classic, 2 players | 400 | 0.94 | +478 |
| Classic, 2 players, fixed cards | 200 | 0.95 | +512 |
| World, 2 players | 200 | 0.955 | +531 |
| Classic, 4 players | 200 | 0.83 | +275 |
| Classic, 4 players, capitals | 200 | 0.805 | +246 |
| World, 6 players | 200 | 0.835 | +282 |

(With 4 or 6 players the score is the share of games won by either of a version's seats; 0.5 is even.)

How it plays: pick a continent to take and stack everything on the territory that attacks into it; defend held
continents' borders against real players (the Neutral never attacks); attack when the battle odds and the payoff
(a card, completing or breaking a continent, an elimination, a capital) beat the expected losses, counting the
armies the defender loses too; move armies forward after a conquest; fortify idle interior stacks toward the most
threatened border.

`delove@1` (808k parameters, 2 epochs on 5.8M decisions from 20,000 Classic 2-player teacher games; it picks the
teacher's move 77% of the time on held-out games), `--seed 5`:

| opponent | setup | games | score | Elo |
| --- | --- | --- | --- | --- |
| `risky@1` | Classic, 2 players | 400 | 0.95 | +512 |
| `risky@1` | World, 2 players | 200 | 0.98 | +676 |
| `risky@1` | Classic, 4 players | 200 | 0.75 | +191 |
| `delove-teacher@1` | Classic, 2 players | 400 | 0.525 | (even: it learned the teacher) |
| `delove-teacher@1` | World, 2 players | 200 | 0.605 | +74 (a map it never trained on) |
| `delove-teacher@1` | Classic, 4 players | 200 | 0.415 | (trained on 2-player games only) |

## Range specialists: Delove Long, Mid and Close Range

The owner's plan for a stronger player in real games: three **separate** networks that take turns within one game,
picked by how many players are still alive, next to the base model `delove@N`. They are never merged into one
network; each line keeps improving on its own. Each is fine-tuned from the best general model on the positions of its
range.

| specialist | plays when | aims for |
| --- | --- | --- |
| **Delove Long Range** (`delove-long-range@N`) | 4 or more players alive | reach the last 3 with the most kills: the most leaderboard points |
| **Delove Mid Range** (`delove-mid-range@N`) | 3 alive | finish top 2, by making someone else the obvious target |
| **Delove Close Range** (`delove-close-range@N`) | 2 alive | win the duel |

Library names (the private models repo, next to `delove@N`) are `delove-long-range@N`, `delove-mid-range@N` and
`delove-close-range@N`; the shorter `delove-long@N` / `delove-mid@N` / `delove-close@N` from #114 still load.

- **Training:** `train.py --alive LO-HI` keeps only decisions with LO..HI players alive (counted from the
  `slot<i>_alive` features of each dataset), e.g. `--alive 4-10 --init <best>.pt --out .../delove-long@1`, then
  `3-3` (mid) and `2-2` (close). In cycle 5's data, Classic 4p has 92k / 203k / 355k decisions for close / mid / long,
  World's big tables 90k / 320k / 709k, Classic 2p 1.5M close.
- **Each its own objective** (`train.py --range long|mid|close`, `python/targets.py`): cycle 7 split the same lessons
  by players alive and came out even, so each specialist now learns its own target from the same pool of games:

  | `--range` | `--alive` | value target | policy |
  | --- | --- | --- | --- |
  | `long` | 4-10 | `points`: leaderboard points (placement + kills) scaled 0..1, the owner's "reach the last 3 with as many kills as possible" | range credit on points |
  | `mid` | 3-3 | `top2`: finished 1st or 2nd, mixed 70/30 with the **threat credit** (`--threat-credit 0.3`) | range credit on top2 + threat |
  | `close` | 2-2 | `win`: a sole win (a turn-limit share is no win) | range credit on win |

  *Range credit* (`--credit-beta 0.5`): each copied move is weighted by `exp((target - V) / beta)`, V the network's own
  value of the position (no gradient), so a specialist copies most the moves that went better than expected *for its
  objective*; the first `--credit-warmup` (500) steps copy evenly while the value head learns the new target. The
  same branch-and-score labels then teach three different lessons. *Threat credit* (Mid Range): at a 3-alive decision,
  the share of the strongest rival's border armies (largest army + territory share) that face the third player
  rather than us, measured at the seat's next decision (1 if a rival fell meanwhile, the final top 2 at the seat's
  last decision), read from the encoded positions. Every preset value can be overridden (`--value-target`,
  `--threat-credit`, `--credit-beta 0` for no credit). A turn-limit game is last place / no top 2 / no win.
  `top2` reads `placement.npy` (written by `delove_gpu.generate` since this change, with `kills.npy`; `export.ts`
  does not write it yet, as that file is in the GPU fingerprint). Older exports estimate a loser's place as the
  players alive at its seat's last recorded decision (see `targets.py`; `train.py` prints which datasets estimate).
  **Which `--init`:** a specialist line improves on itself. The first of each line starts from the base
  (`--init delove@6.pt`); every later one starts from the current best of its own line
  (`--init delove-mid-range@N.pt`), never from a newer base (docs/delove-status.md section 3, "Each specialist is
  its own line"). The data is the newest shared pool.
  Example: `train.py --range mid --data <pool...> --init delove-mid-range@N.pt --out .../cN-mid --epochs 1.5 --batch 512 --lr 2e-4
  --amp --branch-weights 0.5,1,2`. Checks: `python packages/delove/python/test_targets.py`. Cycle 7's script takes
  `RANGE_OBJECTIVES=1` (with `PREFIX`, `ROUTER`, `BASE`) to retrain its trio on its own games with these objectives,
  a direct A/B against cycle 7 with no new games.
- **Playing them as one player:** `models/delove/delove-range@N.json` holds the routes,
  `{"close": "delove-close-range@1", "mid": "delove-mid-range@1", "long": "delove-long-range@1"}`. The loader then registers
  `delove-range@N`, which plays each decision with the network for the players still alive (`rangeOf`), each network's
  top move. Specialists named `delove-long@N` / `delove-mid@N` / `delove-close@N` (or a cycle's `cN-long` / `cN-mid` /
  `cN-close`) are also players on their own. A route to a missing model skips the router rather than failing games.
- **Gate:** each specialist against the base on its own stage, then the routed trio against the base in full games,
  with the yardstick below; the promotion rule is in `docs/delove-status.md` ("Range specialists: how they are
  compared").
### The yardstick: specialist vs base on its own stage (`npm run delove:stages`)

```bash
npm run delove:stages -- --stage close --candidate delove-close-range@1 --base delove@5             # 400 positions, 800 games
npm run delove:stages -- --stage mid   --candidate delove-mid-range@1   --base delove@5             # 300 positions
npm run delove:stages -- --stage long  --candidate delove-long-range@1  --base delove@5             # 200 positions
npm run delove:stages -- --stage full  --trio delove-long-range@1,delove-mid-range@1,delove-close-range@1 --base delove@5
```

(`src/stages.ts` over `src/stage-eval.ts`; add `--workers N`, default 6. Games run in `playStageGame`, self-play's
game loop plus a start position and a stop test; it lives here rather than in `packages/selfplay/src/game.ts` because
that file is in the GPU mirror's fingerprint, and it is tested to play the same games as `playGame`.) How it works:

- **Fixed start positions per stage**, generated deterministically from `--seed` (default 1), the tables and the
  settings: position *i* is on table *i* mod the stage's tables, reached by **Jacob Sensei in every seat**
  (`--capture`, never one of the models being compared) and captured at the first turn start that fits the stage:

  | stage | captured at | default tables | positions | decides on | also reported |
  | --- | --- | --- | --- | --- | --- |
  | `long` | turn 1 (every seat alive) | Classic 6, World 6, Asia 8, World 10 | 200 | mean leaderboard points per seat | P(top 3) |
  | `mid` | first turn with exactly 3 alive, weakest holding ≥ 12% of the armies | Classic 4, World 4, Classic 5, World 6 | 300 | P(finish top 2) | points |
  | `close` | first turn with exactly 2 alive, weaker holding ≥ 20% (fresh duels on 2-player tables) | Classic 2, Classic 4, World 4, World 5 | 400 (800 games) | win rate | points |
  | `full` | the deal (whole games) | Classic 2, 4, 6, World 6, 10 | 200 | mean leaderboard points per seat | win share |

  The balance floor keeps the set from being mostly decided games; a capture that skips the stage (two players out
  in one turn), fails the floor or hits the turn limit moves on to the next seed. `--tables`, `--positions` and
  `--options` (a JSON string or file such as `configs/gen5-nofog.json`; fog is refused) change the set; keep them the
  same across comparisons. `--save-positions FILE` writes the set (a few MB, local only, not for git) and
  `--load-positions FILE` replays exactly that set.
- **Mirrored pairs:** every position is played twice, the candidate on alternate alive seats and then on the others,
  with the same seed (dice and deck come from the position, so both games roll the same dice). The candidate's seats
  play the **specialist only while the game is in its stage** and the base after it (`stagedAgent`), so a stage's
  number measures that stage's network; `full` plays the routed trio (`--trio LONG,MID,CLOSE`, any ids, routed by
  `routedAgent`) or any single `--candidate` (e.g. `delove-range@N`) throughout.
- **Output:** a JSON line on stdout and a table on stderr, per table and pooled: the candidate's and the base's
  metric, their **difference with a 95% interval over positions** (a position's pair is one unit), turn-limit games,
  how many positions were *decided* (both games placed every seat the same, so the seats decided them, not the
  players) and a verdict (`better` / `worse` when the difference's interval clears 0, else `even`).
- **Speed** (CPU, 12 workers, `delove@4` vs `delove@5`, 48 positions each): close 36 s, mid 56 s, long 80 s, full
  112 s (40 positions). A full 800-game close call takes about 5 minutes.

Smoke run, `delove@4` (candidate, in every stage) against `delove@5` (base), 48 positions per stage (40 for
`full`), seed 1, default settings, 2026-10-20: every stage `even`, as expected of two close versions
(close win 0.531 vs 0.469, diff +0.06, 95% -0.03 to +0.15, 43 of 48 decided; mid top 2 0.667 vs 0.653, diff +0.01,
-0.10 to +0.13; long points 0.71 vs 0.93, diff -0.21, -0.79 to +0.36; full points 0.30 vs 0.76, diff -0.46, -1.03 to
+0.11). Too small for a call: proof that the command works, not a result.

- Not on the GPU mirror yet: `delove_gpu.generate` / `ladder` would need a per-decision model choice by players alive in
  their network seats.

## Jacob Sensei (`jacob-sensei@1`): a teacher that doesn't stall

Sensei 2 (`delove-teacher@2`) was tuned on 2- and 4-player Classic and stalls on big boards and big tables: with
progressive cards every seat ends up on thousands of armies and nobody attacks, because in a many-player game the
armies a fight costs mostly help the players who stay out of it (a stalled World 6-player game at turn 500: five
players on 2,800-7,100 armies each, sets worth 790, two conquests a turn, all card grabs). Jacob Sensei
(`src/jacob.ts`, named by the owner) keeps Sensei's judgement and adds terms from the LLM players' post-game notes
(`AI/general-player/risk-learnings.md`), each a tunable number. `teacher.ts` is unchanged, so `delove-teacher@1/@2`
and the GPU mirror are too.

| learning (risk-learnings.md) | heuristic | number(s) | ablation: switched off |
| --- | --- | --- | --- |
| go for the kill; hunt weak players for their cards; plan the whole kill run | a capture from a rival whose whole army is under the attacking stack / `huntRatio` earns `huntValue` x elimination worth / their territories (attacks and placement) | `huntRatio`, `huntValue` | **the big one**: 0.22-0.32 against full Jacob at 4-10 players, games 35-50% longer |
| late-game tactics; huge stacks must be used | every round past `lateRound` lowers the attack bar and own-loss weight (`lateRamp`) and the win chance needed (`lateWin`, floor `minWinFloor`) | `lateRound`, `lateRamp`, `lateWin`, `minWinFloor` | stall insurance: Greater Europe 10p self-play stalls 7 of 32 games without it |
| check the leader's income and territory count, not just your neighbours | a rival's armies and territories are worth more the further its power (armies + `powerIncome` x income + `powerCards` x cards x card value) is above the table mean | `leaderLoss`, `leaderCapture`, `powerIncome`, `powerCards` | neutral (within noise) |
| take at least one territory for the card | until the turn's first conquest the attack bar is lower by `cardUrge` | `cardUrge` | neutral |
| sitting on troops is the most common mistake | own losses count less the more a stack exceeds its border's threat, in turns of income | `stackRamp`, `stackFree` | neutral |
| never skip your fortify; move interior stacks onto a border | an interior stack is always fortified to the front, toward its best attack | `frontPull` | neutral |

Skipped: anything needing chat, diplomacy, fog of war or memory of earlier turns (retaking a loss, kill-guarding,
card-blocking). Ablations: 32 self-play games per big table and 200 mirrored games per table against full Jacob, on
the generation-4 numbers.

**Tuning.** `src/tune.ts --teacher jacob` from the untuned numbers (`DEFAULT_JACOB_PARAMS`: Sensei 2's 28 plus first
guesses), 30 generations of 8 mutants x 300 games, confirmed on 800 (2 accepted), on Classic 2p 0.3, World 2p 0.1,
Classic 4p 0.1, Asia 4p 0.1, World 6p 0.15, Fantasy 6p 0.1, Greater Europe 10p 0.15, 500-turn limit, `--stall 1`.
A first run without a length term accepted a version that wins mixed tables by sitting back and drags self-play
games to the edge of the limit (Greater Europe 10p 158 -> 442 turns). So `--selfplay greater_europe:10,world:6,fantasy:10,classic:4
--length 0.3` also plays each candidate against itself and charges (candidate - best) for turn-limit games and mean
length. The result is `JACOB_SENSEI_1_PARAMS`. Later versions: `models/delove/jacob-sensei@N.json` (N >= 2) register
on their own. `src/tables.ts` runs these checks over many tables at once:

```bash
node --import ./packages/delove/dist/register.js packages/delove/dist/tables.js --agent jacob-sensei@1 \
  [--vs delove-teacher@2] --tables classic:2,world:6,greater_europe:10 --games 64 --workers 6
```

**Results** (2026-10-20, 500-turn limit). Self-play, every seat the same teacher (Sensei 2: 16 games per table;
Jacob: 64):

| table | Sensei 2 turn-limit | Jacob turn-limit | Jacob mean turns |
| --- | --- | --- | --- |
| Classic 2 / 4 / 6p | 0 / 12.5 / 31% | 0 / 0 / 0 | 19 / 50 / 53 |
| World 4 / 6 / 8 / 10p | 62 / 94 / 75 / 100% | 0 / 0 / 0 / 0 | 67 / 79 / 77 / 80 |
| Greater Europe 4 / 6 / 10p | 100 / 100 / 100% | 0 / 0 / 0 | 115 / 129 / 120 |
| Fantasy 6 / 10p | 94 / 100% | 0 / 0 | 83 / 81 |
| Asia 8p, USA 10p, Europe 8p | 44 / 44 / 25% | 0 / 0 / 0 | 58 / 57 / 54 |

Against Sensei 2, seats alternating, mirrored pairs (score = Jacob's share of wins, 0.5 even; points = mean
leaderboard points per seat, placement + kills, a turn-limit game scoring last place for everyone):

| table | games | Jacob score (95%) | Jacob points | Sensei 2 points | turn-limit |
| --- | --- | --- | --- | --- | --- |
| Classic 2p | 1,000 | 0.521 (0.499-0.543) | 0.56 | 0.44 | 0% |
| World 2p | 1,000 | 0.504 (0.482-0.526) | 0.51 | 0.49 | 0% |
| Classic 4p | 200 | 0.645 (0.587-0.703) | 1.11 | 0.39 | 0% |
| Asia 4p | 200 | 0.650 | 1.17 | 0.33 | 0% |
| World 4p | 200 | 0.698 | 1.22 | 0.14 | 2.5% |
| Greater Europe 4p | 200 | 0.638 | 0.50 | -0.34 | 24.5% |
| Classic 6p | 200 | 0.705 | 1.33 | 0.34 | 0% |
| World 6p | 200 | 0.735 | 1.12 | 0.09 | 6% |
| Fantasy 6p | 200 | 0.738 | 1.17 | -0.23 | 9.5% |
| World 10p | 200 | 0.808 | 1.23 | -0.20 | 6.5% |
| Fantasy 10p | 200 | 0.825 | 1.07 | -0.33 | 9% |
| USA 10p | 200 | 0.713 | 1.11 | 0.63 | 0.5% |
| Greater Europe 10p | 200 | 0.763 | -0.20 | -1.95 | 33.5% |

Bar (docs/delove-status.md, section 9 item 1): turn-limit games under ~2% at every table size: met in self-play (0 of
960), which is what rollouts play. No loss at 2 players against Sensei 2: met (1,000 games each on Classic and
World). Tables that keep Sensei 2 in half the seats still stall on the big boards (Greater Europe 25-34%), because
Jacob alone can't finish several turtling Sensei seats in 500 turns; as a cycle's rollout teacher Jacob plays every
seat, so those tables don't arise there, but steps that seat Sensei 2 as an opponent will keep stalling.

**Porting it to the GPU mirror** (`packages/delove-gpu/delove_gpu/teacher.py`, a later step): the same scoring as
Sensei plus per-player armies, territories, income (`reinforcementsFor`) and cards for the power and hunt terms (one
segment-sum over territories per position), the round for the late ramp, the conquest flag for the card urge, and the
interior-to-front fortify branch; then add `src/jacob.ts` to `RULE_FILES` and re-verify with `verify.py`.

## Stage 2: self-play rounds

A round: generate games with a jobs file, export the groups, train from the current best with `--init`, then gate
the candidate on the ladder against the current best (promoted only at >= 0.55 over >= 200 games with the 95%
interval above 0.5).

```bash
bash packages/delove/scripts/generate.sh packages/delove/scripts/round-02.jobs runs/delove/r02 202   # ~14 min
npm run delove -- export --log $(ls -d runs/delove/r02/t*/c* | paste -sd,) --out data/delove/r02-teacher
npm run delove -- export --log $(ls -d runs/delove/r02/x*/c* | paste -sd,) --out data/delove/r02-self
cd packages/delove/python
../../../.venv/Scripts/python train.py --data ../../../data/delove/teacher-01/classic   --data ../../../data/delove/r02-teacher/classic --data ../../../data/delove/r02-self/classic:winners   --init ../../../models/delove/delove@1.pt --out ../../../models/delove/delove@2 --epochs 1 --lr 5e-4   # ~22 min
../../../.venv/Scripts/python export_onnx.py ../../../models/delove/delove@2
cd ../../.. && npm run delove -- ladder --best delove@1 --candidate delove@2 --games 400
```

### A whole cycle in one command

`scripts/cycle.sh` runs a training cycle from a config (`scripts/cycles/c2.cycle` is cycle 2): every step's games go
into one pool of small chunks over all CPU threads (the most expensive step first, so the pool ends on short chunks),
each step is exported as soon as its last chunk is done while the others keep generating, then it trains on the GPU,
plays every ladder gate at once (each split into chunks) and writes the step tables, the gate table and the time of
each phase to `runs/delove/<name>/cycle.md`. Re-running resumes where it stopped.

```bash
DELOVE_MODELS=models/delove PYTHON=.venv/Scripts/python bash packages/delove/scripts/cycle.sh packages/delove/scripts/cycles/c2.cycle
```

Each invocation writes its phase times to `times.tsv` and a copy to `times-<YYYYmmdd-HHMMSS>.tsv` (its start), so a
cycle stopped and resumed keeps every invocation's times.

**Splitting a cycle between home and the cloud.** `GENERATE_ONLY=1` stops `cycle.sh` after generation. Cycle 8 played
its small and medium boards at home that way (steps `a1`-`a4`, `GPU_LANES=4`), played its huge boards on 8 rented
GPUs with `packages/delove-gpu/cloud/remote.py run --name c8 --step b=...` into the same `DATA` and `OUT`, then ran the
full config (every step listed): finished steps are skipped, so it went straight to training and gates. With
`REMOTE_GPUS=N` a single `cycle.sh` run sends every GPU step to the cloud instead.

**GPU lanes and league settings.** `GPU_LANES=N` runs N GPU processes at once and deals the config's GPU steps to them
in turn: split a long step (the big tables) into several so every lane stays busy (cycle 6's second lane idled 5 hours
behind a single big-tables step). Cycle 6's jobs files show the league settings every table now uses (auto setup,
balanced blitz, chosen capitals, and four card/capitals/blizzard variants: `docs/game-settings.md`); cycles 1-5 trained
on the defaults only, and that blind spot was the largest gain of cycle 6.

**Watching a cycle, its history and where the time went.** `scripts/dashboard.mjs` is a local, read-only page over the
run folders (binds 127.0.0.1 only, no external scripts):

```bash
node packages/delove/scripts/dashboard.mjs [--runs runs/delove] [--port 8790] [--no-record]
```

`--runs` is the folder holding the run folders (cycle.sh's `OUT` parent; on the training PC, the stage2 worktree's
`runs/delove`); open `http://127.0.0.1:8790`, `?run=<name>` picks a run (default: the newest).

- **Live**: the phase and pipeline of a cycle, each step's games per map and table size with turn-limit counts, games
  per minute and the time left (from `delove_gpu.generate`'s progress lines), branch-and-score statistics, training
  curves and validation by dataset, the gates with score and points intervals, and the machine's GPU and CPU load over
  the last 2 hours.
- **History**: any run, finished or not. While it runs, the dashboard appends a compact sample every 30 s (phase,
  games, turn-limit games, games/min, GPU load, memory and temperature, CPU load, training step and losses, gate
  games) to `<run>/dashboard/samples.jsonl` for the active run (the newest one written to in the last 10 minutes),
  and the machine's load to `<runs>/_machine/samples-<date>.jsonl`; a sample is skipped when nothing moved (one every
  5 minutes at most then), so a cycle's file stays around 100 KB. The tab charts those samples and, for every run,
  shows its phases on the clock, GPU and CPU busy time, generation per step and map / table size (with the last 5% of
  each configuration's games) and a bottleneck list, worked out from the run's files when it has no samples (cycle 5
  and older). One dashboard records at a time: a second one sees the first's heartbeat (`_machine/recorder.json`) and
  only reads; `--no-record` never writes.
- **Compare cycles**: every run with phase stamps, a bar per phase (CPU pool, each GPU step, training, gates, time
  between invocations) in minutes, games and decisions per hour of generation, training samples/s, GPU and CPU busy
  share, idle time and each cycle's top bottlenecks.

`scripts/timing-report.mjs <run dir> [...more] [--batch N] [--out file.md]` writes the same as Markdown: time per
invocation, phase, step and map / table size; GPU vs CPU share and the idle gaps; throughput (games/min, decisions/s,
training samples/s, from the training batch in the cycle config next to the jobs files, or `--batch`); the slowest tail
(the last 5% of each GPU configuration's games, the CPU and gate pools' tails and slowest chunks); and a short
bottleneck list. It needs only `times*.tsv`, the chunk and gate files, `gpu.json` / `gpu.log` and `train.log`
(`runs/delove/c5` works: its generation and its training and gates ran as two invocations, `times-generation.tsv` and
`times-train-gates.tsv`); with the dashboard's samples it adds measured load and idle stretches. Chunk times come from
the files' creation and last-write times. `scripts/run-timing.mjs` holds the reading both share.

**A step on the GPU.** A config can list steps to play on the GPU instead, `gpu_steps=(classic2)`, or every step,
`gpu_steps=(all)` (`GPU_STEPS="micro classic4"` or `GPU_STEPS=all` overrides the config): that step's tables
go to `python -m delove_gpu.generate` (`packages/delove-gpu`), in the background while the CPU pool plays the other
steps, with the same seed, tables and `DELOVE_BRANCH_*` settings the pool would use. It writes the training arrays to
`DATA/<name>-<step>` itself (no export) and its per-table results and branch stats to `OUT/<step>/gpu.json`, which
`scripts/summary.mjs` reads in place of the chunk results, so `cycle.md` has the step's tables as before. Any map, table
size (2-10 seats) and game setting but fog of war qualifies, with branch, teacher and network seats; the generator
refuses fog of war, `risky@1` and `-explore` seats, and cycle.sh refuses `DELOVE_BRANCH_VALUE`. Before the pool starts,
cycle.sh checks the mirror's fingerprint: if the engine changed since the last verification, run
`packages/delove-gpu/verify.py --models <models dir>` first. Games in flight are sized per table configuration to
`GPU_GB` of game state (default 3, fits the RTX 4060's 8 GB with the networks); `GPU_BATCH` fixes the number.

**GPU steps on rented cloud GPUs.** `REMOTE_GPUS=N` hands every GPU step to `packages/delove-gpu/cloud/remote.py`
instead: the steps' configurations are split over N RunPod GPUs (RTX 4090 by default) by their cost in earlier
`gpu.log` files (`REMOTE_TIMINGS`), played with the same generate arguments, downloaded and merged into the same
`DATA/<name>-<step>/<map>` and `OUT/<step>/gpu.json`. `RUNPOD_API_KEY` must be in the environment; the estimated cost
is printed first, `REMOTE_MAX_GPU_HOURS` (default 4) caps it, and every pod is terminated at the end. Progress goes to
`OUT/remote.log`. See [packages/delove-gpu, Cloud workers](../delove-gpu/README.md#cloud-workers).

**Training on a rented cloud GPU.** `REMOTE_TRAIN=1 REMOTE_VOLUME=<RunPod network volume id>` trains the candidate on
one rented GPU instead (`remote.py train`): with `REMOTE_GPUS` the generation pods run in the volume's data center and
leave their arrays on it, the training pod is rented `REMOTE_TRAIN_LEAD` minutes (default 12) before generation's
estimated end, merges the cycle's arrays there, trains with the same `train_data` and `train_args`, and sends back only
the candidate's `.pt`, `.json`, `.onnx` and `.value.onnx` and `train.log` (progress in `OUT/remote-train.log`). Every
`train_data` entry must be a step of the cycle or `<dataset>/<map>` under `DATA`. A dataset not on the volume trains
the candidate at home instead (exit 3), unless `REMOTE_TRAIN_PUSH=cycle` (this cycle's, e.g. CPU steps) or `all`
(earlier cycles' too, once) pushes it from `DATA`; home training needs the arrays at home (`REMOTE_HOME_COPY=1`).
`REMOTE_TRAIN_MAX_GPU_HOURS` (default 1.5) caps it. See
[packages/delove-gpu, Cloud training](../delove-gpu/README.md#cloud-training).

**Gates on the GPU.** `gpu_gates=(all)` in the config, or a list of gate indices (`gpu_gates=(4 6 7)`, 0-based in
`gates=(...)`), plays those gates on the GPU (`python -m delove_gpu.ladder`, [packages/delove-gpu](../delove-gpu/README.md#ladder-gates-on-the-gpu))
and the rest on the CPU, at the same time; `GPU_GATES=1` (all), `GPU_GATES="4 6"` or `GPU_GATES=0` (none) overrides
the config. CPU gates stay the default. The GPU plays the same chunks with the same seeds and writes the same
`OUT/gates/g<i>-<k>.json` (byte for byte, but for rare ONNX vs PyTorch near-ties), so the gate table and a resumed run
cannot tell them apart; its log is `OUT/gates/gpu.log`. One Python process takes every GPU gate chunk, one engine per
table configuration, one configuration after another (`GPU_GATE_PROCS=N` runs N processes, each with whole
configurations; `GPU_GATE_GB`, default 1, sizes each configuration's games in flight; `GPU_BATCH` fixes it). Before it
starts, cycle.sh checks the mirror's fingerprint and stops on a stale mirror unless `GPU_GATES_ALLOW_UNVERIFIED=1`.
Network and tuned-teacher opponents (and Jacob Sensei where the mirror has it) play on the GPU; it refuses fog of war
and `delove-branch@1`, `risky@1` or `-explore` seats, so leave those gates on the CPU. To re-run gates only (after
training), run cycle.sh again with the same config: finished generation, exports and the trained model are kept.

Which gates to move: a GPU configuration takes about as long as its longest game, whatever the number of games, while
the CPU plays a gate's chunks side by side. So the GPU wins on the big boards and loses on the small ones (200 games:
Greater Europe 6p 541 s on the GPU against 878 s for the CPU's longest chunk with 6 busy processes; Greater Europe 10p
took 1,572 s in cycle 5's full pool; World 10p 213 s against 166-415 s; Classic 2p 34 s against 21-40 s; Four Crowns 2p 71 s
against 12-22 s). Put the big-board gates on the GPU and keep 2-4 player Classic and Four Crowns on the CPU; the gate
phase then ends with the slower side. Measurements and the reasons:
[packages/delove-gpu](../delove-gpu/README.md#speed-of-a-gate).

The games are the CPU's: cycle 3's Classic 2-player step played this way (`c3.cycle` with `gpu_steps=(classic2)`,
same environment as cycle 3) gives a `cycle.md` step table identical to cycle 3's CPU one, every number of it: wins
per table, mean turns, decisions, and all branch-and-score statistics.

**The gate table** reports, for each ladder match, the score (win share, 95% interval, Elo) and the leaderboard view:
mean points per seat for the candidate and the opponent, their difference with a 95% interval (from the spread of the
gate's chunks), the candidate's mean place and kills per seat, and the games that hit the turn limit. Since cycle 5
promotions are judged mainly on the points difference at 4-10 players (`docs/delove-status.md` section 3).

**Training options** (`python/train.py`, through `train_args` and `train_data`):
- `--amp`: the network in bfloat16 mixed precision (losses, optimizer and weights stay float32). On the RTX 4060 it
  gives the same validation loss as float32 (0.9455 vs 0.9449 on cycle 5 data) at 1.9x the speed, and less memory.
- `<dataset>#F` (in `train_data`, or `--data <path>#F`): each epoch trains on a fresh random fraction F of that
  dataset's training decisions, so older cycles keep their influence at a fraction of their cost.
- `<dataset>:value` (mode): the value head learns from those positions and outcomes, the policy ignores their moves
  (weight 0): for data whose moves shouldn't be copied, e.g. cycle 5's big tables, whose moves were mostly Sensei 2's.
- `--branch-weights W0,W1,W2`: weights the policy by what branch and score did at each decision (`branch_tag.npy`,
  written by `delove_gpu.generate`): 0 the teacher's move without comparing, 1 compared and kept, 2 changed. Cycle 6
  used `0.5,1,2`. Datasets without `branch_tag.npy` (CPU exports, older cycles) keep weight 1.
- `--alive LO-HI` (range specialists): only decisions with LO..HI players alive.
- Keep a batch within the card: on big maps (Greater Europe, Fantasy) batch 1024 spilled past the RTX 4060's 8 GB into
  shared memory and ran 5x slower; batch 512 fits.

A cycle-2-sized run (2,000 micro games, 3,000 Classic 2-player and 600 Classic 4-player branch games, training,
1,800 gate games) takes **20 minutes**, where cycle 1's way took about 80 minutes before its gates:

| phase | before (cycle 1/2 logs) | `cycle.sh` |
| --- | --- | --- |
| micro games | 6.8 min | (in the pool) |
| Classic 2-player games | 32.5 min | (in the pool) |
| Classic 4-player games | 26.3 min | (in the pool) |
| all games | 65.6 min | 11.0 min |
| exports | ~5 min after the games | done 5 s after the last game |
| training (GPU) | ~10 min | 8.1 min |
| gates | one match at a time | 1.2 min, all at once |

Where it comes from: the engine copies a state by shape instead of `structuredClone` (most of a simulated move's
time) and lists connected fortify targets with one indexed search per position; the teacher works out each
per-territory answer once per position (together 4.6x on branch games, same moves); branch and score compares 3
options instead of 4 and lets the teacher play `occupy` decisions (1.6x more on 2-player games, 1.75x on 4-player).
Branch settings measured with `scripts/branch-variant.sh`, 2,000 two-player Classic games each against Sensei 2
(both seat orders, same seeds; paired difference against today's setting):

| options / rollouts / skip | score | paired difference | s per game |
| --- | --- | --- | --- |
| 4 / 6 / - (before) | 0.530 | - | 4.69 |
| 3 / 6 / - | 0.562 | +0.032 ± 0.025 | 3.94 |
| 4 / 4 / - | 0.488 | -0.043 ± 0.027 | 3.38 |
| 3 / 4 / - | 0.508 | -0.022 ± 0.025 | 2.73 |
| 4 / 6 / occupy | 0.548 | +0.018 ± 0.023 | 3.51 |
| 3 / 4 / occupy | 0.532 | +0.002 ± 0.026 | 1.99 |
| 3 / 4 / occupy, trade | 0.539 | +0.009 ± 0.026 | 1.91 |
| **3 / 6 / occupy (now)** | **0.574** | **+0.043 ± 0.025** | **2.88** |
| 3 / 6 / occupy, trade | 0.568 | +0.037 ± 0.025 | 2.84 |

Across these runs 4 rollouts cost about 0.035 against 6 (8,000 games a side), so rollouts stay at 6; fewer options
and skipping `occupy` cost nothing measurable. On 4-player Classic (800 games, Sensei 2, `delove@2` and `risky@1` at
the table) the branch player's share of wins was 0.688 before and 0.659 now (paired -0.029 ± 0.043; 0.25 is even) at
10.1 instead of 17.7 s per game. (The 0.688 two-player figure from 96 games earlier was luck or an older setting:
2,000 games put today's setting at 0.53, and cycle 1's own Classic games at 0.549.) `occupy` moves in the logs are now
Sensei 2's own; set `DELOVE_BRANCH_SKIP=` to branch on them again.

Every step can also run on the GPU (`packages/delove-gpu`, `python -m delove_gpu.generate`): the same games, the same
decisions and bit-identical training arrays (checked by replay), on every map and table size; 4.6x faster than this
pool for cycle 3's 6,000 Classic 2-player games (other steps: packages/delove-gpu/README.md, "Speed"). `DELOVE_BRANCH_TRACE=<file>` makes the branch player write each branched decision's options and mean
scores, which the GPU's replay test compares option by option.

### Scoring rollouts by leaderboard points (`DELOVE_BRANCH_SCORE`): tried, not better

The default branch score (`positionScore`, `score: 'share'`) is won 1, lost 0, otherwise the weighted share of
armies, income, territories, cards and continents. It aims at the leaderboard (placement points plus `KILL_POINTS`
per elimination) only indirectly: it gives nothing for a kill made inside the horizon, for the decider's standing
among the players left, or for how early a knock-out comes in a big game. Two opt-in scores (the `score` field of the
branch settings, `DELOVE_BRANCH_SCORE`, `--score` on the GPU) aim at the leaderboard directly:

- **`points`** (`pointsScore`): the decider's expected place among the players still alive (1 plus, for each rival,
  its chance of finishing above, read off the gap in share score: `clamp(0.5 + 0.5 * n * (mine - theirs), 0, 1)` with
  n players alive), turned into the table's placement points (`placementPoints`, interpolated between whole places;
  the place just below the players still alive when the decider is out, first when it won), plus `KILL_POINTS` per
  player the decider has eliminated, scaled so last place is 0 and first place 1;
- **`kills`**: the share score plus the kill credit alone (`killCredit`: `KILL_POINTS` per player eliminated over the
  placement spread, so 0.5 at 2 players, 0.25 at 4, 0.17 at 6, 0.1 at 10).

Both are cheap, deterministic functions of the board, mirrored bit for bit on the GPU. Share stays the default, so the
golden lock and every earlier result are unchanged.

Measured on the GPU (horizon 1, margin 0.01, ranker `delove@3`, Sensei 2 rollouts; `packages/delove-gpu/scripts/
score_compare.py`). 2 players: the share and points runs on the same 1,000 Classic seeds against `delove@3` and Sensei
2 in both seat orders. 4+ players: head to head, both scores at the same table (GPU-only seats
`delove-branch@1:share` / `:points` / `:kills`, spread round it in every order and from every seat; the other seats
`delove@3` and one Sensei 2), so each game is a pair. Leaderboard points per game (placement + kills; a turn-limit game
scores last place for everyone), 95% intervals:

| table | games | share | points | kills | points - share | kills - share | wins share / points / kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Classic 2p (separate runs, same seeds) | 1,000 | +0.722 | +0.680 | | -0.042 ± 0.074 | | 0.574 / 0.560 / | 0% / 0% |
| World 4p (share vs points) | 520 | +1.413 | +0.906 | | **-0.508 ± 0.387** | | 0.400 / 0.290 / | 14.6% |
| Classic 4p (share vs kills) | 520 | +1.558 | | +1.521 | | -0.037 ± 0.398 | 0.385 / / 0.363 | 1.0% |
| 6 and 10 players (share vs points vs kills) | | | | | | | | deferred (below) |

The 6- and 10-player rows are deferred (the GPU was booked for cycles 6 and 7); they suit a cloud GPU. To run them,
from `packages/delove-gpu` (about an hour of GPU per map and size; results per group, so a run can stop and resume):

```bash
python scripts/score_compare.py h2h-jobs h3.jobs --variants share,points,kills --sizes 6:528,10:510
python -m delove_gpu.generate --jobs h3.jobs --seed 7 --models <models dir> --ranker delove@3 --teacher delove-teacher@2 --horizon 1 --margin 0.01 --gpu-gb 1 --results h3.jsonl
python scripts/score_compare.py h2h-report h3.jsonl
```

The points score loses: it turns small share gaps into whole places, at about twice the share score's slope, so the
same `margin` lets rollout noise change more moves, and it pays for pulling level with the nearest rival rather than
for growing. The kill credit alone makes no measurable difference. **Cycle 7 should keep the share score.** Kills and
placements are already in the value target (cycle 5, points), which is where the leaderboard reaches the network.

Speed work has two guards. `scripts/golden.mjs record|check <file>` replays ~60 seeded games across maps, player
counts, settings and players (teachers, `risky@1`, the network, the branch player) and fails if any logged decision,
its features or a result changes: record before touching the engine, self-play or Delove code, check after.
`scripts/branch-variant.sh` measures one branch-and-score setting against Sensei 2 in both seat orders on the same
seeds, with the time per game.

`:winners` data teaches the policy mostly from the side that won (`--loser-weight`, default 0.1); imitation data
counts every move.

**Round 2 (not promoted).** 22,000 games (Sensei with 3-6 players; `delove@1-explore` at temperature 0.7 against
itself, Sensei and `risky@1` with 2-6 players), 19.6M decisions with the original 2-player set, 1 epoch from
`delove@1`. `delove@2` against `delove@1` (`--seed 7`): 0.465 (2p, 400 games), 0.55 (4p, interval reaches 0.48),
0.535 (6p), 0.51 (World). Against Sensei: 0.523 (2p), 0.45 (4p, was 0.415), 0.44 (6p); against `risky@1` 4p: 0.79
(was 0.75). Better with more players, slightly worse head to head: imitation still dominates the data (14M of 19.6M
decisions) and the win/loss signal of a whole game is too noisy to say which moves won it. Next: learn from the
value head's judgement of each move (advantage weighting) and a value-guided lookahead at decision time, which can
play better than the policy alone and gives better training targets than copying.
