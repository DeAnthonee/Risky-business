"""Compare two training datasets (export.ts / generate.py format) game by game, bit for bit.

Rows of one game keep their order in both writers, but the GPU generator interleaves games, so each game's rows
(territory, global, candidates, choice, z, points, seat) are hashed and the two datasets compared as multisets of games.
When both have branch_q.npy (generate.py; branch_q.py for a CPU export), every candidate's branch score is hashed too
(bit for bit, NaN where not compared).

    python tests/dataset_compare.py runs/gpu-gen/t100/classic runs/gpu-verify/branch3-export-all/classic

With --subset, every game of the first dataset must be in the second (e.g. a cloud GPU's run of some of a cycle's
tables against the training PC's whole map folder of that cycle):

    python tests/dataset_compare.py --subset runs/cloud-test/w10b/world data/delove/c6-big/world
"""
from __future__ import annotations

import hashlib
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np


def game_hashes(d: Path, q: bool = False) -> Counter:
    L = lambda n: np.load(d / f"{n}.npy", mmap_mode="r")  # noqa: E731
    terr, glob, cand, cf, ct, off = L("territory"), L("global"), L("cand"), L("cand_from"), L("cand_to"), np.asarray(L("cand_offset"))
    choice, z, game, seat = (np.asarray(L(n)) for n in ("choice", "z", "game", "seat"))
    # leaderboard points (log v3 exports and the GPU writer); absent in older exports
    pts = [np.asarray(L(n)) for n in ("points", "points01") if (d / f"{n}.npy").exists()]
    bq = [L("branch_q")] if q else []
    rows = defaultdict(list)
    for k, g in enumerate(game.tolist()):
        rows[g].append(k)
    out = Counter()
    for ks in rows.values():
        h = hashlib.sha256()
        for k in ks:
            lo, hi = int(off[k]), int(off[k + 1])
            for a in (terr[k], glob[k], cand[lo:hi], cf[lo:hi], ct[lo:hi], choice[k:k + 1], z[k:k + 1], seat[k:k + 1], *(p[k:k + 1] for p in pts),
                      *(x[lo:hi] for x in bq)):
                h.update(np.ascontiguousarray(a).tobytes())
        out[h.hexdigest()] += 1
    return out


def main():
    argv = sys.argv[1:]
    subset = "--subset" in argv
    a, b = (Path(x) for x in argv if x != "--subset")
    q = (a / "branch_q.npy").exists() and (b / "branch_q.npy").exists()
    if q:
        print("branch_q.npy in both: every candidate's branch score compared too")
    ha, hb = game_hashes(a, q), game_hashes(b, q)
    common = sum((ha & hb).values())
    print(f"{a}: {sum(ha.values())} games, {b}: {sum(hb.values())} games, identical games {common}")
    sys.exit(0 if (common == sum(ha.values()) if subset else ha == hb) else 1)


if __name__ == "__main__":
    main()
