"""Label confidence (train.py --confidence TAU[,FLOOR]): how clearly branch and score preferred its pick.

At a branched decision branch_q.npy holds each compared option's mean rollout score (NaN for candidates not compared).
The gap between the best and the second-best compared score says how much the label is worth: measured on cycle 18's
teacher (the architecture review, 2026-10-22), the teacher picks the same move under fresh rollout seeds only about half
the time, and 59% of its decisions have the top two within 0.01. A near-tie label is mostly rollout noise, so its policy
weight is scaled by clip(gap / TAU, FLOOR, 1). Decisions with fewer than two compared options (the teacher's own move,
no search) keep weight 1. NumPy only; works on memory-mapped arrays in chunks.
"""
from __future__ import annotations

import numpy as np


def decision_gaps(q: np.ndarray, offset: np.ndarray, chunk: int = 1 << 20) -> np.ndarray:
    """Per decision, the best minus the second-best finite score among its candidate rows offset[k]..offset[k+1]
    (float32); NaN where fewer than two candidates have a score."""
    n = len(offset) - 1
    out = np.full(n, np.nan, dtype=np.float32)
    for d0 in range(0, n, chunk):
        d1 = min(n, d0 + chunk)
        r0, r1 = int(offset[d0]), int(offset[d1])
        if r1 == r0:
            continue
        v = np.asarray(q[r0:r1], dtype=np.float64)
        counts = np.diff(np.asarray(offset[d0 : d1 + 1], dtype=np.int64))
        seg = np.repeat(np.arange(d1 - d0), counts)
        finite = np.isfinite(v)
        nfin = np.bincount(seg[finite], minlength=d1 - d0)
        w = np.where(finite, v, -np.inf)
        best = np.full(d1 - d0, -np.inf)
        np.maximum.at(best, seg, w)
        # the second best: drop one row that holds the best (the first one), then the max again
        is_best = finite & (w == best[seg])
        first = np.zeros_like(is_best)
        idx = np.flatnonzero(is_best)
        if len(idx):
            _, keep = np.unique(seg[idx], return_index=True)
            first[idx[keep]] = True
        w2 = np.where(first, -np.inf, w)
        second = np.full(d1 - d0, -np.inf)
        np.maximum.at(second, seg, w2)
        with np.errstate(invalid="ignore"):
            gap = np.where(nfin >= 2, best - second, np.nan)
        out[d0:d1] = gap.astype(np.float32)
    return out


def confidence_weights(gaps: np.ndarray, tau: float, floor: float = 0.0) -> np.ndarray:
    """clip(gap / tau, floor, 1); 1 where the gap is NaN (no search to judge)."""
    if tau <= 0:
        raise ValueError("--confidence: TAU must be > 0")
    if not 0 <= floor <= 1:
        raise ValueError("--confidence: FLOOR must be in [0, 1]")
    w = np.clip(np.nan_to_num(gaps, nan=np.inf) / tau, floor, 1.0)
    return w.astype(np.float32)
