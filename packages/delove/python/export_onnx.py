"""Export a trained Delove version to ONNX for live play in Node (packages/delove/src/net-agent.ts).

    .venv/Scripts/python packages/delove/python/export_onnx.py models/delove/delove@1

Reads <path>.pt, writes <path>.onnx (one decision per call) and <path>.value.onnx (the value head alone, batched,
for the lookahead in src/search.ts).
<path>.onnx:
  inputs  territory [1, T, F_t], global [1, F_g], adj [T, T], cand [C, F_c], cand_from [C] int64, cand_to [C] int64
  outputs logits [C], value [1]
<path>.value.onnx:
  inputs  territory [B, T, F_t], global [B, F_g], adj [T, T]   outputs value [B]
T (map size), C (candidates) and B (positions) are dynamic, so the same files play every map.
"""
import sys

import torch

from delove_model import DeloveNet


class OneDecision(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, territory, glob, adj, cand, cand_from, cand_to):
        return self.net(territory, glob, adj, cand, cand_from, cand_to, torch.zeros_like(cand_from))


class Values(torch.nn.Module):
    """The value head alone for B positions (one dummy candidate keeps the policy branch's shapes valid)."""

    def __init__(self, net, f_cand):
        super().__init__()
        self.net = net
        self.f_cand = f_cand

    def forward(self, territory, glob, adj):
        cand = torch.zeros(1, self.f_cand, dtype=territory.dtype)
        none = torch.full((1,), -1, dtype=torch.int64)
        _, value = self.net(territory, glob, adj, cand, none, none, torch.zeros(1, dtype=torch.int64))
        return value


def main():
    path = sys.argv[1]
    ck = torch.load(path + ".pt", map_location="cpu")
    net = DeloveNet(**ck["config"])
    net.load_state_dict(ck["state"])
    net.eval()
    cfg = ck["config"]
    T, C = 42, 7
    example = (
        torch.zeros(1, T, cfg["f_territory"]),
        torch.zeros(1, cfg["f_global"]),
        torch.ones(T, T),
        torch.zeros(C, cfg["f_cand"]),
        torch.full((C,), -1, dtype=torch.int64),
        torch.zeros(C, dtype=torch.int64),
    )
    torch.onnx.export(
        OneDecision(net),
        example,
        path + ".onnx",
        input_names=["territory", "global", "adj", "cand", "cand_from", "cand_to"],
        output_names=["logits", "value"],
        dynamic_axes={"territory": {1: "T"}, "adj": {0: "T", 1: "T"}, "cand": {0: "C"}, "cand_from": {0: "C"}, "cand_to": {0: "C"}, "logits": {0: "C"}},
        opset_version=17,
        dynamo=False,
    )
    print("wrote", path + ".onnx")
    torch.onnx.export(
        Values(net, cfg["f_cand"]),
        (torch.zeros(2, T, cfg["f_territory"]), torch.zeros(2, cfg["f_global"]), torch.ones(T, T)),
        path + ".value.onnx",
        input_names=["territory", "global", "adj"],
        output_names=["value"],
        dynamic_axes={"territory": {0: "B", 1: "T"}, "global": {0: "B"}, "adj": {0: "T", 1: "T"}, "value": {0: "B"}},
        opset_version=17,
        dynamo=False,
    )
    print("wrote", path + ".value.onnx")


if __name__ == "__main__":
    main()
