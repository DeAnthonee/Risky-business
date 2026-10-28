"""T2 opponent styles (packages/delove/src/styles.ts) against the GPU branch (delove_gpu/branch.py), on the CPU, no GPU:

1. the style draws: copyStyles (Node) and copy_styles (here) give every seat of 3,000 copies the same style, at 2 to 10
   seats, every decider seat, three mixes;
2. the style teachers: styleParams of jacob-sensei@1, jacob-sensei@2 (both halves) and delove-teacher@1 (Node) equal the
   rows GpuBranch builds from the rollout teacher's row, number for number.

    python tests/styles_check.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from delove_gpu.branch import copy_styles, parse_styles, style_salt, style_scales  # noqa: E402
from delove_gpu.fingerprint import REPO  # noqa: E402
from delove_gpu.teacher import ALL_KEYS, NP0, agent_params, param_row  # noqa: E402

MIXES = ["net:0.4,aggr:0.2,turtle:0.2,zerg:0.2", "net:0.7,aggr:0.1,turtle:0.1,zerg:0.1", "aggr:1,turtle:3"]
NODE = r"""
import { copyStyles, parseStyles, styleParams } from './packages/delove/dist/styles.js';
import { JACOB_SENSEI_1_PARAMS, JACOB_SENSEI_2_PARAMS, JACOB_SENSEI_2_DUEL_PARAMS } from './packages/delove/dist/jacob.js';
import { DEFAULT_TEACHER_PARAMS } from './packages/delove/dist/teacher.js';
import { readFileSync } from 'node:fs';
const [mixes, cases] = JSON.parse(readFileSync(0, 'utf8'));
const draws = mixes.map((m) => cases.map(([seed, n, me]) => copyStyles(seed, n, me, parseStyles(m))));
const teachers = { 'jacob-sensei@1': [JACOB_SENSEI_1_PARAMS], 'jacob-sensei@2': [JACOB_SENSEI_2_PARAMS, JACOB_SENSEI_2_DUEL_PARAMS],
  'delove-teacher@1': [DEFAULT_TEACHER_PARAMS] };
const params = {};
for (const [id, halves] of Object.entries(teachers))
  for (const s of ['aggr', 'turtle', 'zerg']) params[id + '/' + s] = halves.map((h) => styleParams(h, s));
console.log(JSON.stringify({ draws, params }));
"""


def main() -> int:
    g = torch.Generator().manual_seed(7)
    cases = []
    for _ in range(3000):
        n = int(torch.randint(2, 11, (1,), generator=g))
        cases.append([int(torch.randint(0, 2**32, (1,), generator=g, dtype=torch.int64)), n, int(torch.randint(0, n, (1,), generator=g))])
    r = subprocess.run(["node", "--input-type=module", "-e", NODE], input=json.dumps([MIXES, cases]), cwd=REPO, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-2000:])
        return 1
    got = json.loads(r.stdout)
    ok = True
    salt = style_salt()
    for mi, mix in enumerate(MIXES):
        styles = parse_styles(mix)
        names = [n for n, _ in styles]
        bad = 0
        for ci, (seed, n, me) in enumerate(cases):
            idx = copy_styles(torch.tensor([seed]), torch.tensor([me]), n, styles, salt)[0].tolist()
            mine = ["net" if i < 0 else names[i] for i in idx]
            bad += mine != got["draws"][mi][ci]
        print(f"{'ok ' if not bad else 'BAD'} draws {mix}: {len(cases) - bad} of {len(cases)} copies the same style in every seat")
        ok = ok and not bad
    scales = style_scales()
    for key, halves in got["params"].items():
        teacher, style = key.split("/")
        row = param_row(agent_params(teacher))
        want = list(row)
        for k, m in scales[style].items():
            i = ALL_KEYS.index(k)
            want[i] = row[i] * m
            want[NP0 + i] = row[NP0 + i] * m
        same = all(want[ALL_KEYS.index(k)] == float(v) for k, v in halves[0].items() if k in ALL_KEYS)
        if len(halves) > 1:
            same = same and all(want[NP0 + ALL_KEYS.index(k)] == float(v) for k, v in halves[1].items() if k in ALL_KEYS)
        print(f"{'ok ' if same else 'BAD'} style teacher {key}: the GPU row equals styleParams number for number")
        ok = ok and same
    print(f"styles: CPU and GPU agree on {len(MIXES) * len(cases)} copies' draws and {len(got['params'])} style teachers" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
