#!/usr/bin/env bash
# A cloud GPU worker (RunPod's PyTorch image, any Linux box with an NVIDIA GPU): set up the repo at the uploaded
# commit, play its share of a cycle's GPU tables with delove_gpu.generate, and pack the training arrays for download.
# remote.py uploads JOB (default /root/job) and starts this with nohup; it then polls JOB/status:
#
#   JOB/src.tar        git archive of the commit to run (the mirror, its fingerprint, the engine it reads)
#   JOB/models/        the .pt and teacher .json files the tables need (private: deleted when the run ends)
#   JOB/cache/         optional: NVRTC kernels (*.cubin) from the training PC's delove_gpu/_cache/
#   JOB/job.json       {"torch": "2.11.0+cu128", "verify": [verify.py args] or null, "volume": path or null, "home": "full" or "small"}
#   JOB/lane-<i>.sh    one per lane: its GPU and one delove_gpu.generate per step (written by remote.py)
#   JOB/lanes/<i>.<step>.jobs   each lane's tables of each step
#
# Writes JOB/lanes/<i>/<step>/{data/<map>/,gpu.json,results.jsonl,gpu.log}, JOB/setup.log, JOB/env.json (GPU, driver,
# torch), JOB/out.tar.gz (everything under lanes/ and the logs), and JOB/status: setup, running, packing, done or
# failed: <why>. All lanes run at the same time (several may share a GPU); a lane plays its steps in order.
# With a network volume (job.json "volume": a path under its mount, /workspace), the full archive is written there
# instead, for the training pod (cloud/trainer.py), and JOB/out.tar.gz is a link to it ("home": "full") or a small
# archive without the arrays (*.npy) for the training PC's gpu.json ("home": "small": the games stay in the cloud).
set -uo pipefail
job=${1:-/root/job}
repo=/root/repo
cd "$job" || exit 1
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
# ---- verify.py (once per new GPU type, or to verify a changed mirror, when asked) ---------------------------------------
# It runs before the fingerprint check, so a commit whose mirror changed can be verified here: verify.py rewrites
# engine-fingerprint.json only when everything matched (verify-fingerprint.json comes home to commit), and the check
# below then passes for this run's games; a failed verify leaves the old fingerprint and the check stops the lanes.
mapfile -t vargs < <(python3 -c 'import json,sys; [print(a) for a in (json.load(open(sys.argv[1])).get("verify") or [])]' "$job/job.json")
if (( ${#vargs[@]} )); then
  status "running: verify.py"
  $py packages/delove-gpu/verify.py --no-build --models "$job/models" "${vargs[@]}" > "$job/verify.log" 2>&1 \
    && echo "verify: ok" || echo "verify: FAILED (see verify.log)"
  cp packages/delove-gpu/engine-fingerprint.json "$job/verify-fingerprint.json" 2>/dev/null
fi
if ! $py packages/delove-gpu/delove_gpu/fingerprint.py check; then
  # bring verify.py's log (and its runs/gpu-verify logs' summaries) home, so a failed verify can be read
  [[ -f $job/verify.log ]] && tar -cf - -C "$job" verify.log setup.log env.json 2>/dev/null | gzip -1 > "$job/out.tar.gz.tmp" &&
    mv -f "$job/out.tar.gz.tmp" "$job/out.tar.gz"
  fail "the GPU mirror is not verified for this commit's engine"
fi

# ---- the odds tables, once (not uploaded: 240 MB, about two minutes here): lanes sharing a pod would otherwise all build
# them at the same time in the same _cache/, and older commits' odds.py shared its temporary file names (a lane crashed)
(cd packages/delove-gpu && $py -c 'from delove_gpu import odds; odds.tables(2); odds.tables(3)') || fail "odds tables"

# ---- the lanes ---------------------------------------------------------------------------------------------------------
# remote.py writes one script per lane (lane-<i>.sh: CUDA_VISIBLE_DEVICES and one delove_gpu.generate per step, each
# skipped once its gpu.json exists); every lane runs at the same time.
status running
exec >> "$job/setup.log" 2>&1
export PY=$py REPO=$repo JOB=$job
pids=()
for f in "$job"/lane-*.sh; do bash "$f" & pids+=($!); done
failed=0
for p in "${pids[@]}"; do wait "$p" || failed=1; done
rm -rf "$job/models"  # the private models leave the pod as soon as the games are played

# ---- pack for download (gzip -1: the arrays shrink 11-25x) ----------------------------------------------------------------
jget() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print(v or "")' "$job/job.json" "$1"; }
vol=$(jget volume)
home=$(jget home)
gz() { if command -v pigz >/dev/null; then pigz -1; else gzip -1; fi; }
pack() {  # pack <members...>: JOB/out.tar.gz, and with a volume the full archive on it
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
# A failed lane still leaves the lanes that delivered their gpu.json: remote.py keeps those and replaces the rest.
(( failed )) && { pack lanes setup.log env.json 2>/dev/null; fail "a lane failed (see lanes/*/*/gpu.log)"; }
status packing
files=(lanes setup.log env.json)
[[ -f $job/verify.log ]] && files+=(verify.log)
[[ -f $job/verify-fingerprint.json ]] && files+=(verify-fingerprint.json)
pack "${files[@]}" || fail "pack"
status done
