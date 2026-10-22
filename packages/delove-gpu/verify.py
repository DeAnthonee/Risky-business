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
   (tests/teacher_replay.py: the logged pick at every step of the newest Sensei and of Jacob Sensei, jacob-sensei@1;
   the matrix jacob2 suite for jacob-sensei@2 on every map, table size and setting, and as the rollout teacher),
   branch and score at branch.ts's defaults and at the cycle settings, with Sensei and with Jacob as the rollout
   teacher, with the points, kills and range scores at four seats, and with the ranker playing the rollouts
   (DELOVE_BRANCH_ROLLOUT: every seat at two seats, the decider's seat at four) (tests/branch_replay.py against the
   CPU's DELOVE_BRANCH_TRACE: options, exact mean scores, picks; rollout copies decided by a network near-tie
   reported apart), the training-array writer (tests/export_check.py: bit for
   bit against export) and the kernel's Math.log1p (tests/log1p_check.py);
   with a CUDA device, generate.py's fast path too: k_teacher_run (8 lanes per game), where teacher seats whose decisions
   are not recorded play their moves, which no replay reaches; three small tables (Classic 2p, Skirmish 4p, Greater
   Europe 10p, Jacob Sensei 1 and 2 and the tuned Sensei in the fast seats) generated on the GPU must give the same training arrays,
   game for game, as CPU play + export with the same seeds (tests/dataset_compare.py);
4. only if everything matches, writes engine-fingerprint.json (hashes of the engine files the mirror copies, and
   what was replayed). Commit it with the mirror changes.

A mismatch means the mirror is wrong for this engine: fix packages/delove-gpu (never packages/engine), and run this
again. Logs go to runs/gpu-verify/<date>-<seed>/ (ignored by git). On a shared machine, --parallel caps the CPU
processes playing logs and --gpu-parallel the matrix replays on the GPU.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
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
JACOB2 = "jacob-sensei@2"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run(cmd, cwd=REPO, **kw)


def npm() -> str:
    exe = shutil.which("npm") or shutil.which("npm.cmd")
    if not exe:
        sys.exit("npm not found")
    return exe


