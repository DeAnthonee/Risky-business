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
npm run delove-seat -- --server https://risky.deanthoneeking.com --join ABC123 --agents delove@1,delove-teacher@1
# or create one: Delove hosts, adds 2 built-in bots and starts; watch it at <server>/?game=<code>
npm run delove-seat -- --server http://localhost:8080 --create --agents delove@1,delove-teacher@1 --bots 2
```

`--pace 400` (ms between moves, so spectators can follow), `--names "A,B"`, `--options '{"capitals":true}'`,
`--no-start`. Fog of war games are refused for now: Delove was trained on the full board.

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

**A step on the GPU.** A config can list steps to play on the GPU instead, `gpu_steps=(classic2)`: that step's tables
go to `python -m delove_gpu.generate` (`packages/delove-gpu`), in the background while the CPU pool plays the other
steps, with the same seed, tables and `DELOVE_BRANCH_*` settings the pool would use. It writes the training arrays to
`DATA/<name>-<step>` itself (no export) and its per-table results and branch stats to `OUT/<step>/gpu.json`, which
`scripts/summary.mjs` reads in place of the chunk results, so `cycle.md` has the step's tables as before. Only Classic
2-player tables with no options qualify (the GPU mirror's rules; cycle.sh refuses others, and `DELOVE_BRANCH_VALUE`).
Before the pool starts, cycle.sh checks the mirror's fingerprint: if the engine changed since the last verification,
run `packages/delove-gpu/verify.py --models <models dir>` first. `GPU_BATCH` sets the games in flight (default 6000).

The games are the CPU's: cycle 3's Classic 2-player step played this way (`c3.cycle` with `gpu_steps=(classic2)`,
same environment as cycle 3) gives a `cycle.md` step table identical to cycle 3's CPU one, every number of it: wins
per table, mean turns, decisions, and all branch-and-score statistics.

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

The Classic 2-player step can also run on the GPU (`packages/delove-gpu`, `python -m delove_gpu.generate`): the same
games, the same decisions and bit-identical training arrays (checked by replay), 4.6x faster than this pool for cycle
3's 6,000 games. `DELOVE_BRANCH_TRACE=<file>` makes the branch player write each branched decision's options and mean
scores, which the GPU's replay test compares option by option.

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
