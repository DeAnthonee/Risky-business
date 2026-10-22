"""Checks for fog_guess.py (no GPU, no data): python packages/delove/python/test_fog_guess.py [--fixture]

1. army_bin puts armies in the right bins.
2. GuessNet gives [B, T, OWNERS + BINS] and the ONNX export gives the same numbers as PyTorch (with onnxruntime).
3. The (view, truth) examples: only hidden territories are targets, their owner is never the decider, every target
   owner is allowed, and the memory columns are set only on hidden territories.

--fixture rewrites packages/delove/test/fixtures/tiny-guess.{onnx,json}, the untrained tiny guesser the TypeScript
tests load (test/fog-search.test.ts).
"""
import json
import os
import sys
import tempfile

import numpy as np
import torch

from fog import MAX_SLOTS, FogMap
from fog_guess import ARMY_BINS, BINS, FOG_GUESS_VERSION, MEMORY, OWNERS, Data, GuessNet, army_bin, export

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "test", "fixtures")
# the feature widths of the encoder (ENCODER_VERSION 2) plus the fog columns
F_TERRITORY, F_GLOBAL = 27 + 1, 95 + 1


def test_bins():
    assert list(army_bin(np.array([1, 2, 3, 4, 5, 8, 9, 16, 17, 300]))) == [0, 1, 2, 2, 3, 3, 4, 4, 5, 5]
    assert len(ARMY_BINS) == BINS


def test_export_matches():
    torch.manual_seed(0)
    net = GuessNet(F_TERRITORY, F_GLOBAL, hidden=8, rounds=1).eval()
    T = 6
    x = (torch.randn(2, T, F_TERRITORY), torch.randn(2, F_GLOBAL), (torch.rand(T, T) > 0.5).float())
    y = net(*x)
    assert y.shape == (2, T, OWNERS + BINS)
    try:
        import onnxruntime as ort
    except ImportError:  # the training venv may not have it; the TypeScript tests load the exported model anyway
        return

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "g.onnx")
        export(net, path, F_TERRITORY, F_GLOBAL)
        s = ort.InferenceSession(path)
        out = s.run(None, {"territory": x[0].numpy(), "global": x[1].numpy(), "adj": x[2].numpy()})[0]
    assert np.allclose(out, y.detach().numpy(), atol=1e-5)


def test_examples(folder):
    d = Data(folder, 200, np.random.default_rng(0))
    v = d.parts["train"]
    hidden = v["t"][:, :, d.fm.TF] == 1  # the fog column (memory columns follow it)
    owner = v["owner"]
    assert ((owner >= 0) <= hidden).all(), "a target outside the hidden territories"
    assert (owner != 0).all(), "the decider's own territory is never hidden"
    allowed = v["allowed"].gather(1, owner.clamp(min=0)) | (owner < 0)
    assert allowed.all(), "a target owner that the mask forbids"
    mem = v["t"][:, :, d.fm.TF + 1 :]
    assert mem.shape[-1] == MEMORY
    assert (mem[~hidden] == 0).all(), "memory columns on a visible territory"
    assert (mem[..., OWNERS] > 0).any(), "no hidden territory was ever seen before"


def write_fixture():
    torch.manual_seed(0)
    net = GuessNet(F_TERRITORY, F_GLOBAL, hidden=8, rounds=1).eval()
    export(net, os.path.join(FIXTURES, "tiny-guess.onnx"), F_TERRITORY, F_GLOBAL)
    with open(os.path.join(FIXTURES, "tiny-guess.json"), "w") as f:
        json.dump(dict(fogGuessVersion=FOG_GUESS_VERSION, config=net.config, owners=OWNERS, armyBins=ARMY_BINS, memory=0), f, indent=1)
    print("wrote", os.path.join(FIXTURES, "tiny-guess.onnx"))


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        write_fixture()
        sys.exit(0)
    test_bins()
    test_export_matches()
    data = os.environ.get("FOG_GUESS_DATA")  # a dataset folder (e.g. data/delove/c17-a1/classic), optional
    if data:
        test_examples(data)
    print("fog_guess ok" + ("" if data else " (set FOG_GUESS_DATA=<dataset folder> to check the examples too)"))
