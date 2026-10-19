"""Blitz odds of packages/engine/src/odds.ts (blitzOdds with stopAt 1, ordinary dice) as lookup tables for the GPU
teacher.

TRAINING ONLY, like the rest of this package. The teacher compares attacks by these numbers to 1e-3 (its tie-break
jitter), so they must be the engine's numbers bit for bit: the tables are filled with exactly the same
double-precision operations in exactly the same order as allIn() (Python floats are IEEE doubles), and the CUDA side
reproduces fit()'s scaling for stacks beyond MAX_ODDS_CELLS. A cell (a, d) of allIn's recurrence does not depend on
the table bounds, so one table answers every blitzOdds(a, d) inside it.

Tables are cached under _cache/ (ignored) after the first build (a few seconds of Python).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

MAX_ODDS_CELLS = 250_000
CACHE = Path(__file__).resolve().parent / "_cache"


def _roll_table(a: int, d: int) -> list[float]:
    pairs = min(a, d)
    counts = [0] * (pairs + 1)
    total = 6 ** (a + d)
    for n in range(total):
        x = n
        ad, dd = [], []
        for _ in range(a):
            ad.append(x % 6 + 1)
            x //= 6
        for _ in range(d):
            dd.append(x % 6 + 1)
            x //= 6
        ad.sort(reverse=True)
        dd.sort(reverse=True)
        counts[sum(1 for i in range(pairs) if ad[i] <= dd[i])] += 1
    return [c / total for c in counts]


def build(amax: int, dmax: int, defense_limit: int = 2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """win, expected attacker losses, expected defender losses of an all-in blitz, [amax + 1, dmax + 1] float64."""
    tables = {(a, d): _roll_table(a, d) for a in range(1, 4) for d in range(1, defense_limit + 1)}
    win = np.zeros((amax + 1, dmax + 1))
    la = np.zeros((amax + 1, dmax + 1))
    ld = np.zeros((amax + 1, dmax + 1))
    for a in range(amax + 1):
        wr, lar, ldr = [0.0] * (dmax + 1), [0.0] * (dmax + 1), [0.0] * (dmax + 1)
        ad = max(0, min(3, a - 1, a - 1))
        prev = [None, win[a - 1] if a >= 1 else None, win[a - 2] if a >= 2 else None, win[a - 3] if a >= 3 else None]
        prev_la = [None, la[a - 1] if a >= 1 else None, la[a - 2] if a >= 2 else None, la[a - 3] if a >= 3 else None]
        prev_ld = [None, ld[a - 1] if a >= 1 else None, ld[a - 2] if a >= 2 else None, ld[a - 3] if a >= 3 else None]
        for d in range(dmax + 1):
            if d == 0:
                wr[0], lar[0], ldr[0] = 1.0, 0.0, 0.0
                continue
            if ad < 1:
                continue
            table = tables[(ad, min(defense_limit, d))]
            pairs = len(table) - 1
            w = 0.0
            l_a = 0.0
            l_d = 0.0
            for k in range(pairs + 1):
                p = table[k]
                if p == 0:
                    continue
                j = d - (pairs - k)
                if k == 0:
                    fw, fa, fd = wr[j], lar[j], ldr[j]
                else:
                    fw, fa, fd = float(prev[k][j]), float(prev_la[k][j]), float(prev_ld[k][j])
                w += p * fw
                l_a += p * (k + fa)
                l_d += p * (pairs - k + fd)
            wr[d], lar[d], ldr[d] = w, l_a, l_d
        win[a], la[a], ld[a] = wr, lar, ldr
    return win, la, ld


def tables(amax: int = 1000, dmax: int = 1000) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"odds-{amax}x{dmax}-v1.npz"
    if f.exists():
        z = np.load(f)
        return z["win"], z["la"], z["ld"]
    win, la, ld = build(amax, dmax)
    np.savez(f, win=win, la=la, ld=ld)
    return win, la, ld
