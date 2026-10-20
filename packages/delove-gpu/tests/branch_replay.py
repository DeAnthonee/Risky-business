"""Replay logged branch-and-score games and check the GPU branch (delove_gpu/branch.py) against the CPU's decisions.

The log must come from `play` with delove-branch@1 at the table and DELOVE_BRANCH_TRACE set (branch.ts then writes,
per branched decision, the options it compared and each one's mean score). Every game is replayed from its seed with
the logged choices. At each decision of delove-branch@1 the GPU runs the whole branch-and-score decision from the same
position and the seat's own stream (teacher pick, ranker options, fortify completions, seeds, rollouts, scores) and is
compared with the CPU: the options (in order), the mean score of every option (exactly: same doubles), the pick.

The options come from the ranker network (ONNX in Node, PyTorch here; fp32 both): a near-tie in its logits can order
the 2nd and 3rd options differently. Such a decision is reported as an option-order difference, and the game keeps
being checked only until the seat's random stream could have diverged (a fortify option draws from it).

    python tests/branch_replay.py runs/gpu-verify/branch3/c2t --trace "runs/gpu-verify/branch3/trace-c2t-*.jsonl" \\
        --models models/delove --ranker c2-candidate --horizon 1 --margin 0.01
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.branch import BranchEngine, GpuBranch, default_branch, net_ranker  # noqa: E402
from delove_gpu.config import GameConfig  # noqa: E402
from delove_gpu.encode import Encoder  # noqa: E402
from delove_gpu.engine import KIND_NAMES  # noqa: E402
from delove_gpu.logs import cand_to_action, games  # noqa: E402
from delove_gpu.play import load_delove  # noqa: E402
from delove_gpu.teacher import agent_params  # noqa: E402

BRANCH = "delove-branch@1"


class Snap:
    def __init__(self, e):
        self.cur = e.cur.cpu().numpy()
        self.atp = e.atp.cpu().numpy()
        self.phase = e.phase.cpu().numpy()
        self.hand = e.hand.cpu().numpy()
        self.hand_n = e.hand_n.cpu().numpy()
        self.pend = torch.stack([e.pend_from, e.pend_to, e.pend_min, e.pend_max], 1).cpu().numpy()
        self.fort_src = e.fort_src.cpu().numpy()
        self.armies = e.armies.cpu().numpy()
        self.owner = e.owner.cpu().numpy()


def name(e, a):
    L = e.L
    return f"{KIND_NAMES[int(L.kind[a])]}#{int(L.arg[a])}/{int(L.slot[a])}" if a >= 0 else "-"


def replay_batch(recs, traces, e_args, ranker_pt, cfg, stats, gcfg=None):
    B = len(recs)
    e = BranchEngine(B, gcfg, **e_args)
    enc = Encoder(e)
    rank = net_ranker(enc, ranker_pt, e.m.adj_matrix)
    br = GpuBranch(e, rank, cfg)
    g = torch.arange(B, device=e.dev)
    seeds = torch.tensor([r[0]["seed"] for r in recs])
    e.reset(g, seeds)
    e.seat_streams(g, seeds)
    ptr = [0] * B
    tptr = [0] * B
    expect2 = [None] * B  # (act2 the GPU branch chose, GPU decision agreed) for the logged fortify_to step
    trusted = [True] * B  # the seat's stream is still in step with the CPU's
    while True:
        live = [b for b in range(B) if ptr[b] < len(recs[b])]
        if not live:
            break
        mask = e.legal()
        snap = Snap(e)
        recs_now = {b: recs[b][ptr[b]] for b in live}
        decide = [b for b in live if recs_now[b]["agent"] == BRANCH and recs_now[b]["state"]["fortifyFrom"] < 0 and trusted[b]]
        acts = {b: [cand_to_action(e, snap, b, c) for c in recs_now[b]["cands"]] for b in live}
        if decide:
            dg = torch.tensor(decide, device=e.dev)
            active = torch.zeros(B, dtype=torch.bool, device=e.dev)
            active[dg] = True
            tact = e.teacher(active)
            terr, glob = enc.encode()
            enc.last = (terr, glob)
            d = br.decide(dg, mask, tact)
            a1, a2 = d.act1.tolist(), d.act2.tolist()
            branched = d.branched.tolist()
            opts = d.options.tolist()
            means = d.means[:, :, 0].tolist()
            best = d.best.tolist()
            for k, b in enumerate(decide):
                r = recs_now[b]
                logged = acts[b][r["choice"]]
                stats["decisions"] += 1
                why = None
                if branched[k]:
                    stats["branched"] += 1
                    tl = traces[r["game"]]
                    t = tl[tptr[b]] if tptr[b] < len(tl) else None
                    tptr[b] += 1
                    if t is None or t["turn"] != r["turn"]:
                        why = "no CPU trace line for a GPU branched decision"
                    else:
                        cpu_opts = [acts[b][i] for i in t["options"]]
                        gpu_opts = [x for x in opts[k] if x >= 0]
                        if cpu_opts != gpu_opts:
                            stats["opt_diff"] += 1
                            why = f"options differ: cpu {[name(e, x) for x in cpu_opts]} gpu {[name(e, x) for x in gpu_opts]}"
                            if sorted(cpu_opts) == sorted(gpu_opts) or cpu_opts[0] == gpu_opts[0]:
                                stats["opt_rank"] += 1
                        else:
                            gm = means[k][: len(gpu_opts)]
                            if gm != t["means"]:
                                stats["mean_diff"] += 1
                                err = max(abs(x - y) for x, y in zip(gm, t["means"]))
                                why = f"means differ by up to {err:.3g}: cpu {t['means']} gpu {gm}"
                            else:
                                stats["means_exact"] += 1
                            if best[k] != t["best"]:
                                why = (why or "") + f" pick: cpu option {t['best']} gpu {best[k]}"
                if a1[k] == logged:
                    stats["same_pick"] += 1
                else:
                    stats["diff_pick"] += 1
                    why = (why or "") + f" | picks: cpu {name(e, logged)} gpu {name(e, a1[k])}"
                if why:
                    stats["fail"].append(f"{r['game']} (seed {r['seed']}) turn {r['turn']} rec {ptr[b]}: {why.strip()}")
                    # the seat's stream stays in step only if the decision drew the same numbers
                    trusted[b] = False
                    stats["untrusted_games"] += 1
                L = e.L
                expect2[b] = a2[k] if a1[k] == logged and L.FFROM <= a1[k] < L.FTO and trusted[b] else None
        action = torch.full((B,), -1, dtype=torch.long)
        for b in live:
            r = recs_now[b]
            a = acts[b][r["choice"]]
            if r["agent"] == BRANCH and r["state"]["fortifyFrom"] >= 0 and expect2[b] is not None:
                stats["fortify_to"] += 1
                if expect2[b] != a:
                    stats["fail"].append(f"{r['game']} turn {r['turn']}: fortify_to cpu {name(e, a)} gpu {name(e, expect2[b])}")
                    trusted[b] = False
                expect2[b] = None
            action[b] = a
            ptr[b] += 1
        e.step(action.to(e.dev))
    stats["games"] += B
    stats["trusted_games"] += sum(trusted)


def log_options(log: str) -> dict:
    f = Path(log) / "options.json"
    return json.loads(f.read_text(encoding="utf8")) if f.exists() else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--trace", action="append", required=True, help="trace JSONL file(s) or glob (DELOVE_BRANCH_TRACE)")
    ap.add_argument("--models", required=True)
    ap.add_argument("--ranker", default="delove@2")
    ap.add_argument("--teacher", default="delove-teacher@2")
    d = default_branch()
    ap.add_argument("--options", type=int, default=d.options)
    ap.add_argument("--rollouts", type=int, default=d.rollouts)
    ap.add_argument("--horizon", type=int, default=d.horizon)
    ap.add_argument("--margin", type=float, default=d.margin)
    ap.add_argument("--batch", type=int, default=400)
    ap.add_argument("--games", type=int, default=0)
    args = ap.parse_args()
    cfg = d
    cfg.options, cfg.rollouts, cfg.horizon, cfg.margin = args.options, args.rollouts, args.horizon, args.margin
    models = Path(args.models)
    params = agent_params(args.teacher, models)
    ranker_pt = load_delove(models / f"{args.ranker}.pt", "cuda")
    e_args = dict(params=params, allow_unverified=True)
    stats = defaultdict(int)
    stats["fail"] = []
    t0 = time.time()
    for log in args.logs:
        traces = defaultdict(list)
        files = [f for pat in args.trace for f in sorted(glob.glob(pat))]
        tag = Path(log).name
        for f in files:
            if f"-{tag}-" not in Path(f).name and len(args.logs) > 1:
                continue
            for line in open(f, encoding="utf8"):
                t = json.loads(line)
                traces[t["game"]].append(t)
        opts = log_options(log)
        batch, n, gcfg = [], 0, None
        for gm in games(log):
            c = GameConfig.make(gm[0]["players"], {**opts, "map": gm[0]["map"]})
            if gcfg is not None and c != gcfg:
                sys.exit(f"{log}: games of different configurations in one log")
            gcfg = c
            batch.append(gm)
            n += 1
            if len(batch) == args.batch:
                replay_batch(batch, traces, e_args, ranker_pt, cfg, stats, gcfg)
                batch = []
            if args.games and n >= args.games:
                break
        if batch:
            replay_batch(batch, traces, e_args, ranker_pt, cfg, stats, gcfg)
    s = stats
    print(f"{s['games']} games, {s['decisions']} branch-player decisions ({s['branched']} branched, {s['fortify_to']} fortify_to steps): "
          f"same pick {s['same_pick']}, different {s['diff_pick']}; branched with the CPU's options: means identical on "
          f"{s['means_exact']}, different on {s['mean_diff']}; options differ on {s['opt_diff']} ({s['opt_rank']} only in "
          f"the ranker's order of the alternatives); games checked to the end {s['trusted_games']}/{s['games']}; {time.time() - t0:.0f}s")
    for f in s["fail"][:25]:
        print("   ", f)
    sys.exit(1 if s["mean_diff"] or s["diff_pick"] > s["opt_diff"] else 0)


if __name__ == "__main__":
    main()
