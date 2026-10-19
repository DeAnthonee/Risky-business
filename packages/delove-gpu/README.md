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
| `delove_gpu/fused.py` | the same rules with one CUDA thread per game (NVRTC, one compile per source, binary cached in `_cache/`), on the same tensors |
| `delove_gpu/teacher.py` | the hand-coded teacher (`packages/delove/src/teacher.ts`, any tuned numbers) inside the kernel |
| `delove_gpu/odds.py` | the blitz odds of `packages/engine/src/odds.ts` as exact double-precision tables for the teacher |
| `delove_gpu/branch.py` | branch and score (`packages/delove/src/branch.ts`): options, common-random-number rollouts, scores, pick |
| `delove_gpu/generate.py` | plays whole cycle tables (branch, teacher, network seats) and writes `export`'s training arrays directly |
| `delove_gpu/npy.py` | the `.npy` writer of `packages/selfplay/src/npy.ts` (same file layout) |
| `delove_gpu/encode.py` | the board encoder of `packages/selfplay/src/encode.ts` (ENCODER_VERSION 2) on tensors, in float64 rounded once to float32 as in JavaScript |
| `delove_gpu/play.py` | random moves, and a Delove network (`.pt` from `train.py`) choosing every move in one batched pass |
| `delove_gpu/logs.py` | reads decision logs (format v2) and compares records with the GPU state |
| `delove_gpu/fingerprint.py` | which engine the mirror was last verified against (`engine-fingerprint.json`), and the stale check |
| `verify.py` | re-verifies the mirror against the current engine and updates the fingerprint |
| `tests/replay.py` | the replay test (below) |
| `tests/teacher_replay.py`, `tests/branch_replay.py`, `tests/export_check.py`, `tests/dataset_compare.py` | the teacher, branch and training-array checks (below) |
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
  2.4e-7, float rounding, then; since the encoder computes in float64 like encode.ts, the difference is 0: bit-identical).
- Network: on the `delove@2` games the GPU network (PyTorch weights `delove@2.pt`, fp32) picks exactly the move the
  ONNX model picked in Node on 24,418 of 24,418 decisions with more than one candidate. ONNX Runtime and PyTorch sum
  in different orders, so a near-tie can swap: a later run had 13,185 of 13,186, the other one with the two logits
  3.8e-6 apart. The test reports such near-ties (within 1e-4) separately and fails on any other difference.
- The test fails when it should: an extra die per attack, +1 income on turn 7 or a wrong 4th card value each fail
  every game that reaches them.
- `tests/blitz_stats.py`: 200,000 battles per starting pair (2 v 1 up to 150 v 40) match the exact outcome
  distribution for both samplers (largest |z| 1.64 over 11 pairs).

## The teacher, branch and score, and training data on the GPU

A training cycle's Classic 2-player step runs here end to end (`delove_gpu/generate.py`): the branch-and-score player,
its opponents (the tuned teacher and Delove networks) and the training arrays, with no JSONL logs and no `export`:

```bash
.venv/Scripts/python -m delove_gpu.generate --models models/delove --ranker c2-candidate --horizon 1 --margin 0.01 --seed 303 \
  --table "c2d 2000 delove-branch@1,delove@2" --table "c2c 2000 c2-candidate,delove-branch@1" \
  --table "c2t 2000 delove-branch@1,delove-teacher@2" --batch 6000 --out data/delove/c3-classic2 --summary runs/c3-classic2.json
```

