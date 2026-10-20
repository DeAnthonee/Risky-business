"""The GPU teacher's blitz odds against packages/engine/src/odds.ts blitzOdds, bit for bit: win, balancedWin and the
expected losses for random battles of every size (exact tables, fit()'s scaled-down huge stacks) and both defence-dice
limits (2, and 3 for capitals).

    python tests/odds_check.py [--n 20000]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.fingerprint import REPO  # noqa: E402
from delove_gpu.teacher import TeacherEngine  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    n = args.n
    # log-uniform sizes from 1 to ~1e6 attackers and ~1e5 defenders, plus small battles
    a = np.concatenate([np.exp(rng.uniform(np.log(2), np.log(1e6), n // 2)), rng.integers(2, 60, n // 2)]).astype(np.int64)
    d = np.concatenate([np.exp(rng.uniform(0, np.log(1e5), n // 2)), rng.integers(1, 60, n // 2)]).astype(np.int64)
    dl = rng.choice([2, 3], n).astype(np.int64)
    js = ("import { blitzOdds } from './packages/engine/dist/index.js'; import { readFileSync } from 'node:fs';"
          "const q = JSON.parse(readFileSync(0, 'utf8')); const out = q.a.map((x, i) => { const o = blitzOdds(x, q.d[i], q.l[i]);"
          " return [o.win, o.balancedWin, o.expectedAttackerLosses, o.expectedDefenderLosses]; });"
          "console.log(JSON.stringify(out));")
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, input=json.dumps({"a": a.tolist(), "d": d.tolist(), "l": dl.tolist()}),
                       capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        sys.exit(r.stderr)
    ref = np.array(json.loads(r.stdout), dtype=np.float64)
    e = TeacherEngine(1, allow_unverified=True)
    gpu = e.odds(torch.tensor(a), torch.tensor(d), torch.tensor(dl)).cpu().numpy()
    bad = np.flatnonzero((gpu != ref).any(1))
    print(f"{n - len(bad)}/{n} battles bit-identical (win, balancedWin, losses); odds outside the tables: {int(e.tstats[0])}")
    for i in bad[:10]:
        print(f"   a={a[i]} d={d[i]} limit={dl[i]}: gpu {gpu[i].tolist()} vs ts {ref[i].tolist()}")
    sys.exit(1 if len(bad) or int(e.tstats[0]) else 0)


if __name__ == "__main__":
    main()
