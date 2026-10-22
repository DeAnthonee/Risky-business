#!/usr/bin/env bash
# Cycle 14, part 2: Close Range only (research plan: the one line with a real stage gain in cycle 12; Long and Mid
# pause, routed to the base). Fine-tuned from BASE (cycle 14's best, delove@11) with train.py --range close and hard
# labels, on cycle 14's games + cycle 12's 2-alive ratio scenarios at 0.5 (c12-rc, #146) + its 2-alive stage games
# (c12-sc, #137); then measured against BASE on the close stage (npm run delove:stages) and as the trio
# BASE,BASE,c14-close on whole games. From the repo root:
#
#   BASE=delove@11 LABELS="" DELOVE_MODELS=<models> DATA=<data> OUT=<runs>/c14 PYTHON=<venv python> \n#     bash packages/delove/scripts/cycles/c14-specialists.sh
#
# Steps resume: a trained specialist (its .onnx) and a finished stage result are kept.
set -euo pipefail
models=${DELOVE_MODELS:?} data=${DATA:?} out=${OUT:?} python=${PYTHON:?}
base=${BASE:?the best base after the c12 gates, e.g. delove@9}
labels=${LABELS-}
mkdir -p "$out/specialists"
export DELOVE_MODELS=$models
times="$out/specialists/times.tsv"
t0=$(date +%s)
stamp() { echo -e "$1\t$(( $(date +%s) - t0 ))" >> "$times"; echo "[$(date +%T)] $1"; }
stamp "start (base $base, labels '${labels}')"

main=(c14-a1/classic c14-a2/classic c14-a2/skirmish c14-a3/europe c14-a3/usa c14-a3/asia c14-a4/bohemia
  c14-a4/nine_realms c14-a4/world c14-b/world c14-b/world_large c14-b/greater_europe c14-b/fantasy c14-b/europe_classic)
prev=("c11-a1/classic#0.4" "c11-a2/classic#0.4" "c11-a2/skirmish#0.4" "c11-a3/europe#0.4" "c11-a3/usa#0.4"
  "c11-a3/asia#0.4" "c11-a4/bohemia#0.4" "c11-a4/nine_realms#0.4" "c11-a4/world#0.4" "c11-b/world#0.4"
  "c11-b/world_large#0.4" "c11-b/greater_europe#0.4" "c11-b/fantasy#0.4" "c11-b/europe_classic#0.4")
step_data() {  # step_data <step> [#F]: every map folder of DATA/c12-<step>
  local f; for f in "$data"/c12-"$1"/*/features.json; do [[ -f $f ]] && echo "c12-$1/$(basename "$(dirname "$f")")${2:-}"; done
}
specialist() {  # specialist <range>
  local range=$1; local cand="$models/c14-$range" extra=() args=()
  [[ -f "$cand.onnx" ]] && return 0
  case $range in
    long) extra=("${prev[@]}") ;;
    mid) mapfile -t extra < <(step_data rm; step_data sm) ;;
    close) mapfile -t extra < <(step_data rc "#0.5"; step_data sc) ;;
  esac
  for d in "${main[@]}" "${extra[@]}"; do args+=(--data "$data/$d"); done
  # shellcheck disable=SC2086
  (cd packages/delove/python && "$python" train.py "${args[@]}" --range "$range" --init "$models/$base.pt" --out "$cand" \
    --epochs ${EPOCHS:-1.5} --batch 512 --lr 2e-4 --hidden 192 --rounds 6 --amp --branch-weights 0.5,1,2 $labels &&
    "$python" export_onnx.py "$cand") > "$out/specialists/train-$range.log" 2>&1 \
    || { echo "training $range failed (see $out/specialists/train-$range.log)"; exit 1; }
  stamp "trained c14-$range"
}
specialist close

stage() {  # stage <name> <args...>
  local f="$out/specialists/stage-$1.json"
  [[ -f "$f" ]] && return 0
  npm run -s delove:stages -- --stage "$@" --base "$base" --workers ${WORKERS:-12} > "$f.tmp" 2> "$out/specialists/stage-$1.txt" \
    && mv "$f.tmp" "$f" || { echo "stage $1 failed (see $out/specialists/stage-$1.txt)"; exit 1; }
  stamp "stage $1"
}
stage close --candidate c14-close
stage full --trio "$base,$base,c14-close"  # Long and Mid routed to the base
stamp "specialists done"