(run from `packages/delove-gpu`; `--out` is a dataset folder `train.py --data` reads, `--summary` has the branch statistics
of `scripts/summary.mjs` and each table's results). A table is `NAME GAMES AGENT,AGENT [START]` as in a jobs file; game
i is seeded and seated exactly as `play` does it, so a table here is the same set of games as on the CPU. The rollout
teacher is the newest `delove-teacher@N.json` in `--models` (`--teacher`), the branch settings default to
`DEFAULT_BRANCH` in `branch.ts` (read from the file), networks play from their `.pt` weights in fp32.

- **The teacher** (`teacher.py`) is `teacherPickWith(params)` in CUDA, one thread per game, inside the same kernel as the
  rules. It must pick exactly what teacher.ts picks, ties included: every score is built with the same double-precision
  operations in the same order (compiled with `--fmad=false`, so no fused multiply-adds), the 1e-3 tie-break jitter
  comes from the seat's own mulberry32 stream, candidates are visited in actions.ts order (fortify destinations in the
  engine's connected-search order), and the blitz odds are `odds.ts`'s numbers bit for bit (`odds.py` fills the tables
  with allIn()'s exact arithmetic; fit()'s scaling for huge stacks is reproduced in the kernel).
- **Branch and score** (`branch.py`) follows `branchAgent`: the teacher's move first, then the ranker's favourites
  (logits descending, ties in candidate order); fortify options completed by the teacher and the rollout seeds drawn
  from the seat's stream in the same order; options x rollouts board copies (common random numbers: rngState = seed,
  deck reshuffled with mulberry32(seed ^ 0x5bd1e995)), each played `horizon` rounds by the teacher in one CUDA thread;
  `positionScore` in double precision, averaged seed by seed with true division (a CUDA tensor divided by a Python
  number is multiplied by the reciprocal, which differs from JavaScript in the last bit), and the `margin` rule.
- **Training arrays** (`generate.py` Recorder, `npy.py`): export.ts's files and `features.json`, with the feature names
  and versions read from the built self-play package. The encoder computes in float64 and rounds to float32 once, as
  encode.ts stores doubles into a Float32Array, so the arrays are bit-identical to `export`'s.

What is not on the GPU: the micro (Four Crowns) and 4-player steps of a cycle (the rules mirror is Classic 2-player
only), `risky@1` opponents and `-explore` (sampling) network seats. Those steps stay on the CPU.

### Proof that they match the TypeScript

```bash
# the teacher: the logged pick at every step of logged teacher games
npm run delove -- play --agents delove-teacher@2,delove-teacher@2 --games 1000 --seed 21 --log runs/gpu-verify/t2t2
.venv/Scripts/python packages/delove-gpu/tests/teacher_replay.py runs/gpu-verify/t2t2 --agent delove-teacher@2 --params models/delove/delove-teacher@2.json
# branch and score: CPU branch games with DELOVE_BRANCH_TRACE (each branched decision's options and mean scores)
DELOVE_BRANCH_RANKER=c2-candidate DELOVE_BRANCH_HORIZON=1 DELOVE_BRANCH_MARGIN=0.01 DELOVE_BRANCH_TRACE=runs/gpu-verify/trace-c2t.jsonl \
  npm run delove -- play --agents delove-branch@1,delove-teacher@2 --games 100 --seed 303 --log runs/gpu-verify/c2t
.venv/Scripts/python packages/delove-gpu/tests/branch_replay.py runs/gpu-verify/c2t --trace runs/gpu-verify/trace-c2t.jsonl \
  --models models/delove --ranker c2-candidate --horizon 1 --margin 0.01
# training arrays: the GPU writer on the same log against export, bit for bit
npm run delove -- export --log runs/gpu-verify/c2t --out runs/gpu-verify/c2t-export --only-agents delove-branch@1
.venv/Scripts/python packages/delove-gpu/tests/export_check.py runs/gpu-verify/c2t runs/gpu-verify/c2t-export
# whole datasets, game by game (GPU-generated vs CPU play + export of the same tables and seeds)
.venv/Scripts/python packages/delove-gpu/tests/dataset_compare.py data/delove/c3-classic2/classic runs/cpu/c3-classic2-export/classic
```

