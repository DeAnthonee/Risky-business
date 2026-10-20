"""Check the kernel's Math.log1p (teacher.py log1p_fd, fdlibm as in V8) against Node's, bit for bit.

Jacob Sensei's stack ramp divides own losses by 1 + stackRamp * Math.log1p(surplus); CUDA's log1p (and the platform
libm) differ from V8's in the last bit on a good share of inputs, so the kernel carries its own port.

    python tests/log1p_check.py [--n 200000]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.config import GameConfig  # noqa: E402
from delove_gpu.teacher import TeacherEngine  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200_000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    xs = [rnd.random() * 10 ** rnd.uniform(-12, 7) for _ in range(args.n)]
    # the surpluses Jacob sees: max(0, (stack - threat) / income - stackFree)
    xs += [max(0.0, a / b - 3) for a in range(0, 5000, 7) for b in range(3, 80)]
    xs += [0.0, 5e-324, 1e-300, 2.0**-55, 2.0**-30, 0.4142, 0.41, 1e300, -0.2, -0.3, -0.5]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "xs.json"
        f.write_text(json.dumps(xs), encoding="utf8")
        js = "const xs = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write(JSON.stringify(xs.map(Math.log1p)))"
        r = subprocess.run(["node", "-e", js, str(f)], capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        sys.exit(r.stderr)
    want = torch.tensor(json.loads(r.stdout), dtype=torch.float64)
    e = TeacherEngine(256, GameConfig.make(2), allow_unverified=True)
    got = e.log1p(torch.tensor(xs, dtype=torch.float64)).cpu()
    bad = (got.view(torch.int64) != want.view(torch.int64)).nonzero().flatten().tolist()
    print(f"log1p: {len(xs) - len(bad)} of {len(xs)} values bit-identical to Node's Math.log1p")
    for i in bad[:10]:
        print(f"   x={xs[i]!r}: node {float(want[i])!r}, kernel {float(got[i])!r}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
