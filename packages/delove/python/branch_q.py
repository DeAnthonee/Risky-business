"""branch_q.npy for a CPU export: every candidate's branch-and-score result, from the play log and the branch trace.

`delove_gpu.generate` writes branch_q.npy with the other arrays. On the CPU the branch player's per-option scores are
in its trace (DELOVE_BRANCH_TRACE: one JSON line per branched decision with the options as candidate indexes and
each option's mean score), and `npm run delove -- export` writes the rest. This lines the trace up with export's rows
and writes <export>/<map>/branch_q.npy, the same array generate.py writes for the same games:

    float32 [M], aligned with cand.npy: the mean branch score of the candidate's option at a branched decision (the
    score the pick is made on), NaN where the candidate was not compared (unbranched decisions, fortify_to steps,
    candidates outside the options, decisions of other players).

    python packages/delove/python/branch_q.py --export runs/x-export --log runs/x/c0 runs/x/trace-c0.jsonl \
        --log runs/x/c1 runs/x/trace-c1.jsonl --agents delove-branch@1

Give the logs in the order they were passed to export (`--log a,b`), each with its trace file, and the same
`--agents` and `--maps` as export's --only-agents and --maps. A trace line belongs to the branch player's next decision
in the same game, seat and turn that it could have branched on (no pending conquest, not a fortify_to step, more
than one candidate, choice = the trace's pick); every trace line must find its decision and every row count must
match export's, else nothing is written.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
LOG_TS = HERE.parents[1] / "selfplay" / "src" / "log.ts"


def rule_keys() -> list[str]:
    """RULE_KEYS of packages/selfplay/src/log.ts (the order of a record's `rules` flags)."""
    m = re.search(r"export const RULE_KEYS = \[(.*?)\]", LOG_TS.read_text(encoding="utf8"))
    if not m:
        raise SystemExit(f"RULE_KEYS not found in {LOG_TS}")
    return re.findall(r"'(\w+)'", m.group(1))


def shards(log_dir: str) -> list[str]:
    """export.ts decisionShards: decisions-*.jsonl(.gz), sorted by name."""
    return [os.path.join(log_dir, f) for f in sorted(os.listdir(log_dir)) if re.match(r"^decisions-.*\.jsonl(\.gz)?$", f)]


def records(log_dir: str):
    for shard in shards(log_dir):
        opener = gzip.open if shard.endswith(".gz") else open
        with opener(shard, "rt", encoding="utf8") as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)


def read_trace(path: str) -> dict[tuple[str, int], list[dict]]:
    """Trace lines by (game, seat), in the order they were written."""
    out: dict[tuple[str, int], list[dict]] = defaultdict(list)
    with open(path, encoding="utf8") as f:
        for line in f:
            if line.strip():
                t = json.loads(line)
                out[(t["game"], t["seat"])].append(t)
    return out


def matches(rec: dict, t: dict, skip: set[str]) -> bool:
    """Could `rec` be the decision trace line `t` was written for?"""
    st, cands = rec["state"], rec["cands"]
    if rec["turn"] != t["turn"] or st.get("pending") is not None or st.get("fortifyFrom", -1) >= 0 or len(cands) < 2:
        return False
    opts = t["options"]
    if not opts or max(opts) >= len(cands) or cands[opts[0]][0] in skip:
        return False
    return 0 <= t["best"] < len(opts) and rec["choice"] == opts[t["best"]]


def build(pairs: list[tuple[str, str]], agents: list[str] | None, maps: list[str] | None, skip: set[str]):
    """{map: (q rows float32 [M], candidate counts per decision)} and the number of trace lines used."""
    fog = rule_keys().index("fogOfWar")
    out: dict[str, tuple[list[np.ndarray], list[int]]] = {}
    used = 0
    for log_dir, trace in pairs:
        lines = read_trace(trace) if trace else {}
        ptr: dict[tuple[str, int], int] = defaultdict(int)
        for rec in records(log_dir):
            if maps and rec["map"] not in maps:
                continue
            if agents and rec["agent"] not in agents:
                continue
            qs, counts = out.setdefault(rec["map"], ([], []))
            if (rec.get("rules") or [0] * (fog + 1))[fog] or rec["choice"] < 0:
                continue  # export skips these too
            q = np.full(len(rec["cands"]), np.nan, dtype=np.float32)
            key = (rec["game"], rec["seat"])
            ls = lines.get(key, [])
            k = ptr[key]
            if k < len(ls) and matches(rec, ls[k], skip):
                t = ls[k]
                for i, mean in zip(t["options"], t["means"]):
                    q[i] = np.float32(mean)  # the double rounded once, as generate.py stores it
                ptr[key] = k + 1
                used += 1
            qs.append(q)
            counts.append(len(rec["cands"]))
        for key, ls in lines.items():
            if ptr[key] != len(ls):
                game, seat = key
                raise SystemExit(f"{trace}: game {game} seat {seat}: {len(ls) - ptr[key]} of {len(ls)} trace lines found no decision "
                                 f"(is --agents the branch player, and the log the one this trace was written with?)")
    return out, used


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--export", required=True, help="the export's output folder (one folder per map inside)")
    ap.add_argument("--log", nargs=2, action="append", required=True, metavar=("LOG_DIR", "TRACE"),
                    help="a log folder and its branch trace file ('-' if none), in export's --log order")
    ap.add_argument("--agents", help="comma-separated, as export's --only-agents")
    ap.add_argument("--maps", help="comma-separated, as export's --maps")
    ap.add_argument("--skip", default="occupy", help="the branch player's DELOVE_BRANCH_SKIP kinds (default occupy)")
    args = ap.parse_args()
    pairs = [(d, None if t == "-" else t) for d, t in args.log]
    agents = args.agents.split(",") if args.agents else None
    maps = args.maps.split(",") if args.maps else None
    out, used = build(pairs, agents, maps, {k for k in args.skip.split(",") if k})
    for m, (qs, counts) in out.items():
        d = Path(args.export) / m
        off = np.load(d / "cand_offset.npy")
        if len(off) != len(counts) + 1 or not np.array_equal(np.diff(off), np.asarray(counts, dtype=off.dtype)):
            raise SystemExit(f"{d}: the export's decisions ({len(off) - 1}) do not line up with these logs' ({len(counts)}): "
                             "same logs, order, --agents and --maps as the export?")
    for m, (qs, _) in out.items():
        q = np.concatenate(qs) if qs else np.zeros(0, dtype=np.float32)
        np.save(Path(args.export) / m / "branch_q.npy", q.astype("<f4"))
        print(json.dumps({"map": m, "decisions": len(qs), "candidates": int(len(q)), "branched": int(sum(np.isfinite(x).any() for x in qs)),
                          "scored": int(np.isfinite(q).sum())}))
    print(json.dumps({"traceLines": used}))


if __name__ == "__main__":
    sys.exit(main())
