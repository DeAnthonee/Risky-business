"""Checks for soft.py (CPU, no data): python packages/delove/python/test_soft.py"""
import math

import torch

from soft import policy_losses, soft_targets

NAN = float("nan")


def close(a, b, tol=1e-6):
    return all(abs(x - y) <= tol for x, y in zip(torch.as_tensor(a).flatten().tolist(), torch.as_tensor(b).flatten().tolist()))


def test_uniform_prior_two_compared():
    # one decision, 4 candidates; candidates 0 and 2 compared (scores 0.2, 0.6), uniform prior, c = 2
    prior = torch.zeros(4)
    q = torch.tensor([0.2, NAN, 0.6, NAN])
    seg = torch.zeros(4, dtype=torch.long)
    t, soft = soft_targets(prior, q, seg, 1, 2.0)
    assert soft.tolist() == [True]
    # q_hat: 0 and 1; uncompared get the prior-weighted mean of the compared = 0.5
    logits = torch.tensor([0.0, 1.0, 2.0, 1.0])
    assert close(t, torch.softmax(logits, 0))
    assert close(t.sum(), 1.0)


def test_uncompared_keep_prior_order():
    prior = torch.tensor([0.0, 3.0, 1.0, -1.0, 0.5])
    q = torch.tensor([0.1, NAN, 0.4, NAN, NAN])
    seg = torch.zeros(5, dtype=torch.long)
    t, _ = soft_targets(prior, q, seg, 1, 5.0)
    # the uncompared candidates 1, 3, 4 shift by the same constant: their ratios are the prior's
    assert math.isclose(t[1].item() / t[3].item(), math.exp(4.0), rel_tol=1e-5)
    assert math.isclose(t[4].item() / t[3].item(), math.exp(1.5), rel_tol=1e-5)
    # the better compared candidate gains c relative to the worse one on top of the prior gap
    assert math.isclose(t[2].item() / t[0].item(), math.exp(1.0 + 5.0), rel_tol=1e-5)


def test_hard_where_fewer_than_two_or_equal_scores():
    # decision 0: one compared candidate (hard); decision 1: two equal scores (soft, q_hat 0.5 each = prior)
    prior = torch.tensor([0.0, 0.0, 1.0, 0.0, 2.0])
    q = torch.tensor([0.3, NAN, 0.5, 0.5, NAN])
    seg = torch.tensor([0, 0, 1, 1, 1])
    t, soft = soft_targets(prior, q, seg, 2, 3.0)
    assert soft.tolist() == [False, True]
    assert close(t[2:], torch.softmax(prior[2:], 0))  # every q_done 0.5: the prior itself


def test_scale_free_and_c_zero_is_prior():
    prior = torch.tensor([0.5, -0.5, 0.0])
    seg = torch.zeros(3, dtype=torch.long)
    a, _ = soft_targets(prior, torch.tensor([0.1, 0.2, NAN]), seg, 1, 4.0)
    b, _ = soft_targets(prior, torch.tensor([10.0, 20.0, NAN]), seg, 1, 4.0)
    assert close(a, b)  # min-max: only the order and relative gaps matter, not the table's score scale
    z, _ = soft_targets(prior, torch.tensor([0.1, 0.2, NAN]), seg, 1, 0.0)
    assert close(z, torch.softmax(prior, 0))


def test_absolute_scale_keeps_small_gaps_soft():
    # two compared options 0.002 apart (rollout noise): min-max makes them 0 vs 1, a fixed scale S keeps them close
    prior = torch.zeros(3)
    q = torch.tensor([0.500, 0.502, NAN])
    seg = torch.zeros(3, dtype=torch.long)
    mm, _ = soft_targets(prior, q, seg, 1, 5.0)
    ab, soft = soft_targets(prior, q, seg, 1, 5.0, scale=0.05)
    assert soft.tolist() == [True]
    assert math.isclose(mm[1].item() / mm[0].item(), math.exp(5.0), rel_tol=1e-4)
    assert math.isclose(ab[1].item() / ab[0].item(), math.exp(5.0 * 0.002 / 0.05), rel_tol=1e-3)  # 0.2 logits
    # a gap of S or more is the full shift C, clipped
    big, _ = soft_targets(prior, torch.tensor([0.1, 0.4, NAN]), seg, 1, 5.0, scale=0.05)
    assert math.isclose(big[1].item() / big[0].item(), math.exp(5.0), rel_tol=1e-4)
    # equal scores: no shift between them (q_hat 0 for both)
    eq, _ = soft_targets(prior, torch.tensor([0.3, 0.3, NAN]), seg, 1, 5.0, scale=0.05)
    assert close(eq[0], eq[1])


def test_policy_losses():
    logp = torch.log(torch.tensor([0.5, 0.25, 0.25, 0.9, 0.1]))
    seg = torch.tensor([0, 0, 0, 1, 1])
    hard = torch.tensor([1, 3])
    plain = policy_losses(logp, hard, seg, 2)
    assert close(plain, [-math.log(0.25), -math.log(0.9)])
    target = torch.tensor([0.0, 1.0, 0.0, 0.5, 0.5])
    soft = torch.tensor([True, False])
    mixed = policy_losses(logp, hard, seg, 2, target, soft)
    # soft decision 0 with a one-hot target equals the hard loss; decision 1 keeps the hard loss
    assert close(mixed, [-math.log(0.25), -math.log(0.9)])
    soft2 = torch.tensor([True, True])
    ce = policy_losses(logp, hard, seg, 2, target, soft2)
    assert close(ce[1], -(0.5 * math.log(0.9) + 0.5 * math.log(0.1)))


def test_gradient_moves_toward_better_option():
    torch.manual_seed(0)
    logits = torch.zeros(3, requires_grad=True)
    seg = torch.zeros(3, dtype=torch.long)
    t, soft = soft_targets(torch.zeros(3), torch.tensor([0.2, 0.9, NAN]), seg, 1, 3.0)
    from delove_model import segment_log_softmax

    loss = policy_losses(segment_log_softmax(logits, seg, 1), torch.tensor([0]), seg, 1, t, soft).sum()
    loss.backward()
    assert logits.grad[1] < 0 < logits.grad[0]  # descent raises the better-scoring option, lowers the worse


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
