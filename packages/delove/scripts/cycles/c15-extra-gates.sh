#!/usr/bin/env bash
# Cycle 15's fog and horde gates (research plan), run after both base candidates' cycle.sh gates. They stay out of
# cycle.sh's gate list on purpose: scripts/sprt.mjs pools every 4+ player gate against the base, and promotion follows
# the no-fog pooled points only. From the repo root:
#
#   DELOVE_MODELS=<models> OUT=<runs>/c15 bash packages/delove/scripts/cycles/c15-extra-gates.sh
#
# Fog: each candidate (CANDIDATES, default "c15-candidate c151-candidate") against BASE (default delove@11),
# jacob-sensei@1 and jacob-sensei@2 at 4 and 6 players, 200 mirrored games each, with packages/delove/configs/
# gen5-randomfog.json's settings (fog of war, capitals, 8 blizzards, progressive cards). Horde: npm run delove:horde
# with (b) against (a), seed 1. Results: OUT/extra-gates/summary.md. Finished chunks are kept.
set -euo pipefail
export DELOVE_MODELS=${DELOVE_MODELS:?}
out=${OUT:?}/extra-gates
base=${BASE:-delove@11}
cands=(${CANDIDATES:-c15-candidate c151-candidate})
parallel=${PARALLEL:-21}
mkdir -p "$out"
fog=$(node -e 'const o=JSON.parse(require("fs").readFileSync("packages/delove/configs/gen5-randomfog.json","utf8")); delete o.spectatorChat; process.stdout.write(JSON.stringify(o))')
pool="$out/pool.txt"; : > "$pool"
for c in "${cands[@]}"; do
  for opp in "$base" jacob-sensei@1 jacob-sensei@2; do
    for p in 4 6; do
      for k in $(seq 0 9); do echo "$c $opp $p $k $fog" >> "$pool"; done
    done
  done
done
export out
run() {
  read -r c opp p k o <<< "$1"
  local f="$out/$c-$opp-$p-$k.json"
  [[ -f "$f" ]] && return 0
  node --import ./packages/delove/dist/register.js packages/selfplay/dist/cli.js ladder --candidate "$c" --best "$opp" \
    --players "$p" --games 20 --seed $(( 915000 + p * 100 + k )) --options "$o" > "$f.tmp" 2> "${f%.json}.err" \
    && mv "$f.tmp" "$f" || { echo "FAILED $c $opp $p $k"; return 1; }
}
export -f run
tr '\n' '\0' < "$pool" | xargs -0 -P "$parallel" -I{} bash -c 'run "$1"' _ {}

if [[ ${#cands[@]} -ge 2 && ! -f "$out/horde.txt" ]]; then
  npm run -s delove:horde -- --candidate "${cands[1]}" --base "${cands[0]}" --seed 1 > "$out/horde.json" 2> "$out/horde.txt" \
    || echo "FAILED horde gate (see $out/horde.txt)"
fi

node - "$out" "${cands[@]}" > "$out/summary.md" <<'EOF'
const fs = require('fs'), path = require('path');
const [dir, ...cands] = process.argv.slice(2);
const rows = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'horde.json')) {
  const m = f.match(/^(.+?)-((?:delove|jacob-sensei)@\d+)-(\d+)-\d+\.json$/);
  if (!m) continue;
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const key = `${m[1]}|${m[2]}|${m[3]}`;
  (rows[key] ??= []).push(d);
}
console.log('| candidate | opponent | players | games | score | points diff (95%, chunk means) |\n| --- | --- | --- | --- | --- | --- |');
for (const key of Object.keys(rows).sort()) {
  const xs = rows[key], g = xs.reduce((a, x) => a + x.games, 0);
  const score = xs.reduce((a, x) => a + x.score * x.games, 0) / g;
  const d = xs.map((x) => x.pointsDiff), n = d.length, mean = d.reduce((a, b) => a + b, 0) / n;
  const se = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) / n) : NaN;
  const [c, opp, p] = key.split('|');
  const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  console.log(`| ${c} | ${opp} | ${p} | ${g} | ${score.toFixed(3)} | ${f2(mean)} (${f2(mean - 1.96 * se)} to ${f2(mean + 1.96 * se)}) |`);
}
EOF
echo "fog gates: $out/summary.md; horde gate: $out/horde.txt"
