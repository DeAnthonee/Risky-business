"""Compare a ladder match played on the CPU (`npm run delove -- ladder ... --log DIR`) with the same match on the GPU
(`python -m delove_gpu.ladder ... --results FILE`): game by game (winner, turns, placements, kills, points) and the two
printed results.

    python tests/ladder_compare.py CPU_LOG_DIR GPU_RESULTS.jsonl [--match gI-K] [--cpu-json CPU.json --gpu-json GPU.json]

A game that differs is a fail unless it is explained by a network near-tie (ONNX Runtime and PyTorch sum in different
orders, so two moves whose logits are within ~1e-5 can swap; the game then diverges, equally valid). Without the
decision log replayed through the GPU network the two cannot be told apart here, so the script reports how many
games differ; `tests/replay.py --net` on the CPU log settles whether each one is a near-tie.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

FIELDS = ["winner", "turns", "placement", "kills", "points"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cpu_log")
    ap.add_argument("gpu_results")
    ap.add_argument("--cpu-json")
    ap.add_argument("--gpu-json")
    ap.add_argument("--match", help="only this match of the GPU results (a gate chunk, e.g. g3-7)")
    args = ap.parse_args()
    cpu = {}
    for f in sorted(Path(args.cpu_log).glob("games-*.jsonl")):
        for line in f.read_text(encoding="utf8").splitlines():
            if line.strip():
                g = json.loads(line)
                cpu[g["index"]] = g
    gpu = {}
    for line in Path(args.gpu_results).read_text(encoding="utf8").splitlines():
        if line.strip():
            g = json.loads(line)
            if args.match is None or g["match"] == args.match:
                gpu[g["i"]] = g
    if sorted(cpu) != sorted(gpu):
        print(f"game sets differ: CPU {len(cpu)}, GPU {len(gpu)}")
        return 1
    diff = [i for i in sorted(cpu) if any(cpu[i][k] != gpu[i][k] for k in FIELDS)]
    winners = sum(1 for i in diff if cpu[i]["winner"] != gpu[i]["winner"])
    out = {"games": len(cpu), "identical": len(cpu) - len(diff), "different": len(diff), "differentWinner": winners, "differentGames": diff[:20]}
    if args.cpu_json and args.gpu_json:
        a = json.loads(Path(args.cpu_json).read_text(encoding="utf8"))
        b = json.loads(Path(args.gpu_json).read_text(encoding="utf8"))
        out["resultDiff"] = {k: [a.get(k), b.get(k)] for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}
    print(json.dumps(out))
    return 0 if not diff else 2


if __name__ == "__main__":
    sys.exit(main())
