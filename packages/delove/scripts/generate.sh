#!/usr/bin/env bash
# Play a mix of self-play games for a Delove training round, in parallel, from the repo root:
#
#   bash packages/delove/scripts/generate.sh packages/delove/scripts/round-02.jobs runs/delove/r02 202 [14]
#
# Each line of the jobs file is "<name> <games> <agent,agent,...> [options JSON]" (one seat per agent, '#' starts a
# comment; the options are any game settings, e.g. {"map":"skirmish"}). Games are split into chunks of up to 500
# (CHUNK) played by up to PARALLEL processes (default 14); chunk logs go to OUT/<name>/c<start>, results to
# OUT/<name>-c<start>.json and a chunk's errors to OUT/<name>-c<start>.err. Exploring versions (delove@N-explore)
# sample at DELOVE_TEMPERATURE (default here 0.7); branch-and-score stats go to OUT (DELOVE_BRANCH_STATS). A failed
# chunk is reported as FAILED and the script exits non-zero.
set -euo pipefail
jobs=$1; out=$2; seed=$3; parallel=${4:-14}; chunk=${CHUNK:-500}
mkdir -p "$out"
chunks=$(mktemp)
trap 'rm -f "$chunks"' EXIT
grep -v '^\s*\(#\|$\)' "$jobs" | while read -r name total agents options; do
  for ((s = 0; s < total; s += chunk)); do
    echo "$name $s $agents $(( total - s < chunk ? total - s : chunk )) ${options:-"{}"}"
  done
done > "$chunks"
echo "$(wc -l < "$chunks") chunks of up to $chunk games, $parallel at a time -> $out"
export out seed
export DELOVE_TEMPERATURE=${DELOVE_TEMPERATURE:-0.7}
export DELOVE_BRANCH_STATS=${DELOVE_BRANCH_STATS:-$out}
run_chunk() {
  read -r name start agents games options <<< "$1"
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js play --agents "$agents" \
    --games "$games" --start "$start" --seed "$seed" --options "$options" --log "$out/$name/c$start" \
    > "$out/$name-c$start.json" 2> "$out/$name-c$start.err" \
    && echo "done $name c$start" || { echo "FAILED $name c$start (see $out/$name-c$start.err)"; exit 1; }
}
export -f run_chunk
# Job lines go through xargs NUL-separated and untouched (xargs would strip the options JSON's quotes).
tr '\n' '\0' < "$chunks" | xargs -0 -P "$parallel" -I{} bash -c 'run_chunk "$1"' _ {}
