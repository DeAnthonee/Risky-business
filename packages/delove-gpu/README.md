# delove-gpu: Risk self-play on the GPU (training-only prototype)

**A training-only mirror of the engine's rules.** `packages/engine` (TypeScript) is the authority on the rules. This
package re-implements a subset of them on GPU tensors so Delove's training simulations can run many thousands of
games at once. It is trusted only as far as the replay tests below show: it must play exactly the same game as the
engine, step for step, on logged self-play games. A mismatch is a bug here, never a reason to change
`packages/engine`. Nothing here is imported by the server, the client or the character code, and it never runs a
live game. (Plan and context: [docs/delove.md](../../docs/delove.md), [packages/delove](../delove/README.md).)

Python + PyTorch (CUDA), not an npm workspace. Uses the repo's `.venv`:

```bash
.venv/Scripts/python -m pip install -r packages/delove-gpu/requirements.txt
```

## What it covers

The Classic map, 2 players plus the classic Neutral, with `DEFAULT_OPTIONS`: random deal, setup placement one army at
a time, reinforcements (territories / 3, at least 3, continent bonuses, first-round bonus), progressive card sets,
optional trades and forced trades at 5 cards (the engine's `bestSet` choice), blitz attacks with the real dice
(3 attack dice against up to 2), occupy, connected fortify (in the two self-play steps), end turn, card draw and
reshuffle, elimination with card capture, the win condition and the turn limit.

Moves are the self-play action space (`packages/selfplay/src/actions.ts`) laid out as one fixed index space of 432
moves; legal moves are a `[games, 432]` mask. Not covered yet: capitals, fog of war, blizzards, neutrals option,
fixed / exponential cards, balanced blitz, adjacent fortify, 3-6 players, maps other than Classic. The code keeps
the map, seat count and options as data (`mapdata.py`, `Engine(n_seats=...)`) so they can be added.

| file | what |
| --- | --- |
| `delove_gpu/mapdata.py` | map data read from the engine's own `packages/engine/src/generated/classic.json` (never copied) |
| `delove_gpu/rng.py` | the engine's mulberry32 as a counter-based generator on tensors, one stream per game |
| `delove_gpu/engine.py` | the rules as batched tensor operations: the readable reference (`exact=False`: faster sampling, below) |
| `delove_gpu/fused.py` | the same rules with one CUDA thread per game (NVRTC via `torch.cuda._compile_kernel`), on the same tensors |
| `delove_gpu/encode.py` | the board encoder of `packages/selfplay/src/encode.ts` (ENCODER_VERSION 2) on tensors |
| `delove_gpu/play.py` | random moves, and a Delove network (`.pt` from `train.py`) choosing every move in one batched pass |
| `delove_gpu/logs.py` | reads decision logs (format v2) and compares records with the GPU state |
| `tests/replay.py` | the replay test (below) |
| `tests/blitz_stats.py` | battle outcomes against the exact dice distribution |
| `bench.py`, `bench_cpu.mjs` | GPU and CPU throughput |

Every game carries its own mulberry32 stream seeded like `createGame(seed)`, so with the same seed and the same
choices a game here *is* the engine's game: same deal, same dice, same reshuffles. `fused.py` does the same in a
CUDA kernel. `engine.py` with `exact=False` instead uses torch's generator, shuffles by sorting random keys, and
resolves runs of 3-against-2 dice rolls with one multinomial draw: same probabilities, not the same numbers.

## Proof that it plays the same game

```bash
npm run delove -- play --agents delove-teacher@1,delove-teacher@1 --games 1000 --seed 11 --log runs/gpu-verify/tt
cd packages/delove-gpu
../../.venv/Scripts/python tests/replay.py ../../runs/gpu-verify/tt            # engine.py
../../.venv/Scripts/python tests/replay.py ../../runs/gpu-verify/tt --fused    # fused.py
```

For every decision step of every logged game the GPU state must equal the record: owners and armies of every
territory; each seat's alive flag, card count, armies to place and income; the decider's hand (ids, in order); the
trade count and personal trades; the pending conquest; the conquered and fortified flags; turn order, phase, turn and
round. The GPU's legal moves must be exactly the record's candidate list (as a set). Then the logged choice is played.
When a game's records end, the GPU game must be over the same way (same winner, or the turn limit). Options:
`--export DIR` also compares the GPU encoder with the arrays `npm run delove -- export` wrote from the same log;
`--net AGENT MODEL.pt` checks that the GPU network's top move is AGENT's logged move.

One thing the log does not record: the order an agent listed a trade's cards in. It decides which owned territory gets
the +2 and the order the cards go on the discard pile. Self-play candidates (every Delove player) send them sorted
by id, as the GPU engine does; `risky@1` sends `tradeableSets[0]`, in hand order. The test replays `risky@1`'s
trades in hand order (`HAND_ORDER_TRADERS` in `tests/replay.py`) and says how many it did.

Results (2026-10-19, logs in the ignored `runs/gpu-verify/`):

| log | games | decision steps | `engine.py` | `fused.py` |
| --- | --- | --- | --- | --- |
| `delove-teacher@1` vs itself | 1,000 | 294,579 | identical | identical |
| `risky@1` vs `delove-teacher@1` (1,462 hand-order trades) | 1,000 | 267,756 | identical | identical |
| `delove@2-explore` vs `delove-teacher@1` | 300 | 84,552 | identical | identical |
| `delove@2` vs `delove-teacher@1` | 200 | 51,528 | identical | identical |
| `random@1` vs itself (499 of 500 reach the 500-turn limit: long hands, reshuffles, huge stacks) | 500 | 1,416,395 | identical | identical |
| **total** | **3,000** | **2,114,810** | **0 mismatches** | **0 mismatches** |

- Encoder: on all 84,552 decisions of the `delove@2-explore` log the GPU features equal `export`'s (largest difference
  2.4e-7, float rounding).
