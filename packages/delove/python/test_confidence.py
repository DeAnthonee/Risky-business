"""Checks for confidence.py (CPU, no data): python packages/delove/python/test_confidence.py"""
import math

import numpy as np

from confidence import confidence_weights, decision_gaps

NAN = float("nan")


def test_gaps():
    # 4 decisions: compared 3 options; one compared option (no gap); none compared; a tie at the top
    q = np.array([0.50, 0.53, NAN, 0.40, 0.7, NAN, NAN, NAN, 0.6, 0.6, 0.1], dtype=np.float32)
    offset = np.array([0, 4, 6, 8, 11])
    g = decision_gaps(q, offset)
    assert math.isclose(g[0], 0.03, abs_tol=1e-6)
    assert math.isnan(g[1]) and math.isnan(g[2])
    assert g[3] == 0.0


def test_chunks_match():
    rng = np.random.default_rng(1)
    counts = rng.integers(1, 7, size=500)
    offset = np.concatenate([[0], np.cumsum(counts)])
    q = rng.random(offset[-1]).astype(np.float32)
    q[rng.random(len(q)) < 0.4] = np.nan
    assert np.allclose(decision_gaps(q, offset), decision_gaps(q, offset, chunk=7), equal_nan=True)
    # against a plain loop
    for k in range(len(counts)):
        v = q[offset[k] : offset[k + 1]]
        v = np.sort(v[np.isfinite(v)])[::-1]
        want = v[0] - v[1] if len(v) >= 2 else np.nan
        got = decision_gaps(q, offset)[k]
        assert (math.isnan(want) and math.isnan(got)) or math.isclose(got, want, abs_tol=1e-6)


def test_weights():
    w = confidence_weights(np.array([NAN, 0.0, 0.005, 0.02, 0.5], dtype=np.float32), tau=0.01, floor=0.1)
    assert np.allclose(w, [1.0, 0.1, 0.5, 1.0, 1.0])
    for bad in ((0.0, 0.0), (0.01, 1.5)):
        try:
            confidence_weights(np.zeros(1), *bad)
            raise AssertionError("no error")
        except ValueError:
            pass


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
