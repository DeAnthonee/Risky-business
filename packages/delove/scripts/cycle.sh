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
#   train_data=("<step>/<map>[:mode][*N]" | "<dataset under DATA or path>[:mode][*N]" ...)   *N repeats it N times
#   train_init=<model id, or empty for a fresh network>  candidate=<cN-candidate>  train_args="--epochs 1.5 --lr 3e-4"
#   gates=("<opponent> <players> <games> [options JSON]" ...)   ladder matches of the candidate
#   gpu_gates=(<gate index> ... | all)   optional: gates played on the GPU (delove_gpu.ladder: the same games and the
#                              same gates/g<i>-<k>.json as on the CPU); the others stay on the CPU. GPU_GATES
#                              (space-separated indices or all; 1 = all, 0 = none) overrides it.
# Environment: CYCLE_NAME (overrides name, e.g. for a trial run), DELOVE_MODELS (models folder, default models/delove), OUT (default runs/delove/<name>), DATA (default
# data/delove), PYTHON (default .venv/Scripts/python), PARALLEL, CHUNKS (chunks per process and step, default 4; or
# CHUNK = fixed games per chunk), GATE_CHUNK (games per gate chunk, default 20), GPU_BATCH (games in flight on the
# GPU per configuration; default: sized to GPU_GB of game state, default 3). Re-running resumes: finished chunks, exports, GPU steps, the trained model and finished gate
# chunks are kept. GPU gates refuse a stale GPU mirror (fingerprint.py check) unless GPU_GATES_ALLOW_UNVERIFIED=1;
# GPU_GATE_PROCS (default 1) GPU processes share the gate configurations, each sizing its batch to GPU_GATE_GB (default 1).
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
run_gpu_step() {
  local step=$1 jobs=$2
  [[ -f "$out/$step/gpu.json" ]] && return 0
  local args=(--models "$(absdir "$models")" --seed "$seed" --batch "${GPU_BATCH:-0}" --gpu-gb "${GPU_GB:-3}" --jobs "$(abs "$jobs")")
  [[ -n ${DELOVE_BRANCH_TEACHER:-} ]] && args+=(--teacher "$DELOVE_BRANCH_TEACHER")
  [[ -n ${DELOVE_BRANCH_RANKER:-} ]] && args+=(--ranker "$DELOVE_BRANCH_RANKER")
  [[ -n ${DELOVE_BRANCH_OPTIONS:-} ]] && args+=(--options "$DELOVE_BRANCH_OPTIONS")
  [[ -n ${DELOVE_BRANCH_ROLLOUTS:-} ]] && args+=(--rollouts "$DELOVE_BRANCH_ROLLOUTS")
  [[ -n ${DELOVE_BRANCH_HORIZON:-} ]] && args+=(--horizon "$DELOVE_BRANCH_HORIZON")
  [[ -n ${DELOVE_BRANCH_MARGIN:-} ]] && args+=(--margin "$DELOVE_BRANCH_MARGIN")
  [[ -n ${DELOVE_BRANCH_SKIP+x} ]] && args+=(--skip "$DELOVE_BRANCH_SKIP")
  if [[ -n ${DELOVE_BRANCH_VALUE:-} && ${DELOVE_BRANCH_VALUE} != 0 ]]; then
    echo "GPU step $step: DELOVE_BRANCH_VALUE is not mirrored on the GPU"; return 1
  fi
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
  (
    for s in "${steps[@]}"; do
      read -r step jobs _ <<< "$s"
      if on_gpu "$step"; then run_gpu_step "$step" "$jobs" || exit 1; fi
    done
  ) &
  gpu_runner=$!
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
[[ -f "$out/pool.failed" ]] && { rm -f "$out/pool.failed"; echo "generation failed"; exit 1; }
stamp "exports done"

# ---- 3. train on the GPU ----------------------------------------------------------------------------------------
cand="$models/$candidate"
if [[ ! -f "$cand.onnx" ]]; then
  args=()
  for d in "${train_data[@]}"; do
    reps=1; [[ $d == *"*"* ]] && reps=${d##*"*"} && d=${d%"*"*}
    mode=""; [[ $d == *:* ]] && mode=":${d##*:}" && d=${d%:*}
    # <step>/<map> of this cycle, else a dataset under DATA, else a path.
    path="$data/$name-$d"; [[ -e $path ]] || path="$data/$d"; [[ -e $path ]] || path=$d
    [[ -e $path ]] || { echo "no training data $path"; exit 1; }
    for ((i = 0; i < reps; i++)); do args+=(--data "$(absdir "$path")$mode"); done
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
  if gate_on_gpu "$i"; then
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
  echo "### $name: time per phase (minutes from the start)"
  echo
  echo "| phase | minutes |"
  echo "| --- | --- |"
  awk -F'\t' '{ printf "| %s | %.1f |\n", $1, $2 / 60 }' "$times"
} > "$out/cycle.md"
cat "$out/cycle.md"
