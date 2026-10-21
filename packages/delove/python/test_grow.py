"""Checks for --grow-rounds (network surgery; CPU, no data): python packages/delove/python/test_grow.py"""
import torch

from delove_model import DeloveNet, grow_rounds


def inputs(n=3, T=5, ft=4, fg=6, fc=3, per=2):
    torch.manual_seed(0)
    M = n * per
    return (torch.randn(n, T, ft), torch.randn(n, fg), torch.ones(T, T), torch.randn(M, fc),
            torch.full((M,), -1), torch.full((M,), -1), torch.arange(n).repeat_interleave(per))


def test_grown_network_plays_exactly_like_the_original():
    torch.manual_seed(1)
    small = DeloveNet(4, 6, 3, hidden=8, rounds=2).eval()
    big = DeloveNet(4, 6, 3, hidden=8, rounds=4).eval()
    missing, unexpected = big.load_state_dict(small.state_dict(), strict=False)
    assert not unexpected and all(k.startswith("blocks.2.") or k.startswith("blocks.3.") for k in missing)
    grow_rounds(big, 2)
    a, b = small(*inputs()), big(*inputs())
    assert torch.equal(a[0], b[0]) and torch.equal(a[1], b[1])
    assert big.config["rounds"] == 4


def test_new_rounds_learn():
    torch.manual_seed(1)
    big = DeloveNet(4, 6, 3, hidden=8, rounds=3)
    grow_rounds(big, 2)
    logits, value = big(*inputs())
    (logits.sum() + value.sum()).backward()
    assert big.blocks[2].mix[2].weight.grad.abs().sum().item() > 0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
