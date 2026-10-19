# Delove: our base model, a trained Risk player with no personality

Status: Stages 0 and 1 done. `delove-teacher@1` beats `risky@1` on every setup tried, and `delove@1`, the network
distilled from it, matches the teacher on Classic 2-player (0.525), beats it on World (0.605) and beats `risky@1`
0.95-0.98 (numbers and commands in `packages/delove/README.md`). Stage 2 round 2 (`delove@2`: more players plus win-weighted self-play) was not promoted: better with 4-6 players,
slightly worse head to head. Next round: advantage weighting from the value head and a value-guided lookahead.

## What it is, and what it is not

**Delove** is our base model: a neural network trained only to play Risk well. It has no character, no chat, no
diary and no relationships. It looks at the board, scores the legal moves and picks one.

It is a **separate path** from the character work, and the two must not mix:

| | Delove, our base model (this document) | Characters |
| --- | --- | --- |
| Goal | play as strongly as possible | play *as someone*: personality, table talk, grudges |
| Brain | a small network trained by us on self-play | a language model (Ollama / OpenAI-compatible) reading `AI/` profiles |
| Code | `packages/delove` (new) on top of `packages/selfplay` | `packages/llm-player`, `packages/runner`, `AI/` |
| Learns from | millions of simulated games | diaries, findings, post-game lessons |
| Runs on | the training PC (Windows, RTX 4060) | the Mac mini next to the server |
| Versions | `delove@1`, `delove@2`, ... on the self-play ladder | character names, league ratings |

### Naming

Everything on this path is named **delove** so it never collides with a collaborator's model: player versions
`delove@1`, `delove@2`, ... and the teacher `delove-teacher@1` on the ladder, code in `packages/delove`, weights in
`models/delove/`. Another collaborator's base model gets its own name, package and folder, and the two compete on the
same ladder.

Keeping them apart lets us compare them later: the same ladder and the same tables can put `delove@N` against
`risky@1`, against each other and against characters, and tell us whether personality costs strength or adds it.
Later still, a character could use a base model as its move chooser and keep the personality for talk and
diplomacy; that is a choice to make with numbers in hand, not now.

Rules that keep the paths separate:

- The base model never reads `AI/` files, character memory or chat. Its only input is the board encoder
  (`packages/selfplay/src/encode.ts`).
- Character code never imports `packages/delove`; if it ever uses a base model, it does so as a player
  version it can call, the same way the ladder does.
- Model weights, datasets and run logs never go in the repo. They live in an ignored folder on the training PC
  (`runs/`, `data/`, `models/`).

## How it learns: transfer first, then sharpen

Training a Risk network from random play wastes most of the early compute on learning that attacking 1 army
with 20 is good. Instead, the first version **inherits** basic skill from a teacher (knowledge transfer /
distillation), and self-play then makes it better than the teacher.

### Stage 0: the teacher (`delove-teacher@1`)

Claude writes a stronger hand-coded player than `risky@1`, encoding what we already know about good Risk
(`AI/general-player/playbook.md`, `ways-to-win.md`, `findings.md`, plus standard strategy):

- take and hold continents by value per border to defend; break opponents' bonuses
- earn a card every turn; count opponents' hands and the next set value; trade at the right time
- eliminate weak players for their cards when it pays
- reinforce and fortify toward real threats, keep stacks on borders, not in the interior
- attack only with a payoff, using the engine's battle odds (`odds.ts`)
- capital rules under Capital Conquest

It lives with the other agents in self-play, plays deterministically from the seed like every agent, and must beat
`risky@1` on the ladder (score ≥ 0.55 over ≥ 200 mirrored games) before it is used as a teacher. The teacher is
the way Claude's Risk knowledge gets into the network: it can play millions of moves, which a chat session cannot.

Optional: a small set of positions where Claude picks the move directly (through the MCP or a script that asks
it), used as a high-quality test set to check the teacher and the student on hard situations. Too slow to be the
main training data.

### Stage 1: the student inherits (`delove@1`)

