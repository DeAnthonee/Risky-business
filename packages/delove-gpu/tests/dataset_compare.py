"""Compare two training datasets (export.ts / generate.py format) game by game, bit for bit.

Rows of one game keep their order in both writers, but the GPU generator interleaves games, so each game's rows
(territory, global, candidates, choice, z, seat) are hashed and the two datasets compared as multisets of games.

    python tests/dataset_compare.py runs/gpu-gen/t100/classic runs/gpu-verify/branch3-export-all/classic
"""
from __future__ import annotations

import hashlib
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np


def game_hashes(d: Path) -> Counter:
    L = lambda n: np.load(d / f"{n}.npy", mmap_mode="r")  # noqa: E731
    terr, glob, cand, cf, ct, off = L("territory"), L("global"), L("cand"), L("cand_from"), L("cand_to"), np.asarray(L("cand_offset"))
    choice, z, game, seat = (np.asarray(L(n)) for n in ("choice", "z", "game", "seat"))
    rows = defaultdict(list)
    for k, g in enumerate(game.tolist()):
        rows[g].append(k)
    out = Counter()
    for ks in rows.values():
        h = hashlib.sha256()
        for k in ks:
            lo, hi = int(off[k]), int(off[k + 1])
            for a in (terr[k], glob[k], cand[lo:hi], cf[lo:hi], ct[lo:hi], choice[k:k + 1], z[k:k + 1], seat[k:k + 1]):
                h.update(np.ascontiguousarray(a).tobytes())
        out[h.hexdigest()] += 1
    return out


def main():
    a, b = Path(sys.argv[1]), Path(sys.argv[2])
    ha, hb = game_hashes(a), game_hashes(b)
    common = sum((ha & hb).values())
    print(f"{a}: {sum(ha.values())} games, {b}: {sum(hb.values())} games, identical games {common}")
    sys.exit(0 if ha == hb else 1)


if __name__ == "__main__":
    main()
