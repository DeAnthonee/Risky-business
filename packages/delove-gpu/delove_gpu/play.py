"""Move choosers for the GPU engine: uniform random legal moves, and a Delove network (PyTorch weights)."""
from __future__ import annotations

import sys
from pathlib import Path

import torch

from .encode import F_CAND, F_GLOBAL, F_TERRITORY, Encoder
from .engine import Engine

DELOVE_PYTHON = Path(__file__).resolve().parents[2] / "delove" / "python"


def random_moves(mask: torch.Tensor, gen: torch.Generator | None = None) -> torch.Tensor:
    """One uniformly random legal move per game (0 for games with none; the engine ignores finished games)."""
    r = torch.rand(mask.shape, device=mask.device, generator=gen)
    return torch.where(mask, r, -1.0).argmax(1)


def load_delove(path: str | Path, device) -> torch.nn.Module:
    """A Delove checkpoint written by train.py (dict(config=..., state=...)) on the network in delove_model.py."""
    if str(DELOVE_PYTHON) not in sys.path:
        sys.path.insert(0, str(DELOVE_PYTHON))
    from delove_model import DeloveNet

    ck = torch.load(path, map_location=device, weights_only=False)
    cfg = ck["config"]
    fog = (cfg["f_territory"], cfg["f_global"], cfg["f_cand"]) == (F_TERRITORY + FOG_TERRITORY, F_GLOBAL + FOG_GLOBAL, F_CAND)
    if not fog and (cfg["f_territory"], cfg["f_global"], cfg["f_cand"]) != (F_TERRITORY, F_GLOBAL, F_CAND):
        raise ValueError(f"{path}: network expects features {cfg}, the encoder makes {F_TERRITORY}/{F_GLOBAL}/{F_CAND}"
                         f" (or {F_TERRITORY + FOG_TERRITORY}/{F_GLOBAL + FOG_GLOBAL}/{F_CAND} with fog inputs)")
    net = DeloveNet(**cfg).to(device)
    net.load_state_dict(ck["state"])
    net.eval()
    return FogInputs(net).eval() if fog else net


# fog inputs (packages/selfplay/src/fog.ts FOG_TERRITORY_FEATURES / FOG_GLOBAL_FEATURES, FOG_INPUT_VERSION 1): one
# column appended to each territory (hidden) and one to the globals (hidden_share)
FOG_TERRITORY, FOG_GLOBAL = 1, 1


class FogInputs(torch.nn.Module):
    """A network trained with fog inputs (train.py --fog-dropout; "fogInputs" in its .json), fed the mirror's full-board
    features. The GPU plays without fog, so every position is a full board, and fog.ts fogInputs(f, map, fogged=false)
    gives exactly the full-board features with the fog columns at 0 (net-agent.ts feeds a fog model that on the CPU).
    So the fog columns are appended here as zeros."""

    def __init__(self, net: torch.nn.Module):
        super().__init__()
        self.net = net
        self.config = net.config

    def forward(self, territory, glob, *args, **kw):
        t = torch.cat([territory, territory.new_zeros(*territory.shape[:-1], FOG_TERRITORY)], -1)
        g = torch.cat([glob, glob.new_zeros(*glob.shape[:-1], FOG_GLOBAL)], -1)
        return self.net(t, g, *args, **kw)


class NetPlayer:
    """Scores every legal move of every game with one batched forward pass and plays the top one (temperature 0,
    as delove@N plays) or samples softmax(logits / temperature) (delove@N-explore).

    precision: "fp32" (as trained; the same top move as the ONNX model in Node, see tests/replay.py --net),
    "tf32" (fp32 with tensor-core matmuls) or "fp16" (half-precision weights, about twice as fast; near-ties can
    flip: about 2% of top moves differ from fp32 on Classic 2-player positions)."""

    def __init__(self, engine: Engine, net: torch.nn.Module, temperature: float = 0.0, precision: str = "fp32"):
        if precision not in ("fp32", "tf32", "fp16"):
            raise ValueError(f"precision {precision!r}")
        self.e = engine
        self.precision = precision
        self.dtype = torch.float16 if precision == "fp16" else torch.float32
        self.net = net.half() if precision == "fp16" else net
        self.enc = Encoder(engine)
        self.temperature = temperature
        self.adj = engine.m.adj_matrix.to(self.dtype)

    @torch.inference_mode()
    def logits(self, mask: torch.Tensor) -> torch.Tensor:
        """[B, A] logits, -inf where illegal."""
        terr, glob = self.enc.encode()
        b, a = mask.nonzero(as_tuple=True)
        cand, cf, ct = self.enc.candidates(b, a)
        tf32 = torch.backends.cuda.matmul.allow_tf32
        torch.backends.cuda.matmul.allow_tf32 = self.precision == "tf32"
        try:
            d = self.dtype
            lg, _ = self.net(terr.to(d), glob.to(d), self.adj, cand.to(d), cf, ct, b)
        finally:
            torch.backends.cuda.matmul.allow_tf32 = tf32
        out = torch.full(mask.shape, float("-inf"), device=mask.device)
        out[b, a] = lg.float()
        return out

    def __call__(self, mask: torch.Tensor) -> torch.Tensor:
        lg = self.logits(mask)
        if self.temperature <= 0:
            return lg.argmax(1)
        gumbel = -torch.log(-torch.log(torch.rand_like(lg).clamp(1e-20, 1.0)))
        return (lg / self.temperature + gumbel).argmax(1)
