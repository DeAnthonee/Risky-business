"""The proof for stage games (delove_gpu/stage.py): the GPU generator plays the same stage games as the CPU and writes
the same training arrays, bit for bit.

For each case, the same table is played twice: on the CPU (`npm run selfplay -- play` with the TypeScript engine and
agents, logged, then `export --only-agents delove-branch@1`) and on the GPU (generate.py). Then:
- every game must end the same way on both: winner, turns, the turn the stage began and who played each seat in it;
- the two datasets must hold the same games, row for row (tests/dataset_compare.py's game hashes: board, global and
  candidate features, choices, z, points, seats).

Cases cover a lead-in by teachers (the fast kernel's stop at N players alive), a lead-in with network seats (the
step-by-step path), settings (capitals, exponential cards, blizzards), and positions from game records
(tests/stage_records.mjs writes them; `positions` extracts the 3- and 2-alive moments; fog switched off), and ratio
scenarios (`split:`, packages/selfplay/src/scenario.ts: 2 and 3 survivors at 6-10 seat tables, Capital Conquest,
blizzards, card modes; the GPU asks node for the same positions).

    python tests/stage_check.py --models <models> --out runs/gpu-verify/stage [--scale 1] [--seed 5]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from delove_gpu.fingerprint import REPO  # noqa: E402
from tests.dataset_compare import game_hashes  # noqa: E402

BR, J, T2 = "delove-branch@1", "jacob-sensei@1", "delove-teacher@2"
NETP = "delove@3"  # the default ranker, also a network seat in some cases (--ranker)
# the records the positions come from: map, seats, games, settings (fog on in some: positions switch it off)
RECORDS = ["classic 4 12", "world 6 8 {\"fogOfWar\":true}", "europe 5 6 {\"cardValues\":\"fixed\",\"capitals\":true}",
           "skirmish 4 10 {\"blizzards\":2,\"neutrals\":2}"]


def seats(n: int, *agents: str) -> str:
    return ",".join(agents[i % len(agents)] for i in range(n))


def cases(scale: float, positions: Path, NETP: str = NETP) -> list[tuple[str, int, str, dict]]:
    g = lambda n: max(2, int(n * scale))  # noqa: E731
    return [
        ("lead-world-6p-3", g(24), seats(6, J) + f">{BR},{NETP},{J}", {"map": "world"}),
        ("lead-classic-4p-2", g(40), seats(4, J, T2) + f">{BR},{J}", {}),
        ("lead-skirmish-4p-3-settings", g(40), seats(4, J) + f">{BR},{J},{T2}", {"map": "skirmish", "capitals": True, "cardValues": "exponential", "blizzards": 2}),
        ("lead-classic-4p-net-2", g(30), seats(4, NETP, J) + f">{BR},{J}", {}),
        ("lead-classic-3p-3", g(30), seats(3, J) + f">{BR},{J},{T2}", {}),  # already 3 alive: the stage is the whole game
        ("pos-2", g(40), f"pos:{positions}>{BR},{J}", {}),
        ("pos-3", g(30), f"pos:{positions}>{BR},{J},{NETP}", {}),
        ("split-classic-6p-60-40", g(30), f"split:60/40>{BR},{J}", {"maxPlayers": 6}),
        ("split-europe-8p-30-70-settings", g(24), f"split:30/70>{BR},{NETP}",
         {"map": "europe", "maxPlayers": 8, "autoSetup": True, "chooseCapitals": True, "capitals": True, "cardValues": "fixed"}),
        ("split-world-10p-50-25-25-settings", g(16), f"split:50/25/25>{BR},{J},{NETP}",
         {"map": "world", "maxPlayers": 10, "capitals": True, "cardValues": "exponential", "blizzards": 8}),
        ("split-asia-8p-34-33-33", g(20), f"split:34/33/33>{BR},{J},{T2}", {"map": "asia", "maxPlayers": 8, "cardValues": "progressive"}),
    ]


def run(cmd: list[str], env: dict | None = None, cwd: Path = REPO) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env, shell=os.name == "nt" and cmd[0] == "npm")
    if r.returncode:
        raise RuntimeError(f"{' '.join(cmd[:6])} ...: {r.stderr[-3000:]}")
    return r.stdout


def cpu_games(log: Path) -> dict[int, dict]:
    out = {}
    for f in log.glob("games-*.jsonl"):
        for line in f.read_text(encoding="utf8").splitlines():
            if line.strip():
                r = json.loads(line)
                out[r["index"]] = r
    return out


def same_end(cpu: dict, gpu: dict) -> str | None:
    cs, gs = cpu.get("stage"), gpu.get("stage")
    if cpu["winner"] != gpu["winner"] or cpu["turns"] != gpu["turns"]:
        return f"winner/turns cpu {cpu['winner']}/{cpu['turns']} gpu {gpu['winner']}/{gpu['turns']}"
    if (cs is None) != (gs is None) or (cs and (cs["turn"] != gs["turn"] or cs["agents"] != gs["agents"])):
        return f"stage cpu {cs} gpu {gs}"
    if cpu["points"] != gpu["points"]:
        return f"points cpu {cpu['points']} gpu {gpu['points']}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--models", required=True, help="models folder: jacob-sensei@1.json, delove-teacher@2.json, the ranker's .pt and .onnx")
    ap.add_argument("--ranker", default=NETP, help="the branch ranker, also a network seat in some cases")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--only", default=None)
    args = ap.parse_args()
    branch = ["--ranker", args.ranker, "--teacher", J, "--horizon", "1", "--margin", "0.01"]
    branch_env = {"DELOVE_BRANCH_RANKER": args.ranker, "DELOVE_BRANCH_TEACHER": J, "DELOVE_BRANCH_HORIZON": "1", "DELOVE_BRANCH_MARGIN": "0.01"}
    out = Path(args.out).resolve()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    t0 = time.time()
    run(["node", "packages/delove-gpu/tests/stage_records.mjs", str(out / "records"), str(args.seed), *RECORDS])
    positions = out / "positions.jsonl"
    print(run(["node", "packages/selfplay/dist/cli.js", "positions", "--records", str(out / "records"), "--out", str(positions)]).strip())
    env = {**os.environ, **branch_env, "DELOVE_MODELS": args.models}
    ok, total = True, 0
    for k, (name, games, agents, options) in enumerate(cases(args.scale, positions, args.ranker)):
        if args.only and args.only not in name:
            continue
        seed = args.seed * 100 + k
        d = out / name
        run(["node", "--import", "./packages/delove/dist/register.js", "packages/selfplay/dist/cli.js", "play", "--agents", agents, "--games", str(games),
             "--seed", str(seed), "--options", json.dumps(options), "--log", str(d / "log")], env)
        run(["node", "packages/selfplay/dist/cli.js", "export", "--log", str(d / "log"), "--out", str(d / "cpu"), "--only-agents", BR])
        table = f"{name} {games} {agents}" + (f" {json.dumps(options)}" if options else "")
        run([sys.executable, "-m", "delove_gpu.generate", "--models", args.models, *branch, "--table", table, "--seed", str(seed),
             "--out", str(d / "gpu"), "--results", str(d / "gpu-results.jsonl"), "--allow-unverified"], cwd=HERE.parent)
        cpu = cpu_games(d / "log")
        gpu = {r["index"]: r for r in map(json.loads, (d / "gpu-results.jsonl").read_text(encoding="utf8").splitlines())}
        bad = [f"game {i}: {why}" for i in sorted(cpu) if (why := same_end(cpu[i], gpu[i])) is not None] if cpu.keys() == gpu.keys() else ["game sets differ"]
        maps = sorted({p.name for p in (d / "cpu").iterdir() if p.is_dir()} | {p.name for p in (d / "gpu").iterdir() if p.is_dir()})
        rows = 0
        for m in maps:
            ha, hb = (game_hashes(d / side / m) if (d / side / m).is_dir() else Counter() for side in ("cpu", "gpu"))
            rows += sum(ha.values())
            if ha != hb:
                bad.append(f"{m}: datasets differ ({sum((ha & hb).values())} of {sum(ha.values())} cpu / {sum(hb.values())} gpu games identical)")
        reached = sum(1 for r in cpu.values() if r.get("stage"))
        print(f"{'ok ' if not bad else 'BAD'} {name}: {len(cpu)} games, {reached} reached the stage, {rows} games with recorded decisions"
              f" on {maps}" + ("".join(f"\n    {b}" for b in bad[:5])), flush=True)
        ok = ok and not bad
        total += len(cpu)
    print(f"{total} stage games identical in {time.time() - t0:.0f}s" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
