#!/usr/bin/env bash
# A branch-and-score cycle step on the CPU and on the GPU, timed, from the repo root:
#
#   bash packages/delove-gpu/bench/bench_cycle.sh packages/delove-gpu/bench/micro.jobs runs/bench/micro [cpu|gpu|both]
#
# CPU: generate.sh's pool over every thread but one (PARALLEL, default threads - 1) with logs, then export of the
# branch player's decisions (what cycle.sh does). GPU: delove_gpu.generate on the same tables and seed, writing the
# training arrays directly. Branch settings as in the cycles: ranker delove@3, horizon 1, margin 0.01; the rollout
# teacher DELOVE_BRANCH_TEACHER (e.g. jacob-sensei@1) on both sides. Prints seconds and games/s of each;
# DELOVE_MODELS is the models folder, PYTHON the venv's python.
set -euo pipefail
jobs=$1; out=$2; which=${3:-both}
seed=${SEED:-404}
models=${DELOVE_MODELS:?set DELOVE_MODELS}
python=${PYTHON:-.venv/Scripts/python}
export DELOVE_MODELS=$models DELOVE_BRANCH_RANKER=${DELOVE_BRANCH_RANKER:-delove@3} DELOVE_BRANCH_HORIZON=${DELOVE_BRANCH_HORIZON:-1} DELOVE_BRANCH_MARGIN=${DELOVE_BRANCH_MARGIN:-0.01}
threads=$(node -e 'console.log(require("os").availableParallelism())')
games=$(grep -v '^\s*\(#\|$\)' "$jobs" | awk '{n += $2} END {print n}')
mkdir -p "$out"
calc() { awk "BEGIN { printf \"%.3f\", $1 }"; }
if [[ $which != gpu ]]; then
  rm -rf "$out/cpu" "$out/cpu-export"
  t0=$(date +%s.%N)
  CHUNK=${CHUNK:-$(( (games + (threads - 1) * 4 - 1) / ((threads - 1) * 4) ))} bash packages/delove/scripts/generate.sh "$jobs" "$out/cpu" "$seed" "${PARALLEL:-$((threads - 1))}" > "$out/cpu.log"
  t1=$(date +%s.%N)
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js export --log "$(ls -d "$out"/cpu/*/c* | paste -sd,)" --out "$out/cpu-export" --only-agents delove-branch@1 > "$out/cpu-export.json"
  t2=$(date +%s.%N)
  echo "{\"side\":\"cpu\",\"jobs\":\"$jobs\",\"games\":$games,\"play_s\":$(calc "$t1 - $t0"),\"export_s\":$(calc "$t2 - $t1"),\"total_s\":$(calc "$t2 - $t0"),\"games_per_s\":$(calc "$games / ($t2 - $t0)")}" | tee "$out/cpu.json"
fi
if [[ $which != cpu ]]; then
  rm -rf "$out/gpu"
  t0=$(date +%s.%N)
  (cd packages/delove-gpu && "$python" -m delove_gpu.generate --models "$models" --ranker "$DELOVE_BRANCH_RANKER" --horizon "$DELOVE_BRANCH_HORIZON" \
    --margin "$DELOVE_BRANCH_MARGIN" --seed "$seed" --jobs "../../$jobs" --out "../../$out/gpu" --summary "../../$out/gpu-summary.json" \
    --gpu-gb "${GPU_GB:-3}" ${GPU_BATCH:+--batch $GPU_BATCH} ${DELOVE_BRANCH_TEACHER:+--teacher $DELOVE_BRANCH_TEACHER} ${ALLOW_UNVERIFIED:+--allow-unverified}) > "$out/gpu.log" 2>&1
  t1=$(date +%s.%N)
  echo "{\"side\":\"gpu\",\"jobs\":\"$jobs\",\"games\":$games,\"total_s\":$(calc "$t1 - $t0"),\"games_per_s\":$(calc "$games / ($t1 - $t0)")}" | tee "$out/gpu.json"
fi
