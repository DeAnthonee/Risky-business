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
| `delove@2`, ... | self-play improved versions (Stage 2) | next |

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
