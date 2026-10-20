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

**Every map, every table size and every game setting but fog of war** (`fused.py`, `teacher.py`, `branch.py`,
`generate.py`): the ten verified maps of `MAP_IDS` (classic, world, world_large, europe, greater_europe with 116 territories,
europe_classic, usa, asia, fantasy, skirmish / Four Crowns), plus bohemia (Bohemia, 42 territories) and nine_realms (The Nine Realms, 58
territories), which are wired into `RULE_FILES` and the rules matrix but **not yet verified** (its replay proof is pending), 2 to 10 seats up to each map's player limit, and these
settings in any combination: capitals and `chooseCapitals`, card values (progressive, fixed, exponential), fortify mode
(connected, adjacent), balanced blitz, blizzards, `firstRoundBonus`, `setupBatch`, `autoSetup`, `randomDeal` (the
claiming phase) and `neutrals` / `neutralArmies`. That is the whole game: the deal (random or claimed), setup,
capitals chosen or assigned, reinforcements (territories / 3, continent bonuses over open territories, capitals,
the first-round bonus), card trades and forced trades (the engine's `bestSet`), blitz attacks with the real dice
(3 defence dice on capitals, the median of 5 runs with balanced blitz), occupy, fortify, 3+ player turn order,
elimination with card capture, the Neutral at 2 players and the neutral territories at 3+, the win conditions
(domination, every capital) and the turn limit; and the outcome training reads (log v3: z, and the leaderboard's
placements, kills and points, `outcome.py`).

A configuration (`delove_gpu/config.py`: map, seats, settings) is checked like `validateOptions` checks it. Every map
fact it rests on (the territories, adjacency in the engine's own order and continents from
`packages/engine/src/generated/<id>.json`; `STARTING_ARMIES` per table size, the player limit, the blizzard limit and
`DEFAULT_OPTIONS`) is read from the engine itself, never copied. The configuration is compiled into the CUDA source as
constants: one NVRTC compile per configuration (about a minute; the binary is cached in `_cache/`, so later runs load
it at once).

Moves are the self-play action space (`packages/selfplay/src/actions.ts`) laid out as one fixed index space per map
(3T place + 10 trades + one attack per directed edge + 3 occupy + T fortify sources + 2T fortify destinations + end
turn + T capitals: 256 moves on Four Crowns, 474 on Classic, 1,326 on Greater Europe); legal moves are a
`[games, A]` mask, and `cand_order()` lists them in actions.ts order. `engine.py` (the tensor reference) stays Classic
2-player with the default settings.

| file | what |
| --- | --- |
| `delove_gpu/config.py` | `GameConfig` (map, seats, settings) and the map facts read from the built engine |
| `delove_gpu/mapdata.py` | map data read from the engine's own `packages/engine/src/generated/<id>.json` (never copied) |
| `delove_gpu/rng.py` | the engine's mulberry32 as a counter-based generator on tensors, one stream per game |
| `delove_gpu/engine.py` | `State` (the tensors of B games of one configuration) and the rules as batched tensor operations for Classic 2-player: the readable reference (`exact=False`: faster sampling, below) |
| `delove_gpu/fused.py` | the rules of any configuration with one CUDA thread per game (NVRTC, one compile per configuration, binary cached in `_cache/`) |
| `delove_gpu/teacher.py` | the hand-coded teachers inside the kernel: Sensei (`packages/delove/src/teacher.ts`, `delove-teacher@N`) and Jacob Sensei (`packages/delove/src/jacob.ts`, `jacob-sensei@N`), any tuned numbers, several versions at one table |
| `delove_gpu/odds.py` | the blitz odds of `packages/engine/src/odds.ts` as exact double-precision tables for the teacher (both defence-dice limits, balanced blitz, every stack size) |
| `delove_gpu/branch.py` | branch and score (`packages/delove/src/branch.ts`): options, common-random-number rollouts, scores, pick |
| `delove_gpu/generate.py` | plays whole cycle steps (any mix of configurations; branch, teacher and network seats) and writes `export`'s training arrays directly |
| `delove_gpu/ladder.py` | ladder matches (candidate vs best, mirrored pairs): the games and the JSON of `npm run delove -- ladder`; cycle.sh's GPU gates |
| `delove_gpu/outcome.py` | a finished game's z and leaderboard placements, kills and points (`finalPlacements`, `gamePoints`) |
| `delove_gpu/npy.py` | the `.npy` writer of `packages/selfplay/src/npy.ts` (same file layout) |
| `delove_gpu/encode.py` | the board encoder of `packages/selfplay/src/encode.ts` (ENCODER_VERSION 2) on tensors, in float64 rounded once to float32 as in JavaScript |
| `delove_gpu/play.py` | random moves, and a Delove network (`.pt` from `train.py`) choosing every move in one batched pass |
| `delove_gpu/logs.py`, `delove_gpu/packed.py` | read decision logs (format v2 and v3) and compare records with the GPU state (`packed.py`: as flat vectors, a whole batch at once) |
| `delove_gpu/fingerprint.py` | which engine the mirror was last verified against (`engine-fingerprint.json`), and the stale check |
| `scripts/balanced_odds.mjs` | odds.ts's balanced-blitz chance for the odds tables, computed by V8 (its `Math.pow`) |
| `verify.py` | re-verifies the mirror against the current engine and updates the fingerprint |
| `tests/replay.py` | the replay test (below): rules, teacher picks, outcome, encoder, network |
| `tests/matrix.py` | the replay proof over every map, table size and setting (CPU logs in parallel, GPU replays) |
| `tests/teacher_replay.py`, `tests/branch_replay.py`, `tests/export_check.py`, `tests/dataset_compare.py`, `tests/odds_check.py`, `tests/log1p_check.py` | the teacher, branch, training-array, odds and `Math.log1p` checks (below) |
| `tests/ladder_compare.py` | a ladder match on the CPU (`--log`) against the same match on the GPU, game by game |
| `tests/blitz_stats.py` | battle outcomes against the exact dice distribution |
| `bench.py`, `bench_cpu.mjs`, `bench/` | GPU and CPU throughput; `bench/bench_cycle.sh` times a cycle step on both |

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
round; every seat's capital and the blizzards. The GPU's legal moves must be exactly the record's candidate list, in
the same order (actions.ts order: what the training arrays and every network's tie-breaking rely on; `--slow`, the
per-game loop the encoder and network checks use, compares them as a set). Then the logged choice is played. When a
game's records end, the GPU game must be over the same way (same winner, or the turn limit), and on log v3 every
seat's outcome must match: placement, kills, leaderboard points and z. The game settings come from `options.json` in
the log folder (`tests/matrix.py` writes it), the map and table size from the records. Options: `--teacher
AGENT[=PARAMS.json]` (repeatable) checks that the GPU teacher picks AGENT's logged candidate at every step AGENT
decided; `--export DIR` also compares the GPU encoder with the arrays `npm run delove -- export` wrote from the same
log; `--net AGENT MODEL.pt` checks that the GPU network's top move is AGENT's logged move.

One thing the log does not record: the order an agent listed a trade's cards in. It decides which owned territory gets
the +2 and the order the cards go on the discard pile. Self-play candidates (every Delove player) send them sorted
by id, as the GPU engine does; `risky@1` sends `tradeableSets[0]`, in hand order. The test replays `risky@1`'s
trades in hand order (`HAND_ORDER_TRADERS` in `tests/replay.py`) and says how many it did.

Classic 2-player results (2026-10-19, from #72; logs in the ignored `runs/gpu-verify/`):

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

### Every map, table size and setting

```bash
cd packages/delove-gpu
../../.venv/Scripts/python tests/matrix.py --suite rules --out ../../runs/gpu-verify/m-rules --scale 3 --models <models dir>
../../.venv/Scripts/python tests/matrix.py --suite settings --out ../../runs/gpu-verify/m-settings --models <models dir>
../../.venv/Scripts/python tests/matrix.py --suite branch --out ../../runs/gpu-verify/m-branch --scale 0.5 --models <models dir>
../../.venv/Scripts/python tests/matrix.py --suite net --out ../../runs/gpu-verify/m-net --models <models dir>
```

`tests/matrix.py` plays the logged CPU games of a suite in parallel (the TypeScript engine and agents, `options.json`
next to each log) and replays every log through `fused.py` with `replay.py`: the board, cards, capitals, blizzards,
phase and the candidate list in order at every step, the teacher's pick at every step of `delove-teacher@1` and
`delove-teacher@2` (Sensei 2) seats, and every seat's outcome at the end. Results (2026-10-20, logs in the ignored
`runs/gpu-verify/`):

| suite | what | games | decision steps | result |
| --- | --- | --- | --- | --- |
| `rules` (scale 3) | all 10 maps at 2 seats, a middle size and the map's largest table (60 configurations up to 10 players): Sensei 2, delove-teacher@1 and `risky@1` seats (900 games per table up to 4 seats, 450 above), and random players (120 / 60) | 22,440 | 39,698,293 | **0 mismatches**; 30,842,705 of 30,842,705 teacher picks; 12,160 of 12,160 v3 outcomes (placement, kills, points) |
| `settings` | 15 combinations of the settings (each alone, then all at once, with the claiming phase and with auto setup) on Classic 2p, Four Crowns 3p, World 6p, Greater Europe 10p | 7,020 | 10,378,222 | **0 mismatches**; 7,941,185 of 7,941,185 teacher picks; 7,020 of 7,020 outcomes |
| `net` | `delove@3` seats on Classic 2p, Four Crowns 4p, World 8p, Greater Europe 10p (capitals, blizzards), Realms of Halvaren 6p (exponential cards, adjacent fortify, claiming) | 196 | 182,770 | **0 mismatches**; GPU network top move = the ONNX move logged in Node on 74,074 of 74,074 decisions |
| `branch` (scale 0.5) | `delove-branch@1` (ranker `delove@3`, horizon 1, margin 0.01) on Four Crowns 2p / 4p, Classic 2p / 4p, World 6p, Greater Europe 10p, and four tables with settings | 442 | 264,095 | **0 mismatches** in the rules and teacher; 98,968 of 98,970 branch decisions the same pick; of 56,398 branched decisions, 56,381 compared the CPU's options and got every option's mean score identical (same doubles), 17 had the ranker order two alternatives differently (ONNX vs PyTorch near-ties; the 2 different picks are among them) |
| `jacob` (scale 0.5, 2026-10-20) | Jacob Sensei (`jacob-sensei@1`): self-play on all 10 maps at 2 seats, a middle size and the largest table; mixed with Sensei 2 and `risky@1` above 2 seats; the 15 settings combinations on Classic 2p, Four Crowns 3p, World 6p, Greater Europe 10p (Jacob and Sensei 2 seats); branch and score with Jacob as the rollout teacher (`jb-*`: Four Crowns 2p, Classic 2p / 4p, World 6p, Greater Europe 10p, two tables with settings) | 3,955 | 3,414,946 | **0 mismatches**; 3,213,258 of 3,213,258 teacher picks (Jacob, Sensei 2, delove-teacher@1 seats); 3,955 of 3,955 outcomes; 25,124 of 25,125 branch decisions the same pick, all 13,700 branched decisions with the CPU's options with identical mean scores, 1 ranker near-tie (the different pick) |

Also: `odds_check.py` 6,000 of 6,000 battles bit-identical to `blitzOdds` (win, balancedWin, losses; up to 10^6 attackers,
both dice limits); `export_check.py` bit for bit on Four Crowns 4p (fixed cards, capitals), World 6p (blizzards,
adjacent fortify, neutrals) and Classic 2p branch logs (8,124 decisions, `points` / `points01` included); and a mixed
jobs file (Four Crowns 4p exponential, Classic 2p, World 6p capitals + balanced blitz) generated on the GPU with
`generate.py` gave 152 of 152 games identical to CPU play + `export` (`dataset_compare.py`).

## The teacher, branch and score, and training data on the GPU

Every step of a training cycle runs here end to end (`delove_gpu/generate.py`): the branch-and-score player, its
opponents (the tuned teacher and Delove networks) and the training arrays, on any map, table size and covered setting,
with no JSONL logs and no `export`:

```bash
.venv/Scripts/python -m delove_gpu.generate --models models/delove --ranker c3-candidate --horizon 1 --margin 0.01 --seed 304 \
  --jobs ../delove/scripts/cycles/c4-micro.jobs --jobs ../delove/scripts/cycles/c4-classic2.jobs \
  --jobs ../delove/scripts/cycles/c4-classic4.jobs --out data/delove/c4-gpu --summary runs/c4-gpu.json
```

(run from `packages/delove-gpu`; `--out` is a dataset folder `train.py --data` reads, one folder per map; `--summary` has
the branch statistics of `scripts/summary.mjs` and each table's results). A table is `NAME GAMES AGENT,AGENT [START]
[OPTIONS JSON]` (`--table`), or a jobs file's line (`--jobs`); game i is seeded and seated exactly as `play` does it, so
a table here is the same set of games as on the CPU. Tables of one configuration share one engine; configurations run
one after another, each with as many games in flight as fit in `--gpu-gb` of game state (default 3 GB; `--batch`
fixes it). Teacher seats whose moves are not recorded play on inside one kernel until a branch or network seat is to
move (`k_teacher_run`: the same moves and random streams as one step at a time, without a round trip to Python per
move; a 10-player table with eight teachers spends most of its moves there). The rollout teacher is `--teacher`
(`DELOVE_BRANCH_TEACHER` in `cycle.sh`; e.g. `jacob-sensei@1`; default the newest `delove-teacher@N.json` in
`--models`): it plays every seat of the rollouts and the branch player's own teacher moves, while each teacher seated
at a table (`delove-teacher@N`, `jacob-sensei@N`, any mix) plays its own version, as `play` does. The branch settings default to `DEFAULT_BRANCH` in `branch.ts`
(read from the file), networks play from their `.pt` weights in fp32, scored in chunks that fit the GPU on big maps.

- **The teachers** (`teacher.py`) are `teacherPickWith(params)` (Sensei) and `jacobPickWith(params)` (Jacob Sensei,
  below) in CUDA, one thread per game, inside the same kernel as the rules. It must pick exactly what teacher.ts picks, ties included: every score is built with the same double-precision
  operations in the same order (compiled with `--fmad=false`, so no fused multiply-adds), the 1e-3 tie-break jitter
  comes from the seat's own mulberry32 stream, candidates are visited in actions.ts order (fortify destinations in the
  engine's connected-search order), and the blitz odds are `odds.ts`'s numbers bit for bit (`odds.py` fills the tables
  with allIn()'s exact arithmetic; fit()'s scaling for huge stacks is reproduced in the kernel).
  **Lane groups** (`Grp`, `teacher_pick_g<G>`): G lanes of one warp can make a pick together. Every lane runs the same
  code on the same board, and only the candidate loops (attacks, placements) are split, candidate c on lane c % G.
  The jitter draws keep their order, because mulberry32 adds 0x6D2B79F5 to its state per draw: the k-th draw of a loop
  comes from st0 + k x 0x6D2B79F5, and a lane learns k from how many earlier candidates draw (two ballots). The best
  candidate is then reduced over the group with the loop's own rule (the higher score; on a tie the earlier
  candidate), and every lane leaves with the same pick and the same stream. Only lane 0 changes the board, between
  two `__syncwarp()`s. The rollouts use G = 16 (`SIM_LANES`), the main games' teacher seats G = 8
  (`k_teacher_run`, `RUN_LANES`), and every other kernel G = 1, the one-thread loop as before.
- **Branch and score** (`branch.py`) follows `branchAgent`: the teacher's move first, then the ranker's favourites
  (logits descending, ties in candidate order); fortify options completed by the teacher and the rollout seeds drawn
  from the seat's stream in the same order; options x rollouts board copies (common random numbers: rngState = seed,
  deck reshuffled with mulberry32(seed ^ 0x5bd1e995)), each played `horizon` rounds by the teacher in a lane group;
  `positionScore` in double precision, averaged seed by seed with true division (a CUDA tensor divided by a Python
  number is multiplied by the reciprocal, which differs from JavaScript in the last bit), and the `margin` rule.
  `--score points` (branch.ts `pointsScore`, `DELOVE_BRANCH_SCORE=points`) scores the copies by leaderboard points
  instead: every alive player's share score, the expected place from the pairwise gaps, the placement points table and
  `KILL_POINTS` read from the built engine (as `outcome.py` does), kills from the kernel's record of who eliminated
  whom; `--score kills` is the share score plus that kill credit; same doubles in the same order. `generate.py` also
  takes GPU-only seats `delove-branch@1:share` / `:points` / `:kills` (one branch player per score at the same table,
  each with its own rollout copies) for comparing scores head to head (`scripts/score_compare.py`; results in
  packages/delove/README.md).
- **Training arrays** (`generate.py` Recorder, `npy.py`): export.ts's files and `features.json`, with the feature names
  and versions read from the built self-play package. The encoder computes in float64 and rounds to float32 once, as
  encode.ts stores doubles into a Float32Array, so the arrays are bit-identical to `export`'s. One extra array, not in
  export's: `branch_tag.npy` (int8 per decision: 0 the teacher's move without comparing options, 1 compared and kept,
  2 changed), which `train.py --branch-weights` reads.

- **Outcomes** (`outcome.py`): z, and log v3's leaderboard placements, kills and points (`points.npy`, `points01.npy`):
  the kernel records who eliminated whom and in which order, `finalPlacements`' ordering is mirrored, and the points
  table and `KILL_POINTS` are read from the built engine.

What is not on the GPU: fog of war, `risky@1` opponents and `-explore` (sampling) network seats in `generate.py` (the
replay tests do replay `risky@1` games), and `DELOVE_BRANCH_VALUE` (the value blend). A step with any of those stays on
the CPU; `generate.py` refuses it.

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
| `branch_replay.py --score points` / `--score kills` (horizon 1, margin 0.01, ranker `delove@3`) | points: 30 Classic 2p games against Sensei 2 and 30 Classic 4p games (Sensei 2, `delove@3`, Sensei 1); kills: 30 Classic 4p games | points: 9,443 of 9,443 decisions the same pick, all 5,216 branched decisions with identical mean scores; kills: 6,418 of 6,418 the same pick, all 3,709 branched identical |
| `export_check.py` | the `c2t` log's 13,600 branch decisions, 196,341 candidates | every array bit for bit equal to `export`'s, candidate order included |
| `dataset_compare.py` | cycle 3's whole Classic 2-player step played on the GPU vs on the CPU (6,000 games, same seeds) | 6,000 of 6,000 games identical, row for row |

That last run also reproduces cycle 3's own statistics in [CYCLES.md](../delove/CYCLES.md) exactly: 757,268 branching
decisions, 395,729 branched, 7,099,734 simulations of 89,623,920 moves, 111,930 changes (attack 58,195/221,119, place
29,088/114,748, end_turn 10,122/18,601, fortify_from 9,170/26,503, trade 5,355/14,758), same wins per table. The only
expected difference is the ranker near-tie above (about 1 in 20,000 branched decisions; when it changes a pick, the
game diverges from the CPU's from there on, equally valid).

### Jacob Sensei (`jacob-sensei@1`)

Jacob Sensei (`packages/delove/src/jacob.ts`, PR #98) is Sensei's judgement plus terms for big tables. It runs in the
same kernel as Sensei: a teacher version is one row of numbers (`PARAM_KEYS`, `JACOB_KEYS`, then a Jacob flag), and the
kernel takes Jacob's code paths only where the flag is on:
- `stats()`: armies, territories, income (`reinforcementsFor`) and power of every living seat, summed in seat order,
  and the mean power; the leader term on captures and on a rival's armies lost;
- the hunt (a share of an elimination once a stack outweighs a rival's whole army), in attacks and in placement scores
  (with the largest amount being placed, as `pickPlace` passes it);
- the card urge, the late-game win floor, and own losses divided by `1 + stackRamp * Math.log1p(surplus)`;
- the interior-to-front pull in `bestFortify`.

`Math.log1p` is V8's: `src/base/ieee754.cc`, FreeBSD's fdlibm `s_log1p.c`, ported operation for operation
(`log1p_fd`). CUDA's `log1p` and the platform libm differ from it in the last bit on about 17% of inputs, which is
enough to swap a near-tie. `tests/log1p_check.py` compares the two on 255,066 values.

Numbers: `jacob-sensei@1` uses `JACOB_SENSEI_1_PARAMS`, read from `jacob.ts` (its JSON in the models folder is ignored,
as `register.ts` does). Later versions use `models/delove/jacob-sensei@N.json` over `DEFAULT_JACOB_PARAMS`
(`agent_params` in `teacher.py`). An engine holds several versions; `tver[game, seat]` says which row plays each seat.
So `generate.py` seats `delove-teacher@N` and `jacob-sensei@N` at one table, and `--teacher jacob-sensei@1`
(`DELOVE_BRANCH_TEACHER` in `cycle.sh`) makes Jacob the rollout teacher.

Proof (2026-10-20, 0 mismatches; logs under `<training PC>\Risky-business-stage2\runs\gpu-verify\jacob` and `m-jacob`):

| check | what was compared | result |
| --- | --- | --- |
| `teacher_replay.py` | 1,000 Jacob self-play games, Classic 2p | 258,651 of 258,651 decisions: the logged pick. With `DEFAULT_JACOB_PARAMS` instead, 178 of 200 games fail; with Jacob's numbers but the flag off (Sensei's code paths), 194 of 200 fail |
| `branch_replay.py`, Jacob rollouts | 150 branch games at the cycle settings (ranker `delove@3`, horizon 1, margin 0.01), 100 at branch.ts's defaults (ranker `delove@2`) | 31,035 of 31,035 branch decisions the same pick; all 16,180 branched decisions with identical mean scores |
| `tests/matrix.py --suite jacob` (scale 0.5) | every map and table size, mixed tables, every setting, branch with Jacob rollouts (the table above) | 118 of 118 cases identical: 3,213,258 teacher picks, 25,124 of 25,125 branch picks (1 ranker near-tie) |
| `verify.py --models` | fresh logs: Jacob self-play, branch with Jacob rollouts, and the `jacob` suite at scale 0.1 next to the other suites | 4,563,002 steps identical on `engine.py`, `fused.py`, the teacher and branch; 500 Jacob self-play games (131,150 picks) and 100 branch games with Jacob rollouts (12,086 decisions, 6,309 branched, means identical); matrix rules 60/60, settings 120/120, branch 10/10, `jacob` 118/118 cases identical. Fingerprint written, `jacob.ts` in `RULE_FILES` |

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

### Speed of every cycle step: maps and table sizes

A branch-and-score cycle mix on the training PC, games to training arrays (`bench/bench_cycle.sh`: the CPU side is
`generate.sh`'s pool over 27 processes with logs, then `export` of the branch player's decisions, as `cycle.sh` does
it; the GPU side is `generate.py` on the same tables and seed, start-up included, kernels already compiled; ranker
`delove@3`, horizon 1, margin 0.01, the tuned teacher Sensei 2):

| step (jobs file in `bench/`) | games | CPU, 27 processes | GPU | GPU vs CPU | GPU games in flight, peak GPU memory |
| --- | --- | --- | --- | --- | --- |
| Four Crowns micro, 1v1 (`micro.jobs`, cycle 4's step) | 1,200 | 45.2 s (26.5 games/s) | 17.1 s (70.0 games/s) | **2.6x** | 1,280 games, 0.42 GB |
| Classic 2-player (`classic2.jobs`: cycle 4's three tables, 1,000 games each) | 3,000 | 223.3 s (13.4 games/s) | 68.0 s (44.1 games/s) | **3.3x** | 3,072 games, 0.95 GB |
| Classic 4-player (`classic4.jobs`, cycle 4's step) | 600 | 324.8 s (1.85 games/s) | 186.3 s (3.22 games/s) | **1.7x** | 768 games, 0.36 GB |
| Greater Europe, 10 players (`ge10.jobs`: branch player, `delove@3`, 8 teachers) | 400 (CPU: 54) | 824.2 s for 54 games (0.066 games/s) | 1,279 s (0.313 games/s) | **4.7x** | 512 games, 0.49 GB |
| the same, more games in flight (`ge10-2048.jobs`) | 2,048 | | 1,940 s (1.06 games/s) | **16x** | 2,048 games, 1.44 GB |

What decides these numbers:

- **Games in flight.** A step of the lockstep loop costs far less than in proportion to the games taking it (it waits
  for its longest thread: a teacher's run of moves, or a branch rollout of a whole round): 0.5 s with 512 Greater
  Europe 10-player games, 0.83 s with 2,048. A step with few games wastes the GPU. A cycle's 1,200 micro games or 600 four-player games fill a fraction of it; more
  games per configuration (a bigger step, or several cycle steps' worth at once) raise the GPU's games/s almost in
  proportion, as the Greater Europe rows show.
- **The tail.** Games that run long (to the 500-turn limit: 9 of the 600 four-player games, 384 of the 400 Greater
  Europe games) keep stepping alone at the end, about 25 ms a step: the four-player step finishes 555 of its 600 games
  in 78 s and spends 117 s on the last 45. The CPU pool hides its long games behind other chunks.
- **First compile.** A configuration's kernels compile once (40-60 s per map, table size and settings; cached in
  `_cache/` from then on): a cycle's first run on a new configuration pays it once.
- **cycle.sh runs the GPU steps alongside the CPU pool**, so a cycle's generation takes as long as the slower of the
  two: give the GPU the steps it is best at (Classic 2-player, big maps with many games) and let the pool keep the
  small ones, or put every step on the GPU (`gpu_steps=(all)`) and free the CPU for the gates.

### Big tables: lane groups

On a big table the step waits for its rollouts. Before this change, a 10-player branch decision on Greater Europe
played 18 rollouts of a whole round each in one CUDA thread. Profiled during cycle 6 (`jacob-sensei@1` rollouts, ranker
`delove@3`, horizon 1, 3 options x 6 rollouts), a lockstep step of 256 Greater Europe 10-player games spent 88% of its
time in `k_branch_sim`: about 900 rollout copies (7 blocks for the GPU's 24 SMs), and inside each thread 88% of the
cycles in the teacher's attack loop, a few hundred double-precision expected values per pick at 1/64 of the fp32
rate, with no other warps to hide their latency. The networks, the encoder and the main games' teacher seats took
the remaining 12%.

Lane groups (see the teacher bullet above) give each rollout copy 16 lanes (CUDA threads of one warp; not
`cycle.sh`'s `GPU_LANES`, which are whole GPU processes), which score its candidate attacks and placements in parallel. Nothing else changes: the arithmetic of every score, the order of the random draws and the
moves are the same.

Before and after (RTX 4060 with nothing else on the GPU, warm kernels; the jobs files are `bench/speed-*.jobs`, cycle 6's
tables at 256 games each; the first 400 lockstep steps, from the first deal; "before" is the deploy branch at #114):

| table (cycle 6) | before | after | speedup | games finished by then |
| --- | --- | --- | --- | --- |
| Classic 4-player (`c4a`) | 45.6 s | 17.8 s | **2.6x** | 211 of 256 |
| World 6-player (`w6a`) | 91.3 s | 30.3 s | **3.0x** | 23 |
| World 10-player (`w10a`) | 203.9 s | 48.4 s | **4.2x** | 137 |
| Grand World 10-player (`wl10a`) | 382.3 s | 74.4 s | **5.1x** | 47 |
| Greater Europe 6-player (`ge6a`) | 239.5 s | 56.2 s | **4.3x** | 0 |
| Greater Europe 10-player (`ge10a`) | 296.5 s | 81.0 s | **3.7x** | 0 |
| Fantasy 10-player (`fa10a`) | 273.9 s | 67.8 s | **4.0x** | 106 |

Whole runs, to the last game: Classic 4-player 62.4 s → 25.1 s (2.5x), World 10-player 339.0 s → 86.6 s (3.9x).
Every run played the same games before and after: the same decisions, branched decisions, simulated moves and
changes, the same final state of every game and stream (hashed), and the same results.

After the change, a Greater Europe 10-player step of 256 games takes about 150 ms: the rollouts 94 ms, the networks
24 ms (`delove@3` twice, as the ranker and as a seat, and `delove@2`), the main games' teacher seats 14 ms
(`k_teacher_run`, 8 lanes), the encoder 9 ms, the rest about 9 ms. The rollouts are still the largest part, so the next gains are there (below, What is left).

Lanes per rollout copy, the rollout kernel alone on five launches captured from that Greater Europe table (about 900
copies each; measured while cycle 6 shared the GPU, so only the ratios count): one thread per copy (before) 4,113 ms,
4 lanes 1,170 ms, 8 lanes 1,355 ms (a different run, 4.2x its own baseline), **16 lanes 468 ms (8.8x)**, 32 lanes
595 ms. With 16 lanes two copies share a warp, so the parts every lane repeats (the legal moves, the board summary,
the move itself) diverge less than with 32 copies per warp. Below 16 lanes, the attack loop stays long; at 32 lanes,
the 255-register kernel fits fewer copies on the GPU at once.

**Cheaper settings are not worth it on the GPU.** `bench/branch_agreement.py` plays a table with the full settings and,
at every decision of the branch player, also runs each variant from the same position and streams. On the
Greater Europe 10-player table (256 games, 10 minutes, 81,919 decisions, 50,262 branched by the full search, which
moved away from the teacher's move on 10,294 of them):

| variant (an option of `generate.py`) | rollout time vs full | decisions with another move | per full-search branched decision |
| --- | --- | --- | --- |
| `--rollouts 4` | 80% | 5,233 (6.4%) | 10.4% |
| `--rollouts 3` | 72% | 7,124 (8.7%) | 14.2% |
| `--options 2` | 79% | 5,624 (6.9%) | 11.2% |
| `--skip occupy,place` (no branching on placements) | 84% | 2,053 (2.5%) | 4.1% |

The rollouts are latency-bound, so fewer copies save little time (16-28%). Yet each variant moves away from the full
search on 4-14% of its branched decisions, against the 20% where the full search moves away from the teacher. The
defaults stay as they are. The variants are options for a run that needs speed over labels.

## Ladder gates on the GPU

A cycle's gates (candidate network vs the best, mirrored pairs at 2-10 players) play here too
(`delove_gpu/ladder.py`): the same games as `npm run delove -- ladder`, and the same printed JSON (`summarizeMatch`'s
score, interval and Elo, turn limit and mean turns, the leaderboard view `points` / `bestPoints` / `pointsDiff` /
`meanPlacement` / `killsPerGame`, and `promotionDecision`), so `cycle.sh`'s gate table reads it unchanged. Game i of a
match is seeded `gameSeed(seed, floor(i / 2))` and seated as `matchSeats` seats it (the candidate on even seats in even
games, on odd seats in odd games): a match is two tables on one seed, run by `generate.py`'s engine loop with no
recording. Network seats play from their `.pt` weights in fp32, teacher seats in the kernel.

```bash
# one match (run from packages/delove-gpu)
.venv/Scripts/python -m delove_gpu.ladder --models models/delove --candidate c6-candidate --best delove@3 \
  --players 6 --games 200 --seed 42 --options '{"map":"world"}'
# many matches at once (cycle.sh's GPU gates): one line per match, OUT/gI-K.json per match, finished ones skipped
.venv/Scripts/python -m delove_gpu.ladder --models models/delove --candidate c6-candidate --gates gpu.txt --out runs/c6/gates
```

A `--gates` line is `I K BEST PLAYERS GAMES SEED [OPTIONS JSON]`. Every match of one configuration (map, seats,
settings) shares one engine, so a cycle's 2-player Classic gates (800 + 400 + 400 games over 80 chunks) are one batch of
1,600 games in flight. `--results FILE` writes each game (winner, turns, placements, kills, points);
`tests/ladder_compare.py` compares it with a CPU match's `--log`, game by game. Like generation, it refuses a stale
mirror unless `--allow-unverified` (gates are evaluation, not training data, but a gate on a mirror that plays a
different game would not be the CPU's gate). In `cycle.sh`: `gpu_gates=(all)` or `GPU_GATES=1` (see
[packages/delove](../delove/README.md#a-whole-cycle-in-one-command)).

### Proof: the CPU's gates, game for game

`delove@3` against `delove@2`, each configuration as a cycle.sh gate of 200 games (10 chunks of 20, chunk k of gate i
seeded `601 * 1000 + 100 * i + k`), played by `npm run delove -- ladder ... --log` and by `delove_gpu.ladder --gates`,
compared with `tests/ladder_compare.py` (2026-10-20, `--allow-unverified`: the deploy branch's fingerprint was stale
for the new Bohemia and Nine Realms maps, which none of these games use):

| configuration | games | identical (winner, turns, placements, kills, points) | gate JSON (`g<i>-<k>.json`) |
| --- | --- | --- | --- |
| Classic, 2 players | 200 | 200 | 10 of 10 chunks equal |
| Classic, 4 players | 200 | 200 | 10 of 10 |
| Four Crowns (`skirmish`), 2 players | 200 | 200 | 10 of 10 |
| World, 6 players | 200 | 200 | 10 of 10 |
| World, 10 players | 200 | 200 | 10 of 10 |
| Greater Europe, 6 players | 200 | 198 | 8 of 10 |
| **total** | **1,200** | **1,198** | **58 of 60** |

The two other games (game 17 of two Greater Europe chunks, 9,261 and 10,797 decisions) are ONNX vs PyTorch near-ties:
replaying the CPU's log through the GPU (`tests/replay.py --fused --net`) gives the same rules at every step and the
logged move at every network decision but one in each game, where the two best logits were 5.7e-6 apart (a
`delove@2` decision) and 8.6e-6 apart (a `delove@3` one). From there each game goes on differently, equally valid, and
so do its chunk's numbers: 2 games in 1,200 here, both on the biggest board.

On cycle 6's tree (with Jacob Sensei in the mirror, fingerprint verified, no `--allow-unverified`), `c5-candidate`
against cycle 6's other gate kinds, 40 games each: Jacob Sensei on World 6p, and two league-settings gates (Classic 6p
with auto setup, balanced blitz, chosen capitals, progressive cards and 8 blizzards; Classic 2p with exponential cards):
120 of 120 games identical, every gate file byte-identical to the CPU's. A cycle.sh run of a two-gate config, once
with both gates on the GPU and once with one on each, wrote byte-identical gate files both times.

### Speed of a gate

The same 200-game gates (2026-10-20, RTX 4060 and i7-14700F). CPU: one `ladder` process per 20-game chunk, as cycle.sh
plays them; a gate's wall time on the CPU is its longest chunk when it has a free process per chunk. GPU: one
`delove_gpu.ladder` process, all 200 games of the configuration in flight (batch 256, 0.3 GB), kernels already
compiled (a new configuration compiles once, about 1-2 minutes, cached in `_cache/`):

| configuration | CPU, one chunk (mean / longest, 6 processes) | CPU, longest chunk in cycle 5's gates (21 busy processes) | GPU, all 200 games | GPU while cycle 6 trained (GPU at 99%) |
| --- | --- | --- | --- | --- |
| Classic, 2 players | 18 s / 21 s | 33-40 s | 34 s | 39 s |
| Classic, 4 players | 44 s / 50 s | 100 s | 174 s | 131 s |
| Four Crowns, 2 players | 10 s / 12 s | 22 s | 71 s | 84 s |
| World, 6 players | 184 s / 230 s | 463 s | 463 s | 523 s |
| World, 10 players | 130 s / 166 s | 415 s | 213 s | 317 s |
| Greater Europe, 6 players | 658 s / 878 s | (10 players: 1,572 s) | 541 s | 1,594 s |
| all six | 10,447 process-seconds | | 1,502 s one after another | |

What decides it:

- **A GPU match lasts as long as its longest game.** The loop steps every game in flight once per decision, so a
  configuration takes (the longest game's decisions) x (one step: ~30 ms on Greater Europe, ~50 ms on World with 256
  games, mostly the encoder and the two networks' many small kernels; the rules take under 2 ms), whatever the number
  of games. 1,000 games cost about what 200 do: the GPU's gain is in games per gate, not in a single gate's latency.
- **The CPU plays a gate's chunks side by side**, so with a free process per chunk a gate takes one chunk (20 games
  one after another). Against that the GPU wins on the big boards (Greater Europe, World 10p) and loses on the small
  ones, where 20 CPU games take less than the GPU's longest game.
- **Sharing the GPU slows every step** (2-3x while training ran), and one process runs its configurations one after
  another. `--procs N` (cycle.sh: `GPU_GATE_PROCS`) runs configurations in N processes at once, which should overlap
  their latency-bound steps; it has not been timed yet (it needs the GPU to itself).

So in a cycle: put on the GPU the gates whose CPU chunks are the longest (Greater Europe, World 10p and other big
boards), keep the 2-4 player Classic and Four Crowns gates on the CPU, and the gate phase ends when the slower side
does. The GPU is also the cheap way to more games per big-board gate (their 95% intervals are the widest).

## Keeping the mirror in step with the engine

The mirror is only right for the engine it was checked against. `engine-fingerprint.json` records hashes of the engine
and self-play files it copies (`RULE_FILES` in `delove_gpu/fingerprint.py`: `engine.ts`, `cards.ts`, `rng.ts`,
`types.ts`, `maps.ts`, every map's generated JSON, `ranking.ts`, self-play's `actions.ts`, `encode.ts`, `log.ts`,
`game.ts`, `traits.ts`, `export.ts`, `npy.ts`, and Delove's `teacher.ts`, `jacob.ts`, `branch.ts` with the engine's `odds.ts`),
written only after logs made with exactly those files replayed identically.

- **Training refuses a stale mirror.** `Engine(...)`, `FusedEngine(...)`, `TeacherEngine(...)` and `BranchEngine(...)`
  raise `StaleMirror` when any of those files changed since the last verification (or the last verification did not
  cover that layer: rules, teacher, branch), so GPU-generated training data always comes from a verified mirror. The
  replay tests and the benchmarks pass `allow_unverified=True` (`generate.py --allow-unverified`); nothing that makes
  training data should.
- **CI warns, never blocks.** `.github/workflows/ci.yml` runs `fingerprint.py check --github`: a PR that changes one of
  those files gets a "GPU mirror needs re-verifying" warning. Engine and server work is never held up by this
  training-only package (CI has no GPU to run the replay on anyway).
- **Per map:** `npm run maps:status` shows, for every board, whether it is in `RULE_FILES` and the rules matrix and
  whether its JSON matches the fingerprint (GPU-verified); CI puts that table in the job summary and warns per
  offered map that is not verified ([docs/map-making.md](../../docs/map-making.md#7-tracking-every-map)).
- **Re-verify on the training PC** after such a change is merged:

  ```bash
  .venv/Scripts/python packages/delove-gpu/delove_gpu/fingerprint.py check   # what changed
  .venv/Scripts/python packages/delove-gpu/verify.py --model models/delove/delove@2.pt --models models/delove
  ```

  `verify.py` builds the packages, plays fresh logged games with the current engine (new seeds each run: teacher,
  `risky@1`, random to the turn limit, a network player with `--model`; with `--models` the newest tuned teacher
  against itself and branch games at branch.ts's defaults and at the cycle settings, with traces), replays them
  through `engine.py` and `fused.py` with the encoder and network checks, then the teacher, branch and training-array
  checks, the odds check and the matrix suites over every map, table size and setting (`--matrix-scale`, default 0.1
  of `tests/matrix.py`'s game counts: about an hour), and writes the fingerprint only if every step matches. Commit the
  fingerprint (with any mirror fixes) in a PR. A change that does not touch the rules (a refactor, a comment) only
  needs the run; a mismatch means the mirror needs the same change, made in `packages/delove-gpu`, never the engine.

A hash changes for any edit, so the check can be stale without anything being wrong; the run settles it (about an
hour with the matrix).

## Speed

All on the training PC (i7-14700F, 28 threads; RTX 4060 8 GB). First, from #72 / #76: Classic 2-player, both seats the same player. CPU:
`node packages/delove-gpu/bench_cpu.mjs` (TypeScript self-play, no logging, one process per hardware thread). GPU:
`python bench.py` (games restart as they finish; 20-40 s measured after a warm-up). The two count decisions a little
differently (a fortify is one engine decision on the CPU, two steps on the GPU), so compare games per second.

| player | CPU, 1 core | CPU, 28 processes | GPU | GPU vs whole CPU |
| --- | --- | --- | --- | --- |
| random moves (games run to the 500-turn limit, ~2,840 steps) | 4.2 games/s | 42.6 games/s | **16,361 games/s** (`fused`, 65,536 games; 43.8M steps/s) | **384x** |
| `delove@2` network, fp32 (same moves as Node) | 3.9 games/s | 40 games/s | **258 games/s** (`fused`, 4,096-8,192 games; 66k decisions/s) | **6.5x** |
| `delove@2` network, fp16 weights | | | **522 games/s** (`fused`, 8,192 games; 132k decisions/s) | **13x** |
| `delove-teacher@1` / `@2` (hand-coded; `bench.py --policy teacher`) | 32 games/s | 376 games/s (1,075 with today's engine, after #71's speed-ups: below) | **18,346 games/s** (`teacher.py`, 65,536 games; 5.0M decisions/s) | **49x** |

The teacher (Sensei 2, `delove-teacher@2`) in every seat, on every map and table size (`bench/bench_teacher.sh`: CPU
`bench_cpu.mjs` over 28 processes, GPU `bench.py --policy teacher`, whole games inside the kernel, timed until the
last game of the batch ends):

| map, seats | CPU, 28 processes | GPU (games in flight) | GPU vs whole CPU | games at the 500-turn limit |
| --- | --- | --- | --- | --- |
| Four Crowns, 2 | 1,387 games/s | 50,088 games/s (32,768) | 36x | 0% |
| Four Crowns, 4 | 161 | 20,445 (32,768) | 127x | 0.1% |
| Classic, 2 | 1,075 | 13,130 (32,768) | 12x | 0% |
| Classic, 4 | 2.5 | 1,404 (16,384) | 560x | 17% |
| Classic, 6 | 1.7 | 1,210 (16,384) | 710x | 19% |
| Europe, 8 | 0.9 | 1,125 (16,384) | 1,250x | 45% |
| Asia, 8 | 0.6 | 920 (16,384) | 1,530x | 52% |
| USA, 10 | 0.8 | 1,277 (16,384) | 1,600x | 32% |
| World, 6 | 0.5 | 300 (16,384) | 600x | 87% |
| World, 10 | 0.6 | 312 (16,384) | 520x | 86% |
| Grand World, 10 | 0.6 | 141 (8,192) | 235x | 99% |
| Europe Advanced, 6 | 0.5 | 186 (8,192) | 370x | 97% |
| Realms of Halvaren, 10 | 0.5 | 183 (8,192) | 370x | 98% |
| Greater Europe, 2 | 100 | 1,215 (16,384) | 12x | 0% |
| Greater Europe, 6 | 0.4 | 130 (8,192) | 320x | 100% |
| Greater Europe, 10 | 0.5 | 138 (8,192) | 275x | 100% |

At 2 players the GPU's margin is the 12-50x of #76. With more players the teacher stalls (most big-table games
reach the turn limit with stacks of thousands), and the CPU then spends its time in `blitzOdds`: every attack it
weighs builds an exact all-in table of up to 250,000 cells, which the GPU reads from its precomputed tables (`odds.py`).
These are teacher-only games, an upper bound on the gain; the cycle mix above (branch players, networks) is the
realistic one.

### Batch sizes and memory (RTX 4060, 8 GB)

`generate.py` sizes each configuration's games in flight to `--gpu-gb` (default 3 GB) from the map, the table size and
the branch settings; with branch and score (options 3, rollouts 6) that is 16,384 games on Four Crowns 2-player, 9,472
on Classic 2-player, 9,216 on Classic 4-player, 5,376 on World 6-player, 5,120 on World 10-player, 3,584 on Grand
World 10-player and 3,328 on Greater Europe 10-player. Measured peaks (`peak_gpu_gb` in the summary): 0.42 GB for
1,280 Four Crowns games, 0.95 GB for 3,072 Classic 2-player games, 0.36 GB for 768 Classic 4-player games, 1.44 GB for
2,048 Greater Europe 10-player games (about 0.3 MB per Classic game, 0.7 MB per Greater Europe 10-player game:
the board copies of the rollouts, the candidates and the encoder's features; the networks score in chunks of at most
262,144 territory rows). Above that the networks' activations grow first; the odds tables take 0.23 GB once.

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

## Cloud workers

`cloud/` plays a cycle's GPU steps on rented cloud GPUs (RunPod first; RTX 4090 by default), so the training PC's GPU
is free and a cycle's generation is spread over several GPUs. Nothing in it is a rule: the pods run this package's
`delove_gpu.generate` at a given commit, with the cycle's seed, tables and branch settings.

| file | what it does |
| --- | --- |
| `cloud/remote.py` | runs on the training PC: splits the GPU steps over lanes, launches pods through the RunPod REST API, uploads, polls, downloads, terminates, merges (`plan`, `run`, `pods`, `terminate`) |
| `cloud/worker.sh` | runs on a pod: unpacks the commit (`git archive`), Node 22, `npm ci` and builds the engine and self-play, installs the training PC's PyTorch version, loads the uploaded `_cache/` kernels, checks the fingerprint, runs every lane, deletes the models, packs `out.tar.gz` (gzip -1: the arrays shrink 11-25x) |
| `cloud/merge.py` | joins several workers' map folders into one `DATA/<name>-<step>/<map>` (rows appended, `cand_offset` continued, `game` renumbered, counts summed; any per-row array such as `branch_tag.npy` included) and their summaries into the step's `gpu.json` |
| `tests/cloud_check.py` | offline checks (no GPU, no pods): a real map folder cut into workers and merged back is identical game for game; the split places every table once and its jobs lines round-trip; `remote.py run` against a fake API terminates every pod on success, on a worker failure and on Ctrl+C |

**How a step is split.** The unit is a configuration (map, seats, settings): `generate` plays all of a configuration's
tables in one engine, and a configuration takes about as long as its longest games whatever their number (a lockstep
step costs far less than in proportion to its games). So each configuration plays whole on one lane, and its games
are the same games as at home (same tables, seeds and batch for the same `--gpu-gb`). Lanes are pods x GPUs per pod
(`--gpus`) x processes per GPU (`--procs`); configurations go longest first onto the least-loaded lane, their cost
read from the `... games in N s (batch B)` lines of earlier `gpu.log` files (`--timings`, any number; a configuration
never measured is guessed from the same map and table size, else the board size, and marked "(guess)"). A lane runs
one `generate` per step, so the workers' arrays come back per lane and step, and `merge.py` joins them.

**What it can and cannot shorten.** Cycle 6 on the RTX 4060 is about 6 hours of GPU generation; split over 6 lanes
it is about 72 minutes of games per lane at the 4060's speed (`remote.py plan` on cycle 6's jobs and timings), and no
number of lanes goes below the slowest configuration (Greater Europe 6-player, 500 games: 47 minutes on the 4060).
Getting under that needs a faster GPU per game (the first test below measures it), several processes per GPU
(`--procs`, which overlapped straggler tails at home: `GPU_LANES`), or the big-table speed-ups in "What is left".

**Cost and shutdown.** `plan` (and `run` before it launches) prints every lane with its configurations and minutes
and the estimate: setup (~10 minutes) + the longest lane + download, times pods x GPUs x `--price` ($/GPU-hour;
default 0.69, the pods report their real price). `--max-gpu-hours` (default 4) is a hard cap: `run` refuses a bigger
estimate, and terminates every pod when the cap's share of wall time is spent. Pods end on every path: each pod is
terminated as soon as its arrays are downloaded, and every pod on failure, timeout or Ctrl+C (their ids are kept in
`OUT/remote/pods.json`; `remote.py terminate --all` ends every `delove-*` pod of the account if this script was
killed). Inside each pod a watchdog in the start command terminates it at the run's deadline (cap + 15 minutes) with
`runpodctl` and the pod's own key, even if the training PC is gone. Without `--yes`, `run` only prints the plan.

**Secrets and models.** The API key is read from `RUNPOD_API_KEY` (set by the owner in the environment) and only sent
in the `Authorization` header: never printed, logged or written. SSH uses a fresh ed25519 key per run, generated
under `OUT/remote/` and deleted at the end. The pods get only the models the tables need (each network seat's and the
ranker's `.pt`, the teachers' `.json`), uploaded straight to the owner's pods; the worker deletes them once its games
are played, `remote.py` deletes them again before terminating, terminating destroys the pod's disk (no network
volume is used), and the local upload tar is deleted right after the upload.

**Running it.** From a cycle: `REMOTE_GPUS=6` (and `REMOTE_TIMINGS`, `REMOTE_MAX_GPU_HOURS`, `REMOTE_PROCS`,
`REMOTE_GPU_TYPE`, `REMOTE_CLOUD`) makes cycle.sh hand every GPU step to `remote.py run` with the same generate
arguments as a local step; progress goes to `OUT/remote.log`, the merged arrays to `DATA/<name>-<step>/<map>` and each
step's `gpu.json` and `gpu.log` to `OUT/<step>/`, so training, `summary.mjs` and the dashboard are unchanged. By hand
(from `packages/delove-gpu`; the generate arguments go after `--`):

```bash
python cloud/remote.py plan --name c7 --step big=../delove/scripts/cycles/c7-big.jobs --pods 6 --timings <runs>/c6/big/gpu.log
python cloud/remote.py run --name c7 --step big=... --pods 6 --models <models> --data <data> --out <runs>/c7 \
    --timings <runs>/c6/big/gpu.log --max-gpu-hours 8 --yes -- --seed 307 --gpu-gb 6 --ranker delove@3 --teacher jacob-sensei@1 --horizon 1 --margin 0.01
python cloud/remote.py pods                  # every delove-* pod of the account
python cloud/remote.py terminate --all       # end them all
```

`--commit` (default `HEAD`) is the commit the pods run, by `git archive`, so it need not be pushed; uncommitted
changes to the mirror, engine or self-play are warned about, since the pods will not have them. `--cache` (default
`_cache/`) uploads the NVRTC kernels and odds tables: the cache key holds the GPU's compute capability and the
PyTorch version, so the 4060's kernels load on a 4090 (both Ada, sm_89) and other GPUs compile their own (about a
minute per configuration). `--verify '<verify.py args>'` runs `verify.py --models` on each pod before its games.

**Bit-exactness on a new GPU.** Before trusting a GPU type's data, play tables the training PC has already played,
with the same seed and `--gpu-gb` (so the same batch), and compare game for game; `--subset` asks that every game of
the first folder be among the second's:

```bash
python tests/dataset_compare.py --subset <data>/<name>-big/world <training PC data>/c6-big/world
```

or run `verify.py --models` on it (`--verify`). First test (pending the owner's go-ahead): one RTX 4090, cycle 6's
`w10b`, `ge6b` and `c4b` with cycle 6's seed, settings and commit, for games/s against the 4060's `gpu.log` and this
comparison; its results go here.

## What is left

Done (above): the rules, the tuned teacher, branch and score, the outcome and the training arrays of every cycle step,
on every map, table size and setting but fog of war, each verified against the TypeScript, and wired into `cycle.sh`
(`gpu_steps`). In rough order of what would help next:

1. **Big-table speed, continued:** lane groups (above) made big-table steps 2.6-5.1x faster, but the rollouts are
   still 2/3 of a Greater Europe 10-player step. The parts every lane repeats come next: the legal moves, the board
   summary (`board_init`), `best_fortify` and the move itself. Splitting those needs the board in shared memory per
   group, not in each lane's local memory. Running two configurations at once (on two CUDA streams) would fill the GPU
   while one waits on its tail.
2. **A faster teacher kernel:** less divergence between threads in different phases, a smaller per-thread board,
   fewer recomputations between a move's two fortify steps.
3. **Other players in the pool:** `risky@1` (`packages/engine/src/bot.ts`, short) and sampling (`-explore`) network
   seats, which need ONNX-identical sampling arithmetic; `DELOVE_BRANCH_VALUE` (the value head's blend).
4. **Fog of war:** the encoder would need a seat's-eye view first (export skips fog games today anyway).
