"""How often cheaper branch settings pick what the full search picks, and what they save: plays a table with
generate.py's Group (the full settings decide every move), and at each decision of the branch player also runs every
variant from the same position and the same streams (the seat's stream is put back afterwards), counting the decisions
where the variant's move differs and timing the variant's rollouts.

TRAINING ONLY, a measurement: the variants are options of generate.py (--rollouts, --options, --skip), never defaults.

    python bench/branch_agreement.py --models models/delove --games 128 --seconds 900 \\
        --table 'ge10a 128 delove-branch@1,jacob-sensei@1,... {"map":"greater_europe",...}' \\
        --variant rollouts=4 --variant rollouts=3 --variant skip=occupy,place --variant options=2

(run from packages/delove-gpu). Prints one JSON object: per variant the decisions compared, the share with the same
move, the branched decisions, the rollout seconds and moves against the full search's.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu import generate as G  # noqa: E402
from delove_gpu.branch import GpuBranch, default_branch  # noqa: E402


def parse_variant(s: str) -> tuple[str, dict]:
    out = {}
    for part in s.split(";"):
        k, v = part.split("=", 1)
        out[k] = [x for x in v.split(",") if x] if k == "skip" else int(v)
    return s, out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--table", required=True, help="'NAME GAMES AGENT,AGENT [OPTIONS JSON]' (one table)")
    ap.add_argument("--games", type=int, default=0, help="override the table's game count")
    ap.add_argument("--seconds", type=float, default=900, help="stop after this long (games in flight are not finished)")
    ap.add_argument("--models", required=True)
    ap.add_argument("--ranker", default="delove@3")
    ap.add_argument("--teacher", default="jacob-sensei@1")
    ap.add_argument("--horizon", type=int, default=1)
    ap.add_argument("--margin", type=float, default=0.01)
    ap.add_argument("--options", type=int, default=3)
    ap.add_argument("--rollouts", type=int, default=6)
    ap.add_argument("--variant", action="append", type=parse_variant, default=[],
                    help="e.g. rollouts=4, options=2, skip=occupy,place, or several joined by ';'")
    ap.add_argument("--seed", type=int, default=909)
    a = ap.parse_args()
    t = G.parse_table(a.table)
    if a.games:
        t.games = a.games
    full = default_branch()
    full.options, full.rollouts, full.horizon, full.margin = a.options, a.rollouts, a.horizon, a.margin
    run = G.Run([t], a.seed, Path(a.models), a.ranker, a.teacher, full, [G.BRANCH_ID], None, 500, "fp32", "cuda", True)
    grp = G.Group(run, t.config, [t], t.games)
    e = grp.e
    variants = []
    for name, over in a.variant:
        cfg = copy.deepcopy(full)
        for k, v in over.items():
            setattr(cfg, k, v)
        variants.append((name, GpuBranch(e, grp.nets[run.ranker], cfg)))
    stats = {name: {"decisions": 0, "same": 0, "branched": 0, "seconds": 0.0, "moves": 0} for name, _ in variants}
    stats["full"] = {"decisions": 0, "branched": 0, "changed": 0, "seconds": 0.0, "moves": 0}
    real = grp.branch.decide
    t0 = time.time()

    class Stop(Exception):
        pass

    def decide(games, mask, tact):
        if time.time() - t0 > a.seconds:
            raise Stop
        for name, br in variants:
            saved = e.arng.clone()
            torch.cuda.synchronize()
            ts = time.perf_counter()
            d = br.decide(games, mask, tact)
            torch.cuda.synchronize()
            s = stats[name]
            s["seconds"] += time.perf_counter() - ts
            s["moves"] += d.moves
            s["decisions"] += games.numel()
            s["branched"] += int(d.branched.sum())
            alt = (d.act1, d.act2)
            e.arng.copy_(saved)
            decide.alts.append((name, alt))
        torch.cuda.synchronize()
        ts = time.perf_counter()
        d = real(games, mask, tact)
        torch.cuda.synchronize()
        f = stats["full"]
        f["seconds"] += time.perf_counter() - ts
        f["moves"] += d.moves
        f["decisions"] += games.numel()
        f["branched"] += int(d.branched.sum())
        f["changed"] += int(d.changed.sum())  # the full search's own moves away from the teacher's
        for name, (a1, a2) in decide.alts:
            stats[name]["same"] += int(((a1 == d.act1) & (a2 == d.act2)).sum())
        decide.alts = []
        return d

    decide.alts = []
    grp.branch.decide = decide
    try:
        grp.run(progress=False)
    except Stop:
        pass
    for name, _ in variants:
        s = stats[name]
        s["sameShare"] = round(s["same"] / max(1, s["decisions"]), 4)
        # of the decisions the full search branched on, the share where the variant's move differs
        s["differPerFullBranched"] = round((s["decisions"] - s["same"]) / max(1, stats["full"]["branched"]), 4)
        s["timeVsFull"] = round(s["seconds"] / max(1e-9, stats["full"]["seconds"]), 3)
    print(json.dumps({"table": a.table, "games": t.games, "finished": len(run.results), "seconds": round(time.time() - t0, 1),
                      "full": {"options": full.options, "rollouts": full.rollouts, "skip": full.skip}, "stats": stats}, indent=1))


if __name__ == "__main__":
    main()
