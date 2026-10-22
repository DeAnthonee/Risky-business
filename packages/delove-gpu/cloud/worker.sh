#!/usr/bin/env bash
# A cloud GPU worker (RunPod's PyTorch image, any Linux box with an NVIDIA GPU): set up the repo at the uploaded
# commit, play its share of a cycle's GPU tables with delove_gpu.generate, and pack the training arrays for download.
# remote.py uploads JOB (default /root/job) and starts this with nohup; it then polls JOB/status:
#
#   JOB/src.tar        git archive of the commit to run (the mirror, its fingerprint, the engine it reads)
#   JOB/models/        the .pt and teacher .json files the tables need (private: deleted when the run ends)
#   JOB/cache/         optional: NVRTC kernels (*.cubin) from the training PC's delove_gpu/_cache/
#   JOB/job.json       {"torch": "2.11.0+cu128", "verify": [verify.py args] or null, "volume": path or null, "home": "full" or "small",
#                      "allowUnverified": bool, "commit": sha}
#   JOB/lane-<i>.sh    one per lane: its GPU and one delove_gpu.generate per configuration (written by remote.py)
#   JOB/lanes/<i>.<step>.<key>.jobs   the tables of each of a lane's configurations
#
# Writes JOB/lanes/<i>/<step>/<key>/{data/<map>/,gpu.json,results.jsonl,gpu.log}, JOB/setup.log, JOB/env.json (GPU, driver,
# torch), JOB/out.tar.gz (everything under lanes/ and the logs), and JOB/status: setup, running, packing, done or
# failed: <why>. All lanes run at the same time (several may share a GPU); a lane plays its steps in order.
# With a network volume (job.json "volume": a path under its mount, /workspace), the full archive is written there
# instead, for the training pod (cloud/trainer.py), and JOB/out.tar.gz is a link to it ("home": "full") or a small
# archive without the arrays (*.npy) for the training PC's gpu.json ("home": "small": the games stay in the cloud).
#
# `worker.sh JOB --salvage` (remote.py, when the pod's time is spent): stops the lanes and packs only the
# configurations that finished (their gpu.json) into JOB/out.tar.gz (with a volume: <volume archive>-salvage.tar.gz).
set -uo pipefail
job=${1:-/root/job}
repo=/root/repo
cd "$job" || exit 1
jget() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v or "")' "$job/job.json" "$1"; }
gz() { if command -v pigz >/dev/null; then pigz -1; else gzip -1; fi; }
vol=$(jget volume)
home=$(jget home)
pack() {  # pack <members...>: JOB/out.tar.gz, and with a volume the full archive on it ($vol)
  if [[ -n $vol ]]; then
    mkdir -p "$(dirname "$vol")" && tar -cf - -C "$job" "$@" | gz > "$vol.part" && mv "$vol.part" "$vol" || return 1
    if [[ $home == small ]]; then
      tar -cf - --exclude='*.npy' -C "$job" "$@" | gz > "$job/out.tar.gz.tmp" || return 1
    else
      ln -sfn "$vol" "$job/out.tar.gz.tmp" || return 1
    fi
  else
    tar -cf - -C "$job" "$@" | gz > "$job/out.tar.gz.tmp" || return 1
  fi
  mv -T "$job/out.tar.gz.tmp" "$job/out.tar.gz"
}
if [[ ${2:-} == --salvage ]]; then
  pkill -f 'worker\.sh [^ ]+$'  # the main worker (its trap marks it failed and deletes the models)
  pkill -f '[l]ane-[0-9]+\.sh'
  pkill -f '[d]elove_gpu\.generate'
  sleep 2
  rm -rf "$job/models"
  mapfile -t finished < <(cd "$job" && for f in lanes/*/*/*/gpu.json; do [[ -f $f ]] && dirname "$f"; done)
  [[ -n $vol ]] && vol=${vol%.tar.gz}-salvage.tar.gz
  rm -f "$job/out.tar.gz"
  members=("${finished[@]}")
  for f in setup.log env.json; do [[ -f $job/$f ]] && members+=("$f"); done
  pack "${members[@]}" || exit 1
  echo "salvaged ${#finished[@]} finished configuration(s)"
  exit 0
