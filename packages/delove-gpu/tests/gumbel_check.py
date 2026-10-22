"""CPU checks of the Gumbel root's Python side (no GPU needed): the halving plan against branch.ts gumbelSchedule, the
seat tokens, the config read from branch.ts, and generate.py's branch_q columns with a Gumbel seat (8 candidates)
next to a plain 5-option seat, through the same functions the step loop and the recorder use.

    python tests/gumbel_check.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.branch import default_branch, gumbel_schedule  # noqa: E402
from delove_gpu.fingerprint import REPO  # noqa: E402
from delove_gpu.generate import branch_q_width, branch_variant, option_q, put_branch_q  # noqa: E402


def main() -> int:
    fails = []

    # 1. the halving plan, against the built TypeScript (packages/delove/dist)
    cases = [(m, b) for m in range(2, 17) for b in (6, 18, 25, 30, 36, 60, 72, 120)]
    js = ("import { gumbelSchedule } from './packages/delove/dist/branch.js';"
          f" console.log(JSON.stringify({json.dumps(cases)}.map(([m, b]) => gumbelSchedule(m, b).map((r) => [r.size, r.copies]))))")
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        fails.append(f"node: {r.stderr[-500:]}")
    else:
        ts = json.loads(r.stdout)
        bad = [(c, t, gumbel_schedule(*c)) for c, t in zip(cases, ts) if [list(x) for x in gumbel_schedule(*c)] != t]
        print(f"schedule: {len(cases) - len(bad)} of {len(cases)} (candidates, budget) plans identical to branch.ts")
        fails += [f"schedule {c}: ts {t} py {p}" for c, t, p in bad[:5]]

    # 2. the config read from branch.ts, and the seat tokens
    d = default_branch()
    if (d.root, d.gumbel_k, d.copies) != ("top", 8, 0):
        fails.append(f"default_branch: root {d.root} gumbel_k {d.gumbel_k} copies {d.copies}")
    for agent, want in [("delove-branch@1:gumbel", {"root": "gumbel"}), ("delove-branch@1:range:gumbel:k12", {"score": "range", "root": "gumbel", "gumbel_k": 12}),
                        ("delove-branch@1:range:o5", {"score": "range", "options": 5}), ("delove-branch@1:top", {"root": "top"})]:
        if branch_variant(agent) != want:
            fails.append(f"branch_variant({agent}) = {branch_variant(agent)}, want {want}")
    print("config and seat tokens: checked")

    # 3. branch_q: a Gumbel seat's 8 candidates and a 5-option seat in one step (the lane that failed before the fix)
    plain, gumbel = replace(d, options=5), replace(d, options=5, root="gumbel", gumbel_k=8)
    width = branch_q_width([plain, gumbel])
    if width != 8:
        fails.append(f"branch_q_width: {width}, want 8")
    B = 6
    bq_opts = torch.full((B, width), -1, dtype=torch.long)
    bq_means = torch.full((B, width), float("nan"), dtype=torch.float64)

    def decision(n: int, k: int, base: int, branched: list[bool]):
        opts = torch.arange(base, base + n * k, dtype=torch.long).view(n, k)
        means = torch.rand(n, k, 8, dtype=torch.float64)
        return SimpleNamespace(options=opts, means=means, branched=torch.tensor(branched))

    dg = decision(3, 8, 100, [True, False, True])  # Gumbel seat, games 0, 2, 4
    dp = decision(3, 5, 200, [True, True, False])  # plain seat, games 1, 3, 5
    put_branch_q(bq_opts, bq_means, torch.tensor([0, 2, 4]), dg)
    put_branch_q(bq_opts, bq_means, torch.tensor([1, 3, 5]), dp)
    ok = (bq_opts[0].tolist() == dg.options[0].tolist() and bq_opts[2].tolist() == [-1] * 8
          and bq_opts[1, :5].tolist() == dp.options[0].tolist() and bq_opts[1, 5:].tolist() == [-1] * 3
          and torch.equal(bq_means[4], dg.means[2, :, 0]) and bool(torch.isnan(bq_means[5]).all()))
    if not ok:
        fails.append("put_branch_q: wrong rows")
    # the recorder's per-candidate scores read every searched candidate, the 8th included
    ordered = torch.full((B, 10), -1, dtype=torch.long)
    ordered[0, :8] = dg.options[0].flip(0)
    q = option_q(ordered, (bq_opts, bq_means), torch.tensor([0]))
    if not torch.equal(q[0, :8], dg.means[0, :, 0].flip(0)) or not bool(torch.isnan(q[0, 8:]).all()):
        fails.append("option_q: the Gumbel seat's candidates do not map to their means")
    print(f"branch_q: width {width}, Gumbel and plain seats' rows and the recorder's per-candidate means checked")

    for f in fails:
        print("FAIL", f)
    print("ok" if not fails else f"{len(fails)} failures")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
