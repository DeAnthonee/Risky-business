#!/usr/bin/env bash
# Cycle 12, part 2: the range specialists (packages/delove/README.md "Range specialists"), after the three base
# candidates (c12.cycle hard labels, c12-soft5.cycle, c12-soft5s.cycle) are gated. Each is fine-tuned from BASE (the
# best base after those gates) with its own objective (train.py --range) and the winning base label flags (LABELS:
# "" for hard, "--soft-targets 5" or "--soft-targets 5 --soft-scale 0.05"), on (research plan):
#   Long:  cycle 12's games + cycle 11's at 0.4
#   Mid:   cycle 12's games + the 3-alive ratio scenarios (rm, #146) + the 3-alive stage games (sm, #137)
#   Close: cycle 12's games + the 2-alive ratio scenarios at 0.5 (rc; 70/30 settles on turn 1) + the 2-alive stage games (sc)
# then measured against BASE on its own stage (npm run delove:stages) and the routed trio on whole games. From the repo root:
#
#   BASE=<best> LABELS="<flags>" DELOVE_MODELS=<models> DATA=<data> OUT=<runs>/c12 PYTHON=<venv python> \
#     bash packages/delove/scripts/cycles/c12-specialists.sh
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

main=(c12-a1/classic c12-a2/classic c12-a2/skirmish c12-a3/europe c12-a3/usa c12-a3/asia c12-a4/bohemia
  c12-a4/nine_realms c12-a4/world c12-b/world c12-b/world_large c12-b/greater_europe c12-b/fantasy c12-b/europe_classic)
prev=("c11-a1/classic#0.4" "c11-a2/classic#0.4" "c11-a2/skirmish#0.4" "c11-a3/europe#0.4" "c11-a3/usa#0.4"
  "c11-a3/asia#0.4" "c11-a4/bohemia#0.4" "c11-a4/nine_realms#0.4" "c11-a4/world#0.4" "c11-b/world#0.4"
  "c11-b/world_large#0.4" "c11-b/greater_europe#0.4" "c11-b/fantasy#0.4" "c11-b/europe_classic#0.4")
step_data() {  # step_data <step> [#F]: every map folder of DATA/c12-<step>
  local f; for f in "$data"/c12-"$1"/*/features.json; do [[ -f $f ]] && echo "c12-$1/$(basename "$(dirname "$f")")${2:-}"; done
}
specialist() {  # specialist <range>
  local range=$1; local cand="$models/c12-$range" extra=() args=()
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
  stamp "trained c12-$range"
}
for r in ${RANGES:-long mid close}; do specialist "$r"; done
[[ -n ${RANGES:-} ]] && exit 0  # RANGES=<some>: train only those now (the stages wait for all three)

stage() {  # stage <name> <args...>
  local f="$out/specialists/stage-$1.json"
  [[ -f "$f" ]] && return 0
  npm run -s delove:stages -- --stage "$@" --base "$base" --workers ${WORKERS:-12} > "$f.tmp" 2> "$out/specialists/stage-$1.txt" \
    && mv "$f.tmp" "$f" || { echo "stage $1 failed (see $out/specialists/stage-$1.txt)"; exit 1; }
  stamp "stage $1"
}
for r in long mid close; do stage "$r" --candidate "c12-$r"; done
stage full --trio c12-long,c12-mid,c12-close
stamp "specialists done"
