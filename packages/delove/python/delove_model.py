"""Delove's network: a graph network over the map that scores every candidate and predicts the result.

Inputs are exactly the board encoder's arrays (packages/selfplay/src/encode.ts), so one network plays any map:
the map's adjacency is an input, not a weight.

    territory [B, T, F_t]   global [B, F_g]   adj [T, T] (0/1)
    cand [M, F_c]   cand_from [M]   cand_to [M]   (-1 = none)   cand_batch [M] (which decision of the batch)

Outputs: logits [M] (softmax within each decision's candidates) and value [B] (win probability, 0..1).
"""
import torch
from torch import nn


def mlp(n_in, n_hidden, n_out):
    return nn.Sequential(nn.Linear(n_in, n_hidden), nn.GELU(), nn.Linear(n_hidden, n_out))


class Block(nn.Module):
    """One round of message passing: each territory mixes its own state, its neighbours' mean and the global state."""

    def __init__(self, h):
        super().__init__()
        self.norm = nn.LayerNorm(h)
        self.mix = mlp(3 * h, 2 * h, h)

    def forward(self, x, adj_norm, g):
        n = self.norm(x)
        neigh = torch.matmul(adj_norm, n)  # [B, T, H]
        return x + self.mix(torch.cat([n, neigh, g.unsqueeze(1).expand_as(n)], dim=-1))


class DeloveNet(nn.Module):
    def __init__(self, f_territory, f_global, f_cand, hidden=128, rounds=4):
        super().__init__()
        self.config = dict(f_territory=f_territory, f_global=f_global, f_cand=f_cand, hidden=hidden, rounds=rounds)
        h = hidden
        self.t_in = mlp(f_territory, h, h)
        self.g_in = mlp(f_global, h, h)
        self.blocks = nn.ModuleList([Block(h) for _ in range(rounds)])
        self.out_norm = nn.LayerNorm(h)
        self.c_in = mlp(f_cand, h, h)
        self.policy = mlp(5 * h, 2 * h, 1)
        self.value = mlp(3 * h, h, 1)

    def forward(self, territory, glob, adj, cand, cand_from, cand_to, cand_batch):
        B, T, _ = territory.shape
        deg = adj.sum(-1, keepdim=True).clamp(min=1.0)
        adj_norm = (adj / deg).unsqueeze(0)  # [1, T, T]
        g = self.g_in(glob)  # [B, H]
        x = self.t_in(territory) + g.unsqueeze(1)
        for block in self.blocks:
            x = block(x, adj_norm, g)
        x = self.out_norm(x)  # [B, T, H]
        pooled_mean = x.mean(dim=1)
        pooled_max = x.max(dim=1).values
        ctx = torch.cat([pooled_mean, pooled_max, g], dim=-1)  # [B, 3H]
        value = torch.sigmoid(self.value(ctx)).squeeze(-1)

        # Territory embeddings a candidate is about; row T of each board is zeros for "none".
        H = x.shape[-1]
        flat = torch.cat([x, torch.zeros(B, 1, H, dtype=x.dtype, device=x.device)], dim=1).reshape(B * (T + 1), H)
        base = cand_batch * (T + 1)
        none = torch.full_like(cand_from, T)
        f_idx = base + torch.where(cand_from < 0, none, cand_from)
        t_idx = base + torch.where(cand_to < 0, none, cand_to)
        c = self.c_in(cand)
        feats = torch.cat([c, flat[f_idx], flat[t_idx], pooled_mean[cand_batch], g[cand_batch]], dim=-1)
        logits = self.policy(feats).squeeze(-1)
        return logits, value


def segment_log_softmax(logits, seg, n_seg):
    """log softmax of `logits` within each segment (decision)."""
    mx = torch.full((n_seg,), float("-inf"), device=logits.device, dtype=logits.dtype)
    mx = mx.scatter_reduce(0, seg, logits, reduce="amax", include_self=True)
    shifted = logits - mx[seg]
    denom = torch.zeros(n_seg, device=logits.device, dtype=logits.dtype).index_add_(0, seg, shifted.exp())
    return shifted - denom.log()[seg]
