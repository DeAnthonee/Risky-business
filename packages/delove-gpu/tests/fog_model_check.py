"""A network trained with fog inputs (train.py --fog-dropout, "fogInputs" in its .json) loads and plays on the GPU.

The GPU mirror plays full boards only, and a fog model on a full board reads the full-board features with its fog
columns at 0 (fog.ts fogInputs(f, map, fogged=false); net-agent.ts feeds it that on the CPU). load_delove wraps such a
network in play.FogInputs, which appends the zero columns. Checks:
1. load: the model loads, wrapped, with one more territory and global column than the mirror's encoder makes;
2. inputs: the wrapper's inputs equal packages/delove/python/fog.py fog_inputs(..., fogged=False) bit for bit (fog.py is
   checked against fog.ts by test_fog.py);
3. play: games logged on the CPU with the model's ONNX seat (Node) are replayed on the GPU (tests/replay.py --net) and
   every top move must be the same, except fp32 near-ties between ONNX Runtime and PyTorch (as in verify.py --model).

    python tests/fog_model_check.py --model <models>/delove@12.pt --out runs/gpu-verify/fog-model [--games 20]
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from delove_gpu.encode import F_GLOBAL, F_TERRITORY  # noqa: E402
from delove_gpu.fingerprint import REPO  # noqa: E402
from delove_gpu.play import DELOVE_PYTHON, FogInputs, load_delove  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", required=True, help="a fog model's .pt; its .onnx and .json beside it")
    ap.add_argument("--out", required=True)
    ap.add_argument("--games", type=int, default=20)
    ap.add_argument("--seed", type=int, default=12)
    args = ap.parse_args()
    model = Path(args.model).resolve()
    ok = True

    # 1. load
    net = load_delove(model, "cuda")
    c = net.config
    good = isinstance(net, FogInputs) and (c["f_territory"], c["f_global"]) == (F_TERRITORY + 1, F_GLOBAL + 1)
    print(f"{'ok ' if good else 'BAD'} load: {model.name} wrapped for fog inputs, network {c['f_territory']}/{c['f_global']}"
          f" features, encoder {F_TERRITORY}/{F_GLOBAL}")
    ok = ok and good

    # 2. inputs: what the wrapper feeds the network, against fog.py on full boards
    sys.path.insert(0, str(DELOVE_PYTHON))
    from fog import fog_inputs
    rng = np.random.default_rng(args.seed)
    terr = rng.random((7, 42, F_TERRITORY), dtype=np.float32)
    glob = rng.random((7, F_GLOBAL), dtype=np.float32)
    seen = {}
    inner = net.net.forward
    net.net.forward = lambda t, g, *a, **k: seen.update(t=t, g=g) or inner(t, g, *a, **k)
    with torch.inference_mode():
        T = torch.from_numpy(terr).cuda()
        net(T, torch.from_numpy(glob).cuda(), torch.ones(42, 42, device="cuda"), torch.zeros(3, 13, device="cuda"),
            torch.zeros(3, dtype=torch.long, device="cuda"), torch.zeros(3, dtype=torch.long, device="cuda"),
            torch.zeros(3, dtype=torch.long, device="cuda"))
    net.net.forward = inner
    want_t, want_g = fog_inputs(terr, glob, np.zeros(7, dtype=bool), None)
    good = (seen["t"].cpu().numpy().tobytes() == want_t.tobytes() and seen["g"].cpu().numpy().tobytes() == want_g.tobytes())
    print(f"{'ok ' if good else 'BAD'} inputs: the wrapper's {tuple(seen['t'].shape)} / {tuple(seen['g'].shape)} equal fog.py"
          " fog_inputs(fogged=False) bit for bit")
    ok = ok and good

    # 3. play: the CPU's ONNX seat against the GPU network
    out = Path(args.out).resolve()
    shutil.rmtree(out, ignore_errors=True)
    agent = model.stem
    env = {**os.environ, "DELOVE_MODELS": str(model.parent)}
    r = subprocess.run(["node", "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play", "--agents",
                        f"{agent},delove-teacher@1", "--games", str(args.games), "--seed", str(args.seed), "--log", str(out / "net")],
                       cwd=REPO, env=env, capture_output=True, text=True)
    if r.returncode:
        print(f"BAD play: {r.stderr[-2000:]}")
        return 1
    r = subprocess.run([sys.executable, "-u", str(HERE / "replay.py"), str(out / "net"), "--batch", "200", "--net", agent, str(model)],
                       capture_output=True, text=True)
    text = r.stdout + r.stderr
    print("    " + "\n    ".join(line for line in text.splitlines() if line.strip()))
    m = re.search(r"TOTAL: (\d+)/(\d+) games identical, (\d+) steps[^\n]*?, (\d+) failed", text)
    n = re.search(r"network: .* on (\d+)/(\d+) decisions.*?; (\d+) of the (\d+) others are near-ties", text)
    good = bool(r.returncode == 0 and m and m.group(1) == m.group(2) and m.group(4) == "0" and n and n.group(3) == n.group(4))
    print(f"{'ok ' if good else 'BAD'} play: {agent} on the GPU against its ONNX seat on the CPU")
    ok = ok and good
    print("fog model: loads and plays the same on the GPU" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
