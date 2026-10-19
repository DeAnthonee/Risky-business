#!/usr/bin/env bash
# Play a mix of self-play games for a Delove training round, in parallel, from the repo root:
#
#   bash packages/delove/scripts/generate.sh packages/delove/scripts/round-02.jobs runs/delove/r02 202 [14]
#
# Each line of the jobs file is "<name> <games> <agent,agent,...>" (one seat per agent, '#' starts a comment).
# Games are split into chunks of 500 played by up to PARALLEL processes (default 14); chunk logs go to
# OUT/<name>/c<start>, a chunk's errors to OUT/<name>-c<start>.err. Exploring versions (delove@N-explore) sample at
# DELOVE_TEMPERATURE (default here 0.7). A failed chunk is reported as FAILED and the script exits non-zero.
set -euo pipefail
jobs=$1; out=$2; seed=$3; parallel=${4:-14}
mkdir -p "$out"
chunks=$(mktemp)
trap 'rm -f "$chunks"' EXIT
grep -v '^\s*\(#\|$\)' "$jobs" | while read -r name total agents; do
  for ((s = 0; s < total; s += 500)); do echo "$name $s $agents $(( total - s < 500 ? total - s : 500 ))"; done
done > "$chunks"
echo "$(wc -l < "$chunks") chunks of up to 500 games, $parallel at a time -> $out"
export out seed
export DELOVE_TEMPERATURE=${DELOVE_TEMPERATURE:-0.7}
xargs -P "$parallel" -L 1 bash -c '
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js play --agents "$2" --games "$3" \
    --start "$1" --seed "$seed" --log "$out/$0/c$1" > "$out/$0-c$1.json" 2> "$out/$0-c$1.err" \
    && echo "done $0 c$1" || { echo "FAILED $0 c$1 (see $out/$0-c$1.err)"; exit 1; }
' < "$chunks"
