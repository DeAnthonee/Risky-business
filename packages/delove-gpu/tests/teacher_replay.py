"""Replay logged games and check that the GPU teacher (delove_gpu/teacher.py) picks the logged candidate at every step
the teacher decided, on any map, table size and covered setting (the map and seats from the records, the settings from
options.json in the log dir, as replay.py reads them).

Each game runs on the GPU from its seed (the rules mirror is checked by replay.py; the board is compared here too).
At every step decided by AGENT (a teacher version: delove-teacher@2 with its tuned numbers in --params or --models,
jacob-sensei@1 with the numbers in jacob.ts), the GPU teacher picks from the same position with the seat's own seeded stream (mixSeed(seed, 0x5eed + seat), as
playGame gives it), so the tie-break jitter must come out the same too. Then the logged choice is played, whoever
made it. Zero mismatches expected.

    python tests/teacher_replay.py runs/gpu-verify/t2t2 --agent delove-teacher@2 --params models/delove/delove-teacher@2.json
    python tests/teacher_replay.py runs/gpu-verify/jj-world-10p --agent jacob-sensei@1
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.config import GameConfig  # noqa: E402
from delove_gpu.engine import KIND_NAMES  # noqa: E402
from delove_gpu.logs import Snapshot, cand_to_action, first_diff, games, record_view  # noqa: E402
from delove_gpu.teacher import TeacherEngine, agent_params  # noqa: E402


def describe(e, a: int) -> str:
    if a < 0:
        return "none"
    L = e.L
    return f"{KIND_NAMES[int(L.kind[a])]}#{int(L.arg[a])}/{int(L.slot[a])}"


def replay_batch(recs, agent: str, params, stats: dict, max_turns: int, check_board: bool, cfg: GameConfig):
    B = len(recs)
    e = TeacherEngine(B, cfg, params=params, max_turns=max_turns, allow_unverified=True)
    g = torch.arange(B, device=e.dev)
    seeds = torch.tensor([r[0]["seed"] for r in recs])
    e.reset(g, seeds)
    e.seat_streams(g, seeds)
    lens = [len(r) for r in recs]
    failed = [False] * B
    for i in range(max(lens)):
        mask = e.legal()
        snap = Snapshot(e) if check_board else None
        if snap is None:
            # what cand_to_action needs, without the full snapshot
            snap = _LightSnap(e)
        active = torch.tensor([not failed[b] and i < lens[b] and recs[b][i]["agent"] == agent for b in range(B)], device=e.dev)
        pick = e.teacher(active).cpu().numpy()
        mask_np = mask.cpu().numpy()
        action = torch.zeros(B, dtype=torch.long)
        for b in range(B):
            if failed[b] or i >= lens[b]:
                continue
            r = recs[b][i]
            why = first_diff(record_view(r), snap.encoded(b)) if check_board else None
            acts = None
            if not why:
                acts = [cand_to_action(e, snap, b, c) for c in r["cands"]]
                if -1 in acts or sorted(acts) != np.flatnonzero(mask_np[b]).tolist():
                    why = "legal moves differ"
            if not why and r["agent"] == agent:
                stats["checked"] += 1
                if pick[b] != acts[r["choice"]]:
                    gpu_i = acts.index(pick[b]) if pick[b] in acts else -1
                    why = (f"teacher picks {describe(e, int(pick[b]))} (candidate {gpu_i}), log has {r['cands'][r['choice']]} "
                           f"(candidate {r['choice']}) of {len(acts)}")
                    stats["mismatch"] += 1
                    kind = r["cands"][r["choice"]][0]
                    stats["by_kind"][kind] = stats["by_kind"].get(kind, 0) + 1
            if why:
                failed[b] = True
                stats["fail"].append(f"{r['game']} (seed {r['seed']}) step {i} turn {r['turn']} phase {r['phase']}: {why}")
                continue
            action[b] = acts[r["choice"]]
            stats["steps"] += 1
        e.step(action.to(e.dev))
    stats["games"] += B
    stats["ok_games"] += B - sum(failed)
    stats["odds_out"] += int(e.tstats[0])


class _LightSnap:
    def __init__(self, e):
        self.cur = e.cur.cpu().numpy()
        self.atp = e.atp.cpu().numpy()
        self.phase = e.phase.cpu().numpy()
        self.hand = e.hand.cpu().numpy()
        self.hand_n = e.hand_n.cpu().numpy()
        self.pend = torch.stack([e.pend_from, e.pend_to, e.pend_min, e.pend_max], 1).cpu().numpy()
        self.fort_src = e.fort_src.cpu().numpy()
        self.armies = e.armies.cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--agent", default="delove-teacher@2", help="whose decisions to check")
    ap.add_argument("--params", help="the teacher's tuned numbers (delove-teacher@N.json, jacob-sensei@N.json for N >= 2)")
    ap.add_argument("--models", help="models folder: the numbers of --agent from <models>/<agent>.json, as register.ts reads them")
    ap.add_argument("--batch", type=int, default=1000)
    ap.add_argument("--games", type=int, default=0)
    ap.add_argument("--max-turns", type=int, default=500)
    ap.add_argument("--no-board", action="store_true", help="skip the board comparison (faster)")
    args = ap.parse_args()
    params = agent_params(args.agent, args.models, args.params)
    stats = {"games": 0, "ok_games": 0, "steps": 0, "checked": 0, "mismatch": 0, "by_kind": {}, "fail": [], "odds_out": 0}
    t0 = time.time()
    for log in args.logs:
        f = Path(log) / "options.json"
        opts = json.loads(f.read_text(encoding="utf8")) if f.exists() else {}
        batch, n, cfg = [], 0, None
        for g in games(log):
            c = GameConfig.make(g[0]["players"], {**opts, "map": g[0]["map"]})
            if cfg is not None and c != cfg:
                sys.exit(f"{log}: games of different configurations in one log ({cfg.label()} and {c.label()})")
            cfg = c
            batch.append(g)
            n += 1
            if len(batch) == args.batch:
                replay_batch(batch, args.agent, params, stats, args.max_turns, not args.no_board, cfg)
                batch = []
            if args.games and n >= args.games:
                break
        if batch:
            replay_batch(batch, args.agent, params, stats, args.max_turns, not args.no_board, cfg)
    print(f"{stats['ok_games']}/{stats['games']} games replayed to the end, {stats['steps']} steps, "
          f"{stats['checked']} {args.agent} decisions checked, {stats['mismatch']} mismatches {stats['by_kind'] or ''}"
          f"{f', odds outside the tables {stats[chr(111) + 'dds_out']}' if stats['odds_out'] else ''}, {time.time() - t0:.0f}s")
    for f in stats["fail"][:15]:
        print("   ", f)
    sys.exit(1 if stats["fail"] else 0)


if __name__ == "__main__":
    main()
