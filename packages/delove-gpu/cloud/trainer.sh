#!/usr/bin/env bash
# The training pod (RunPod's PyTorch image with the network volume at /workspace): set up the repo at the uploaded
# commit and the training PC's PyTorch, then run cloud/trainer.py (merge the cycle's arrays on the volume, unpack the
# datasets, train.py, export_onnx.py). remote.py train uploads JOB (default /root/job) and starts this with nohup:
#
#   JOB/src.tar      git archive of the commit to run (train.py, export_onnx.py, merge.py, trainer.py)
#   JOB/models/      the init model's .pt only (private: deleted when the run ends)
#   JOB/job.json     {"torch": "2.11.0+cu128", ...: see cloud/trainer.py}
#
# JOB/status: setup, then trainer.py's (preparing, training, packing, done) or "failed: setup: <why>" (remote.py
# replaces the pod) or "failed: <why>" (it does not: the data or the training failed).
set -uo pipefail
job=${1:-/root/job}
repo=/root/repo
cd "$job" || exit 1
status() { echo "$*" > "$job/status.tmp" && mv "$job/status.tmp" "$job/status"; }
fail() { status "failed: setup: $*"; rm -rf "$job/models"; exit 1; }
trap 'fail "interrupted"' INT TERM
status setup
exec > >(tee -a "$job/setup.log") 2>&1

cuda=$(nvidia-smi 2>/dev/null | grep -o "CUDA Version: *[0-9.]*" | grep -o "[0-9.]*$" | head -1)
echo "driver CUDA ${cuda:-unknown}"
[[ -n $cuda && $( { echo 12.8; echo "$cuda"; } | sort -V | head -1) == 12.8 ]] || fail "host driver CUDA ${cuda:-unknown} < 12.8"
grep -q " /workspace " /proc/mounts || fail "no network volume mounted at /workspace"
mkdir -p /workspace/delove

rm -rf "$repo" && mkdir -p "$repo" && tar -xf "$job/src.tar" -C "$repo" || fail "unpack src.tar"
cd "$repo"
command -v pigz >/dev/null || (apt-get install -y -qq pigz >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq pigz >/dev/null 2>&1)) || echo "no pigz: Python's gzip instead (slower)"
py=python3
want=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["torch"])' "$job/job.json")
have=$($py -c 'import torch; print(torch.__version__)' 2>/dev/null || echo none)
if [[ $have != "$want" ]]; then
  echo "torch $have -> $want"
  $py -m pip install -q "torch==${want%%+*}" --index-url "https://download.pytorch.org/whl/${want##*+}" || fail "pip torch $want"
fi
$py -m pip install -q -r packages/delove/python/requirements.txt || fail "pip requirements"
$py -c 'import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))' || fail "no CUDA device"
df -h /root /workspace

exec >> "$job/prep.log" 2>&1
$py packages/delove-gpu/cloud/trainer.py --job "$job" --volume /workspace/delove --work /root/work --repo "$repo"
rm -rf "$job/models" /root/work
