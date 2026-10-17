"""Reference reader for Risky Business self-play decision logs (formats v1 and v2). Standard library only.

v2 splits a fortify into two steps (fortify_from, then fortify_to with state["fortifyFrom"] set) and adds
state["order"], per-seat income in state["seats"] and rec["rules"]. For training arrays use the `export` command and
risky_dataset.py instead of encoding these records yourself.

    from risky_log import load_meta, iter_decisions
    meta = load_meta("runs/night-01")
    for rec in iter_decisions("runs/night-01"):
        x = rec["state"]            # owner / armies per territory, seats, hand, ...
        y = rec["choice"]           # index into rec["cands"] (-1 = off the discrete action space)
        z = rec["outcome"]["z"]     # 1 win, 0 loss, survivors share 1 at the turn limit

Run it directly for a summary: python3 risky_log.py runs/night-01
"""
import glob
import gzip
import json
import os
import sys

SUPPORTED_VERSIONS = (1, 2)


def load_meta(log_dir):
    with open(os.path.join(log_dir, "meta.json")) as f:
        meta = json.load(f)
    if meta["v"] not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported log version {meta['v']}")
    return meta


def _open(path):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path)


def iter_decisions(log_dir):
    """Yield every decision record from every shard, in shard order."""
    for path in sorted(glob.glob(os.path.join(log_dir, "decisions-*.jsonl*"))):
        with _open(path) as f:
            for line in f:
                rec = json.loads(line)
                if rec["v"] not in SUPPORTED_VERSIONS:
                    raise ValueError(f"{path}: unsupported record version {rec['v']}")
                yield rec


def iter_games(log_dir):
    for path in sorted(glob.glob(os.path.join(log_dir, "games-*.jsonl"))):
        with open(path) as f:
            for line in f:
                yield json.loads(line)


def main(log_dir):
    meta = load_meta(log_dir)
    n = off = 0
    kinds = {}
    for rec in iter_decisions(log_dir):
        n += 1
        if rec["choice"] < 0:
            off += 1
        else:
            kind = rec["cands"][rec["choice"]][0]
            kinds[kind] = kinds.get(kind, 0) + 1
        t = len(meta["maps"][rec["map"]]["territoryIds"])
        assert len(rec["state"]["owner"]) == t and len(rec["state"]["armies"]) == t
        assert len(rec["traits"]) == len(meta["traitKeys"])
    games = list(iter_games(log_dir))
    print(json.dumps({"games": len(games), "decisions": n, "offList": off, "chosenKinds": kinds}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
