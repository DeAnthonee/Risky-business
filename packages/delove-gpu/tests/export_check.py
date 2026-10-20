"""Check the GPU training-array writer (delove_gpu/generate.py Recorder) against `npm run delove -- export`.

Replays a decision log on the GPU with the logged choices and writes AGENT's decisions with the same Recorder the GPU
generator uses, then compares every array with export's arrays of the same log, bit for bit: territory, global and
candidate features (float32 bits), candidate order (the GPU's actions.ts order must be the logged candidate list,
fortify destinations included), cand_from / cand_to / cand_offset, choice, z, seat, and the game grouping.

    npm run delove -- export --log runs/gpu-verify/branch3/c2t --out runs/gpu-verify/branch3-export-c2t --only-agents delove-branch@1
    python tests/export_check.py runs/gpu-verify/branch3/c2t runs/gpu-verify/branch3-export-c2t --agent delove-branch@1
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.branch import BranchEngine  # noqa: E402
from delove_gpu.encode import Encoder  # noqa: E402
from delove_gpu.config import GameConfig  # noqa: E402
from delove_gpu.generate import Recorder, ts_constants  # noqa: E402
from delove_gpu.logs import cand_to_action, games  # noqa: E402
from tests.branch_replay import Snap, log_options  # noqa: E402

NAMES = ["territory", "global", "cand", "cand_from", "cand_to", "cand_offset", "choice", "z", "game", "seat"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("export")
    ap.add_argument("--agent", default="delove-branch@1")
    ap.add_argument("--games", type=int, default=0)
    args = ap.parse_args()
    recs = []
    for g in games(args.log):
        recs.append(g)
        if args.games and len(recs) >= args.games:
            break
    t0 = time.time()
    B = len(recs)
    gcfg = GameConfig.make(recs[0][0]["players"], {**log_options(args.log), "map": recs[0][0]["map"]})
    e = BranchEngine(B, gcfg, allow_unverified=True)
    enc = Encoder(e)
    tmp = Path(tempfile.mkdtemp(prefix="gpu-export-"))
    rec = Recorder(tmp, e.m, ts_constants())
    g = torch.arange(B, device=e.dev)
    e.reset(g, torch.tensor([r[0]["seed"] for r in recs]))
    uid = torch.arange(B, device=e.dev)
    order_bad = 0
    for i in range(max(len(r) for r in recs)):
        live = [b for b in range(B) if i < len(recs[b])]
        e.legal()
        snap = Snap(e)
        terr, glob = enc.encode()
        ordered, cnt = e.cand_order()
        o_np, c_np = ordered.cpu().numpy(), cnt.cpu().numpy()
        action = torch.full((B,), -1, dtype=torch.long)
        chosen = torch.full((B,), -1, dtype=torch.long)
        rows, keys = [], []
        for b in live:
            r = recs[b][i]
            acts = [cand_to_action(e, snap, b, c) for c in r["cands"]]
            if acts != o_np[b, : c_np[b]].tolist():
                order_bad += 1
            action[b] = acts[r["choice"]]
            if r["agent"] == args.agent and r["choice"] >= 0:
                rows.append(b)
                keys.append((b, i))
                chosen[b] = acts[r["choice"]]
        if rows:
            rec.add(enc, terr, glob, torch.tensor(rows, device=e.dev), ordered, cnt, chosen.to(e.dev), uid, e.cur, keys)
        e.step(action.to(e.dev))
    for b, r in enumerate(recs):
        z = [0.0] * r[0]["players"]
        for x in r:
            z[x["seat"]] = x["outcome"]["z"]
        rec.finish_game(b, z)
    rec.close([args.log])

    mine = {n: np.load(tmp / gcfg.map / f"{n}.npy") for n in NAMES}
    ref = {n: np.load(Path(args.export) / gcfg.map / f"{n}.npy") for n in NAMES}
    perm = np.array(sorted(range(len(rec.keys)), key=lambda k: rec.keys[k]))
    problems = []
    N = len(perm)
    if N != len(ref["choice"]):
        problems.append(f"{N} decisions, export has {len(ref['choice'])}")
    else:
        bits = lambda a: a.view(np.uint32)  # noqa: E731
        for n in ["territory", "global"]:
            a, b = mine[n][perm], ref[n]
            if not np.array_equal(bits(a), bits(b)):
                k = np.argwhere(bits(a) != bits(b))
                problems.append(f"{n}: {len(k)} values differ, first at {k[0].tolist()}: gpu {a[tuple(k[0])]!r} ts {b[tuple(k[0])]!r}, "
                                f"max abs {float(np.abs(a - b).max()):.3g}")
        off = mine["cand_offset"]
        rows = np.concatenate([np.arange(off[k], off[k + 1]) for k in perm])
        for n in ["cand", "cand_from", "cand_to"]:
            a, b = mine[n][rows], ref[n]
            same = np.array_equal(bits(a), bits(b)) if n == "cand" else np.array_equal(a, b)
            if not same:
                problems.append(f"{n} differs ({int((a != b).sum())} values)")
        counts = np.diff(off)[perm]
        if not np.array_equal(np.concatenate([[0], np.cumsum(counts)]), ref["cand_offset"]):
            problems.append("cand_offset differs")
        for n in ["choice", "z", "seat"]:
            if not np.array_equal(mine[n][perm], ref[n]):
                problems.append(f"{n} differs")
        pairs = set(zip(mine["game"][perm].tolist(), ref["game"].tolist()))
        if len(pairs) != len(set(ref["game"].tolist())) or len({a for a, _ in pairs}) != len(pairs):
            problems.append("games are grouped differently")
    print(f"{N} decisions, {len(mine['cand'])} candidates of {B} games written by the GPU recorder; candidate order differs from "
          f"the log at {order_bad} steps; {'IDENTICAL to export (bit for bit)' if not problems else 'DIFFERENT:'} {time.time() - t0:.0f}s")
    for p in problems:
        print("   ", p)
    sys.exit(1 if problems or order_bad else 0)


if __name__ == "__main__":
    main()