fi
status() { echo "$*" > "$job/status.tmp" && mv "$job/status.tmp" "$job/status"; }
fail() { status "failed: $*"; rm -rf "$job/models"; exit 1; }
trap 'fail "worker interrupted"' INT TERM
status setup
exec > >(tee -a "$job/setup.log") 2>&1

# ---- the host driver: remote.py cannot filter hosts by CUDA (RunPod's allowedCudaVersions refuses every placement), so
# a host whose driver is older than the image's CUDA 12.8 ends here and remote.py terminates the pod
cuda=$(nvidia-smi 2>/dev/null | grep -o "CUDA Version: *[0-9.]*" | grep -o "[0-9.]*$" | head -1)
echo "driver CUDA ${cuda:-unknown}"
[[ -n $cuda && $( { echo 12.8; echo "$cuda"; } | sort -V | head -1) == 12.8 ]] || fail "host driver CUDA ${cuda:-unknown} < 12.8"

# ---- Node 22 (the mirror reads the built engine and self-play packages through node) ------------------------------
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
  v=v22.21.0
  curl -fsSL "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" | tar -xJ -C /opt || fail "node download"
  export PATH="/opt/node-$v-linux-x64/bin:$PATH"
fi
node --version

# ---- the repo at the uploaded commit ---------------------------------------------------------------------------------
rm -rf "$repo" && mkdir -p "$repo" && tar -xf "$job/src.tar" -C "$repo" || fail "unpack src.tar"
cd "$repo"
# Only the engine and self-play are needed by generate.py; the whole tree (delove too) when verify.py runs.
if [[ $(python3 -c 'import json,sys; print(1 if json.load(open(sys.argv[1])).get("verify") else 0)' "$job/job.json") == 1 ]]; then
  npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null || fail "npm build"
else
  npm ci --no-audit --no-fund -w @risk/engine -w @risk/selfplay --include-workspace-root >/dev/null ||
    npm ci --no-audit --no-fund >/dev/null || fail "npm ci"
  npm run build -w @risk/engine >/dev/null && npm run build -w @risk/selfplay >/dev/null || fail "npm build"
fi

