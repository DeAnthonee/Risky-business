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


class Dataset:
    """One map folder of a dataset: its arrays and each game's rows (in order)."""

    def __init__(self, d: Path, q: bool = False):
        d = Path(d)
        L = lambda n: np.load(d / f"{n}.npy", mmap_mode="r")  # noqa: E731
        self.terr, self.glob, self.cand, self.cf, self.ct = L("territory"), L("global"), L("cand"), L("cand_from"), L("cand_to")
        self.off = np.asarray(L("cand_offset"))
        self.choice, self.z, game, self.seat = (np.asarray(L(n)) for n in ("choice", "z", "game", "seat"))
        # leaderboard points (log v3 exports and the GPU writer); absent in older exports
        self.pts = {n: np.asarray(L(n)) for n in ("points", "points01") if (d / f"{n}.npy").exists()}
        self.bq = L("branch_q") if q else None
        self.rows = defaultdict(list)
        for k, g in enumerate(game.tolist()):
            self.rows[g].append(k)

    def fields(self, k: int) -> list[tuple[str, np.ndarray]]:
        """Row k's fields, named, in the order they are hashed."""
        lo, hi = int(self.off[k]), int(self.off[k + 1])
        out = [("territory", self.terr[k]), ("global", self.glob[k]), ("cand", self.cand[lo:hi]), ("cand_from", self.cf[lo:hi]),
               ("cand_to", self.ct[lo:hi]), ("choice", self.choice[k:k + 1]), ("z", self.z[k:k + 1]), ("seat", self.seat[k:k + 1])]
        out += [(n, p[k:k + 1]) for n, p in self.pts.items()]
        return out + ([("branch_q", self.bq[lo:hi])] if self.bq is not None else [])

    def hashes(self) -> dict[int, str]:
        """Each game's hash, by game index."""
        out = {}
        for g, ks in self.rows.items():
            h = hashlib.sha256()
            for k in ks:
                for _, a in self.fields(k):
                    h.update(np.ascontiguousarray(a).tobytes())
            out[g] = h.hexdigest()
        return out


def game_hashes(d: Path, q: bool = False) -> Counter:
    return Counter(Dataset(d, q).hashes().values())


def _differ(a: Dataset, ka: int, b: Dataset, kb: int) -> list[str]:
    return [n for (n, x), (_, y) in zip(a.fields(ka), b.fields(kb)) if np.ascontiguousarray(x).tobytes() != np.ascontiguousarray(y).tobytes()]


def first_difference(a: Dataset, ga: int, b: Dataset, gb: int) -> tuple[int, int, int, list[str]] | None:
    """The first row that differs between game ga of a and game gb of b: (row number in the game, row in a, row in b,
    the fields that differ; "rows" when one side has fewer), or None when the games are identical."""
    ra, rb = a.rows.get(ga, []), b.rows.get(gb, [])
    for i, (ka, kb) in enumerate(zip(ra, rb)):
        if diff := _differ(a, ka, b, kb):
            return i, ka, kb, diff
    n = min(len(ra), len(rb))
    return None if len(ra) == len(rb) else (n, ra[n] if n < len(ra) else -1, rb[n] if n < len(rb) else -1, ["rows"])


def pair_differing(a: Dataset, b: Dataset) -> list[tuple[int | None, int | None]]:
    """The games of a and b that have no identical game on the other side, paired: the two writers number games
    differently, so each game of a goes with the unpaired game of b that shares its longest run of identical first rows
    (None when nothing is left)."""
    ha, hb = a.hashes(), b.hashes()
    left_b = Counter(hb.values())
    lone_a = []
    for g, h in sorted(ha.items()):
        if left_b[h] > 0:
            left_b[h] -= 1
        else:
            lone_a.append(g)
    lone_b = []
    for g, h in sorted(hb.items()):
        if left_b[h] > 0:
            left_b[h] -= 1
            lone_b.append(g)

    def prefix(ga: int, gb: int) -> int:
        d = first_difference(a, ga, b, gb)
        return len(a.rows[ga]) if d is None else d[0]

    out = []
    for ga in lone_a:
        gb = max(lone_b, key=lambda x: prefix(ga, x), default=None)
        if gb is not None:
            lone_b.remove(gb)
        out.append((ga, gb))
    return out + [(None, gb) for gb in lone_b]


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