def teacher_run_check(out: Path, seed: int, g: int, models: str | None, teacher_id: str | None, node: str, rel) -> dict | None:
    """generate.py's fast path: teacher seats whose decisions are not recorded play inside k_teacher_run (8 lanes per
    game, teacher_pick_g8), which no replay above reaches. A few tables played on the GPU by generate.py and on the CPU
    by play + export (same tables and seeds) must give the same training arrays, game for game (tests/dataset_compare.py).
    delove-teacher@1 is the recorded seat (one move per step, as replayed above); Jacob and the tuned Sensei (with
    --models) are the fast seats, several in a row at the bigger tables. None on a mismatch."""
    T1 = "delove-teacher@1"
    tt = teacher_id or JACOB
    # jacob-sensei@2 first: alone at 2 seats (its duel numbers), then with @1 and the tuned Sensei (its main numbers)
    seats = lambda n: ",".join([T1] + [(JACOB2, JACOB, tt)[i % 3] for i in range(n - 1)])  # noqa: E731
    tables = [  # name, games, agents, options (one map each: generate.py and export write one folder per map)
        ("run-classic-2p", max(20, g // 2), seats(2), {"map": "classic"}),
        ("run-skirmish-4p", max(10, g // 5), seats(4), {"map": "skirmish", "capitals": True, "cardValues": "exponential"}),
        ("run-greater_europe-10p", max(4, g // 25), seats(10), {"map": "greater_europe", "blizzards": 6, "balancedBlitz": True}),
    ]
    print(f"  generate.py's k_teacher_run against CPU play + export ({', '.join(f'{n} x{k}' for n, k, _, _ in tables)})")
    tseed = seed + 50
    env = {**os.environ, **({"DELOVE_MODELS": str(Path(models).resolve())} if models else {})}
    procs = []
    for name, n, agents, o in tables:
        cmd = [node, "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play", "--agents", agents,
               "--games", str(n), "--seed", str(tseed), "--options", json.dumps(o), "--log", str(out / name)]
        print("  $", " ".join(cmd), flush=True)
        procs.append((name, subprocess.Popen(cmd, cwd=REPO, env=env, stdout=subprocess.DEVNULL)))
    jobs = out / "run-jobs.txt"
    jobs.write_text("".join(f"{name} {n} {agents} {json.dumps(o)}\n" for name, n, agents, o in tables), encoding="utf8")
    # no branch seat, so no ranker network: a teacher id as --ranker keeps generate.py from loading one; the fingerprint
    # is what this run is about to write, so --allow-unverified
    gen = [sys.executable, "-u", "-m", "delove_gpu.generate", "--jobs", str(jobs), "--seed", str(tseed), "--ranker", JACOB,
           "--export-agents", T1, "--out", str(out / "run-gpu"), "--allow-unverified", *(["--models", str(Path(models).resolve())] if models else [])]
    print("  $", " ".join(gen), flush=True)
    r = subprocess.run(gen, cwd=HERE, capture_output=True, text=True)
    if r.returncode:
        print("    " + (r.stdout + r.stderr).strip()[-3000:].replace("\n", "\n    "))
        print("\ngenerate.py failed (see above). engine-fingerprint.json is unchanged.")
        return None
    for name, p in procs:
        if p.wait():
            print(f"playing {name} failed")
            return None
    if run([node, "packages/selfplay/dist/cli.js", "export", "--log", ",".join(str(out / t[0]) for t in tables), "--out", str(out / "run-cpu"),
            "--only-agents", T1], stdout=subprocess.DEVNULL).returncode:
        return None
    games = 0
    for name, n, _, o in tables:
        a, b = out / "run-gpu" / o["map"], out / "run-cpu" / o["map"]
        r = run([sys.executable, "-u", str(HERE / "tests" / "dataset_compare.py"), str(a), str(b)], capture_output=True, text=True)
        text = (r.stdout + r.stderr).strip()
        print("    " + text.replace("\n", "\n    "))
        m = re.search(r"(\d+) games, .*: (\d+) games, identical games (\d+)", text)
        if r.returncode or not m or not (int(m.group(1)) == int(m.group(2)) == int(m.group(3)) == n):
            print(f"\nMISMATCH: generate.py's {name} games (k_teacher_run) differ from the CPU's. Fix packages/delove-gpu, then run"
                  " verify.py again. engine-fingerprint.json is unchanged.")
            return None
        games += n
    print(f"    k_teacher_run: {games} of {games} generate.py games identical to CPU play + export")
    return {"engine": "teacher", "check": "dataset_compare.py (generate.py, k_teacher_run)", "games": games,
            "logs": [rel(out / t[0]) for t in tables]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--games", type=int, default=500, help="games per log (random games: a tenth)")
    ap.add_argument("--model", help="a Delove .pt checkpoint: also log delove@N games and check the GPU network on them")
    ap.add_argument("--models", help="models folder: also verify the GPU teacher (newest delove-teacher@N.json), branch and score"
                    " (ranker --ranker) and the training-array writer")
    ap.add_argument("--ranker", default="delove@2", help="with --models: the branch ranker (its .pt and .onnx in --models)")
    ap.add_argument("--seed", type=int, default=None, help="default: from the clock, so every run plays new games")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--parallel", type=int, default=0,
                    help="CPU processes for the logged games: the logs here and the matrix suites' (0: one per log here, every thread but one in the matrix)")
    ap.add_argument("--gpu-parallel", type=int, default=6, help="matrix replay processes sharing the GPU at once")
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
                                ("branch-jacob", "1", "0.01", JACOB), ("branch-points", "1", "0.01", teacher_id),
                                ("branch-kills", "1", "0.01", teacher_id), ("branch-range", "1", "0.01", JACOB),
                                ("branch-gumbel", "1", "0.01", JACOB)]:
            # branch-points / branch-kills / branch-range: DELOVE_BRANCH_SCORE at four seats, where places and kills count
            # (range: long at 4 alive, then mid and close as players fall)
            score = name.split("-")[1] if name in ("branch-points", "branch-kills", "branch-range") else None
            gumbel = name == "branch-gumbel"  # the Gumbel root (DELOVE_BRANCH_ROOT=gumbel, 8 candidates within 5 x 6 copies)
            logs[name] = (",".join(["delove-branch@1"] + [rt] * (3 if score or gumbel else 1)), nb)
            extra_env[name] = {"DELOVE_BRANCH_RANKER": args.ranker, "DELOVE_BRANCH_TRACE": str(out / f"trace-{name}.jsonl"),
                               "DELOVE_BRANCH_TEACHER": rt, **({"DELOVE_BRANCH_HORIZON": h, "DELOVE_BRANCH_MARGIN": mg} if h else {}),
                               **({"DELOVE_BRANCH_SCORE": score} if score else {}),
                               **({"DELOVE_BRANCH_ROOT": "gumbel", "DELOVE_BRANCH_K": "8", "DELOVE_BRANCH_OPTIONS": "5"} if gumbel else {})}
        # network rollouts (DELOVE_BRANCH_ROLLOUT, the ranker playing them): every seat at two seats, the decider's at
        # four (Jacob in the others); slower on the CPU (one ONNX call per rollout move), so fewer games
        for name, seats, n_seats in [("branch-netroll", "", 1), ("branch-netself", ":self", 3)]:
            logs[name] = (",".join(["delove-branch@1"] + [JACOB] * n_seats), max(6, nb // 4))
            extra_env[name] = {"DELOVE_BRANCH_RANKER": args.ranker, "DELOVE_BRANCH_TRACE": str(out / f"trace-{name}.jsonl"),
                               "DELOVE_BRANCH_TEACHER": JACOB, "DELOVE_BRANCH_HORIZON": "1", "DELOVE_BRANCH_MARGIN": "0.01",
                               "DELOVE_BRANCH_ROLLOUT": args.ranker + seats}
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
    running: list = []
    for i, (name, (agents, n)) in enumerate(logs.items()):
        while args.parallel and len([p for _, p in running if p.poll() is None]) >= args.parallel:
            time.sleep(1)
        cmd = [node, "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play",
               "--agents", agents, "--games", str(n), "--seed", str(seed + i), "--log", str(out / name)]
        print("  $", " ".join(cmd), flush=True)
        trace = extra_env.get(name, {}).get("DELOVE_BRANCH_TRACE")
        if trace and Path(trace).exists():
            Path(trace).unlink()
        procs.append((name, subprocess.Popen(cmd, cwd=REPO, env={**env, **extra_env.get(name, {})}, stdout=subprocess.DEVNULL)))
        running.append(procs[-1])
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
    near_tie_flips = None
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
                                ("branch-jacob", ["--horizon", "1", "--margin", "0.01"], JACOB),
                                ("branch-points", ["--horizon", "1", "--margin", "0.01", "--score", "points"], teacher_id),
                                ("branch-kills", ["--horizon", "1", "--margin", "0.01", "--score", "kills"], teacher_id),
                                ("branch-range", ["--horizon", "1", "--margin", "0.01", "--score", "range"], JACOB),
                                ("branch-netroll", ["--horizon", "1", "--margin", "0.01", "--rollout", args.ranker], JACOB),
                                ("branch-netself", ["--horizon", "1", "--margin", "0.01", "--rollout", args.ranker + ":self"], JACOB),
                                ("branch-gumbel", ["--horizon", "1", "--margin", "0.01", "--root", "gumbel", "--gumbel-k", "8", "--options", "5"], JACOB)]:
            jobs.append(("branch", [str(tests / "branch_replay.py"), str(out / name), "--trace", str(out / f"trace-{name}.jsonl"), "--models",
                                    str(models), "--ranker", args.ranker, "--teacher", rt, *extra],
                         r"(\d+) games, (\d+) branch-player decisions .*means identical on \d+, different on 0;", 2))
        jobs.append(("branch", [str(tests / "export_check.py"), str(out / "branch-cycle"), str(out / "branch-export")],
                     r"(\d+) decisions, .*differs from the log at 0 steps; IDENTICAL", 1))
        # stage games (a lead-in to N players alive, positions from game records): the GPU generator's games and
        # arrays against the CPU's play + export of the same tables
        # the stage check's near-tie rule and its caps, on made-up datasets (CPU)
        jobs.append(("branch", [str(tests / "stage_near_tie_check.py")], r"stage near-tie rule: (\d+) of \1 cases as expected", 1))
        jobs.append(("branch", [str(tests / "stage_check.py"), "--models", str(models), "--ranker", args.ranker, "--seed", str(seed),
                                "--out", str(out / "stage")], r"(\d+) stage games identical", 1))
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
            if f := re.search(r"ranker near-tie flips (\d+)", text):  # stage_check: games tolerated as near-ties (capped there)
                results[-1]["nearTieFlips"] = near_tie_flips = int(f.group(1))
        engines += ["teacher", "branch"]

    if "fused.py" in engines:
        print("  the teacher's blitz odds against odds.ts (tests/odds_check.py)")
        r = run([py, "-u", str(HERE / "tests" / "odds_check.py")], capture_output=True, text=True)
        print("    " + (r.stdout + r.stderr).strip().replace("\n", "\n    "))
        if r.returncode:
            print("\nMISMATCH: the GPU odds tables differ from odds.ts. engine-fingerprint.json is unchanged.")
            return 1
    if args.matrix_scale > 0 and "fused.py" in engines:
        suites = ["rules", "settings"] + (["branch", "jacob", "jacob2"] if args.models else [])
        for suite in suites:
            print(f"  every map, table size and setting: tests/matrix.py --suite {suite} --scale {args.matrix_scale}")
            cmd = [py, "-u", str(HERE / "tests" / "matrix.py"), "--suite", suite, "--scale", str(args.matrix_scale), "--seed", str(seed),
                   "--out", str(out / f"matrix-{suite}")] + (["--parallel", str(args.parallel)] if args.parallel else [])
            cmd += (["--models", str(models)] if args.models else []) + ["--replay-parallel", str(args.gpu_parallel)]
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
            results.append({"engine": {"branch": "branch", "jacob": "teacher", "jacob2": "teacher"}.get(suite, "fused.py"), "check": f"matrix {suite}", "cases": int(m.group(2)),
                            "steps": steps, "logs": [rel(out / f"matrix-{suite}")]})

    if "fused.py" in engines:
        r = teacher_run_check(out, seed, g, args.models, teacher_id, node, rel)
        if r is None:
            return 1
        results.append(r)
        if "teacher" not in engines:
            engines.append("teacher")

    # a cloud pod's tree is a git archive (no .git): its worker passes the commit in DELOVE_COMMIT
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip() or os.environ.get("DELOVE_COMMIT", "")
    dirty = subprocess.run(["git", "status", "--porcelain", "--", *fingerprint.RULE_FILES], cwd=REPO, capture_output=True, text=True).stdout.strip()
    fingerprint.write({
        "at": dt.datetime.now().isoformat(timespec="seconds"),
        "commit": commit + (" (with uncommitted changes to the rule files)" if dirty else ""),
        "seed": seed,
        "engines": engines,
        "steps": total_steps,
        "replays": results,
    })
    flips = f" Stage check: {near_tie_flips} game(s) tolerated as ranker near-tie flips (see its notes)." if near_tie_flips is not None else ""
    print(f"\n4. verified: {total_steps:,} steps identical on {', '.join(engines)}.{flips} Wrote {rel(fingerprint.FINGERPRINT)}; commit it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
