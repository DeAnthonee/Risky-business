# Delove GPU mirror: running log

Covers `packages/delove-gpu` (the training-only GPU mirror of the rules, its replay tests, the engine fingerprint).
Guide: [packages/delove-gpu/README.md](../../packages/delove-gpu/README.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. **Append a line in the same PR** as any change to
this area (README hard rule 12), and say when the fingerprint (`engine-fingerprint.json`) was re-verified.

- 2026-10-20 #112 `--score points|kills` mirrored bit for bit in `branch.py` (replayed on CPU logs: every mean identical); `generate.py` GPU-only comparison seats `delove-branch@1:<score>`; `scripts/score_compare.py`; verify/matrix cover both scores; `verify.py --parallel` caps the logs' CPU processes, `--gpu-parallel` the matrix replays. Fingerprint not yet re-verified (pending a batched run with Bohemia and Nine Realms)
- 2026-10-20 #110 Jacob Sensei (`jacob-sensei@1`) in the GPU teacher kernel, per-seat teacher versions, `generate.py --teacher jacob-sensei@1`; fingerprint re-verified (incl. `jacob.ts`, matrix `jacob` suite) on the engine before #100 and #102; Bohemia and Nine Realms still need a verify.py run
- 2026-10-20 #105 `delove_gpu.generate` progress lines carry turn-limit counts and the branch statistics so far (for the dashboard)
- 2026-10-20 #102 `nine_realms.json` added to `RULE_FILES` and the rules matrix; the mirror needs re-verifying on the training PC
- 2026-10-20 #101 README: `npm run maps:status` shows per map whether the mirror is wired in and verified
- 2026-10-20 #100 `bohemia.json` added to `RULE_FILES` and the rules matrix, listed as not yet verified in the README; fingerprint NOT re-verified here (GPU busy training): one verify.py run on the training PC covers every map merged on 2026-10-20
- 2026-10-20 #82 every map, 2-10 seats and every setting but fog of war (rules, teacher, branch, training arrays)
- 2026-10-19 #77 Classic 2-player cycle step on the GPU through `cycle.sh`
- 2026-10-19 #76 teacher, branch and score and training arrays on the GPU (4.6x on a cycle's Classic 2-player step)
- 2026-10-19 #73 engine fingerprint, stale guard and re-verification (`verify.py`; CI warns on a stale mirror)
- 2026-10-19 #72 GPU self-play prototype: training-only rules mirror on CUDA