1. Self-play `delove-teacher@1` against itself and `risky@1`, logged (Classic, 2 players first), about 20,000 games.
2. `npm run selfplay -- export` into NumPy arrays (one encoder, the same one live play uses).
3. Train the network on two targets at once:
   - **policy:** which candidate the teacher picked (cross-entropy over the decision's candidates)
   - **value:** who won the game from this position (`z`)
4. Export to ONNX, load it in self-play as `delove@1` through `onnxruntime-node`.
5. Pass mark: `delove@1` scores about 0.5 against `delove-teacher@1` (it copied the skill) and clearly beats `risky@1`.

### Stage 2: sharpen with simulations (`delove@2`, `delove@3`, ...)

A loop, run overnight on the training PC:

1. **Play:** the current best plays many games against itself, older versions, `delove-teacher@1` and `risky@1`
   (a pool of opponents, so it does not learn to beat only itself). 20+ processes in parallel with `--start`.
2. **Learn:** train the next version on those games (policy improved toward moves that led to wins, value
   toward results), starting from the current best's weights.
3. **Gate:** the candidate plays the ladder against the current best. It is **promoted only** with ≥ 200 games,
   score ≥ 0.55 and the 95% interval above 0.5. Otherwise it is discarded and the best stays.
4. **Record:** every version's rating, games played and training settings go in the ladder file and a run log,
   so any improvement can be traced and any regression undone.

Applying learnings correctly means: a version only replaces the best when the ladder proves it is stronger, the
older versions stay in the opponent pool, and the anchor (`risky@1` at 1000 Elo) never moves.

Later improvements, once the loop works: a short lookahead at decision time (the value head judges positions after
the engine's battle odds), and more training from positions where the model lost.

### Stage 3: widen

In this order, each with its own ladder: 3 to 6 players → World map → capitals, blizzards and card settings →
fog of war (needs an encoder that sees only what the player sees; today's encoder sees the whole board, which is
why `export` skips fog games).

## The network

Small enough to train on an RTX 4060 (8 GB) in hours:

- per territory: the encoder's 27 features → a few rounds of message passing over the map's adjacency (a graph
  network), so it understands borders and continents on any map
- global features (phase, seats, cards, income) mixed in
- **policy head:** score each candidate from its own features plus the embeddings of its `from` / `to`
  territories, softmax over the decision's candidates
- **value head:** chance of winning for each seat slot

## Where things go

```
packages/delove/          new package, never imported by the server or the character code
  src/register.ts             registers Delove's players with the self-play CLI (`npm run delove -- ...`)
  src/net-worker.ts           runs the ONNX model in a worker thread (agents answer synchronously)
  src/seat.ts, seat-cli.ts    plays seats in real games over the HTTP API (`npm run delove-seat`)
  src/net-agent.ts            loads an ONNX model and registers it as delove@N for self-play / ladder
  src/teacher.ts              delove-teacher@1
  python/delove_model.py      the network
  python/train.py             distillation (Stage 1) and self-play training (Stage 2), PyTorch
  python/export_onnx.py
  README.md                   how to run each stage on the training PC
packages/delove-gpu/      training-only GPU mirror of the Classic 2-player rules, the tuned teacher and branch and
                          score (Python/PyTorch + CUDA kernels) that plays a cycle's Classic 2-player step and writes
                          its training arrays; checked against the TypeScript by replaying logged games
models/delove/                (ignored) delove@1.onnx, delove@2.onnx, ... + training settings per version
runs/, data/                  (ignored) game logs and exported datasets
```

## Training PC

Windows 11, i7-14700F (28 threads), 32 GB RAM, RTX 4060 8 GB. Measured: 200 logged two-player Classic games in
8.3 s on one core, so about 400 games/s with 20 processes. Exported data is about 2 GB per 1,000 two-player games:
export in batches and delete old exports once trained on. Python training runs in its own virtual environment
(`.venv`, Python 3.12 + PyTorch with CUDA).

## Milestones

1. ✅ `delove-teacher@1` beats `risky@1` on the ladder.
2. ✅ Training pipeline: export → `train.py` → ONNX → `delove@1` plays in self-play.
3. ✅ `delove@1` matches `delove-teacher@1` and beats `risky@1`.
4. The self-play loop promotes `delove@2` over `delove@1` on its own.
5. `delove@N` beats `delove-teacher@1` clearly (the network has gone past what we taught it).
6. Multi-player and World map ladders.
7. ✅ A way to seat `delove@N` in real games over the HTTP API (`npm run delove-seat`), to compare it with characters
   at the same tables.
