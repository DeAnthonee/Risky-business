"""Blitz odds of packages/engine/src/odds.ts (blitzOdds with stopAt 1) as lookup tables for the GPU teacher.

TRAINING ONLY, like the rest of this package. The teacher compares attacks by these numbers to 1e-3 (its tie-break
jitter), so they must be the engine's numbers bit for bit: the tables are filled with exactly the same
double-precision operations in exactly the same order as allIn() (Python floats are IEEE doubles), and the CUDA side
reproduces fit()'s scaling for stacks beyond MAX_ODDS_CELLS. A cell (a, d) of allIn's recurrence does not depend on
the table bounds, so one table answers every blitzOdds(a, d) inside it.

Layout ("hyperbolic"): blitzOdds only ever builds tables of at most MAX_ODDS_CELLS cells, scaling bigger battles down
in proportion (fit()). After fit(), a battle (A, D) always has (A - 0.5)(D - 0.5) <= MAX_ODDS_CELLS (the rounding
moves each side by at most a half), so row d holds a = 0 .. amax(d) = floor(MAX_ODDS_CELLS / (d - 0.5) + 0.5): about
3.6 million cells cover every battle with up to ~2 million attackers against one defender, or ~166,000 defenders.
One table per defence-dice limit (2, and 3 for capitals). balancedWin (balanced blitz) is filled by Node with
odds.ts's own arithmetic (scripts/balanced_odds.mjs), since Math.pow is V8's and not Python's.

Tables are cached under _cache/ (ignored) after the first build (about a minute of Python per table).
"""
from __future__ import annotations

import math
import os
import subprocess
from pathlib import Path

import numpy as np

from .fingerprint import REPO

MAX_ODDS_CELLS = 250_000
CACHE = Path(__file__).resolve().parent / "_cache"
BALANCED_JS = Path(__file__).resolve().parents[1] / "scripts" / "balanced_odds.mjs"


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


def amax(d: int) -> int:
    """Largest attacker count row d holds."""
    return int(math.floor(MAX_ODDS_CELLS / (d - 0.5) + 0.5))


DMAX = int(math.floor(MAX_ODDS_CELLS / 1.5 + 0.5))  # (A' >= 2) - 0.5 = 1.5


def build(defense_limit: int = 2) -> dict[str, np.ndarray]:
    """win, expected attacker losses, expected defender losses of an all-in blitz for every cell of the layout:
    flat float64 arrays, row d at off[d] .. off[d] + amax(d)."""
    tables = {(a, d): _roll_table(a, d) for a in range(1, 4) for d in range(1, defense_limit + 1)}
    am = [0] + [amax(d) for d in range(1, DMAX + 1)]  # row 0 (no defenders) is never read: keep one cell
    rows_w: list[list[float]] = [[] for _ in range(DMAX + 1)]
    rows_la: list[list[float]] = [[] for _ in range(DMAX + 1)]
    rows_ld: list[list[float]] = [[] for _ in range(DMAX + 1)]
    A = am[1]
    dmax_of = DMAX  # rows holding attacker count a: d <= dmax_of (non-increasing in a)
    for a in range(A + 1):
        while dmax_of >= 1 and am[dmax_of] < a:
            dmax_of -= 1
        ad = max(0, min(3, a - 1))
        for d in range(0, dmax_of + 1):
            if d == 0:
                if a == 0:
                    rows_w[0].append(1.0), rows_la[0].append(0.0), rows_ld[0].append(0.0)
                continue
            if ad < 1:
                rows_w[d].append(0.0), rows_la[d].append(0.0), rows_ld[d].append(0.0)
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
                if j == 0:  # d === 0 row of allIn: win 1, no losses
                    fw, fa, fd = 1.0, 0.0, 0.0
                else:
                    fw, fa, fd = rows_w[j][a - k], rows_la[j][a - k], rows_ld[j][a - k]
                w += p * fw
                l_a += p * (k + fa)
                l_d += p * (pairs - k + fd)
            rows_w[d].append(w), rows_la[d].append(l_a), rows_ld[d].append(l_d)
    lens = np.array([len(r) for r in rows_w], dtype=np.int64)
    off = np.concatenate([[0], np.cumsum(lens)[:-1]]).astype(np.int64)
    flat = lambda rows: np.fromiter((x for r in rows for x in r), dtype=np.float64, count=int(lens.sum()))  # noqa: E731
    return {"win": flat(rows_w), "la": flat(rows_la), "ld": flat(rows_ld), "off": off, "len": lens}


def balanced(win: np.ndarray, out: Path) -> np.ndarray:
    """balanced(p) of odds.ts for every win chance, computed by Node (V8's Math.pow)."""
    src = out.with_suffix(f".{os.getpid()}.win.bin")  # per process: several generate processes may build at once
    dst = out.with_suffix(f".{os.getpid()}.bwin.bin")
    win.astype("<f8").tofile(src)
    r = subprocess.run(["node", str(BALANCED_JS), str(src), str(dst)], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        raise RuntimeError(f"balanced odds failed: {r.stderr}")
    b = np.fromfile(dst, dtype="<f8")
    src.unlink()
    dst.unlink()
    if b.shape != win.shape:
        raise RuntimeError("balanced odds: wrong length")
    return b


def tables(defense_limit: int = 2) -> dict[str, np.ndarray]:
    """The layout for one defence-dice limit, with balancedWin ("bwin"); cached on disk."""
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"odds-hyper-d{defense_limit}-v2.npz"
    if f.exists():
        z = np.load(f)
        return {k: z[k] for k in z.files}
    t = build(defense_limit)
    t["bwin"] = balanced(t["win"], f)
    tmp = f.with_suffix(f".{os.getpid()}.tmp.npz")
    np.savez(tmp, **t)
    os.replace(tmp, f)  # atomic: another process never loads a half-written table
    return t