Results (2026-10-19, `delove-teacher@2`, ranker `c2-candidate`, cycle 3's settings):

| check | what was compared | result |
| --- | --- | --- |
| `teacher_replay.py` | 1,000 `delove-teacher@2` self-play games | 275,993 of 275,993 decisions: the logged pick (0 mismatches); with delove-teacher@1's numbers instead every game fails at its first placements |
| `branch_replay.py` | 300 branch games, the three cycle tables (`c2t`, `c2d`, `c2c`, 100 each) | 37,633 of 37,633 branch decisions: the same pick; 19,639 branched decisions with the CPU's options: every option's mean score identical (same doubles); 1 decision where the ranker ordered its two alternatives differently (a near-tie between the ONNX logits in Node and the PyTorch ones here; the pick was the same) |
| `branch_replay.py` at branch.ts's defaults (horizon 2, margin 0.02, ranker `delove@2`; `verify.py`, fresh seeds) | 100 branch games against Sensei 2 | 13,021 of 13,021 decisions: the same pick; all 6,965 branched decisions with identical mean scores |
| `export_check.py` | the `c2t` log's 13,600 branch decisions, 196,341 candidates | every array bit for bit equal to `export`'s, candidate order included |
| `dataset_compare.py` | cycle 3's whole Classic 2-player step played on the GPU vs on the CPU (6,000 games, same seeds) | 6,000 of 6,000 games identical, row for row |

That last run also reproduces cycle 3's own statistics in [CYCLES.md](../delove/CYCLES.md) exactly: 757,268 branching
decisions, 395,729 branched, 7,099,734 simulations of 89,623,920 moves, 111,930 changes (attack 58,195/221,119, place
29,088/114,748, end_turn 10,122/18,601, fortify_from 9,170/26,503, trade 5,355/14,758), same wins per table. The only
expected difference is the ranker near-tie above (about 1 in 20,000 branched decisions; when it changes a pick, the
game diverges from the CPU's from there on, equally valid).

### Speed of a cycle step

Cycle 3's Classic 2-player step (`c3-classic2.jobs`: 6,000 games, branch player against `delove@2`, `c2-candidate` and
Sensei 2; ranker `c2-candidate`, horizon 1, margin 0.01), on the training PC:

| | CPU: `cycle.sh`'s pool, 27 processes | GPU: `generate.py`, 6,000 games in flight | |
| --- | --- | --- | --- |
| play the games | 314.6 s (logs written) | | |
| export the branch decisions (788,260) | 28.0 s | | |
| **games to training arrays** | **342.6 s** | **72-73 s** (75-77 s with start-up) | **4.6x** |

Where the GPU's time goes (profiled, without writing arrays, ~63 s): the rollouts' teacher kernel 28 s (89.6M moves),
the networks 21 s (ranker `c2-candidate` 15 s, `delove@2` seats 6 s, fp32 for the same moves as ONNX), the encoder 7 s,
per-step overhead the rest. The run is lockstep: 99% of games end by step 603 but the longest takes 1,627 steps, and
the last 1% costs 17 s of thin steps. On its own the GPU teacher plays **18,346 games/s** (65,536 games in flight,
5.0M decisions/s), 49x the whole CPU's 376 games/s; one thread per game is latency-bound (block size and a cached
placement score changed nothing), so the next gains are in that kernel (divergence between phases, local-memory
layout) and in batching the tail (fewer, larger steps; a teacher seat's whole turn per step).

In a whole cycle the GPU takes this step off the CPU pool, so the CPU's 27 threads only play the micro and 4-player
steps meanwhile. Cycle 3 generated all three steps in one 9.0-minute pool; the Classic 2-player step alone takes 5.7
minutes of that pool's 27 threads (the table above), 1.25 minutes on the GPU.

## Keeping the mirror in step with the engine

The mirror is only right for the engine it was checked against. `engine-fingerprint.json` records hashes of the engine
and self-play files it copies (`RULE_FILES` in `delove_gpu/fingerprint.py`: `engine.ts`, `cards.ts`, `rng.ts`,
`types.ts`, `maps.ts`, the Classic map JSON, self-play's `actions.ts`, `encode.ts`, `log.ts`, `game.ts`,
`traits.ts`, `export.ts`, `npy.ts`, and Delove's `teacher.ts`, `branch.ts` with the engine's `odds.ts`), written only
after logs made with exactly those files replayed identically.

- **Training refuses a stale mirror.** `Engine(...)`, `FusedEngine(...)`, `TeacherEngine(...)` and `BranchEngine(...)`
  raise `StaleMirror` when any of those files changed since the last verification (or the last verification did not
  cover that layer: rules, teacher, branch), so GPU-generated training data always comes from a verified mirror. The
  replay tests and the benchmarks pass `allow_unverified=True` (`generate.py --allow-unverified`); nothing that makes
  training data should.
- **CI warns, never blocks.** `.github/workflows/ci.yml` runs `fingerprint.py check --github`: a PR that changes one of
  those files gets a "GPU mirror needs re-verifying" warning. Engine and server work is never held up by this
  training-only package (CI has no GPU to run the replay on anyway).
- **Re-verify on the training PC** after such a change is merged:

  ```bash
  .venv/Scripts/python packages/delove-gpu/delove_gpu/fingerprint.py check   # what changed
  .venv/Scripts/python packages/delove-gpu/verify.py --model models/delove/delove@2.pt --models models/delove
  ```

  `verify.py` builds the packages, plays fresh logged games with the current engine (new seeds each run: teacher,
  `risky@1`, random to the turn limit, a network player with `--model`; with `--models` the newest tuned teacher
  against itself and branch games at branch.ts's defaults and at the cycle settings, with traces), replays them
  through `engine.py` and `fused.py` with the encoder and network checks, then the teacher, branch and training-array
  checks, and writes the fingerprint only if every step matches. Commit the
  fingerprint (with any mirror fixes) in a PR. A change that does not touch the rules (a refactor, a comment) only
  needs the run; a mismatch means the mirror needs the same change, made in `packages/delove-gpu`, never the engine.

A hash changes for any edit, so the check can be stale without anything being wrong; the run settles it in a few
minutes.

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
| `delove-teacher@1` / `@2` (hand-coded; `bench.py --policy teacher`) | 32 games/s | 376 games/s | **18,346 games/s** (`teacher.py`, 65,536 games; 5.0M decisions/s) | **49x** |

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

## What is left

Done (above): the rules, the tuned teacher, branch and score and the training arrays of a cycle's Classic 2-player step,
each verified against the TypeScript. In rough order of what would speed a cycle up further:

1. **The other cycle steps:** 3-6 players (turn order with eliminations, the `neutrals` option instead of the
   2-player Neutral) for the 4-player step, and other maps (Four Crowns for the micro step; World): map data is already
   read from the engine's JSON; continents, starting armies (`classicScaled`) and sizes become parameters of the
   kernel source. Then capitals, fixed/exponential cards, blizzards, balanced blitz. Each needs logs with that setting
   in the replay tests first; the teacher's capital and blizzard branches are not mirrored yet either.
2. **A faster teacher kernel** (the rollouts are 40% of the GPU step): less divergence between threads in different
   phases, a smaller per-thread board, fewer recomputations between a move's two fortify steps.
3. **The lockstep tail:** let teacher seats play whole turns per step and start the next cycle step's games while the
   last long games finish, so thin steps stop costing a full kernel latency each.
4. **Other players in the pool:** `risky@1` (`packages/engine/src/bot.ts`, short) and sampling (`-explore`) network
   seats, which need ONNX-identical sampling arithmetic.
5. **cycle.sh wiring:** run the Classic 2-player step with `generate.py` (writing its dataset folder directly) while
   the CPU pool plays the other steps. Left out of this change on purpose: the cycle scripts are being changed in
   the cycles 2-4 PR (#74).