- Network: on the `delove@2` games the GPU network (PyTorch weights `delove@2.pt`, fp32) picks exactly the move the
  ONNX model picked in Node on 24,418 of 24,418 decisions with more than one candidate.
- The test fails when it should: an extra die per attack, +1 income on turn 7 or a wrong 4th card value each fail
  every game that reaches them.
- `tests/blitz_stats.py`: 200,000 battles per starting pair (2 v 1 up to 150 v 40) match the exact outcome
  distribution for both samplers (largest |z| 1.64 over 11 pairs).

## Speed

All on the training PC (i7-14700F, 28 threads; RTX 4060 8 GB), Classic 2-player, both seats the same player. CPU:
`node packages/delove-gpu/bench_cpu.mjs` (TypeScript self-play, no logging, one process per hardware thread). GPU:
`python bench.py` (games restart as they finish; 20-40 s measured after a warm-up). The two count decisions a little
differently (a fortify is one engine decision on the CPU, two steps on the GPU), so compare games per second.

| player | CPU, 1 core | CPU, 28 processes | GPU | GPU vs whole CPU |
| --- | --- | --- | --- | --- |
| random moves (games run to the 500-turn limit, ~2,840 steps) | 4.2 games/s | 42.6 games/s | **16,361 games/s** (`fused`, 65,536 games; 43.8M steps/s) | **384x** |
| `delove@2` network, fp32 (same moves as Node) | 3.9 games/s | 40 games/s | **258 games/s** (`fused`, 4,096-8,192 games; 66k decisions/s) | **6.5x** |
| `delove@2` network, fp16 weights | | | **522 games/s** (`fused`, 8,192 games; 132k decisions/s) | **13x** |
| `delove-teacher@1` (hand-coded, not on the GPU yet) | 32 games/s | 376 games/s | | |

By batch size (games in flight), games per second:

| engine, player | 1,024 | 4,096 | 16,384 | 65,536 |
| --- | --- | --- | --- | --- |
| `fused`, random (moves chosen in the kernel) | 1,546 | 5,256 | 9,004 | 16,361 |
| `fused`, `delove@2` fp32 | 215 | 258 | ~268 (66k decisions/s) | slower: activations overflow 8 GB |
| `fused`, `delove@2` fp16 | 378 | 509 | 501 | |
| `engine.py` exact, random | | | ~76 (217k steps/s) | ~246 (698k steps/s) |
| `engine.py` fast sampling, random | | | ~193 (547k steps/s) | ~323 (916k steps/s) |

