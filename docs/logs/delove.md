# Delove: running log

Covers `packages/delove` (teacher, network agent, seat player, trainer, cycle scripts) and the Delove docs. Per-cycle
numbers go in [packages/delove/CYCLES.md](../../packages/delove/CYCLES.md) and the current state in
[docs/delove-status.md](../delove-status.md); this log only lists the merged changes. GPU mirror: [delove-gpu.md](delove-gpu.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12).

- 2026-10-21 #154 `delove-seat` searches by default: `--agents delove-branch` with the newest delove@N as ranker and `--preset measured` (#142's measured setup: Jacob Sensei 1, 5 options, share, horizon 1, margin 0.01); `--preset js2-range` (Jacob Sensei 2, range score, horizon 2, margin 0.02) is opt-in until a mirrored ladder backs it (`LIVE_BRANCH_PRESETS`, `liveBranchEnv`; any `DELOVE_BRANCH_*` overrides; `--agents delove@N` is the bare network); decision times in packages/delove README
- 2026-10-21 #155 fog of war, first capability: `train.py --fog-dropout P` (`python/fog.py`, bit-identical to fog.ts, `test_fog.py`; widens a pre-fog checkpoint with zero weights; `fogInputs` in the model .json; `fog` validation line); the network player reads fog inputs and plays fog games on its seat view; `delove-seat` seats fog-trained models at fog tables; `chooseFromView` uses the view's legal moves; `cycle.sh` keeps fog gates on the CPU; docs/delove-fog.md status, delove-status, game-settings, README
- 2026-10-21 #148 range-specific teacher labels: branch scores `long` (share + 2 × kill credit), `mid` (P(top 2) + threat deflection), `close` (12 × 2 duel search) and `range` (by players alive) in branch.ts, `DELOVE_BRANCH_SCORE` / `_KILL_WEIGHT` / `_THREAT` / `_CLOSE_ROLLOUTS` / `_CLOSE_HORIZON` (cycle.sh passes them), seats `delove-branch@1:<score>` (branch-env.ts `branchSeatsFromEnv`); head to head vs share (2,228 games): 3p top 2 +0.043 ± 0.051, 6p +0.46 ± 0.58 points, duels even (packages/delove README)
- 2026-10-21 #141 Network rollouts for branch and score (`DELOVE_BRANCH_ROLLOUT=<model>[:self]`, branch.ts `rolloutNet`, opt-in; golden 57/57): measured against Jacob rollouts on 21,000 paired games, worse at 4-10 players (every seat -0.52, decider's seat -0.43 points/game pooled), even at 2p; 4-5 options with Jacob rollouts +0.23 / +0.28 points/game (recommended `DELOVE_BRANCH_OPTIONS=4`); `cycle.sh` passes `DELOVE_BRANCH_ROLLOUT` to GPU steps; README section and delove-status sections 5, 8, 9
- 2026-10-21 #153 `cycle.sh`: `REMOTE_CAPACITY_WAIT` and `REMOTE_ACCEPT_PARTIAL` for remote GPU steps (issue #152)
- 2026-10-21 #150 S5: `train.py --aux-rollout W` (rollout head on `branch_q.npy`, the played option's 1-round branch score; `delove_model.py` `aux_rollout`, `test_aux.py`); measured R² 0.89 on held-out decisions, no change to top-1 or the value in a short fine-tune
- 2026-10-21 #144 `jacob-sensei@2` (Jacob Sensei 2): RISK_LEARNINGS.md sections 7-21 as 11 tunable terms in `src/jacob.ts` (0 in `jacob-sensei@1`, which plays bit-identically), staged duel numbers (`jacobPickWith(params, duel)`, `"duel"` in jacob-sensei@N.json), `tune.ts --fitness points`, `tables.ts --options` and a points-difference interval; vs @1 0.53-0.57 at 2p and +0.42 to +1.33 points per seat at 4-10p; README section, delove-status sections 3, 8, 9
- 2026-10-21 #149 cycle 11: `delove@8` (5 search options, base only, +0.36 points per seat at 4-10p over `delove@7`); `c11.cycle`
- 2026-10-21 #146 ratio-scenario jobs `scripts/stage/split-close.jobs` / `split-mid.jobs` (about 10,000 games per ratio, 6-10 seat tables, branch vs `delove@6`) written by `split-jobs.mjs`, `measure-stages.mjs` for the stage statistics, `generate.sh` reads a START column
- 2026-10-21 #147 cycle 10: `delove@7` (4 search options), first range specialists with `--range` and #137's stage games (all even, not promoted); `c10.cycle`, `c10s.cycle` (stage games, generate-only), `c10-specialists.sh`
- 2026-10-21 #142 search at play time: `delove-seat --agents delove-branch` plays branch and score live (`DELOVE_BRANCH_*`, now in `src/branch-env.ts`, shared with register.ts)
- 2026-10-21 #145 S3: `train.py --soft-targets C` / `--soft-prior` (Gumbel completed-Q policy targets from the branch scores in `branch_q.npy`, frozen prior; `soft.py`, `test_soft.py`), `--soft-scale S` (absolute score scale instead of per-decision min-max), `--device`; `python/branch_q.py` writes `branch_q.npy` for a CPU export from the log and `DELOVE_BRANCH_TRACE`
- 2026-10-21 #143 live seat bug: `stateFromView` gave every opponent 0 cards (dropped `cardCount`), so delove@N and Jacob misread card threats in every live game; opponents' hand sizes and the deck/discard sizes are now rebuilt from the view (random deal of the unseen cards); yardstick caveat for games 1-6
- 2026-10-20 #137 stage games for the range specialists: `scripts/stage/mid.jobs` (3 alive) and `close.jobs` (2 alive), `LEAD>STAGE` tables on cycle 8's maps; `dashboard.mjs` / `run-timing.mjs` count a stage table's seats from its lead-in; README range specialists, delove-status sections 8 and 9 item 2
- 2026-10-21 #139 live yardstick: `docs/delove-yardstick.md` (delove@6 vs 5 Claude Haiku/Sonnet/Opus seats on the live board, one row per game) and its rerun kit `packages/delove/scripts/yardstick/` (setup.mjs, monitor.mjs, seat-prompt.md); delove-status section 9 item 4
- 2026-10-21 #136 each range specialist is its own line: `@1` from the base of its day, every later candidate `--init` from the best of its own line on the newest shared games; re-seeding from a new base is an owner decision (delove-status section 3, packages/delove README)
- 2026-10-20 #132 range specialists learn their own objectives: `train.py --range long|mid|close` (alive range, value target points / top2 + threat credit / win, range credit `--credit-beta` after `--credit-warmup`), `--value-target top2|win`, `python/targets.py` + `test_targets.py`; exports without `placement.npy` estimate the top 2 from players alive at the seat's last decision; `c7-specialists.sh` `RANGE_OBJECTIVES=1` / `PREFIX` / `ROUTER`
- 2026-10-20 #131 Cycle 9: `delove@6`, every game on 10 cloud GPUs; delove-status sections 3, 5, 7 (cloud split, cloud training declined), 8
- 2026-10-20 #130 Range specialist yardstick: `npm run delove:stages` (`src/stages.ts`, `src/stage-eval.ts`): fixed seeded start positions per stage (Long turn 1 at 6-10p, Mid first turn with 3 alive, Close 2 alive, full games), specialist vs base `delove@N` in mirrored pairs scored by the stage's goal (points / P(top 3), P(top 2), win rate; routed trio on full-game points), 95% intervals; library names `delove-long-range@N` / `delove-mid-range@N` / `delove-close-range@N` load; delove-status: how specialists are compared and their promotion rule, never merged; delove.md naming
- 2026-10-20 #129 `cycle.sh` REMOTE_TRAIN=1 (with REMOTE_VOLUME): train the candidate on a rented cloud GPU from the RunPod network volume (`remote.py train`); with REMOTE_GPUS the generation's arrays stay on the volume and the training pod starts REMOTE_TRAIN_LEAD minutes before generation's estimated end; train_data resolved to `<dataset>/<map>`; falls back to home training when a dataset is not in the cloud (REMOTE_TRAIN_PUSH pushes it); REMOTE_HOME_COPY, REMOTE_TRAIN_MAX_GPU_HOURS, REMOTE_TRAIN_MINUTES, REMOTE_TRAIN_GPU_TYPE, REMOTE_TRAIN_DISK_GB; home training stays the default
- 2026-10-21 #128 `cycle.sh` passes `REMOTE_REPLACEMENTS` and `REMOTE_READY_MINUTES` to `remote.py run` (a bad cloud pod is replaced instead of aborting the run)
- 2026-10-20 #127 Cycle 8: `delove@5` (40k games, half the big boards on cloud GPUs); `cycle.sh` `GENERATE_ONLY`; delove-status: the owner's target (three specialists + housing, fog required) and a new section 9
- 2026-10-20 #120 Cycle 7: range specialists from `delove@4` (`scripts/cycles/c7-specialists.sh`), even with `delove@4`, not promoted; CYCLES.md and delove-status sections 5, 8
- 2026-10-20 #116 Cycle 6: `delove@4` (Jacob Sensei teacher, league settings, search-weighted lessons); `train.py` `:value` mode and `--branch-weights`; `cycle.sh` `GPU_LANES=N`; CYCLES.md and delove-status sections 3, 5, 8
- 2026-10-20 #115 `cycle.sh`: `REMOTE_GPUS=N` plays the GPU steps on rented cloud GPUs (packages/delove-gpu/cloud); `gen_args` shared by local and remote GPU steps
- 2026-10-20 #114 Range specialists: `train.py --alive LO-HI`; `delove-range@N` routes each decision to Delove Long / Mid / Close Range by players alive (`delove-range@N.json`, neutral not counted); delove-status §8 row
- 2026-10-20 #113 `cycle.sh` `gpu_gates=(all | indices)` / `GPU_GATES` plays chosen ladder gates on the GPU (same chunks, seeds and gate files; CPU stays the default; refuses a stale mirror unless `GPU_GATES_ALLOW_UNVERIFIED=1`); README "Gates on the GPU"
- 2026-10-20 #112 opt-in branch scores `DELOVE_BRANCH_SCORE=points` (`pointsScore`: expected place among the players alive + kills, on the leaderboard's scale) and `=kills` (share + kill credit); default stays `share` (golden 57/57); GPU head-to-head comparison in the README: points loses at 4p, kills no different; cycle 7 keeps share
- 2026-10-20 #111 delove-status section 9 item 1: Jacob Sensei's GPU port is done (#110), no longer listed as left
- 2026-10-20 #110 delove-status: Jacob Sensei's GPU port done (sections 3 and 8), cycle 6 unblocked by the Jacob-verified fingerprint
- 2026-10-20 #106 `scripts/dashboard.mjs` keeps history (30 s samples in `<run>/dashboard/samples.jsonl` and `_machine/`), History and Compare cycles tabs; `scripts/timing-report.mjs` (per-phase, step and map timing, GPU vs CPU share, idle gaps, throughput, straggler tails, bottlenecks; shared reading in `scripts/run-timing.mjs`); `cycle.sh` keeps a `times-<start>.tsv` copy per invocation
- 2026-10-20 #105 Cycle 5 (all maps 2-10p on the GPU, points target; not promoted, CYCLES.md has why); gate table reports leaderboard points; `scripts/dashboard.mjs` live training view; `train.py --amp` and `#F` dataset fractions; delove-status sections 3, 5, 8 and the owner's promotion rule
- 2026-10-20 #102 delove-status: `nine_realms` added to the map list and to the open-work row to re-verify the GPU fingerprint
- 2026-10-20 #100 delove-status: `bohemia` added to the map list; open-work row to re-verify the GPU fingerprint for it
- 2026-10-20 #98 `docs/delove-status.md`: Jacob Sensei in the models table, open work and section 9 item 1 (bar met in self-play); #82 marked merged
- 2026-10-20 #98 Jacob Sensei (`jacob-sensei@1`): a new hand-coded teacher that never stalls in self-play; `tune.ts --teacher jacob` with self-play length penalty; `src/tables.ts`
- 2026-10-20 #97 README and `delove-seat --help`: tuned teachers, `sensei` aliases and default names (#88)
- 2026-10-20 #91 Gen 5 configs are plain settings objects (pass with `--options`); ladder example uses `npm run delove`
- 2026-10-20 #89 Gen 5 testing parity configs in configs/ and status brief updates
- 2026-10-20 #88 delove-seat: discover and seat tuned teachers (delove-teacher@N, Sensei 2)
- 2026-10-20 #87 `docs/delove-fog.md`: plan for fog of war (seat-view encoder, fog dropout, determinized teacher, GPU, gates)
- 2026-10-20 #83 docs: the GPU mirror covers every map, 2-10 seats and every setting but fog
- 2026-10-20 #82 `cycle.sh` runs any step on the GPU (`gpu_steps=(all)`)
- 2026-10-20 #81 `docs/delove-status.md`: status, strategy and coordination brief
- 2026-10-20 #80 `cycle.sh` GPU steps: four fixes found by a full cycle run
- 2026-10-19 #79 train on leaderboard points (`--value-target points`), strength meter (`fit_strength.py`)
- 2026-10-19 #77 `cycle.sh` plays a cycle's Classic 2-player step on the GPU (`gpu_steps`)
- 2026-10-19 #74 cycles 2-4 results (`delove@3` best), value-blend option, fresh-network training
- 2026-10-19 #71 4x faster training cycles: cheaper branching, `cycle.sh`
- 2026-10-19 #66 Stage 2 tooling: mixed-dataset training and self-play round scripts
- 2026-10-19 #63 Stage 1: `delove@1` trained from the teacher, plus a seat player for real games
- 2026-10-18 #59 Stage 0: `packages/delove` with `delove-teacher@1`
- 2026-10-18 #57 plan for Delove (`docs/delove.md`)
