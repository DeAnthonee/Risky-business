#!/usr/bin/env bash
# Cycle 16, candidate (b): delove@12 with --fog-dropout 0.5 (the next step of docs/delove-fog.md's ramp), trained on a
# second rented pod at the same time as c16.cycle's candidate (a), from the same datasets on the RunPod network volume.
# Start it once (a)'s training pod has merged cycle 16's games into datasets on the volume (its OUT/remote-train.log
# shows the training starting), so the two pods never merge the same archives. From the repo root:
#
#   REMOTE_VOLUME=<volume id> DELOVE_MODELS=<models> DATA=<data> OUT=<runs>/c16-b PYTHON=<venv python> \
#     bash packages/delove/scripts/cycles/c16-train-b.sh
#
# The candidate is c161-candidate ([rc]N-candidate: the agent registry loads only these names); gate it with
# FOG_CANDIDATE=c161-candidate and c16-fog.cycle. Home training is the fallback (train.py with the same data and flags).
set -euo pipefail
models=${DELOVE_MODELS:?} data=${DATA:?} out=${OUT:?} python=${PYTHON:?} volume=${REMOTE_VOLUME:?}
mkdir -p "$out"
abs() { (cd "$(dirname "$1")" && echo "$(pwd -W 2>/dev/null || pwd)/$(basename "$1")"); }
maps=(a1/classic a2/classic a2/skirmish a3/europe a3/usa a3/asia a4/bohemia a4/nine_realms a4/world
  b/world b/world_large b/greater_europe b/fantasy b/europe_classic)
args=()
for m in "${maps[@]}"; do args+=(--data "c16-$m"); done
for m in "${maps[@]}"; do args+=(--data "c15-$m#0.4"); done
for m in a1/classic a2/classic a3/europe a4/bohemia b/world b/greater_europe; do args+=(--data "c14-$m#0.2"); done
"$python" packages/delove-gpu/cloud/remote.py train --name c16 --candidate c161-candidate --init delove@12 \
  --models "$(abs "$models")" --out "$(abs "$out")" --volume "$volume" --data-root "$(abs "$data")" --push-missing none \
  --max-gpu-hours "${REMOTE_TRAIN_MAX_GPU_HOURS:-1.5}" --home-minutes 30 --disk-gb "${REMOTE_TRAIN_DISK_GB:-250}" \
  ${REMOTE_TRAIN_GPU_TYPE:+--gpu-type "$REMOTE_TRAIN_GPU_TYPE"} --yes "${args[@]}" \
  -- --epochs 1.5 --batch 512 --lr 2e-4 --hidden 192 --rounds 6 --value-target points --amp --branch-weights 0.5,1,2 \
  --fog-dropout 0.5
