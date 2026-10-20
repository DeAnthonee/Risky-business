# Delove: running log

Covers `packages/delove` (teacher, network agent, seat player, trainer, cycle scripts) and the Delove docs. Per-cycle
numbers go in [packages/delove/CYCLES.md](../../packages/delove/CYCLES.md) and the current state in
[docs/delove-status.md](../delove-status.md); this log only lists the merged changes. GPU mirror: [delove-gpu.md](delove-gpu.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12).

- 2026-10-20 #TBD Cycle 6: `delove@4` (Jacob Sensei teacher, league settings, search-weighted lessons); `train.py` `:value` mode and `--branch-weights`; `cycle.sh` `GPU_LANES=N`; CYCLES.md and delove-status sections 3, 5, 8
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
