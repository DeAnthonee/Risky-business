"""Checks for targets.py (numpy only, no GPU): python packages/delove/python/test_targets.py"""
import json
import os
import tempfile
from types import SimpleNamespace

import numpy as np

from targets import RANGES, alive_counts, last_decision, next_decision, placement_points, range_target, threat_deflection

S = 10
TF = [f"owner_slot{i}" for i in range(S)] + ["owner_neutral", "owner_none", "armies_log"]
GF = [f"slot{i}_{k}" for i in range(S) for k in ("present", "alive", "territory_share", "army_share")]


def position(owners, armies, alive, strength):
    """One encoded decision on a 4-territory line map: owners/armies per territory (slot numbers), alive slots,
    strength per slot (army share; territory share 0)."""
    terr = np.zeros((4, len(TF)), dtype=np.float32)
    for t, (o, a) in enumerate(zip(owners, armies)):
        terr[t, o] = 1
        terr[t, TF.index("armies_log")] = np.log1p(a) / 5
    glob = np.zeros(len(GF), dtype=np.float32)
    for s in range(len(strength)):
        glob[GF.index(f"slot{s}_present")] = 1
        glob[GF.index(f"slot{s}_alive")] = 1 if s in alive else 0
        glob[GF.index(f"slot{s}_army_share")] = strength[s]
    return terr, glob


def dataset(rows, arrays):
    folder = tempfile.mkdtemp()
    for k, v in arrays.items():
        np.save(os.path.join(folder, k + ".npy"), np.asarray(v))
    info = dict(territoryFeatures=TF, globalFeatures=GF, territoryIds=["a", "b", "c", "d"], adjacency=[[1], [0, 2], [1, 3], [2]])
    with open(os.path.join(folder, "features.json"), "w") as f:
        json.dump(info, f)
    adj = np.zeros((4, 4), dtype=np.float32)
    for i, ns in enumerate(info["adjacency"]):
        adj[i, ns] = 1
    territory = np.stack([r[0] for r in rows])
    glob = np.stack([r[1] for r in rows])
    return SimpleNamespace(name=folder, info=info, territory=territory, glob=glob, adj=adj, game=np.asarray(arrays["game"]),
                           z=np.asarray(arrays["z"], dtype=np.float32), alive=alive_counts(glob, GF))


def test_placement_points():
    # ranking.ts: six seats +3 +2 +1 -1 -2 -3; three seats +1 0 -1; two seats +1 -1
    assert placement_points(np.arange(1, 7), 6).tolist() == [3, 2, 1, -1, -2, -3]
    assert placement_points(np.arange(1, 4), 3).tolist() == [1, 0, -1]
    assert placement_points(np.arange(1, 3), 2).tolist() == [1, -1]


def test_next_decision():
    game = np.array([0, 1, 0, 0, 1, 0])
    seat = np.array([0, 0, 1, 0, 0, 0])
    assert next_decision(game, seat).tolist() == [3, 4, -1, 5, -1, -1]
    assert last_decision(game, seat).tolist() == [5, 4, 2, 5, 4, 5]


def test_threat_deflection():
    # Line a-b-c-d: me on a, the strong rival (slot 1) on b (10 armies) and d (5), the third player (slot 2) on c.
    # b faces me and the third player, d only the third: 10 on me, 15 on the third -> 0.6.
    rows = [position([0, 1, 2, 1], [3, 10, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.6, 0.2]),
            # the third player (slot 2) is stronger now, so it is the rival measured: c faces only slot 1 -> 0 on me
            position([0, 1, 2, 1], [3, 10, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.3, 0.5]),
            # the strong rival (on c and d) borders only a neutral (b): 0.5
            position([0, 10, 1, 1], [3, 3, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.6, 0.2])]
    d = dataset(rows, dict(game=[0, 0, 0], seat=[0, 0, 0], z=[0, 0, 0]))
    got = threat_deflection(d, np.arange(3)).tolist()
    assert np.allclose(got, [0.6, 1.0, 0.5]), got


def test_targets_differ():
    """Same decisions, three objectives: the 6-player games where the decider took 2nd with no kills, 3rd with two
    kills, and won."""
    pos = position([0, 1, 2, 1], [3, 10, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.6, 0.2, 0, 0, 0])
    duel = position([0, 1, 1, 1], [3, 10, 4, 5], alive={0, 1}, strength=[0.2, 0.6, 0, 0, 0, 0])
    rows = [duel, pos, pos, pos]  # the runner-up's last decision saw 2 alive, the 3rd place's saw 3
    lo, hi = -3, 3 + 5
    points = np.array([2, 2, 3, 8], dtype=np.float32)  # 2nd no kills, 3rd (+1) with 1 kill, 1st, 1st with 5 kills
    placement = np.array([2, 3, 1, 1], dtype=np.int32)
    arrays = dict(game=[0, 1, 2, 3], seat=[0, 0, 0, 0], z=[0, 0, 1, 1], points=points, points01=(points - lo) / (hi - lo),
                  placement=placement)
    d = dataset(rows, arrays)
    long, name, _ = range_target(d, "points")
    assert name == "points" and np.allclose(long, (points - lo) / (hi - lo))
    mid, name, note = range_target(d, "top2")
    assert name == "top2" and note == "" and mid.tolist() == [1, 0, 1, 1]
    close, name, _ = range_target(d, "win")
    assert close.tolist() == [0, 0, 1, 1]
    # Without placement.npy a loser's place is estimated from the players alive at its last decision.
    os.remove(os.path.join(d.name, "placement.npy"))
    approx, _, note = range_target(d, "top2")
    assert approx.tolist() == [1, 0, 1, 1] and "estimated" in note
    # Without seat.npy either, from points: the 3rd place with a kill reaches 2nd place's points and counts.
    os.remove(os.path.join(d.name, "seat.npy"))
    approx, _, note = range_target(d, "top2")
    assert approx.tolist() == [1, 1, 1, 1] and "approximate" in note


def test_turn_limit_and_mid_credit():
    # A turn-limit game: everyone gets last place's points (points01 0), so top2 is 0 even for placement 1-2.
    a = position([0, 1, 2, 1], [3, 10, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.6, 0.2])
    b = position([0, 1, 2, 2], [3, 10, 4, 5], alive={0, 1, 2}, strength=[0.2, 0.6, 0.2])  # 10 on me, 10 on the third: 0.5
    two = position([0, 1, 1, 1], [3, 10, 4, 5], alive={0, 1}, strength=[0.2, 0.8, 0])
    rows = [a, b, two, a]
    arrays = dict(game=[0, 0, 0, 1], seat=[0, 0, 0, 0], z=[0, 0, 0, 0.5], points=[0, 0, 0, -1], points01=[0.4, 0.4, 0.4, 0],
                  placement=[2, 2, 2, 1])
    d = dataset(rows, arrays)
    top2, _, _ = range_target(d, "top2")
    assert top2.tolist() == [1, 1, 1, 0]
    mixed, _, note = range_target(d, "top2", threat=0.5)
    # row 0 -> its next position (row 1) deflects 0.5; row 1 -> a rival fell (row 2 has 2 alive): 1; row 2 is not a
    # 3-alive decision; row 3 is the seat's last decision: its top2 (0).
    assert np.allclose(mixed, [0.75, 1.0, 1.0, 0.0]), mixed
    assert "threat credit" in note


def test_presets():
    assert RANGES["long"]["alive"] == "4-10" and RANGES["mid"]["alive"] == "3-3" and RANGES["close"]["alive"] == "2-2"
    assert {r["value_target"] for r in RANGES.values()} == {"points", "top2", "win"}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
