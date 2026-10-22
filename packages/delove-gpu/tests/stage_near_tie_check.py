"""stage_check.py's ranker near-tie rule on small made-up datasets (CPU only, no network: the ranker's logits are stubbed).

A choice that differs on a near-tie in one game of a case is a note; two such games in one case fail (--max-flips-case
1); a near-tie share above --max-flips-share of the run fails; a gap above --near-tie fails; a board that differs fails.

    python tests/stage_near_tie_check.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from tests.dataset_compare import game_hashes  # noqa: E402
from tests.stage_check import NearTie, compare_datasets, over_share  # noqa: E402

GAMES, ROWS, CANDS, T = 6, 4, 3, 5


def write(d: Path) -> None:
    """A dataset of GAMES games, ROWS rows each, CANDS candidates per row; every row differs from every other."""
    n = GAMES * ROWS
    rng = np.random.default_rng(1)
    d.mkdir(parents=True)
    np.save(d / "territory.npy", rng.random((n, T, 4), dtype=np.float32))
    np.save(d / "global.npy", rng.random((n, 6), dtype=np.float32))
    np.save(d / "cand.npy", rng.random((n * CANDS, 13), dtype=np.float32))
    np.save(d / "cand_from.npy", np.zeros(n * CANDS, dtype=np.int32))
    np.save(d / "cand_to.npy", np.ones(n * CANDS, dtype=np.int32))
    np.save(d / "cand_offset.npy", np.arange(n + 1, dtype=np.int64) * CANDS)
    np.save(d / "choice.npy", np.zeros(n, dtype=np.int32))
    np.save(d / "z.npy", np.ones(n, dtype=np.float32))
    np.save(d / "game.npy", np.repeat(np.arange(GAMES, dtype=np.int32), ROWS))
    np.save(d / "seat.npy", np.zeros(n, dtype=np.int32))
    np.save(d / "points.npy", np.ones(n, dtype=np.float32))


def plant(d: Path, games: list[int], board: bool = False) -> None:
    """Change the choice (or the board) in the last row of each of `games`."""
    for name in ("territory",) if board else ("choice",):
        a = np.load(d / f"{name}.npy")
        for g in games:
            k = g * ROWS + ROWS - 1
            if board:
                a[k, 0, 0] += 1
            else:
                a[k] = 1
        np.save(d / f"{name}.npy", a)


class Stub(NearTie):
    def __init__(self, gap: float):
        super().__init__(Path("."), "stub", 2, 1e-4)
        self.gap = gap

    def logits(self, ds, k, map_id):
        return [1.0, 1.0 - self.gap, -5.0]


def case(root: Path, games: list[int], gap: float = 1e-6, board: bool = False, max_case: int = 1):
    shutil.rmtree(root, ignore_errors=True)
    write(root / "cpu" / "m")
    write(root / "gpu" / "m")
    plant(root / "gpu" / "m", games, board)
    bad: list[str] = []
    rows, notes, flips = compare_datasets(root / "cpu", root / "gpu", ["m"], Stub(gap), max_case, bad)
    return bad, notes, flips


def main() -> int:
    ok, n, good = True, 0, 0

    def expect(what: str, cond: bool) -> None:
        nonlocal ok, n, good
        print(f"{'ok ' if cond else 'BAD'} {what}")
        ok, n, good = ok and cond, n + 1, good + bool(cond)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "same")
        expect("game hashes of a written dataset are stable", game_hashes(root / "same") == game_hashes(root / "same"))
        bad, notes, flips = case(root / "c0", [])
        expect("identical datasets: no failure, no flip", not bad and not notes and flips == 0)
        bad, notes, flips = case(root / "c1", [2])
        expect("one near-tie flip in a case: a note, not a failure", not bad and flips == 1 and "near-tie" in notes[0] and "smallest gap" in notes[0])
        bad, notes, flips = case(root / "c2", [1, 4])
        expect("two near-tie flips in one case: fails (--max-flips-case 1)", flips == 2 and any("--max-flips-case" in b for b in bad))
        bad, notes, flips = case(root / "c3", [1, 4], max_case=2)
        expect("two flips with --max-flips-case 2: a note each", not bad and flips == 2)
        bad, notes, flips = case(root / "c4", [3], gap=0.5)
        expect("a gap above --near-tie: fails", bool(bad) and flips == 0 and any("smallest gap" in b for b in bad))
        bad, notes, flips = case(root / "c5", [3], board=True)
        expect("a board that differs: fails, naming the field", bool(bad) and any("territory differ" in b for b in bad))
        bad = ["game 0: winner/turns cpu 1/20 gpu 2/20"]
        write(root / "c6" / "cpu" / "m")
        write(root / "c6" / "gpu" / "m")
        plant(root / "c6" / "gpu" / "m", [2])
        compare_datasets(root / "c6" / "cpu", root / "c6" / "gpu", ["m"], Stub(1e-6), 1, bad)
        expect("a game that ended differently: no near-tie, fails", any("datasets differ" in b for b in bad))
    expect("run share: 6 flips in 324 games pass at 2%", over_share(6, 324, 0.02) is None)
    expect("run share: 7 flips in 324 games fail at 2%", over_share(7, 324, 0.02) is not None)
    print(f"stage near-tie rule: {good} of {n} cases as expected" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
