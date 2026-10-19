"""Verify the GPU mirror against the engine in this checkout, and record it in engine-fingerprint.json.

Run it on the training PC whenever `python packages/delove-gpu/delove_gpu/fingerprint.py check` (or the CI warning,
or a StaleMirror error) says the engine changed:

    .venv/Scripts/python packages/delove-gpu/verify.py [--games 500] [--model models/delove/delove@2.pt]

1. builds the engine, self-play and Delove packages (skip with --no-build if they are current);
2. plays fresh logged games with the current engine, new seeds every run (teacher vs teacher, risky@1 vs teacher,
   random vs random to the turn limit, and delove@N vs teacher when --model is given), plus a small log exported
   with the TypeScript encoder;
3. replays every log through engine.py and fused.py (tests/replay.py): board, cards, phase and legal moves must be
   identical at every step; checks the GPU encoder against the export, and the GPU network against the logged
   network moves with --model;
4. only if everything matches, writes engine-fingerprint.json (hashes of the engine files the mirror copies, and
   what was replayed). Commit it with the mirror changes.

A mismatch means the mirror is wrong for this engine: fix packages/delove-gpu (never packages/engine), and run this
again. Logs go to runs/gpu-verify/<date>-<seed>/ (ignored by git).
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from delove_gpu import fingerprint  # noqa: E402

REPO = fingerprint.REPO


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run(cmd, cwd=REPO, **kw)


def npm() -> str:
    exe = shutil.which("npm") or shutil.which("npm.cmd")
    if not exe:
        sys.exit("npm not found")
    return exe


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--games", type=int, default=500, help="games per log (random games: a tenth)")
    ap.add_argument("--model", help="a Delove .pt checkpoint: also log delove@N games and check the GPU network on them")
    ap.add_argument("--seed", type=int, default=None, help="default: from the clock, so every run plays new games")
    ap.add_argument("--no-build", action="store_true")
    args = ap.parse_args()

    import torch

    engines = ["engine.py"] + (["fused.py"] if torch.cuda.is_available() else [])
    if "fused.py" not in engines:
        print("warning: no CUDA device; only engine.py is verified (FusedEngine stays unverified)")
    seed = args.seed if args.seed is not None else int(time.time()) % 100_000
    out = REPO / "runs" / "gpu-verify" / f"{dt.date.today().isoformat()}-{seed}"
    out.mkdir(parents=True, exist_ok=True)
    rel = lambda p: Path(os.path.relpath(p, REPO)).as_posix()  # noqa: E731
    print(f"GPU mirror verification, seed {seed}, logs in {rel(out)}")
    print("changed since the last verification:", ", ".join(fingerprint.changed_files()) or "nothing")

    if not args.no_build:
        print("1. build")
        if run([npm(), "run", "build", "-w", "@risk/engine", "-w", "@risk/mcp", "-w", "@risk/selfplay", "-w", "@risk/delove"]).returncode:
            return 1

    print("2. play logged games with the current engine")
    g = args.games
    logs = {
        "teacher": ("delove-teacher@1,delove-teacher@1", g),
        "risky": ("risky@1,delove-teacher@1", g),
        "random": ("random@1,random@1", max(10, g // 10)),
        "encoder": ("delove-teacher@1,delove-teacher@1", max(20, g // 10)),
    }
    env = dict(os.environ)
    net_agent = None
    if args.model:
        model = Path(args.model).resolve()
        net_agent = model.stem  # delove@N, as net-agent.ts registers models/delove/<id>.onnx
        if not model.with_suffix(".onnx").exists():
            sys.exit(f"{model.with_suffix('.onnx')} missing: the Node side plays the ONNX export of the same weights")
        env["DELOVE_MODELS"] = str(model.parent)
        logs["net"] = (f"{net_agent},delove-teacher@1", max(20, g // 5))
    node = shutil.which("node") or "node"
    procs = []
    for i, (name, (agents, n)) in enumerate(logs.items()):
        cmd = [node, "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play",
               "--agents", agents, "--games", str(n), "--seed", str(seed + i), "--log", str(out / name)]
        print("  $", " ".join(cmd), flush=True)
        procs.append((name, subprocess.Popen(cmd, cwd=REPO, env=env, stdout=subprocess.DEVNULL)))
    for name, p in procs:
        if p.wait():
            print(f"playing {name} failed")
            return 1
    print("  export the encoder log with the TypeScript encoder")
    if run([node, "packages/selfplay/dist/cli.js", "export", "--log", str(out / "encoder"), "--out", str(out / "encoder-export")],
           stdout=subprocess.DEVNULL).returncode:
        return 1

    print("3. replay through the GPU engines")
    py = sys.executable
    replay = str(HERE / "tests" / "replay.py")
    total_steps = 0
    results = []
    for engine in engines:
        fused = ["--fused"] if engine == "fused.py" else []
        jobs = [
            ([str(out / "teacher"), str(out / "risky")], ["--batch", "500"]),
            ([str(out / "random")], ["--batch", "100"]),
            ([str(out / "encoder")], ["--batch", "200", "--export", str(out / "encoder-export")]),
        ]
        if net_agent:
            jobs.append(([str(out / "net")], ["--batch", "200", "--net", net_agent, str(Path(args.model).resolve())]))
        for dirs, opts in jobs:
            r = run([py, "-u", replay, *dirs, *opts, *fused], capture_output=True, text=True)
            text = r.stdout + r.stderr
            print("    " + "\n    ".join(line for line in text.splitlines() if line.strip()))
            m = re.search(r"TOTAL: (\d+)/(\d+) games identical, (\d+) steps, (\d+) failed", text)
            ok = r.returncode == 0 and m and m.group(1) == m.group(2) and m.group(4) == "0"
            if net_agent and "--net" in opts:
                n = re.search(r"network: .* on (\d+)/(\d+) decisions", text)
                ok = ok and n and n.group(1) == n.group(2)
            if not ok:
                print(f"\nMISMATCH: {engine} does not play the engine's game (see above). Fix packages/delove-gpu, then run"
                      " verify.py again. engine-fingerprint.json is unchanged.")
                return 1
            total_steps += int(m.group(3))
            results.append({"engine": engine, "logs": [rel(d) for d in dirs], "games": int(m.group(2)), "steps": int(m.group(3))})

    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", *fingerprint.RULE_FILES], cwd=REPO, capture_output=True, text=True).stdout.strip()
    fingerprint.write({
        "at": dt.datetime.now().isoformat(timespec="seconds"),
        "commit": commit + (" (with uncommitted changes to the rule files)" if dirty else ""),
        "seed": seed,
        "engines": engines,
        "steps": total_steps,
        "replays": results,
    })
    print(f"\n4. verified: {total_steps:,} steps identical on {', '.join(engines)}. Wrote {rel(fingerprint.FINGERPRINT)}; commit it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
