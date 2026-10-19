#!/usr/bin/env bash
# Measure one branch-and-score setting: delove-branch@1 against an opponent (default delove-teacher@2), GAMES games
# in each seat order (same seeds for every variant, so variants differ only by the setting), from the repo root:
#
#   GAMES=1000 bash packages/delove/scripts/branch-variant.sh runs/delove/bvar o3r4 DELOVE_BRANCH_OPTIONS=3 DELOVE_BRANCH_ROLLOUTS=4
#
# OPPONENT may list several agents (OPPONENT=delove-teacher@2,delove@2,risky@1 for a 4-player table; the branch
# player sits first, then last). Prints the branch player's score (with more players: its share of wins) and the time
# per game (one process's game time, with PARALLEL processes busy).
# OPPONENT, OPTIONS (game settings JSON), SEED, PARALLEL (default 26) and CHUNK (default 25) as for generate.sh.
set -euo pipefail
out=$1; name=$2; shift 2
games=${GAMES:-1000}; opp=${OPPONENT:-delove-teacher@2}; options=${OPTIONS:-}
dir="$out/$name"
rm -rf "$dir"; mkdir -p "$dir"
printf '%s\n' "b $games delove-branch@1,$opp $options" "r $games $opp,delove-branch@1 $options" > "$dir/jobs"
t0=$(date +%s)
env "$@" CHUNK=${CHUNK:-25} bash packages/delove/scripts/generate.sh "$dir/jobs" "$dir" "${SEED:-4242}" "${PARALLEL:-26}" > "$dir/generate.out"
echo "$name $* wall $(( $(date +%s) - t0 ))s" > "$dir/wall"
node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
let w = 0, l = 0, d = 0, sec = 0, n = 0;
for (const f of fs.readdirSync(dir).filter((f) => /^[br]-c\d+\.json$/.test(f))) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const b = r.agents.indexOf("delove-branch@1");
  w += r.winsBySeat[b]; l += r.games - r.turnLimit - r.winsBySeat[b]; d += r.turnLimit; sec += r.seconds; n += r.games;
}
const s = (w + d / 2) / n, se = Math.sqrt((s * (1 - s)) / n);
const res = { name: path.basename(dir), games: n, wins: w, losses: l, draws: d, score: +s.toFixed(4), ci95: [+(s - 1.96 * se).toFixed(3), +(s + 1.96 * se).toFixed(3)], secondsPerGame: +(sec / n).toFixed(3), wall: fs.readFileSync(path.join(dir, "wall"), "utf8").trim() };
fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res));
' "$dir"
