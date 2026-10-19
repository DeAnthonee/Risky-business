"""Check that blitz outcomes match the dice rules in distribution, for the exact (mulberry32) and the fast sampler.

The exact distribution of a blitz from (attacker armies, defender armies) to (attacker left, defender left, dice in
the last roll) is computed by dynamic programming over every roll of the dice (engine.ts rollBattle rules: attacker
min(3, armies - 1) dice, defender min(2, armies), highest against highest, ties to the defender). Each sampler's
outcomes over many battles are compared with it by a chi-square test (bins with expected count < 5 merged).

    python tests/blitz_stats.py [--n 200000]
"""
from __future__ import annotations

import argparse
import itertools
import math
import sys
from functools import lru_cache
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.engine import Engine  # noqa: E402

PAIRS = [(2, 1), (3, 2), (4, 1), (5, 5), (10, 10), (12, 3), (30, 20), (6, 25), (60, 1), (100, 100), (150, 40)]


@lru_cache(None)
def roll_probs(ad: int, dd: int) -> dict[tuple[int, int], float]:
    """{(attacker losses, defender losses): probability} for one roll."""
    out: dict[tuple[int, int], float] = {}
    rolls = list(itertools.product(range(1, 7), repeat=ad + dd))
    for r in rolls:
        a = sorted(r[:ad], reverse=True)
        d = sorted(r[ad:], reverse=True)
        al = dl = 0
        for x, y in zip(a, d):
            if x > y:
                dl += 1
            else:
                al += 1
        out[(al, dl)] = out.get((al, dl), 0.0) + 1 / len(rolls)
    return out


def exact(fa: int, ta: int) -> dict[tuple[int, int, int], float]:
    """Final (fa, ta, last attacker dice) distribution, by DP over the battle's states."""
    dist: dict[tuple[int, int, int], float] = {}
    front = {(fa, ta, 0): 1.0}
    while front:
        nxt: dict[tuple[int, int, int], float] = {}
        for (a, d, last), p in front.items():
            if a < 2 or d == 0:
                dist[(a, d, last)] = dist.get((a, d, last), 0.0) + p
                continue
            ad, dd = min(3, a - 1), min(2, d)
            for (al, dl), q in roll_probs(ad, dd).items():
                k = (a - al, d - dl, ad)
                nxt[k] = nxt.get(k, 0.0) + p * q
        front = nxt
    return dist


def chi2(counts: dict, expected: dict, n: int) -> tuple[float, int]:
    keys = sorted(expected, key=lambda k: -expected[k])
    stat, df = 0.0, -1
    acc_o = acc_e = 0.0
    for k in keys:
        acc_o += counts.get(k, 0)
        acc_e += expected[k] * n
        if acc_e >= 5:
            stat += (acc_o - acc_e) ** 2 / acc_e
            df += 1
            acc_o = acc_e = 0.0
    if acc_e > 0:
        stat += (acc_o - acc_e) ** 2 / max(acc_e, 1e-9)
        df += 1
    missing = sum(v for k, v in counts.items() if k not in expected)
    if missing:
        stat = float("inf")
    return stat, max(df, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200_000)
    args = ap.parse_args()
    n = args.n
    worst = 0.0
    ok = True
    for exact_mode in (True, False):
        e = Engine(1, exact=exact_mode, seed=7, allow_unverified=True)
        name = "exact (mulberry32)" if exact_mode else "fast (multinomial jumps)"
        for fa0, ta0 in PAIRS:
            fa = torch.full((n,), fa0, device=e.dev)
            ta = torch.full((n,), ta0, device=e.dev)
            s = torch.randint(0, 2**32, (n,), device=e.dev, dtype=torch.long)
            f = e._blitz if exact_mode else e._blitz_fast
            ra, rt, _, last = f(fa, ta, s)
            keys = (ra * 1000 + rt) * 10 + last
            u, c = torch.unique(keys, return_counts=True)
            counts = {(int(k) // 10000, (int(k) // 10) % 1000, int(k) % 10): int(v) for k, v in zip(u.tolist(), c.tolist())}
            exp = exact(fa0, ta0)
            stat, df = chi2(counts, exp, n)
            z = (stat - df) / math.sqrt(2 * df)
            worst = max(worst, abs(z))
            win = sum(v for k, v in counts.items() if k[1] == 0) / n
            ewin = sum(v for k, v in exp.items() if k[1] == 0)
            flag = "ok" if abs(z) < 4 else "MISMATCH"
            ok &= abs(z) < 4
            print(f"{name:26s} {fa0:4d} vs {ta0:3d}: conquest {win:.4f} (exact {ewin:.4f}), chi2 {stat:8.1f} on {df:3d} df, z {z:+5.2f} {flag}")
    print("PASS" if ok else "FAIL", f"(worst |z| {worst:.2f}, {n} battles per pair)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
