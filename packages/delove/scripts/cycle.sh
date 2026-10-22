#!/usr/bin/env bash
# Run a whole Delove training cycle from a config, from the repo root:
#
#   bash packages/delove/scripts/cycle.sh packages/delove/scripts/cycles/c2.cycle
#
# 1. generate: every step's games go into ONE pool of small chunks (most expensive step first), PARALLEL processes
#    at a time (default: CPU threads - 1), so no step ends with a few processes running alone; a step listed in
#    gpu_steps is played on the GPU instead (packages/delove-gpu, delove_gpu.generate), alongside the pool;
# 2. export: each step is exported (training arrays) as soon as its last chunk is done, while the pool goes on;
# 3. train: on the GPU from the config's init model, then export to ONNX next to the other models;
# 4. gate: every ladder match of the config at once, each split into chunks over all CPU threads;
# 5. summary: each step's tables (scripts/summary.mjs), the gate table and the time of every phase in OUT/cycle.md.
#
# The config is a bash file (see cycles/c2.cycle). Everything it names:
#   name, seed                 cycle name (runs/delove/<name>, data/delove/<name>-<step>) and base seed
#   steps=("<step> <jobs file> <title>" ...)       jobs files as for generate.sh; title for the summary
#   gpu_steps=(<step> ... | all)   optional: steps played on the GPU (any map, 2-10 seats, every setting but fog of war;
#                              branch, teacher and network seats); same games as on the CPU, training arrays
#                              written directly (no export). GPU_STEPS (space-separated, or all) overrides it.
#   export_agents=delove-branch@1                  whose decisions are exported (--only-agents)
#   train_data=("<step>/<map>[:mode][#F][*N]" | "<dataset under DATA or path>[:mode][#F][*N]" ...)   *N repeats it N
#                              times; #F trains on a fresh random fraction F of it each epoch (older cycles' data)
#   train_init=<model id, or empty for a fresh network>  candidate=<cN-candidate>  train_args="--epochs 1.5 --lr 3e-4"
#   gates=("<opponent> <players> <games> [options JSON]" ...)   ladder matches of the candidate
#   gpu_gates=(<gate index> ... | all)   optional: gates played on the GPU (delove_gpu.ladder: the same games and the
#                              same gates/g<i>-<k>.json as on the CPU); the others stay on the CPU, and so does every
#                              fog gate ("fogOfWar":true: the GPU mirror has no fog). GPU_GATES
#                              (space-separated indices or all; 1 = all, 0 = none) overrides it.
#   league=<league.json>       optional: jobs seats "@league" / "@league:<kind>" sampled from this league by PFSP
#                              (src/league.ts); the expanded jobs files go to OUT/<step>.league.jobs
# Environment: CYCLE_NAME (overrides name, e.g. for a trial run), DELOVE_MODELS (models folder, default models/delove), OUT (default runs/delove/<name>), DATA (default
# data/delove), PYTHON (default .venv/Scripts/python), PARALLEL, CHUNKS (chunks per process and step, default 4; or
# CHUNK = fixed games per chunk), GATE_CHUNK (games per gate chunk, default 20), GPU_BATCH (games in flight on the
# GPU per configuration; default: sized to GPU_GB of game state, default 3), GPU_LANES (N GPU processes at once, the
# config's GPU steps dealt to them in turn; split a long step into several so the lanes stay busy). Re-running resumes: finished chunks, exports, GPU steps, the trained model and finished gate
# chunks are kept. GATE_SPRT=1 keeps adding gate chunks to the pooled 4-10p tables (and to 2-player tables still in
# doubt) until the sequential test of scripts/sprt.mjs decides, up to GATE_SPRT_MAX games per table (default 800):
# GATE_SPRT_H1 (default 0.15 points per seat) is the gain worth detecting, GATE_SPRT_ALPHA / _BETA (default 0.05) the
# error rates; the summary always adds the paired statistics. PANEL=1 adds the fixed reference panel (panel_gates
# below: older Deloves and the teachers) to the gates, so every cycle measures the same opponents.
# GPU gates refuse a stale GPU mirror (fingerprint.py check) unless GPU_GATES_ALLOW_UNVERIFIED=1;
# GPU_GATE_PROCS (default 1) GPU processes share the gate configurations, each sizing its batch to GPU_GATE_GB (default 1).
# REMOTE_GPUS=N plays the GPU steps on N rented cloud GPUs instead (RunPod; RUNPOD_API_KEY in the environment; see
# packages/delove-gpu/README.md "Cloud workers"): REMOTE_MAX_GPU_HOURS (default 4) caps the spend, REMOTE_TIMINGS
# (space-separated gpu.log files of earlier cycles) sizes the split, REMOTE_PROCS (default 1) processes per GPU,
# REMOTE_GPU_TYPE (default NVIDIA GeForce RTX 4090), REMOTE_CLOUD (SECURE or COMMUNITY), REMOTE_REPLACEMENTS (default 2) and REMOTE_READY_MINUTES (default 15) for replacing a bad pod; progress in OUT/remote.log.
# The cap is per pod, counted from each pod's creation; REMOTE_CAPACITY_WAIT (minutes, default 30) waits for RunPod
# stock (nothing billed). Finished configurations are kept (OUT/remote/units/) when a pod is cut or fails: run cycle.sh
# again and only the missing ones play (OUT/<step>/gpu.partial.json lists them); REMOTE_ACCEPT_PARTIAL=1 merges a step
# from what was delivered instead.
# REMOTE_TRAIN=1 trains on one rented cloud GPU instead, from datasets on the RunPod network volume REMOTE_VOLUME
# (remote.py train; packages/delove-gpu/README.md "Cloud training"): with REMOTE_GPUS the generation pods run in the
# volume's data center and leave their arrays on it (only gpu.json, gpu.log and the like come home; REMOTE_HOME_COPY=1
# downloads the arrays too), and the training pod is rented REMOTE_TRAIN_LEAD minutes (default 12) before generation's
# estimated end, so its setup and the earlier cycles' datasets overlap it. Every train_data entry must be a step of this
# cycle or <dataset>/<map> under DATA; a dataset not on the volume is pushed from DATA only with REMOTE_TRAIN_PUSH=cycle
# (this cycle's, e.g. CPU steps) or all (seeds the volume once); otherwise the candidate trains at home as usual, which
# needs the arrays at home. REMOTE_TRAIN_MAX_GPU_HOURS (default 1.5), REMOTE_TRAIN_MINUTES (the home training's minutes,
# for the estimate; default 30), REMOTE_TRAIN_GPU_TYPE (default REMOTE_GPU_TYPE), REMOTE_TRAIN_DISK_GB (default 200);
# progress in OUT/remote-train.log.
set -euo pipefail
config=$1
export_agents=delove-branch@1
train_data=(); gates=(); train_args=""; gpu_steps=(); gpu_gates=()
# shellcheck source=/dev/null
source "$config"
name=${CYCLE_NAME:-$name}
root=$(pwd)
out=${OUT:-runs/delove/$name}
data=${DATA:-data/delove}
models=${DELOVE_MODELS:-models/delove}
python=${PYTHON:-.venv/Scripts/python}
[[ $python == /* || $python == ?:* ]] || python="$(pwd)/$python"
threads=$(node -e 'console.log(require("os").availableParallelism())')
parallel=${PARALLEL:-$((threads - 1))}
export DELOVE_MODELS=$models
export DELOVE_TEMPERATURE=${DELOVE_TEMPERATURE:-0.7}
mkdir -p "$out"
[[ -n ${GPU_STEPS:-} ]] && read -r -a gpu_steps <<< "$GPU_STEPS"
# league=<league.json> (packages/delove/README.md "League"): a step whose jobs file has "@league" seats plays
# OUT/<step>.league.jobs instead, its league seats sampled by PFSP (src/league.ts) from the cycle's seed; a resumed
# cycle keeps the file it already wrote, so it plays the same games.
if [[ -n ${league:-} ]]; then
  for i in "${!steps[@]}"; do
    read -r step jobs title <<< "${steps[$i]}"
    grep -q '@league' "$jobs" || continue
    expanded="$out/$step.league.jobs"
    [[ -f $expanded ]] || node packages/delove/dist/league-cli.js expand --league "$league" --jobs "$jobs" --seed "$seed" --out "$expanded" \
      || { echo "FAILED league expansion of $jobs"; exit 1; }
    steps[$i]="$step $expanded $title"
  done
fi
on_gpu() { [[ " ${gpu_steps[*]} " == *" all "* || " ${gpu_steps[*]} " == *" $1 "* ]]; }
# Absolute paths for Python (on Windows Git Bash, C:/... rather than /c/...).
absdir() { (cd "$1" || exit 1; pwd -W 2>/dev/null || pwd); }
abs() { echo "$(absdir "$(dirname "$1")")/$(basename "$1")"; }
times="$out/times.tsv"
t_start=$(date +%s)
# times.tsv holds this invocation's phases; times-<start>.tsv keeps a copy, so a resumed cycle keeps every
# invocation's phase times (scripts/timing-report.mjs and the dashboard read them all).
times_copy="$out/times-$(date -d "@$t_start" +%Y%m%d-%H%M%S).tsv"
stamp() { echo -e "$1\t$(( $(date +%s) - t_start ))" | tee -a "$times" >> "$times_copy"; echo "[$(date +%T)] $1"; }
: > "$times"
# Every step, where it plays and its jobs file, for the dashboard (scripts/dashboard.mjs).
for s in "${steps[@]}"; do
  read -r step jobs title <<< "$s"
  echo -e "$step\t$(on_gpu "$step" && echo gpu || echo cpu)\t$(abs "$jobs")\t$title"
done > "$out/plan.tsv"
echo -e "train\t$candidate\ngates\t${#gates[@]}" >> "$out/plan.tsv"
stamp start

# ---- 1. one pool of chunks over every step ----------------------------------------------------------------------
pool="$out/pool.txt"
: > "$pool"
for s in "${steps[@]}"; do
  read -r step jobs _ <<< "$s"
  mkdir -p "$out/$step"
  on_gpu "$step" && continue
  grep -v '^\s*\(#\|$\)' "$jobs" | while read -r g total agents options; do
    # Games per chunk: CHUNK, else enough for CHUNKS chunks per process across this step.
    total_step=$(grep -v '^\s*\(#\|$\)' "$jobs" | awk '{n += $2} END {print n}')
    chunk=${CHUNK:-$(( (total_step + parallel * ${CHUNKS:-4} - 1) / (parallel * ${CHUNKS:-4}) ))}
    for ((st = 0; st < total; st += chunk)); do
      echo "$step $g $st $agents $(( total - st < chunk ? total - st : chunk )) ${options:-"{}"}"
    done
  done > "$out/$step/chunks.txt"
  echo "$step $(wc -l < "$out/$step/chunks.txt")" >> "$out/steps.txt.tmp"
done
touch "$out/steps.txt.tmp"
mv "$out/steps.txt.tmp" "$out/steps.txt"
# Most expensive step first (by the agents' per-game cost, estimated from seats: more seats and bigger maps cost
# more), cheapest last, so the pool ends on short chunks. The config's order is the tie-break.
for s in "${steps[@]}"; do read -r step _ <<< "$s"; on_gpu "$step" || cat "$out/$step/chunks.txt"; done |
  awk '{ seats = split($4, a, ","); cost = seats * ($6 ~ /skirmish/ ? 1 : 3); print cost "\t" NR "\t" $0 }' |
  sort -t$'\t' -k1,1nr -k2,2n | cut -f3- > "$pool"
echo "$(wc -l < "$pool") chunks over $(wc -l < "$out/steps.txt") steps, $parallel at a time -> $out"

# The GPU steps, one after another in the background while the pool plays: same tables, seeds and branch settings
# (the DELOVE_BRANCH_* environment) as the pool would use; gpu.json holds the per-table results for summary.mjs.
# gen_args: delove_gpu.generate's seed and branch settings, the same for a local and a remote (REMOTE_GPUS) step.
gen_args() {
  args=(--seed "$seed" --batch "${GPU_BATCH:-0}" --gpu-gb "${GPU_GB:-3}")
  [[ -n ${DELOVE_BRANCH_TEACHER:-} ]] && args+=(--teacher "$DELOVE_BRANCH_TEACHER")
  [[ -n ${DELOVE_BRANCH_RANKER:-} ]] && args+=(--ranker "$DELOVE_BRANCH_RANKER")
  [[ -n ${DELOVE_BRANCH_OPTIONS:-} ]] && args+=(--options "$DELOVE_BRANCH_OPTIONS")
  [[ -n ${DELOVE_BRANCH_ROLLOUTS:-} ]] && args+=(--rollouts "$DELOVE_BRANCH_ROLLOUTS")
  [[ -n ${DELOVE_BRANCH_HORIZON:-} ]] && args+=(--horizon "$DELOVE_BRANCH_HORIZON")
  [[ -n ${DELOVE_BRANCH_MARGIN:-} ]] && args+=(--margin "$DELOVE_BRANCH_MARGIN")
  [[ -n ${DELOVE_BRANCH_SKIP+x} ]] && args+=(--skip "$DELOVE_BRANCH_SKIP")
  [[ -n ${DELOVE_BRANCH_SCORE:-} ]] && args+=(--score "$DELOVE_BRANCH_SCORE")
  [[ -n ${DELOVE_BRANCH_KILL_WEIGHT:-} ]] && args+=(--kill-weight "$DELOVE_BRANCH_KILL_WEIGHT")
  [[ -n ${DELOVE_BRANCH_THREAT:-} ]] && args+=(--threat "$DELOVE_BRANCH_THREAT")
  [[ -n ${DELOVE_BRANCH_CLOSE_ROLLOUTS:-} ]] && args+=(--close-rollouts "$DELOVE_BRANCH_CLOSE_ROLLOUTS")
  [[ -n ${DELOVE_BRANCH_CLOSE_HORIZON:-} ]] && args+=(--close-horizon "$DELOVE_BRANCH_CLOSE_HORIZON")
  [[ -n ${DELOVE_BRANCH_ROOT:-} ]] && args+=(--root "$DELOVE_BRANCH_ROOT")
  [[ -n ${DELOVE_BRANCH_K:-} ]] && args+=(--gumbel-k "$DELOVE_BRANCH_K")
  [[ -n ${DELOVE_BRANCH_COPIES:-} ]] && args+=(--copies "$DELOVE_BRANCH_COPIES")
  [[ -n ${DELOVE_BRANCH_ROLLOUT:-} ]] && args+=(--rollout "$DELOVE_BRANCH_ROLLOUT")
  # The config's export_agents, so GPU steps also export per-job seats such as delove-branch@1:range (#148).
  args+=(--export-agents "$export_agents")
  if [[ -n ${DELOVE_BRANCH_VALUE:-} && ${DELOVE_BRANCH_VALUE} != 0 ]]; then
    echo "GPU steps: DELOVE_BRANCH_VALUE is not mirrored on the GPU"; return 1
  fi
}
run_gpu_step() {
  local step=$1 jobs=$2 args
  [[ -f "$out/$step/gpu.json" ]] && return 0
  gen_args || return 1
  args+=(--models "$(absdir "$models")" --jobs "$(abs "$jobs")")
  # The jobs file's tables as they are (options JSON included); generate.py refuses any setting the mirror does not
  # cover (fog of war) and any agent it cannot play on the GPU (risky@1, -explore seats).
  mkdir -p "$data"
  args+=(--out "$(absdir "$data")/$name-$step" --summary "$(absdir "$out/$step")/gpu.json.tmp")
  (cd packages/delove-gpu && "$python" -m delove_gpu.generate "${args[@]}") > "$out/$step/gpu.log" 2>&1     || { echo "FAILED GPU step $step (see $out/$step/gpu.log)"; return 1; }
  mv "$out/$step/gpu.json.tmp" "$out/$step/gpu.json"
  stamp "generated and exported $step (GPU)"
}
gpu_runner=""
if (( ${#gpu_steps[@]} )); then
  # A stale mirror would fail a GPU step still to play; say so now, before the pool spends its minutes.
  for s in "${steps[@]}"; do
    read -r st _ <<< "$s"
    on_gpu "$st" || continue  # the config's steps, so gpu_steps=(all) is checked step by step too
    [[ -f "$out/$st/gpu.json" ]] && continue
    "$python" packages/delove-gpu/delove_gpu/fingerprint.py check || { echo "run packages/delove-gpu/verify.py first"; exit 1; }
    break
  done
  if [[ -n ${REMOTE_GPUS:-} ]]; then
    # REMOTE_GPUS=N: every GPU step at once on N rented cloud GPUs (packages/delove-gpu/cloud/remote.py), split by
    # configuration and merged back into the same DATA and OUT/<step>/gpu.json; the local GPU stays free.
    (
      mkdir -p "$data"
      remote=(--name "$name" --pods "$REMOTE_GPUS" --procs "${REMOTE_PROCS:-1}" --models "$(absdir "$models")" --data "$(absdir "$data")"
        --out "$(absdir "$out")" --max-gpu-hours "${REMOTE_MAX_GPU_HOURS:-4}" --yes)
      for s in "${steps[@]}"; do
        read -r step jobs _ <<< "$s"
        on_gpu "$step" && remote+=(--step "$step=$(abs "$jobs")")
      done
      for t in ${REMOTE_TIMINGS:-}; do remote+=(--timings "$(abs "$t")"); done
      [[ -n ${REMOTE_GPU_TYPE:-} ]] && remote+=(--gpu-type "$REMOTE_GPU_TYPE")
      [[ -n ${REMOTE_CLOUD:-} ]] && remote+=(--cloud "$REMOTE_CLOUD")
      [[ -n ${REMOTE_REPLACEMENTS:-} ]] && remote+=(--replacements "$REMOTE_REPLACEMENTS")
      [[ -n ${REMOTE_READY_MINUTES:-} ]] && remote+=(--ready-minutes "$REMOTE_READY_MINUTES")
      [[ -n ${REMOTE_CAPACITY_WAIT:-} ]] && remote+=(--capacity-wait "$REMOTE_CAPACITY_WAIT")
      [[ ${REMOTE_ACCEPT_PARTIAL:-0} == 1 ]] && remote+=(--accept-partial)
      if [[ ${REMOTE_TRAIN:-0} == 1 ]]; then  # the arrays go to the network volume, for the training pod
        remote+=(--volume "$REMOTE_VOLUME")
        [[ ${REMOTE_HOME_COPY:-0} == 1 ]] && remote+=(--home-copy)
      fi
      gen_args || exit 1
      "$python" packages/delove-gpu/cloud/remote.py run "${remote[@]}" -- "${args[@]}" > "$out/remote.log" 2>&1         || { echo "FAILED remote GPU steps (see $out/remote.log)"; exit 1; }
      stamp "generated and exported the GPU steps (remote, $REMOTE_GPUS GPUs)"
    ) &
  else
    # GPU_LANES=N: N GPU processes at once, the config's GPU steps dealt to them in turn (config order), so their
    # straggler tails overlap (a configuration's last few games step alone; one configuration's game state takes
    # about 1 GB of the card). Split a long step into several so every lane stays busy.
    (
      lanes=${GPU_LANES:-1}
      lane() {  # lane <k>: every lanes-th GPU step, starting at the k-th
        local i=0
        for s in "${steps[@]}"; do
          read -r step jobs _ <<< "$s"
          on_gpu "$step" || continue
          (( i % lanes == $1 )) && { run_gpu_step "$step" "$jobs" || return 1; }
          i=$((i + 1))
        done
      }
      pids=()
      for ((k = 0; k < lanes; k++)); do lane "$k" & pids+=($!); done
      for p in "${pids[@]}"; do wait "$p" || exit 1; done
    ) &
  fi
  gpu_runner=$!
fi

# REMOTE_TRAIN=1: the cloud training job (packages/delove-gpu/cloud/remote.py train). train_data resolved for the volume:
# "<step>/<map>" of this cycle is the dataset <name>-<step>/<map>, anything else must be "<dataset>/<map>".
remote_train=""; rt=()
if [[ ${REMOTE_TRAIN:-0} == 1 ]]; then
  [[ -n ${REMOTE_VOLUME:-} ]] || { echo "REMOTE_TRAIN=1 needs REMOTE_VOLUME (a RunPod network volume id)"; exit 1; }
  is_step() { local s st; for s in "${steps[@]}"; do read -r st _ <<< "$s"; [[ $st == "$1" ]] && return 0; done; return 1; }
  rt=(--name "$name" --candidate "$candidate" --models "$(absdir "$models")" --out "$(absdir "$out")" --volume "$REMOTE_VOLUME"
    --data-root "$(absdir "$data")" --push-missing "${REMOTE_TRAIN_PUSH:-none}" --max-gpu-hours "${REMOTE_TRAIN_MAX_GPU_HOURS:-1.5}"
    --home-minutes "${REMOTE_TRAIN_MINUTES:-30}" --disk-gb "${REMOTE_TRAIN_DISK_GB:-200}" --abort-file "$(absdir "$out")/remote-train.abort" --yes)
  [[ -n ${train_init:-} ]] && rt+=(--init "$train_init")
  rt_type=${REMOTE_TRAIN_GPU_TYPE:-${REMOTE_GPU_TYPE:-}}
  [[ -n $rt_type ]] && rt+=(--gpu-type "$rt_type")
  [[ -n ${REMOTE_CLOUD:-} ]] && rt+=(--cloud "$REMOTE_CLOUD")
  for d in "${train_data[@]}"; do
    reps=1; [[ $d == *"*"* ]] && reps=${d##*"*"} && d=${d%"*"*}
    first=${d%%/*}
    spec=$d; is_step "$first" && spec="$name-$d"
    [[ $spec == /* || $spec == ?:* || $spec != */* ]] && { echo "REMOTE_TRAIN: $d is not <step>/<map> or <dataset>/<map>; training at home"; rt=(); break; }
    for ((i = 0; i < reps; i++)); do rt+=(--data "$spec"); done
  done
  if (( ${#rt[@]} )); then
    rm -f "$out/remote-train.abort"
    if [[ -n ${REMOTE_GPUS:-} && -z ${GENERATE_ONLY:-} && ! -f "$models/$candidate.onnx" ]]; then
      # Rented before generation ends: it waits for every step's gpu.json (GPU) or export.json (CPU) to merge and train.
      rm -f "$out/remote/eta"
      for s in "${steps[@]}"; do
        read -r st _ <<< "$s"
        if on_gpu "$st"; then rt+=(--wait-for "$(absdir "$out/$st")/gpu.json"); else rt+=(--wait-for "$(absdir "$out/$st")/export.json"); fi
      done
      rt+=(--eta "$(absdir "$out")/remote/eta" --lead-minutes "${REMOTE_TRAIN_LEAD:-12}")
      mkdir -p "$out/remote"
      # shellcheck disable=SC2086
      "$python" packages/delove-gpu/cloud/remote.py train "${rt[@]}" -- $train_args > "$out/remote-train.log" 2>&1 &
      remote_train=$!
    fi
  fi
fi

export out seed root
run_chunk() {
  read -r step g start agents games options <<< "$1"
  local base="$out/$step/$g-c$start"
  [[ -f "$base.done" ]] && return 0
  DELOVE_BRANCH_STATS="$out/$step" node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js play \
    --agents "$agents" --games "$games" --start "$start" --seed "$seed" --options "$options" --log "$out/$step/$g/c$start" \
    > "$base.json" 2> "$base.err" && touch "$base.done" || { echo "FAILED $step $g c$start (see $base.err)"; return 1; }
}
export -f run_chunk

export_step() {
  local step=$1
  [[ -f "$out/$step/export.json" ]] && return 0
  local logs base
  # Windows paths for node: Git Bash converts only the first path of a comma-separated list, so an absolute
  # /c/... OUT would leave every other log directory unreadable.
  base=$(absdir "$out/$step")
  logs=$(cd "$out/$step" && ls -d */c* | sed "s|^|$base/|" | paste -sd,)
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js export --log "$logs" --out "$data/$name-$step" \
    --only-agents "$export_agents" --force > "$out/$step/export.json.tmp" 2> "$out/$step/export.err"
  mv "$out/$step/export.json.tmp" "$out/$step/export.json"
  stamp "exported $step"
}

# Watch the pool: export each step once all its chunks are done.
watch_exports() {
  declare -A started=()
  [[ -s "$out/steps.txt" ]] || return 0
  while true; do
    local pending=0
    while read -r step n; do
      [[ -n "${started[$step]:-}" ]] && continue
      if (( $(ls "$out/$step"/*.done 2>/dev/null | wc -l) >= n )); then
        started[$step]=1
        stamp "generated $step"
        export_step "$step" &
      else
        pending=1
      fi
    done < "$out/steps.txt"
    (( pending )) || break
    [[ -f "$out/pool.failed" ]] && break
    sleep 3
  done
  wait
}
watch_exports &
watcher=$!
tr '\n' '\0' < "$pool" | xargs -0 -P "$parallel" -I{} bash -c 'run_chunk "$1"' _ {} || touch "$out/pool.failed"
stamp "generation done"
wait "$watcher"
[[ -n $gpu_runner ]] && { wait "$gpu_runner" || touch "$out/pool.failed"; }
if [[ -f "$out/pool.failed" ]]; then
  rm -f "$out/pool.failed"
  echo "generation failed"
  # the cloud training job ends its pod (if it has one) and exits
  [[ -n $remote_train ]] && { touch "$out/remote-train.abort"; wait "$remote_train" || true; }
  exit 1
fi
stamp "exports done"
# GENERATE_ONLY=1: stop here (play part of a cycle now, train and gate later with the full config: finished steps are
# kept, so a later run of a config that lists them skips straight to the steps still to play).
[[ -n ${GENERATE_ONLY:-} ]] && { echo "GENERATE_ONLY: stopping after generation"; exit 0; }

# ---- 3. train on the GPU ----------------------------------------------------------------------------------------
cand="$models/$candidate"
if [[ ! -f "$cand.onnx" && ${REMOTE_TRAIN:-0} == 1 && ${#rt[@]} -gt 0 ]]; then
  rc=0
  if [[ -n $remote_train ]]; then
    wait "$remote_train" || rc=$?
  else
    # shellcheck disable=SC2086
    "$python" packages/delove-gpu/cloud/remote.py train "${rt[@]}" -- $train_args > "$out/remote-train.log" 2>&1 || rc=$?
  fi
  if (( rc == 0 )) && [[ -f "$cand.onnx" ]]; then
    stamp "trained $candidate (cloud)"
  elif (( rc == 3 )); then
    echo "REMOTE_TRAIN: a dataset is not on the volume (see $out/remote-train.log); training at home"
  else
    echo "REMOTE_TRAIN failed (exit $rc, see $out/remote-train.log); training at home"
  fi
fi
if [[ ! -f "$cand.onnx" ]]; then
  args=()
  for d in "${train_data[@]}"; do
    reps=1; [[ $d == *"*"* ]] && reps=${d##*"*"} && d=${d%"*"*}
    frac=""; [[ $d == *"#"* ]] && frac="#${d##*#}" && d=${d%#*}
    mode=""; [[ $d == *:* ]] && mode=":${d##*:}" && d=${d%:*}
    # <step>/<map> of this cycle, else a dataset under DATA, else a path.
    path="$data/$name-$d"; [[ -e $path ]] || path="$data/$d"; [[ -e $path ]] || path=$d
    [[ -e $path ]] || { echo "no training data $path"; exit 1; }
    for ((i = 0; i < reps; i++)); do args+=(--data "$(absdir "$path")$mode$frac"); done
  done
  cand_path=$(abs "$cand")
  # An empty train_init trains a fresh network (its size from train_args, e.g. --hidden 192 --rounds 6).
  [[ -n ${train_init:-} ]] && args+=(--init "$(abs "$models/$train_init.pt")")
  # shellcheck disable=SC2086
  (cd packages/delove/python && "$python" train.py "${args[@]}" --out "$cand_path" $train_args &&
    "$python" export_onnx.py "$cand_path") > "$out/train.log" 2>&1 || { echo "training failed (see $out/train.log)"; exit 1; }
  stamp "trained $candidate"
fi

# ---- 4. ladder gates, all at once -------------------------------------------------------------------------------
gate_chunk=${GATE_CHUNK:-20}
# The fixed reference panel (PANEL=1): the same opponents every cycle, so progress reads off one table across cycles.
panel_gates=(
  'delove@6 6 200 {"map":"world"}' 'delove@6 2 400 {}' 'delove@3 6 200 {"map":"world"}'
  'jacob-sensei@1 6 200 {"map":"world"}' 'jacob-sensei@2 6 200 {"map":"world"}' 'jacob-sensei@2 2 400 {}' 'delove-teacher@2 2 400 {}'
)
[[ ${PANEL:-0} == 1 ]] && gates+=("${panel_gates[@]}")
mkdir -p "$out/gates"
gpool="$out/gates/pool.txt"
: > "$gpool"
for i in "${!gates[@]}"; do
  read -r opp players games options <<< "${gates[$i]}"
  for ((k = 0; k * gate_chunk < games; k++)); do
    echo "$i $k $opp $players $(( games - k * gate_chunk < gate_chunk ? games - k * gate_chunk : gate_chunk )) ${options:-"{}"}" >> "$gpool"
  done
done
# Gates listed in gpu_gates play on the GPU: one process (delove_gpu.ladder) for all their chunks, every chunk of one
# configuration in one engine, alongside the CPU gates. Same chunks, seeds and output files as run_gate.
case ${GPU_GATES:-} in
  '') ;;
  1) gpu_gates=(all) ;;  # the environment's on switch; gpu_gates=(1) in a config is gate 1
  0) gpu_gates=() ;;
  *) read -r -a gpu_gates <<< "$GPU_GATES" ;;
esac
gate_on_gpu() { [[ " ${gpu_gates[*]} " == *" all "* || " ${gpu_gates[*]} " == *" $1 "* ]]; }
gpu_gpool="$out/gates/gpu.txt"
cpu_gpool="$out/gates/cpu.txt"
: > "$gpu_gpool"
: > "$cpu_gpool"
while read -r i k opp players games options; do
  [[ -f "$out/gates/g$i-$k.json" ]] && continue
  # Fog gates always play on the CPU: the GPU mirror has no fog (each seat plays on its view there, foggedAgent).
  if gate_on_gpu "$i" && [[ $options != *'"fogOfWar":true'* && $options != *'"fogOfWar": true'* ]]; then
    echo "$i $k $opp $players $games $(( seed * 1000 + 100 * i + k )) $options" >> "$gpu_gpool"
  else
    echo "$i $k $opp $players $games $options" >> "$cpu_gpool"
  fi
done < "$gpool"
gpu_gate_runner=""
if [[ -s "$gpu_gpool" ]]; then
  gpu_gate_args=(--models "$(absdir "$models")" --candidate "$candidate" --gates "$(abs "$gpu_gpool")" --out "$(absdir "$out/gates")"
    --batch "${GPU_BATCH:-0}" --gpu-gb "${GPU_GATE_GB:-1}" --procs "${GPU_GATE_PROCS:-1}")
  if [[ ${GPU_GATES_ALLOW_UNVERIFIED:-0} == 1 ]]; then
    gpu_gate_args+=(--allow-unverified)
  else
    "$python" packages/delove-gpu/delove_gpu/fingerprint.py check ||
      { echo "GPU gates: the mirror is stale (run packages/delove-gpu/verify.py first, or GPU_GATES_ALLOW_UNVERIFIED=1)"; exit 1; }
  fi
  echo "$(wc -l < "$gpu_gpool") gate chunks on the GPU, $(wc -l < "$cpu_gpool") on the CPU"
  (cd packages/delove-gpu && "$python" -m delove_gpu.ladder "${gpu_gate_args[@]}") > "$out/gates/gpu.log" 2>&1 &
  gpu_gate_runner=$!
fi
export candidate
run_gate() {
  read -r i k opp players games options <<< "$1"
  local f="$out/gates/g$i-$k.json"
  [[ -f "$f" ]] && return 0
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js ladder --candidate "$candidate" --best "$opp" \
    --players "$players" --games "$games" --seed $(( seed * 1000 + 100 * i + k )) --options "$options" > "$f.tmp" 2> "$out/gates/g$i-$k.err" \
    && mv "$f.tmp" "$f" || { echo "FAILED gate $i chunk $k"; return 1; }
}
export -f run_gate
gates_failed=0
tr '\n' '\0' < "$cpu_gpool" | xargs -0 -P "$parallel" -I{} bash -c 'run_gate "$1"' _ {} || gates_failed=1
if [[ -n $gpu_gate_runner ]]; then
  wait "$gpu_gate_runner" || { echo "FAILED GPU gates (see $out/gates/gpu.log)"; gates_failed=1; }
fi
(( gates_failed )) && exit 1
# GATE_SPRT=1: more chunks for the tables whose call is still open, until the sequential test decides.
if [[ ${GATE_SPRT:-0} == 1 ]]; then
  sprt_args=(--h1 "${GATE_SPRT_H1:-0.15}" --alpha "${GATE_SPRT_ALPHA:-0.05}" --beta "${GATE_SPRT_BETA:-0.05}" --max-games "${GATE_SPRT_MAX:-800}")
  for ((round = 1; round <= 20; round++)); do
    more=$(node packages/delove/scripts/sprt.mjs "$out/gates" "${sprt_args[@]}" --next 2)
    [[ -z $more ]] && break
    echo "SPRT round $round: $(wc -l <<< "$more") more gate chunks"
    printf '%s\n' "$more" | tr '\n' '\0' | xargs -0 -P "$parallel" -I{} bash -c 'run_gate "$1"' _ {} || { echo "FAILED SPRT gate chunks"; exit 1; }
  done
fi
stamp "gates done"
stamp "summary"

# ---- 5. summary -------------------------------------------------------------------------------------------------
{
  echo "## $name"
  for s in "${steps[@]}"; do
    read -r step _ title <<< "$s"
    echo
    node packages/delove/scripts/summary.mjs "$out/$step" "$title"
  done
  echo
  echo "### $name: ladder gate ($candidate)"
  echo
  node -e '
const fs = require("fs");
const [dir, ...gates] = process.argv.slice(1);
// Points: mean leaderboard points per seat (candidate, opponent) and their difference, with a 95% interval from
// the spread of the chunk differences; the candidate mean place and kills per seat; games at the turn limit.
console.log("| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
gates.forEach((g, i) => {
  const [opp, players, , ...opt] = g.split(" ");
  const rs = fs.readdirSync(dir).filter((f) => new RegExp(`^g${i}-\\d+\\.json$`).test(f)).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")));
  const n = rs.reduce((a, r) => a + r.games, 0);
  const s = rs.reduce((a, r) => a + r.score * r.games, 0) / n;
  // Each chunk reports a pair-based interval; combine the chunks as independent samples.
  const se = Math.sqrt(rs.reduce((a, r) => a + (r.games * (r.scoreHigh - r.scoreLow) / 3.92) ** 2, 0)) / n;
  const elo = (x) => Math.round(400 * Math.log10(Math.min(0.999, Math.max(0.001, x)) / (1 - Math.min(0.999, Math.max(0.001, x)))));
  const w = (k) => rs.reduce((a, r) => a + (r[k] ?? 0) * r.games, 0) / n;
  const d = w("pointsDiff");
  const k = rs.length;
  const mk = rs.reduce((a, r) => a + (r.pointsDiff ?? 0), 0) / k;  // unweighted chunk mean, for the spread
  const dse = k > 1 ? Math.sqrt(rs.reduce((a, r) => a + ((r.pointsDiff ?? 0) - mk) ** 2, 0) / (k - 1) / k) : 0;
  const tl = rs.reduce((a, r) => a + (r.turnLimit ?? 0), 0);
  const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
  console.log(`| ${opp} | ${players} | ${opt.join(" ") || "{}"} | ${n} | ${s.toFixed(3)} | ${(s - 1.96 * se).toFixed(3)}-${(s + 1.96 * se).toFixed(3)} | ${elo(s) > 0 ? "+" : ""}${elo(s)} | ` +
    `${f2(w("points"))} | ${f2(w("bestPoints"))} | ${f2(d)} (${f2(d - 1.96 * dse)} to ${f2(d + 1.96 * dse)}) | ${w("meanPlacement").toFixed(2)} | ${w("killsPerGame").toFixed(2)} | ${tl} |`);
});
' "$out/gates" "${gates[@]}"
  echo
  echo "### $name: paired statistics (mirrored pairs) and SPRT"
  echo
  node packages/delove/scripts/sprt.mjs "$out/gates" --h1 "${GATE_SPRT_H1:-0.15}" --alpha "${GATE_SPRT_ALPHA:-0.05}" --beta "${GATE_SPRT_BETA:-0.05}" --max-games "${GATE_SPRT_MAX:-800}"
  echo
  echo "### $name: time per phase (minutes from the start)"
  echo
  echo "| phase | minutes |"
  echo "| --- | --- |"
  awk -F'\t' '{ printf "| %s | %.1f |\n", $1, $2 / 60 }' "$times"
} > "$out/cycle.md"
cat "$out/cycle.md"
