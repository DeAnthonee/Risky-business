"""Verify the GPU mirror against the engine in this checkout, and record it in engine-fingerprint.json.

Run it on the training PC whenever `python packages/delove-gpu/delove_gpu/fingerprint.py check` (or the CI warning,
or a StaleMirror error) says the engine changed:

    .venv/Scripts/python packages/delove-gpu/verify.py [--games 500] [--model models/delove/delove@2.pt] [--models models/delove]

1. builds the engine, self-play and Delove packages (skip with --no-build if they are current);
2. plays fresh logged games with the current engine, new seeds every run (teacher vs teacher, risky@1 vs teacher,
   random vs random to the turn limit, and delove@N vs teacher when --model is given), plus a small log exported
   with the TypeScript encoder;
3. replays every log through engine.py and fused.py (tests/replay.py): board, cards, phase and legal moves must be
   identical at every step; checks the GPU encoder against the export, and the GPU network against the logged
   network moves with --model;
   with --models (a folder with delove-teacher@N.json and the ranker's .pt and .onnx), also the GPU teachers
   (tests/teacher_replay.py: the logged pick at every step of the newest Sensei and of Jacob Sensei, jacob-sensei@1),
   branch and score at branch.ts's defaults and at the cycle settings, with Sensei and with Jacob as the rollout
   teacher (tests/branch_replay.py against the CPU's DELOVE_BRANCH_TRACE: options, exact mean scores, picks), the
   training-array writer (tests/export_check.py: bit for bit against export) and the kernel's Math.log1p
   (tests/log1p_check.py);
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
JACOB = "jacob-sensei@1"


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
    ap.add_argument("--models", help="models folder: also verify the GPU teacher (newest delove-teacher@N.json), branch and score"
                    " (ranker --ranker) and the training-array writer")
    ap.add_argument("--ranker", default="delove@2", help="with --models: the branch ranker (its .pt and .onnx in --models)")
    ap.add_argument("--seed", type=int, default=None, help="default: from the clock, so every run plays new games")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--matrix-scale", type=float, default=0.1,
                    help="every map, table size and setting (tests/matrix.py suites rules and settings, and branch with --models) at"
                         " this scale of their game counts; 0 skips them (then only Classic 2-player is verified)")
    args = ap.parse_args()

    import torch

    engines = ["engine.py"] + (["fused.py"] if torch.cuda.is_available() else [])
    if args.models and "fused.py" not in engines:
        sys.exit("--models needs a CUDA device (the GPU teacher and branch run only in the kernel)")
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
    extra_env: dict[str, dict] = {}
    net_agent = None
    teacher_id = None
    if args.models:
        models = Path(args.models).resolve()
        vs = sorted((int(f.stem.split("@")[1]), f.stem) for f in models.glob("delove-teacher@*.json"))
        if not vs:
            sys.exit(f"{models}: no delove-teacher@N.json")
        teacher_id = vs[-1][1]
        for ext in (".pt", ".onnx"):
            if not (models / f"{args.ranker}{ext}").exists():
                sys.exit(f"{models / (args.ranker + ext)} missing (the CPU ranks with the ONNX, the GPU with the .pt)")
        env["DELOVE_MODELS"] = str(models)
        logs["teacher-tuned"] = (f"{teacher_id},{teacher_id}", g)
        logs["teacher-jacob"] = (f"{JACOB},{JACOB}", g)
        nb = max(20, g // 5)
        for name, h, mg, rt in [("branch-default", None, None, teacher_id), ("branch-cycle", "1", "0.01", teacher_id),
                                ("branch-jacob", "1", "0.01", JACOB)]:
            logs[name] = (f"delove-branch@1,{rt}", nb)
            extra_env[name] = {"DELOVE_BRANCH_RANKER": args.ranker, "DELOVE_BRANCH_TRACE": str(out / f"trace-{name}.jsonl"),
                               "DELOVE_BRANCH_TEACHER": rt, **({"DELOVE_BRANCH_HORIZON": h, "DELOVE_BRANCH_MARGIN": mg} if h else {})}
    if args.model:
        model = Path(args.model).resolve()
        net_agent = model.stem  # delove@N, as net-agent.ts registers models/delove/<id>.onnx
        if not model.with_suffix(".onnx").exists():
            sys.exit(f"{model.with_suffix('.onnx')} missing: the Node side plays the ONNX export of the same weights")
        if args.models and model.parent != Path(args.models).resolve():
            sys.exit("--model must be in the --models folder (one DELOVE_MODELS for the Node side)")
        env["DELOVE_MODELS"] = str(model.parent)
        logs["net"] = (f"{net_agent},delove-teacher@1", max(20, g // 5))
    node = shutil.which("node") or "node"
    procs = []
    for i, (name, (agents, n)) in enumerate(logs.items()):
        cmd = [node, "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play",
               "--agents", agents, "--games", str(n), "--seed", str(seed + i), "--log", str(out / name)]
        print("  $", " ".join(cmd), flush=True)
        trace = extra_env.get(name, {}).get("DELOVE_BRANCH_TRACE")
        if trace and Path(trace).exists():
            Path(trace).unlink()
        procs.append((name, subprocess.Popen(cmd, cwd=REPO, env={**env, **extra_env.get(name, {})}, stdout=subprocess.DEVNULL)))
    for name, p in procs:
        if p.wait():
            print(f"playing {name} failed")
            return 1
    print("  export the encoder log with the TypeScript encoder")
    if run([node, "packages/selfplay/dist/cli.js", "export", "--log", str(out / "encoder"), "--out", str(out / "encoder-export")],
           stdout=subprocess.DEVNULL).returncode:
        return 1
    if args.models:
        print("  export the cycle-settings branch log (the branching player's decisions)")
        if run([node, "packages/selfplay/dist/cli.js", "export", "--log", str(out / "branch-cycle"), "--out", str(out / "branch-export"),
                "--only-agents", "delove-branch@1"], stdout=subprocess.DEVNULL).returncode:
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
            m = re.search(r"TOTAL: (\d+)/(\d+) games identical, (\d+) steps[^\n]*?, (\d+) failed", text)
            ok = r.returncode == 0 and m and m.group(1) == m.group(2) and m.group(4) == "0"
            if net_agent and "--net" in opts:
                # every top move the same, except fp32 near-ties between ONNX Runtime and PyTorch (replay.py NEAR_TIE)
                n = re.search(r"network: .* on (\d+)/(\d+) decisions.*?; (\d+) of the (\d+) others are near-ties", text)
                ok = ok and n and n.group(3) == n.group(4)
            if not ok:
                print(f"\nMISMATCH: {engine} does not play the engine's game (see above). Fix packages/delove-gpu, then run"
                      " verify.py again. engine-fingerprint.json is unchanged.")
                return 1
            total_steps += int(m.group(3))
            results.append({"engine": engine, "logs": [rel(d) for d in dirs], "games": int(m.group(2)), "steps": int(m.group(3))})

    if args.models:
        tests = HERE / "tests"
        jobs = [
            ("teacher", [str(tests / "teacher_replay.py"), str(out / "teacher-tuned"), "--agent", teacher_id, "--params", str(models / f"{teacher_id}.json")],
             r"(\d+)/(\d+) games replayed to the end, (\d+) steps, \d+ \S+ decisions checked, 0 mismatches", 3),
            ("teacher", [str(tests / "teacher_replay.py"), str(out / "teacher-jacob"), "--agent", JACOB],
             r"(\d+)/(\d+) games replayed to the end, (\d+) steps, \d+ \S+ decisions checked, 0 mismatches", 3),
            ("teacher", [str(tests / "log1p_check.py")], r"(\d+) of (\d+) values bit-identical", 1),
        ]
        for name, extra, rt in [("branch-default", [], teacher_id), ("branch-cycle", ["--horizon", "1", "--margin", "0.01"], teacher_id),
                                ("branch-jacob", ["--horizon", "1", "--margin", "0.01"], JACOB)]:
            jobs.append(("branch", [str(tests / "branch_replay.py"), str(out / name), "--trace", str(out / f"trace-{name}.jsonl"), "--models",
                                    str(models), "--ranker", args.ranker, "--teacher", rt, *extra],
                         r"(\d+) games, (\d+) branch-player decisions .*means identical on \d+, different on 0;", 2))
        jobs.append(("branch", [str(tests / "export_check.py"), str(out / "branch-cycle"), str(out / "branch-export")],
                     r"(\d+) decisions, .*differs from the log at 0 steps; IDENTICAL", 1))
        for engine, cmd, pattern, group in jobs:
            r = run([py, "-u", *cmd], capture_output=True, text=True)
            text = r.stdout + r.stderr
            print("    " + "\n    ".join(line for line in text.splitlines() if line.strip()))
            m = re.search(pattern, text)
            if r.returncode != 0 or not m:
                print(f"\nMISMATCH: the GPU {engine} does not match the TypeScript (see above). Fix packages/delove-gpu, then run"
                      " verify.py again. engine-fingerprint.json is unchanged.")
                return 1
            results.append({"engine": engine, "check": Path(cmd[0]).name, "logs": [rel(c) for c in cmd[1:2] if Path(c).is_dir()],
                            "decisions": int(m.group(group))})
        engines += ["teacher", "branch"]

    if "fused.py" in engines:
        print("  the teacher's blitz odds against odds.ts (tests/odds_check.py)")
        r = run([py, "-u", str(HERE / "tests" / "odds_check.py")], capture_output=True, text=True)
        print("    " + (r.stdout + r.stderr).strip().replace("\n", "\n    "))
        if r.returncode:
            print("\nMISMATCH: the GPU odds tables differ from odds.ts. engine-fingerprint.json is unchanged.")
            return 1
    if args.matrix_scale > 0 and "fused.py" in engines:
        suites = ["rules", "settings"] + (["branch", "jacob"] if args.models else [])
        for suite in suites:
            print(f"  every map, table size and setting: tests/matrix.py --suite {suite} --scale {args.matrix_scale}")
            cmd = [py, "-u", str(HERE / "tests" / "matrix.py"), "--suite", suite, "--scale", str(args.matrix_scale), "--seed", str(seed),
                   "--out", str(out / f"matrix-{suite}")] + (["--models", str(models)] if args.models else [])
            r = run(cmd, capture_output=True, text=True)
            text = r.stdout + r.stderr
            tail = [line for line in text.splitlines() if line.startswith(("ok ", "BAD")) or "cases identical" in line]
            print("    " + "\n    ".join(tail[-80:]))
            m = re.search(r"(\d+)/(\d+) cases identical", text)
            if r.returncode or not m or m.group(1) != m.group(2):
                print(f"\nMISMATCH in the {suite} matrix (see above). Fix packages/delove-gpu, then run verify.py again."
                      " engine-fingerprint.json is unchanged.")
                return 1
            steps = sum(int(x) for x in re.findall(r"games identical, (\d+) steps", text))
            total_steps += steps
            results.append({"engine": {"branch": "branch", "jacob": "teacher"}.get(suite, "fused.py"), "check": f"matrix {suite}", "cases": int(m.group(2)),
                            "steps": steps, "logs": [rel(out / f"matrix-{suite}")]})

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