# ---- Python: the training PC's PyTorch version, so kernels, cache keys and arithmetic match ---------------------------
py=python3
want=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["torch"])' "$job/job.json")
have=$($py -c 'import torch; print(torch.__version__)' 2>/dev/null || echo none)
if [[ $have != "$want" ]]; then
  echo "torch $have -> $want"
  cuda=${want##*+}  # e.g. cu128
  $py -m pip install -q "torch==${want%%+*}" --index-url "https://download.pytorch.org/whl/$cuda" || fail "pip torch $want"
fi
$py -m pip install -q -r packages/delove-gpu/requirements.txt || fail "pip requirements"
mkdir -p packages/delove-gpu/delove_gpu/_cache  # where fused.py and odds.py look
[[ -d $job/cache ]] && cp "$job"/cache/* packages/delove-gpu/delove_gpu/_cache/ 2>/dev/null
$py - > "$job/env.json" <<'EOF' || fail "no CUDA device"
import json, torch
print(json.dumps({"torch": torch.__version__, "cuda": torch.version.cuda, "gpus": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
                  "capability": "".join(map(str, torch.cuda.get_device_capability()))}))
EOF
cat "$job/env.json"

# ---- verify.py (once per new GPU type, or for a commit whose mirror is not verified yet, when asked) ------------------
# Before the fingerprint check: a passing run writes the fingerprint for this commit (download verify-fingerprint.json
# and commit it), so the games below may run on a commit whose mirror was stale; a failing one leaves it stale.
mapfile -t vargs < <(python3 -c 'import json,sys; [print(a) for a in (json.load(open(sys.argv[1])).get("verify") or [])]' "$job/job.json")
if (( ${#vargs[@]} )); then
  status "running: verify.py"
  export DELOVE_COMMIT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commit") or "")' "$job/job.json")
  $py packages/delove-gpu/verify.py --no-build --models "$job/models" "${vargs[@]}" > "$job/verify.log" 2>&1 \
    && echo "verify: ok" || echo "verify: FAILED (see verify.log)"
  cp packages/delove-gpu/engine-fingerprint.json "$job/verify-fingerprint.json" 2>/dev/null
fi
# generate --allow-unverified (benchmarks and comparisons, never training data) plays on a stale mirror, with a warning
if [[ $(python3 -c 'import json,sys; print(1 if json.load(open(sys.argv[1])).get("allowUnverified") else 0)' "$job/job.json") == 1 ]]; then
  $py packages/delove-gpu/delove_gpu/fingerprint.py check || echo "WARNING: the GPU mirror is not verified for this commit (--allow-unverified)"
else $py packages/delove-gpu/delove_gpu/fingerprint.py check || {
  tar -czf "$job/out.tar.gz" -C "$job" setup.log env.json verify.log verify-fingerprint.json 2>/dev/null
  fail "the GPU mirror is not verified for this commit's engine"
}
fi

# ---- the odds tables, once (not uploaded: 240 MB, about two minutes here): lanes sharing a pod would otherwise all build
# them at the same time in the same _cache/, and older commits' odds.py shared its temporary file names (a lane crashed)
(cd packages/delove-gpu && $py -c 'from delove_gpu import odds; odds.tables(2); odds.tables(3)') || fail "odds tables"

# ---- the lanes ---------------------------------------------------------------------------------------------------------
# remote.py writes one script per lane (lane-<i>.sh: CUDA_VISIBLE_DEVICES and one delove_gpu.generate per configuration,
# each skipped once its gpu.json exists); every lane runs at the same time.
status running
exec >> "$job/setup.log" 2>&1
export PY=$py REPO=$repo JOB=$job
pids=()
t_lanes=$SECONDS
for f in "$job"/lane-*.sh; do bash "$f" & pids+=($!); done
failed=0
for p in "${pids[@]}"; do wait "$p" || failed=1; done
took=$(( SECONDS - t_lanes ))
rm -rf "$job/models"  # the private models leave the pod as soon as the games are played

# ---- pack for download (gzip -1: the arrays shrink 11-25x) ----------------------------------------------------------------
# A failed lane still leaves the configurations that delivered their gpu.json: remote.py keeps those and replaces the rest.
# Every lane failed within seconds and none delivered: the code, the models or the arguments, not the host. remote.py
# rents no replacement for "failed: systematic: ..." (a replacement would fail the same way); the reason is the last line
# of the first gpu.log that has one (an empty gpu.log says so).
if (( failed )); then
  pack lanes setup.log env.json 2>/dev/null
  delivered=$(ls "$job"/lanes/*/*/*/gpu.json 2>/dev/null | wc -l)
  if (( delivered == 0 && took < ${SYSTEMATIC_S:-180} )); then
    why=""
    for f in "$job"/lanes/*/*/*/gpu.log; do
      [[ -s $f ]] && { why=$(grep -av '^[[:space:]]*$' "$f" | tail -n1 | tr -d '\r' | cut -c1-240); break; }
    done
    fail "systematic: every lane failed within ${took} s, nothing delivered: ${why:-every gpu.log is empty}"
  fi
  fail "a lane failed (see lanes/*/*/*/gpu.log)"
fi
status packing
files=(lanes setup.log env.json)
[[ -f $job/verify.log ]] && files+=(verify.log)
[[ -f $job/verify-fingerprint.json ]] && files+=(verify-fingerprint.json)
pack "${files[@]}" || fail "pack"
status done
