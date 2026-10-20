#!/usr/bin/env bash
# Cycle 7: the range specialists (the owner's plan; packages/delove/README.md "Range specialists"). No new games: three
# networks fine-tuned from delove@4 on the decisions of cycles 5-6 with that many players alive, then the routed trio
# (delove-range@1) gated against delove@4. From the repo root:
#
#   DELOVE_MODELS=<models> DATA=<data> OUT=<runs>/c7 PYTHON=<venv python> bash packages/delove/scripts/cycles/c7-specialists.sh
#
# Steps resume: a trained specialist (its .onnx) and finished gate chunks are kept.
set -euo pipefail
models=${DELOVE_MODELS:?} data=${DATA:?} out=${OUT:?} python=${PYTHON:?}
base=${BASE:-delove@4}
parallel=${PARALLEL:-21}
mkdir -p "$out/gates"
export DELOVE_MODELS=$models
times="$out/times.tsv"
t0=$(date +%s)
stamp() { echo -e "$1\t$(( $(date +%s) - t0 ))" >> "$times"; echo "[$(date +%T)] $1"; }
stamp start

# Training data per range: cycle 6 (branch-tag weighted), cycle 5's 2-player data as a share, and cycle 5's multiplayer
# tables as value-only data (their moves were mostly Sensei 2's).
c6_multi=(c6-classic4/classic c6-big/world c6-big/world_large c6-big/greater_europe c6-big/fantasy c6-big/europe
  c6-big/usa c6-big/asia c6-big/europe_classic c6-big/classic)
c5_value=(c5-big/world c5-big/fantasy c5-big/europe c5-big/usa c5-big/asia c5-big/greater_europe c5-big/classic c5-classic4/classic)
specialist() {  # specialist <range> <LO-HI> <dataset specs...>
  local range=$1 alive=$2; shift 2
  local cand="$models/c7-$range"
  [[ -f "$cand.onnx" ]] && return 0
  local args=()
  for d in "$@"; do args+=(--data "$data/$d"); done
  (cd packages/delove/python && "$python" train.py "${args[@]}" --alive "$alive" --init "$models/$base.pt" --out "$cand" \
    --epochs ${EPOCHS:-1.5} --batch 512 --lr 2e-4 --value-target points --amp --branch-weights 0.5,1,2 &&
    "$python" export_onnx.py "$cand") > "$out/train-$range.log" 2>&1 || { echo "training $range failed (see $out/train-$range.log)"; exit 1; }
  stamp "trained c7-$range"
}
multi=("${c6_multi[@]}")
for d in "${c5_value[@]}"; do multi+=("$d:value#0.4"); done
specialist long 4-10 "${multi[@]}"
specialist mid 3-3 "${multi[@]}"
specialist close 2-2 "${multi[@]}" c6-classic2/classic c6-micro/skirmish "c5-classic2/classic#0.3" "c5-micro/skirmish#0.3"

# The routed trio: delove-range@1 plays each decision with the specialist for the players still alive.
echo '{"close": "c7-close", "mid": "c7-mid", "long": "c7-long"}' > "$models/delove-range@1.json"

# Gates: the trio against the base, on the cycle 6 tables (CPU ladder; the router is not on the GPU mirror).
L='"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true'
gates=(
  "$base 2 800 {}"
  "$base 4 200 {}"
  "$base 6 200 {}"
  "$base 6 200 {\"map\":\"world\"}"
  "$base 10 200 {\"map\":\"world\"}"
  "$base 6 200 {$L,\"cardValues\":\"progressive\",\"capitals\":true,\"blizzards\":8}"
  "$base 6 200 {\"map\":\"world\",$L,\"cardValues\":\"fixed\",\"capitals\":true}"
  "$base 4 200 {$L,\"cardValues\":\"exponential\",\"blizzards\":8}"
  "$base 2 400 {$L,\"cardValues\":\"exponential\",\"blizzards\":8}"
  "jacob-sensei@1 6 200 {\"map\":\"world\"}"
)
printf '%s\n' "${gates[@]}" > "$out/gates/list.txt"
pool="$out/gates/pool.txt"; : > "$pool"
for i in "${!gates[@]}"; do
  read -r opp players games options <<< "${gates[$i]}"
  for ((k = 0; k * 20 < games; k++)); do echo "$i $k $opp $players $(( games - k * 20 < 20 ? games - k * 20 : 20 )) $options" >> "$pool"; done
done
export out
run_gate() {
  read -r i k opp players games options <<< "$1"
  local f="$out/gates/g$i-$k.json"
  [[ -f "$f" ]] && return 0
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js ladder --candidate delove-range@1 --best "$opp" \
    --players "$players" --games "$games" --seed $(( 307000 + 100 * i + k )) --options "$options" > "$f.tmp" 2> "$out/gates/g$i-$k.err" \
    && mv "$f.tmp" "$f" || { echo "FAILED gate $i chunk $k"; return 1; }
}
export -f run_gate
tr '\n' '\0' < "$pool" | xargs -0 -P "$parallel" -I{} bash -c 'run_gate "$1"' _ {}
stamp "gates done"
