"""Checks for fog.py (no GPU): python packages/delove/python/test_fog.py

1. fog.py against fog.ts, bit for bit: packages/delove/scripts/fog-fixture.mjs (needs `npm run build`) dumps decisions
   from built-in bot games on five maps and settings with their full-board features and fog.ts's seat view; fog.py must
   rebuild the seat view from the full-board features exactly.
2. A decision that is not fogged keeps its features, with the fog columns at 0.
3. widen_state: a network widened for the fog inputs gives the same outputs on decisions whose fog columns are 0.
"""
import json
import os
import subprocess
import sys

import numpy as np
import torch

from delove_model import DeloveNet
from fog import FogMap, fog_inputs, widen_state

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")


def fixture():
    r = subprocess.run(["node", "packages/delove/scripts/fog-fixture.mjs"], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        sys.exit(f"fog-fixture.mjs failed (npm run build first?): {r.stderr[-2000:]}")
    return json.loads(r.stdout)


def test_matches_fog_ts(fx):
    TF, GF = len(fx["territoryFeatures"]), len(fx["globalFeatures"])
    checked = hidden = 0
    for map_id, m in fx["maps"].items():
        info = dict(m, territoryFeatures=fx["territoryFeatures"], globalFeatures=fx["globalFeatures"])
        fm = FogMap(info)
        rows = [r for r in fx["rows"] if r["map"] == map_id]
        T = len(m["territoryIds"])
        terr = np.array([r["territory"] for r in rows], dtype=np.float32).reshape(-1, T, TF)
        glob = np.array([r["global"] for r in rows], dtype=np.float32)
        want_t = np.array([r["fogTerritory"] for r in rows], dtype=np.float32).reshape(-1, T, TF + 1)
        want_g = np.array([r["fogGlobal"] for r in rows], dtype=np.float32)
        got_t, got_g = fog_inputs(terr, glob, np.ones(len(rows), dtype=bool), fm)
        bad_t = np.argwhere(got_t != want_t)
        bad_g = np.argwhere(got_g != want_g)
        assert len(bad_t) == 0, f"{map_id}: territory features differ at {bad_t[:5].tolist()} (feature {[(fx['territoryFeatures'] + ['hidden'])[i[2]] for i in bad_t[:5]]})"
        assert len(bad_g) == 0, f"{map_id}: global features differ at {bad_g[:5].tolist()} ({[(fx['globalFeatures'] + ['hidden_share'])[i[1]] for i in bad_g[:5]]})"
        checked += len(rows)
        hidden += int((want_g[:, -1] > 0).sum())
    assert hidden > checked // 4, f"only {hidden} of {checked} decisions had anything hidden"
    print(f"fog.py = fog.ts on {checked} decisions over {len(fx['maps'])} maps ({hidden} with hidden territory): bit-identical")


def test_not_fogged(fx):
    m = next(iter(fx["maps"].values()))
    fm = FogMap(dict(m, territoryFeatures=fx["territoryFeatures"], globalFeatures=fx["globalFeatures"]))
    rows = [r for r in fx["rows"] if r["map"] == m["map"]][:20]
    T, TF = len(m["territoryIds"]), len(fx["territoryFeatures"])
    terr = np.array([r["territory"] for r in rows], dtype=np.float32).reshape(-1, T, TF)
    glob = np.array([r["global"] for r in rows], dtype=np.float32)
    t, g = fog_inputs(terr, glob, np.zeros(len(rows), dtype=bool), fm)
    assert np.array_equal(t[:, :, :TF], terr) and not t[:, :, TF:].any()
    assert np.array_equal(g[:, :-1], glob) and not g[:, -1].any()
    print("not fogged: features unchanged, fog columns 0")


def test_widen():
    torch.manual_seed(0)
    net = DeloveNet(27, 94, 13, hidden=32, rounds=2).eval()
    wide = DeloveNet(28, 95, 13, hidden=32, rounds=2).eval()
    wide.load_state_dict(widen_state(net.state_dict(), 28, 95))
    T, M = 6, 9
    terr, glob = torch.randn(2, T, 27), torch.randn(2, 94)
    adj = (torch.rand(T, T) > 0.5).float()
    cand = torch.randn(M, 13)
    cf, ct = torch.randint(-1, T, (M,)), torch.randint(-1, T, (M,))
    cb = torch.tensor([0] * 4 + [1] * 5)
    with torch.no_grad():
        a = net(terr, glob, adj, cand, cf, ct, cb)
        b = wide(torch.cat([terr, torch.zeros(2, T, 1)], -1), torch.cat([glob, torch.zeros(2, 1)], -1), adj, cand, cf, ct, cb)
    assert all(torch.equal(x, y) for x, y in zip(a, b))
    print("widened network: identical outputs with the fog columns at 0")


if __name__ == "__main__":
    fx = fixture()
    test_matches_fog_ts(fx)
    test_not_fogged(fx)
    test_widen()
    print("ok")
