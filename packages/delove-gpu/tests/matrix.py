"""The replay proof over every map, table size and covered setting: plays logged CPU games for each case of a suite
(the TypeScript engine and agents, in parallel over the CPU's threads), then replays every log through the GPU
(tests/replay.py --fused: board, cards, phase and legal moves at every step; the teacher's logged pick at every step
of delove-teacher@1, delove-teacher@2 and jacob-sensei@1 seats; tests/branch_replay.py for branch games) and prints one
table.

    python tests/matrix.py --suite rules --out runs/gpu-verify/matrix [--seed 7] [--scale 1] [--models models/delove]
    python tests/matrix.py --suite rules --out ... --only greater_europe   # cases whose name contains this

A case is `name map seats agents games [options JSON]`. Logs go to OUT/<name>/ with the case's options in
options.json (replay.py reads them). Re-running skips logs that are complete and replays again.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from delove_gpu.fingerprint import REPO  # noqa: E402

PYTHON = sys.executable
R, T1, T2, RK, J = "random@1", "delove-teacher@1", "delove-teacher@2", "risky@1", "jacob-sensei@1"


def seats(n: int, *agents: str) -> str:
    """n seats filled with the agents in rotation."""
    return ",".join(agents[i % len(agents)] for i in range(n))


# Every map at 2 seats, a middle size and its largest table; random players reach the turn limit and every corner of
# the rules, teachers play real games (eliminations, card captures, conquests of whole continents).
def rules_suite(scale: float) -> list[tuple]:
    g = lambda n: max(4, int(n * scale))  # noqa: E731
    maps = {"classic": 6, "world": 10, "world_large": 10, "europe": 8, "greater_europe": 10, "europe_classic": 6, "usa": 10,
            "asia": 8, "fantasy": 10, "skirmish": 4}
    cases = []
    for m, mx in maps.items():
        sizes = sorted({2, (2 + mx + 1) // 2, mx})
        for n in sizes:
            cases.append((f"{m}-{n}p-teacher", m, n, seats(n, T2, T1, RK), g(300 if n <= 4 else 150), {}))
            cases.append((f"{m}-{n}p-random", m, n, seats(n, R, T1), g(40 if n <= 4 else 20), {}))
    return cases


# The settings, each on two or three maps and table sizes (and together at the end).
def settings_suite(scale: float) -> list[tuple]:
    g = lambda n: max(4, int(n * scale))  # noqa: E731
    sets = [
        ("capitals", {"capitals": True}),
        ("choosecap", {"capitals": True, "chooseCapitals": True}),
        ("fixed", {"cardValues": "fixed"}),
        ("expo", {"cardValues": "exponential"}),
        ("adjacent", {"fortifyMode": "adjacent"}),
        ("balanced", {"balancedBlitz": True}),
        ("blizzards", {"blizzards": -1}),  # -1: the map's maximum
        ("nofrb", {"firstRoundBonus": False}),
        ("batch3", {"setupBatch": 3}),
        ("batch40", {"setupBatch": 40}),
        ("autosetup", {"autoSetup": True}),
        ("claim", {"randomDeal": False}),
        ("neutrals", {"neutrals": 6, "neutralArmies": 3}),
        ("all", {"capitals": True, "chooseCapitals": True, "cardValues": "exponential", "fortifyMode": "adjacent", "balancedBlitz": True,
                 "blizzards": 4, "firstRoundBonus": False, "setupBatch": 2, "randomDeal": False, "neutrals": 4, "neutralArmies": 1}),
        ("all-auto", {"capitals": True, "cardValues": "fixed", "balancedBlitz": True, "blizzards": 6, "autoSetup": True, "neutrals": 8}),
    ]
    tables = [("classic", 2), ("skirmish", 3), ("world", 6), ("greater_europe", 10)]
    cases = []
    for name, o in sets:
        for m, n in tables:
            oo = dict(o)
            cases.append((f"{name}-{m}-{n}p-teacher", m, n, seats(n, T2, T1, RK), g(150 if n <= 3 else 60), oo))
            cases.append((f"{name}-{m}-{n}p-random", m, n, seats(n, R, T1), g(16 if n <= 3 else 8), oo))
    return cases


# Branch and score (delove-branch@1 with the CPU's DELOVE_BRANCH_TRACE) on the cycle's tables and beyond: the GPU must
# compare the same options, get the same mean scores (same doubles) and pick the same move. Rules and teacher checked too.
BR, NETP = "delove-branch@1", "delove@3"


def branch_suite(scale: float) -> list[tuple]:
    g = lambda n: max(2, int(n * scale))  # noqa: E731
    return [
        ("br-skirmish-2p-branch", "skirmish", 2, f"{BR},{T2}", g(200), {}),
        ("br-skirmish-4p-branch", "skirmish", 4, f"{BR},{T2},{NETP},{T1}", g(100), {}),
        ("br-classic-2p-branch", "classic", 2, f"{BR},{NETP}", g(200), {}),
        ("br-classic-4p-branch", "classic", 4, f"{BR},{T2},{NETP},{T1}", g(100), {}),
        ("br-world-6p-branch", "world", 6, seats(6, BR, T2, NETP), g(30), {}),
        ("br-greater_europe-10p-branch", "greater_europe", 10, seats(10, BR, T2, T1, NETP), g(12), {}),
        ("br-classic-2p-settings-branch", "classic", 2, f"{BR},{T2}", g(100),
         {"capitals": True, "cardValues": "fixed", "balancedBlitz": True, "blizzards": 4}),
        ("br-skirmish-3p-settings-branch", "skirmish", 3, f"{BR},{T2},{NETP}", g(100),
         {"fortifyMode": "adjacent", "cardValues": "exponential", "neutrals": 3, "firstRoundBonus": False}),
        ("br-europe-5p-settings-branch", "europe", 5, seats(5, BR, T2, NETP), g(30),
         {"capitals": True, "chooseCapitals": True, "randomDeal": False, "setupBatch": 3, "blizzards": 5}),
        ("br-greater_europe-6p-settings-branch", "greater_europe", 6, seats(6, BR, T2, NETP), g(12),
         {"autoSetup": True, "balancedBlitz": True, "neutrals": 10, "neutralArmies": 4, "fortifyMode": "adjacent"}),
    ]


# Games with Delove network seats: the rules replay, and (slow path) the GPU network's top move against the logged ONNX
# move at every network decision.
def net_suite(scale: float) -> list[tuple]:
    g = lambda n: max(2, int(n * scale))  # noqa: E731
    return [
        ("net-classic-2p-net", "classic", 2, f"{NETP},{T2}", g(100), {}),
        ("net-skirmish-4p-net", "skirmish", 4, f"{NETP},{T2},{RK},{T1}", g(60), {}),
        ("net-world-8p-net", "world", 8, seats(8, NETP, T2, RK), g(12), {}),
        ("net-greater_europe-10p-net", "greater_europe", 10, seats(10, NETP, T2, T1), g(8), {"capitals": True, "blizzards": 6}),
        ("net-fantasy-6p-net", "fantasy", 6, seats(6, NETP, RK), g(16), {"cardValues": "exponential", "fortifyMode": "adjacent", "randomDeal": False}),
    ]


# Jacob Sensei (jacob-sensei@1, src/jacob.ts): self-play on every map at 2 seats, a middle size and the largest table;
# mixed with Sensei 2 and risky@1 (several teacher versions in one game); every setting; and branch and score with
# Jacob as the rollout teacher (cases named jb-*: DELOVE_BRANCH_TEACHER on the CPU, --teacher on the GPU).
MAPS = {"classic": 6, "world": 10, "world_large": 10, "europe": 8, "greater_europe": 10, "europe_classic": 6, "usa": 10,
        "asia": 8, "fantasy": 10, "skirmish": 4}


def jacob_suite(scale: float) -> list[tuple]:
    g = lambda n: max(2, int(n * scale))  # noqa: E731
    cases = []
    for m, mx in MAPS.items():
        for n in sorted({2, (2 + mx + 1) // 2, mx}):
            cases.append((f"j-{m}-{n}p-teacher", m, n, seats(n, J), g(200 if n <= 4 else 60), {}))
            if n > 2:
                cases.append((f"jmix-{m}-{n}p-teacher", m, n, seats(n, J, T2, RK), g(100 if n <= 4 else 30), {}))
    tail = "-classic-2p-teacher"
    for name, o in [(c[0][: -len(tail)], c[5]) for c in settings_suite(1) if c[0].endswith(tail)]:
        for m, n in [("classic", 2), ("skirmish", 3), ("world", 6), ("greater_europe", 10)]:
            cases.append((f"js-{name}-{m}-{n}p-teacher", m, n, seats(n, J, T2), g(80 if n <= 3 else 16), dict(o)))
    cases += [
        ("jb-skirmish-2p-branch", "skirmish", 2, f"{BR},{J}", g(100), {}),
        ("jb-classic-2p-branch", "classic", 2, f"{BR},{J}", g(100), {}),
        ("jb-classic-2p-net-branch", "classic", 2, f"{BR},{NETP}", g(60), {}),
        ("jb-classic-4p-branch", "classic", 4, f"{BR},{J},{NETP},{T2}", g(40), {}),
        ("jb-world-6p-branch", "world", 6, seats(6, BR, J, NETP), g(12), {}),
        ("jb-greater_europe-10p-branch", "greater_europe", 10, seats(10, BR, J, T2, NETP), g(6), {}),
        ("jb-classic-2p-settings-branch", "classic", 2, f"{BR},{J}", g(60),
         {"capitals": True, "cardValues": "fixed", "balancedBlitz": True, "blizzards": 4}),
        ("jb-europe-5p-settings-branch", "europe", 5, seats(5, BR, J, NETP), g(12),
         {"capitals": True, "chooseCapitals": True, "randomDeal": False, "setupBatch": 3, "blizzards": 5}),
    ]
    return cases


SUITES = {"rules": rules_suite, "settings": settings_suite, "branch": branch_suite, "net": net_suite, "jacob": jacob_suite}
BRANCH_ENV = {"DELOVE_BRANCH_RANKER": NETP, "DELOVE_BRANCH_HORIZON": "1", "DELOVE_BRANCH_MARGIN": "0.01"}


def resolve_options(m: str, o: dict) -> dict:
    o = dict(o)
    if o.get("blizzards") == -1:
        from delove_gpu.config import engine_facts

        o["blizzards"] = engine_facts()["maps"][m]["maxBlizzards"]
    return o


def rollout_teacher(name: str) -> str:
    return J if name.startswith("jb-") else T2


def node_play(agents: str, games: int, start: int, seed: int, options: dict, log: Path, models: str | None,
              teacher: str = T2) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if models:
        env["DELOVE_MODELS"] = models
    if BR in agents:
        env.update(BRANCH_ENV)
        env["DELOVE_BRANCH_TEACHER"] = teacher
        env["DELOVE_BRANCH_TRACE"] = str(log.parent / f"trace-{log.name}-x.jsonl")
    cmd = ["node", "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play", "--agents", agents,
           "--games", str(games), "--start", str(start), "--seed", str(seed), "--options", json.dumps(options), "--log", str(log)]
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, env=env)


def generate(cases: list[tuple], out: Path, seed: int, models: str | None, parallel: int, chunk: int):
    jobs = []
    for i, (name, m, n, agents, games, o) in enumerate(cases):
        d = out / name
        opts = {**resolve_options(m, o), "map": m}
        if (d / "complete").exists():
            continue
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
        (d / "options.json").write_text(json.dumps(opts) + "\n", encoding="utf8")
        for st in range(0, games, chunk):
            jobs.append((name, agents, min(chunk, games - st), st, seed * 1000 + i, opts, d / f"c{st}"))
    print(f"generating {len(jobs)} chunks over {parallel} processes", flush=True)
    t0 = time.time()

    def run(j):
        name, agents, games, st, sd, opts, log = j
        r = node_play(agents, games, st, sd, opts, log, models, rollout_teacher(name))
        if r.returncode:
            raise RuntimeError(f"{name} c{st}: {r.stderr[-2000:]}")
        return name

    with ThreadPoolExecutor(parallel) as ex:
        list(ex.map(run, jobs))
    for name, *_ in cases:
        (out / name / "complete").touch()
    print(f"generated in {time.time() - t0:.0f}s", flush=True)


def flatten(case_dir: Path) -> list[str]:
    return sorted(str(p) for p in case_dir.iterdir() if p.is_dir())


def replay_case(name: str, d: Path, args) -> dict:
    """One case: every chunk through replay.py --fused, with the teacher picks checked at teacher seats. The result
    is saved in the case's folder (replay.json); with --resume a case already replayed identically is not replayed again."""
    done = d / "replay.json"
    if args.resume and done.exists():
        res = json.loads(done.read_text(encoding="utf8"))
        if res.get("rules_ok"):
            return res
    res = {"case": name}
    logs = flatten(d)
    for lg in logs:  # chunk dirs inherit the case's options
        shutil.copy(d / "options.json", Path(lg) / "options.json")
    cmd = [PYTHON, str(HERE / "replay.py"), *logs, "--fused", "--batch", str(args.batch)]
    if args.models:
        cmd += ["--teacher", f"{T1}=", "--teacher", f"{T2}={Path(args.models) / (T2 + '.json')}", "--teacher", f"{J}="]
    if name.endswith("-net") and args.models:
        cmd += ["--net", NETP, str(Path(args.models) / f"{NETP}.pt")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    res["rules"] = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-500:]
    res["rules_ok"] = r.returncode == 0
    res["rules_log"] = r.stdout[-3000:] + r.stderr[-3000:]
    if name.endswith("-net"):
        net = [x for x in r.stdout.splitlines() if x.startswith("network:")]
        res["rules"] += " | " + (net[0] if net else "no network line")
    if name.endswith("-branch") and args.models:
        cmd = [PYTHON, str(HERE / "branch_replay.py"), *logs, "--trace", str(d / "trace-*.jsonl"), "--models", args.models,
               "--ranker", NETP, "--teacher", rollout_teacher(name), "--horizon", BRANCH_ENV["DELOVE_BRANCH_HORIZON"], "--margin", BRANCH_ENV["DELOVE_BRANCH_MARGIN"],
               "--batch", str(args.batch)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        res["rules"] += " | branch: " + (r.stdout.strip().splitlines()[0] if r.stdout.strip() else r.stderr[-500:])
        res["rules_ok"] = res["rules_ok"] and r.returncode == 0
        res["rules_log"] += r.stdout[-3000:] + r.stderr[-3000:]
    done.write_text(json.dumps(res) + "\n", encoding="utf8")
    print(f"{'ok ' if res['rules_ok'] else 'BAD'} {name}", flush=True)
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--suite", choices=list(SUITES), required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--scale", type=float, default=1.0, help="multiply every case's game count")
    ap.add_argument("--models", default=None, help="models folder (delove-teacher@2.json; DELOVE_MODELS for the CPU games)")
    ap.add_argument("--only", default=None, help="only cases whose name contains this")
    ap.add_argument("--parallel", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--replay-parallel", type=int, default=6, help="replay processes at once (they share the GPU)")
    ap.add_argument("--chunk", type=int, default=25)
    ap.add_argument("--batch", type=int, default=400)
    ap.add_argument("--no-generate", action="store_true")
    ap.add_argument("--no-replay", action="store_true", help="only generate the logs")
    ap.add_argument("--resume", action="store_true", help="skip cases whose saved replay result (replay.json) is identical")
    args = ap.parse_args()
    cases = SUITES[args.suite](args.scale)
    if args.only:
        cases = [c for c in cases if args.only in c[0]]
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not args.no_generate:
        generate(cases, out, args.seed, args.models, args.parallel, args.chunk)
    if args.no_replay:
        return
    t0 = time.time()
    with ThreadPoolExecutor(args.replay_parallel) as ex:
        results = list(ex.map(lambda c: replay_case(c[0], out / c[0], args), cases))
    bad = 0
    for r in results:
        ok = r["rules_ok"]
        bad += not ok
        print(f"{'ok ' if ok else 'BAD'} {r['case']}: {r['rules']}")
        if not ok:
            print("    " + r["rules_log"].replace("\n", "\n    ")[-2500:])
    (out / f"results-{args.suite}.json").write_text(json.dumps(results, indent=1) + "\n", encoding="utf8")
    print(f"{len(results) - bad}/{len(results)} cases identical, replay {time.time() - t0:.0f}s")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
