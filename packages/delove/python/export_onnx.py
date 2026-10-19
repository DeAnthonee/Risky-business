"""Export a trained Delove version to ONNX for live play in Node (packages/delove/src/net-agent.ts).

    .venv/Scripts/python packages/delove/python/export_onnx.py models/delove/delove@1

Reads <path>.pt, writes <path>.onnx. One decision per call:
  inputs  territory [1, T, F_t], global [1, F_g], adj [T, T], cand [C, F_c], cand_from [C] int64, cand_to [C] int64
  outputs logits [C], value [1]
T (map size) and C (candidates) are dynamic, so the same file plays every map.
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


if __name__ == "__main__":
    main()
