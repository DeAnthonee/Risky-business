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

### Scoring rollouts by leaderboard points (`DELOVE_BRANCH_SCORE=points`)

The default branch score (`positionScore`, `score: 'share'`) is won 1, lost 0, otherwise the weighted share of
armies, income, territories, cards and continents. It aims at the leaderboard (placement points plus `KILL_POINTS`
per elimination) only indirectly: it gives nothing for a kill made inside the horizon, for the decider's standing
among the players left, or for how early a knock-out comes in a big game. `DELOVE_BRANCH_SCORE=points` (the `score`
field of the branch settings; `--score points` on the GPU) scores each rollout copy by `pointsScore` instead:

- the decider's expected place among the players still alive: 1 plus, for each rival, its chance of finishing above,
  read off the gap in share score (`clamp(0.5 + 0.5 * n * (mine - theirs), 0, 1)` with n players alive: even shares a
  coin flip, a lead of 1/n of the board or more certain);
- that place turned into the table's placement points (`placementPoints`, interpolated between whole places), or the
  points of the place just below the players still alive when the decider is out, or first place when it won;
- plus `KILL_POINTS` for each player the decider has eliminated;
- scaled so last place is 0 and first place 1 (a kill adds 1 / the placement spread: 0.5 at 2 players, 0.25 at 4,
  0.17 at 6, 0.1 at 10), so `margin` keeps about the same meaning.

It is a cheap, deterministic function of the board (no network). Share stays the default, so the golden lock and
every earlier result are unchanged. RESULTS_PLACEHOLDER

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