(`engine.py` rows: no random game finishes inside the window, so games/s = steps/s / 2,837 steps per game. The fp32
16,384 row likewise: the window was too short for a steady mix of game lengths, so it is decisions/s / ~250.)

What the numbers say:

- **The rules are not the problem on a GPU.** One CUDA thread per game runs a whole game of random moves in a few
  microseconds of GPU time: 384x the whole CPU, about 3,900x one core. The tensor version (`engine.py`) is only a
  few times faster than the CPU: hundreds of small launches per move (30-60 ms a step whatever the batch) and a
  synchronisation per dice roll in blitzes. It stays as the readable reference; `fused.py` is the one to build on.
- **With the network choosing every move, the network is the cost.** delove@2 is ~50 MFLOP per decision (4 rounds
  of a 384-256-128 MLP over 42 territories); a step spends ~85% of its time in it. 6.5x the CPU in fp32, 13x in fp16
  (fp16 picks a different top move on ~2% of decisions, near-ties; TF32 is 18% faster than fp32 and differs on
  0.14%). Beyond ~8k games the GPU is saturated and larger batches only cost memory.

## What is left before it could replace CPU generation in a training cycle

Measured here: the GPU runs the rules 100x+ faster than the CPU, and the network at 6.5-13x. A training cycle's
simulations are neither of those yet: branch and score (`packages/delove/src/branch.ts`) plays ~100-240M rollout moves
per cycle with the hand-coded teacher in every seat. In rough order:

1. **The rollout teacher on the GPU.** Port `delove-teacher@1/@2` (`packages/delove/src/teacher.ts`, ~470 lines, plus
   the blitz odds of `packages/engine/src/odds.ts`) into the fused kernel, one thread per game like the rules, and
   verify it the same way: replay teacher logs and require the GPU teacher's choice to equal the logged choice at
   every step (it is deterministic from the seed, and the odds are double-precision arithmetic CUDA can reproduce in
   the same order). Not measured: a teacher move costs more than a random one (it scores every candidate; the odds
   can be a lookup table), so expect well below 43M steps/s. Even a tenth of that would be ~40x the CPU's ~105k
   teacher decisions/s. This piece decides the speedup of a cycle.
2. **Branch and score as a GPU driver.** Copy a decision's position into options x rollouts games (the state is a set
   of tensors, so a copy is an index), give each copy its own seed and reshuffled deck as `branch.ts` does, play the
   horizon (2 rounds) in the kernel, score the positions (`positionScore`: sums over tensors) and pick. The network
   that proposes the options is one batched call for every game at a decision.
3. **Training data straight from the GPU.** The encoder already runs there and matches `export`, so a GPU generator
   can write the `.npy` arrays `train.py` reads, skipping JSONL logs and `export` (today 33 GB per 5.8M decisions).
4. **More of the rules:** 3-6 players (turn order with eliminations, the `neutrals` option instead of the 2-player
   Neutral), other maps (Four Crowns micro games, World: map data is already read from the engine's JSON; continents,
   starting armies (`classicScaled`) and sizes become parameters of the kernel source), then capitals,
   fixed/exponential cards, blizzards, balanced blitz. Each needs logs with that setting in the replay test first.
5. **Other players in the pool:** `risky@1` (`packages/engine/src/bot.ts`, short) for opponent variety. Network
   versions already work through `NetPlayer`.

**Recommendation: worth finishing, starting with the teacher.** The open question was whether a GPU mirror can be
exactly right and still fast. It can: 2.1M decision steps identical on two independent GPU implementations, and the
kernel runs the rules hundreds of times faster than the whole CPU. What remains is mostly porting known code into the
same kernel and checking it the same way. The costs: every rules change in `packages/engine` has to be mirrored here
(the replay test catches drift, so it should run whenever the engine changes), and if training moves to the network
choosing rollout moves, the network sets the pace (6.5-13x on this card; a smaller rollout network would raise it).
