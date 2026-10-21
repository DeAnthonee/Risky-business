"""Soft policy targets from branch and score's per-option results (train.py --soft-targets).

A branched decision compared a few options (the teacher's move and the ranker's favourites) by rollouts; branch_q.npy
holds each compared candidate's mean score (NaN for the others). Instead of copying only the played move, the policy
learns the whole comparison, as Gumbel AlphaZero / MuZero train on "completed Q" (Danihelka et al. 2022):

    q_hat  = the compared candidates' scores scaled to 0..1 within the decision (min-max; 0.5 each if all equal),
             or with an absolute scale S: clip((q - the lowest compared score) / S, 0, 1), so a gap of rollout-noise
             size stays a small shift instead of becoming 0 vs 1 (Gumbel MuZero's fixed value bounds)
    q_done = q_hat for compared candidates; for the others, the prior-weighted mean of the compared q_hat
    target = softmax(prior_logit + c * q_done) over every candidate of the decision

so the compared candidates move up or down by how they scored, and the ones never compared keep their prior order
(their q_done is the same constant). `prior_logit` comes from a frozen network (the starting weights by default, or
zeros: a uniform prior), never from the network being trained, so the target cannot drift with it. Decisions with
fewer than two compared candidates keep the hard target (the played move).
"""
from __future__ import annotations

import torch

from delove_model import segment_log_softmax


def soft_targets(prior_logits: torch.Tensor, q: torch.Tensor, seg: torch.Tensor, n: int, c: float, scale: float | None = None):
    """prior_logits, q: [rows] (q NaN where not compared); seg: [rows] decision of each row; n decisions; scale: None
    for min-max within each decision, or the absolute score gap S that counts as the full 0..1.
    Returns (target probabilities [rows], soft [n] bool: the decision has a soft target)."""
    prior_logits = prior_logits.float()
    q = q.float()
    ev = torch.isfinite(q)
    cnt = torch.zeros(n, device=q.device).index_add_(0, seg, ev.float())
    soft = cnt >= 2
    inf = torch.full((n,), float("inf"), device=q.device)
    qmin = inf.scatter_reduce(0, seg, torch.where(ev, q, float("inf")), reduce="amin", include_self=True)
    qmax = (-inf).scatter_reduce(0, seg, torch.where(ev, q, float("-inf")), reduce="amax", include_self=True)
    if scale is not None:
        qn = ((q - qmin[seg]) / scale).clamp(0.0, 1.0)
    else:
        span = (qmax - qmin)[seg]
        qn = torch.where(ev & (span > 0), (q - qmin[seg]) / torch.where(span > 0, span, 1.0), torch.full_like(q, 0.5))
    qn = torch.where(ev, qn, torch.zeros_like(q))
    pi = segment_log_softmax(prior_logits, seg, n).exp()
    num = torch.zeros(n, device=q.device).index_add_(0, seg, torch.where(ev, pi * qn, torch.zeros_like(q)))
    den = torch.zeros(n, device=q.device).index_add_(0, seg, torch.where(ev, pi, torch.zeros_like(q)))
    v = num / den.clamp(min=1e-12)
    q_done = torch.where(ev, qn, v[seg])
    target = segment_log_softmax(prior_logits + c * q_done, seg, n).exp()
    return target, soft


def policy_losses(logp: torch.Tensor, hard: torch.Tensor, seg: torch.Tensor, n: int, target: torch.Tensor | None = None,
                  soft: torch.Tensor | None = None) -> torch.Tensor:
    """Per-decision policy loss [n]: -log p(played move), or with (target, soft) the cross-entropy against the soft
    target where `soft` is set."""
    loss = -logp[hard]
    if target is None:
        return loss
    ce = torch.zeros(n, device=logp.device, dtype=logp.dtype).index_add_(0, seg, -(target * logp))
    return torch.where(soft, ce, loss)
