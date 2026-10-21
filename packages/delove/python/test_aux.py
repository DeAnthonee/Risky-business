"""Checks for the rollout head (train.py --aux-rollout; CPU, no data): python packages/delove/python/test_aux.py"""
import math

import torch

from delove_model import DeloveNet
from train import step_loss

NAN = float("nan")


def batch(n=3, T=5, ft=4, fg=6, fc=3, per=2, rq=None):
    torch.manual_seed(0)
    M = n * per
    seg = torch.arange(n).repeat_interleave(per)
    return dict(
        territory=torch.randn(n, T, ft), glob=torch.randn(n, fg), cand=torch.randn(M, fc),
        cand_from=torch.full((M,), -1), cand_to=torch.full((M,), -1), cand_batch=seg,
        target=torch.arange(n) * per, q=None, rq=rq, z=torch.full((n,), 0.5), w=torch.ones(n),
        advantage=False, policy=True, n=n,
    )


def net(aux):
    torch.manual_seed(1)
    return DeloveNet(4, 6, 3, hidden=8, rounds=1, aux_rollout=aux)


def test_default_forward_and_config_unchanged():
    plain, withaux = net(False), net(True)
    assert "aux_rollout" not in plain.config and withaux.config["aux_rollout"] is True
    b = batch()
    adj = torch.ones(5, 5)
    out = withaux(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"])
    assert len(out) == 2  # the ONNX export calls this form
    _, _, r = withaux(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"], aux=True)
    assert r.shape == (3,) and bool(((r > 0) & (r < 1)).all())


def test_old_weights_load_into_an_aux_network():
    old = net(False).state_dict()
    model = net(True)
    missing, unexpected = model.load_state_dict(old, strict=False)
    assert not unexpected and missing and all(k.startswith("rollout.") for k in missing)
    # the policy and value are the old network's
    b = batch()
    adj = torch.ones(5, 5)
    ref = net(False)
    ref.load_state_dict(old)
    a = model(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"])
    r = ref(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"])
    assert torch.allclose(a[0], r[0]) and torch.allclose(a[1], r[1])


def test_loss_adds_only_where_a_branch_score_exists():
    model = net(True)
    adj = torch.ones(5, 5)
    base = step_loss(model, batch(rq=torch.tensor([0.7, NAN, 0.2])), adj, 0.5)[0]
    off = step_loss(model, batch(rq=torch.tensor([0.7, NAN, 0.2])), adj, 0.5, aux_rollout=0.0)[0]
    on = step_loss(model, batch(rq=torch.tensor([0.7, NAN, 0.2])), adj, 0.5, aux_rollout=2.0)[0]
    assert math.isclose(base.item(), off.item(), rel_tol=1e-6) and on.item() > off.item()
    none = step_loss(model, batch(rq=torch.tensor([NAN, NAN, NAN])), adj, 0.5, aux_rollout=2.0)[0]
    assert math.isclose(none.item(), off.item(), rel_tol=1e-6)
    model.zero_grad()
    on.backward()
    assert model.rollout[0].weight.grad.abs().sum().item() > 0


def test_a_plain_network_ignores_the_flag_without_scores():
    model = net(False)
    adj = torch.ones(5, 5)
    loss = step_loss(model, batch(rq=None), adj, 0.5, aux_rollout=1.0)[0]
    assert torch.isfinite(loss)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
