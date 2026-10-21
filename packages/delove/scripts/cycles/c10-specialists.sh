#!/usr/bin/env bash
# Cycle 10, part 2: the first of each range line (packages/delove/README.md "Range specialists"). Each specialist is
# fine-tuned from delove@6 with its own objective (train.py --range long|mid|close) on cycle 10's games plus cycle 9's
# as a share, then measured against delove@6 on its own stage (npm run delove:stages), and the routed trio on whole
# games. Run after c10.cycle has trained its candidate (they share the home GPU). From the repo root:
#
#   DELOVE_MODELS=<models> DATA=<data> OUT=<runs>/c10 PYTHON=<venv python> bash packages/delove/scripts/cycles/c10-specialists.sh
#
# Steps resume: a trained specialist (its .onnx) and a finished stage result are kept.
set -euo pipefail
models=${DELOVE_MODELS:?} data=${DATA:?} out=${OUT:?} python=${PYTHON:?}
base=${BASE:-delove@6}
mkdir -p "$out/specialists"
export DELOVE_MODELS=$models
times="$out/specialists/times.tsv"
t0=$(date +%s)
stamp() { echo -e "$1\t$(( $(date +%s) - t0 ))" >> "$times"; echo "[$(date +%T)] $1"; }
stamp start

pool=(c10-a1/classic c10-a2/classic c10-a2/skirmish c10-a3/europe c10-a3/usa c10-a3/asia c10-a4/bohemia
  c10-a4/nine_realms c10-a4/world c10-b/world c10-b/world_large c10-b/greater_europe c10-b/fantasy c10-b/europe_classic
  "c9-a1/classic#0.4" "c9-a2/classic#0.4" "c9-a2/skirmish#0.4" "c9-a3/europe#0.4" "c9-a3/usa#0.4" "c9-a3/asia#0.4"
  "c9-a4/bohemia#0.4" "c9-a4/nine_realms#0.4" "c9-a4/world#0.4" "c9-b/world#0.4" "c9-b/world_large#0.4"
  "c9-b/greater_europe#0.4" "c9-b/fantasy#0.4" "c9-b/europe_classic#0.4")
# The stage games (#137, c10s.cycle): DATA/c10-sm holds decisions at 3 and 2 alive, c10-sc at 2 alive; Mid and Close
# Range add them (train.py --range keeps each one's rows).
stage_data() { for s in "$@"; do for f in "$data"/c10-"$s"/*/features.json; do [[ -f $f ]] && echo "c10-$s/$(basename "$(dirname "$f")")"; done; done; }
specialist() {  # specialist <range>: c10-<range> from the base
  local range=$1; local cand="$models/c10-$range"
  [[ -f "$cand.onnx" ]] && return 0
  local args=() extra=()
  case $range in mid) mapfile -t extra < <(stage_data sm) ;; close) mapfile -t extra < <(stage_data sm sc) ;; esac
  for d in "${pool[@]}" "${extra[@]}"; do args+=(--data "$data/$d"); done
  (cd packages/delove/python && "$python" train.py "${args[@]}" --range "$range" --init "$models/$base.pt" --out "$cand" \
    --epochs ${EPOCHS:-1.5} --batch 512 --lr 2e-4 --hidden 192 --rounds 6 --amp --branch-weights 0.5,1,2 &&
    "$python" export_onnx.py "$cand") > "$out/specialists/train-$range.log" 2>&1 \
    || { echo "training $range failed (see $out/specialists/train-$range.log)"; exit 1; }
  stamp "trained c10-$range"
}
for r in ${RANGES:-long mid close}; do specialist "$r"; done
[[ -n ${RANGES:-} ]] && exit 0  # RANGES=<some>: train only those now (the stages wait for all three)

# Each on its own stage against the base, then the routed trio on whole games.
stage() {  # stage <name> <args...>
  local f="$out/specialists/stage-$1.json"
  [[ -f "$f" ]] && return 0
  npm run -s delove:stages -- --stage "$@" --base "$base" --workers ${WORKERS:-12} > "$f.tmp" 2> "$out/specialists/stage-$1.txt" \
    && mv "$f.tmp" "$f" || { echo "stage $1 failed (see $out/specialists/stage-$1.txt)"; exit 1; }
  stamp "stage $1"
}
for r in long mid close; do stage "$r" --candidate "c10-$r"; done
stage full --trio c10-long,c10-mid,c10-close
stamp "specialists done"
