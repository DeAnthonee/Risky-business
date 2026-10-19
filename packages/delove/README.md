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
| `delove@2`, ... | self-play improved versions (Stage 2) | round 2 tried, not promoted (below) |

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
