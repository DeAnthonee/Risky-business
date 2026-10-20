# Delove: running log

Covers `packages/delove` (teacher, network agent, seat player, trainer, cycle scripts) and the Delove docs. Per-cycle
numbers go in [packages/delove/CYCLES.md](../../packages/delove/CYCLES.md) and the current state in
[docs/delove-status.md](../delove-status.md); this log only lists the merged changes. GPU mirror: [delove-gpu.md](delove-gpu.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12).

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
