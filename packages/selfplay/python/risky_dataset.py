"""Load a dataset written by `npm run selfplay -- export` (one folder per map). Needs numpy.

    from risky_dataset import load_dataset
    ds = load_dataset("data/export-01/classic")      # memory-mapped, so big exports load instantly
    for k in range(len(ds)):
        x_t, x_g, cands, c_from, c_to = ds.decision(k)
        y = ds.choice[k]                          # index into this decision's candidates
        z = ds.z[k]                               # 1 win, 0 loss (survivors share 1 at the turn limit)

    train, val = ds.split_by_game(0.1)            # keep every decision of a game on one side

Run it directly for a summary and sanity checks: python3 risky_dataset.py data/export-01/classic
"""
import json
import os
import sys

import numpy as np

SUPPORTED_ENCODER = 1
ARRAYS = ["territory", "global", "cand", "cand_from", "cand_to", "cand_offset", "choice", "z", "game", "seat"]


class Dataset:
    def __init__(self, folder, mmap=True):
        with open(os.path.join(folder, "features.json")) as f:
            self.info = json.load(f)
        if self.info["encoderVersion"] != SUPPORTED_ENCODER:
            raise ValueError(f"encoder v{self.info['encoderVersion']}, this loader reads v{SUPPORTED_ENCODER}")
        for name in ARRAYS:
            setattr(self, name, np.load(os.path.join(folder, name + ".npy"), mmap_mode="r" if mmap else None))
        self.adjacency = self.info["adjacency"]

    def __len__(self):
        return len(self.choice)

    def decision(self, k):
        """Features of decision k: territory [T, F_t], global [F_g], candidates [C, F_c], cand_from [C], cand_to [C]."""
        a, b = int(self.cand_offset[k]), int(self.cand_offset[k + 1])
        return self.territory[k], self.global_[k], self.cand[a:b], self.cand_from[a:b], self.cand_to[a:b]

    @property
    def global_(self):
        return getattr(self, "global")

    def split_by_game(self, val_fraction, seed=0):
        """Index arrays (train, val) with whole games on one side."""
        games = np.unique(self.game)
        rng = np.random.default_rng(seed)
        val_games = set(rng.choice(games, size=max(1, int(len(games) * val_fraction)), replace=False).tolist())
        is_val = np.array([g in val_games for g in self.game])
        return np.nonzero(~is_val)[0], np.nonzero(is_val)[0]


def load_dataset(folder, mmap=True):
    return Dataset(folder, mmap)


def check(folder):
    ds = load_dataset(folder)
    n = len(ds)
    counts = np.diff(ds.cand_offset)
    assert ds.cand_offset[0] == 0 and ds.cand_offset[-1] == len(ds.cand), "offsets do not cover the candidates"
    assert (counts > 0).all(), "a decision with no candidates"
    assert (ds.choice >= 0).all() and (ds.choice < counts).all(), "choice outside its candidate list"
    for name in ["territory", "global", "cand", "z"]:
        assert np.isfinite(getattr(ds, name)).all(), f"{name} has NaN/inf"
    T = len(ds.info["territoryIds"])
    assert ds.territory.shape == (n, T, len(ds.info["territoryFeatures"]))
    assert ds.global_.shape == (n, len(ds.info["globalFeatures"]))
    assert ds.cand.shape[1] == len(ds.info["candidateFeatures"])
    assert ((ds.cand_from >= -1) & (ds.cand_from < T)).all() and ((ds.cand_to >= -1) & (ds.cand_to < T)).all()
    # Exactly one owner bucket per territory (seat slots, neutral, none).
    owner_cols = [i for i, f in enumerate(ds.info["territoryFeatures"]) if f.startswith("owner_")]
    assert np.allclose(ds.territory[..., owner_cols].sum(-1), 1), "owner one-hot broken"
    train, val = ds.split_by_game(0.1)
    assert len(set(ds.game[train].tolist()) & set(ds.game[val].tolist())) == 0
    print(json.dumps({
        "map": ds.info["map"], "decisions": n, "games": int(len(np.unique(ds.game))),
        "candidates": int(len(ds.cand)), "meanCandidates": round(float(counts.mean()), 1), "maxCandidates": int(counts.max()),
        "meanZ": round(float(np.asarray(ds.z).mean()), 3), "train": int(len(train)), "val": int(len(val)),
        "featureRanges": {name: [round(float(np.min(getattr(ds, name))), 3), round(float(np.max(getattr(ds, name))), 3)]
                          for name in ["territory", "global", "cand"]},
    }, indent=2))


if __name__ == "__main__":
    check(sys.argv[1])
