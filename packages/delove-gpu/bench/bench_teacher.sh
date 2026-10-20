#!/usr/bin/env bash
# Teacher-played games per second, per map and table size: the GPU (bench.py --policy teacher: whole games inside the
# kernel, timed until the last game of the batch ends) against every CPU thread (bench_cpu.mjs, one process each).
#
#   DELOVE_MODELS=<models dir> PYTHON=<venv python> bash packages/delove-gpu/bench/bench_teacher.sh runs/bench/teacher.jsonl
set -euo pipefail
out=$1
models=${DELOVE_MODELS:?set DELOVE_MODELS}
python=${PYTHON:-.venv/Scripts/python}
procs=${PROCS:-$(node -e 'console.log(require("os").availableParallelism())')}
teacher=${TEACHER:-delove-teacher@2}
[[ ${SKIP:-0} == 0 ]] && : > "$out"
skip=${SKIP:-0}; n=0
# map seats GPU-batch CPU-games-per-process
while read -r map seats batch per; do
  n=$((n + 1)); (( n <= skip )) && continue
  agents=$(node -e "console.log(Array($seats).fill('$teacher').join(','))")
  DELOVE_MODELS=$models node packages/delove-gpu/bench_cpu.mjs --agents "$agents" --games "$per" --procs "$procs" \
    --options "{\"map\":\"$map\"}" | tee -a "$out"
  (cd packages/delove-gpu && "$python" bench.py --policy teacher --params "$models/$teacher.json" --map "$map" --seats "$seats" \
    --batch "$batch") | tee -a "$out"
done <<'EOF'
skirmish 2 32768 800
skirmish 4 32768 100
classic 2 32768 300
classic 4 16384 60
classic 6 16384 30
europe 8 16384 4
asia 8 16384 4
usa 10 16384 4
world 6 16384 4
world 10 16384 3
world_large 10 8192 2
europe_classic 6 8192 2
fantasy 10 8192 2
greater_europe 2 16384 8
greater_europe 6 8192 2
greater_europe 10 8192 2
EOF
