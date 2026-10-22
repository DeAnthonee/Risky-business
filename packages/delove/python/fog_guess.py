"""The fog guesser: a small network that guesses what is behind the fog (docs/delove-fog.md section 4.5).

From a decision's seat view (fog.py's transform of the full-board features, exactly what a fogged seat is shown), it
predicts for every territory a distribution over its owner (seat slots 0-9 relative to the decider, then the Neutral)
and over its armies in bins (ARMY_BINS). Only hidden territories are trained and used. The fog sampler
(packages/delove/src/fog-guesser.ts, fog-sampler.ts) draws hidden owners and armies from it.

Phase 1 (this file): (view, truth) pairs come for free from any cycle's full-board arrays: the view is fog.py's
transform of the features, the truth is the untouched features. The seat's memory of earlier turns is not used yet.

    python fog_guess.py --data <dataset dir> [<dataset dir> ...] --out models/delove/fog-guess@1 [--per 15000]

writes <out>.pt, <out>.onnx (inputs territory [B, T, TF + 1], global [B, GF + 1], adj [T, T]; output guess
[B, T, OWNERS + BINS]) and <out>.json (config, the bins, held-out metrics).
"""
import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from delove_model import Block, mlp
from fog import MAX_SLOTS, FogMap, fog_inputs

FOG_GUESS_VERSION = 1
OWNERS = MAX_SLOTS + 1  # seat slots 0-9, then the Neutral
NEUTRAL_CLASS = MAX_SLOTS
# army bins: [lo, hi] inclusive; the last is open-ended
ARMY_BINS = [[1, 1], [2, 2], [3, 4], [5, 8], [9, 16], [17, 10**9]]
BINS = len(ARMY_BINS)


class GuessNet(nn.Module):
    def __init__(self, f_territory, f_global, hidden=64, rounds=3):
        super().__init__()
        self.config = dict(f_territory=f_territory, f_global=f_global, hidden=hidden, rounds=rounds)
        h = hidden
        self.t_in = mlp(f_territory, h, h)
        self.g_in = mlp(f_global, h, h)
        self.blocks = nn.ModuleList([Block(h) for _ in range(rounds)])
        self.out_norm = nn.LayerNorm(h)
        self.head = mlp(2 * h, h, OWNERS + BINS)

    def forward(self, territory, glob, adj):
        deg = adj.sum(-1, keepdim=True).clamp(min=1.0)
        adj_norm = (adj / deg).unsqueeze(0)
        g = self.g_in(glob)
        x = self.t_in(territory) + g.unsqueeze(1)
        for block in self.blocks:
            x = block(x, adj_norm, g)
        x = self.out_norm(x)
        return self.head(torch.cat([x, g.unsqueeze(1).expand_as(x)], dim=-1))


def army_bin(armies):
    b = np.zeros(armies.shape, dtype=np.int64)
    for k, (lo, _hi) in enumerate(ARMY_BINS):
        b = np.where(armies >= lo, k, b)
    return b


class Data:
    """One dataset folder's (view, truth) examples: `per` decisions from training games and per/5 from held-out games."""

    def __init__(self, folder, per, rng, val_fraction=0.1):
        with open(os.path.join(folder, "features.json")) as f:
            info = json.load(f)
        self.name = os.path.basename(os.path.normpath(folder))
        self.map = info["map"]
        self.fm = FogMap(info)
        T = len(info["territoryIds"])
        adj = np.zeros((T, T), dtype=np.float32)
        for i, ns in enumerate(info["adjacency"]):
            adj[i, ns] = 1
        self.adj = torch.from_numpy(adj)
        territory = np.load(os.path.join(folder, "territory.npy"), mmap_mode="r")
        glob = np.load(os.path.join(folder, "global.npy"), mmap_mode="r")
        game = np.asarray(np.load(os.path.join(folder, "game.npy"), mmap_mode="r"))
        games = np.unique(game)
        val_games = rng.choice(games, size=max(1, int(len(games) * val_fraction)), replace=False)
        is_val = np.isin(game, val_games)
        pick = lambda pool, n: np.sort(rng.choice(pool, size=min(n, len(pool)), replace=False))
        self.parts = {}
        for part, pool, n in (("train", np.nonzero(~is_val)[0], per), ("val", np.nonzero(is_val)[0], max(1, per // 5))):
            ks = pick(pool, n)
            self.parts[part] = self._examples(np.asarray(territory[ks]), np.asarray(glob[ks]))

    def _examples(self, territory, glob):
        fm = self.fm
        ti, gi = fm.t, fm.g
        x_t, x_g = fog_inputs(territory, glob, np.ones(len(territory), dtype=bool), fm)
        hidden = x_t[:, :, fm.TF] == 1
        slots = territory[:, :, :MAX_SLOTS] == 1
        owner = np.where(slots.any(-1), slots.argmax(-1), np.where(territory[:, :, ti["owner_neutral"]] == 1, NEUTRAL_CLASS, -1))
        lin = territory[:, :, ti["armies_lin"]]
        armies = np.where(lin < 1, np.round(lin * 30), np.round(np.expm1(territory[:, :, ti["armies_log"]] * 5)))
        target_owner = np.where(hidden & (owner >= 0), owner, -1)
        target_bin = np.where(hidden & (owner >= 0), army_bin(armies), -1)
        # owners a hidden territory can have: the other seats still alive, and the Neutral
        allowed = np.zeros((len(territory), OWNERS), dtype=bool)
        for k in range(1, MAX_SLOTS):
            allowed[:, k] = (glob[:, gi[f"slot{k}_present"]] == 1) & (glob[:, gi[f"slot{k}_alive"]] == 1)
        allowed[:, NEUTRAL_CLASS] = True
        players = np.stack([glob[:, gi[f"slot{k}_present"]] == 1 for k in range(MAX_SLOTS)], 1).sum(1)
        keep = (target_owner >= 0).any(1)
        return dict(
            t=torch.from_numpy(x_t[keep]),
            g=torch.from_numpy(x_g[keep]),
            owner=torch.from_numpy(target_owner[keep]),
            bin=torch.from_numpy(target_bin[keep]),
            allowed=torch.from_numpy(allowed[keep]),
            players=players[keep],
        )


def losses(model, d, idx, adj, device):
    out = model(d["t"][idx].to(device), d["g"][idx].to(device), adj.to(device))
    owner_logits = out[..., :OWNERS].masked_fill(~d["allowed"][idx].to(device).unsqueeze(1), -1e9)
    owner, bins = d["owner"][idx].to(device), d["bin"][idx].to(device)
    lo = F.cross_entropy(owner_logits.reshape(-1, OWNERS), owner.reshape(-1), ignore_index=-1)
    lb = F.cross_entropy(out[..., OWNERS:].reshape(-1, BINS), bins.reshape(-1), ignore_index=-1)
    return lo, lb, owner_logits, out[..., OWNERS:]


@torch.no_grad()
def evaluate(model, data, device, batch=512):
    """Held-out metrics per player count: owner accuracy of the top guess and of one draw (the sampler draws), owner
    log-loss, the uniform draw's accuracy (one of the allowed owners at random), army-bin accuracy."""
    model.eval()
    acc = {}
    for d in data:
        v = d.parts["val"]
        for s in range(0, len(v["owner"]), batch):
            idx = torch.arange(s, min(s + batch, len(v["owner"])))
            _, _, ol, bl = losses(model, v, idx, d.adj, device)
            owner, bins = v["owner"][idx].to(device), v["bin"][idx].to(device)
            m = owner >= 0
            p = ol.softmax(-1)
            p_true = p.gather(-1, owner.clamp(min=0).unsqueeze(-1)).squeeze(-1)
            n_allowed = v["allowed"][idx].to(device).sum(-1, keepdim=True).expand_as(owner).float()
            for i, n in enumerate(v["players"][idx.numpy()]):
                key = "2p" if n <= 2 else "3-4p" if n <= 4 else "5-6p" if n <= 6 else "7p+"
                a = acc.setdefault(key, np.zeros(7))
                mi = m[i]
                a += [
                    mi.sum().item(),
                    (ol[i].argmax(-1) == owner[i])[mi].sum().item(),
                    p_true[i][mi].sum().item(),
                    -torch.log(p_true[i][mi].clamp(min=1e-9)).sum().item(),
                    (1 / n_allowed[i])[mi].sum().item(),
                    (bl[i].argmax(-1) == bins[i])[mi].sum().item(),
                    1,
                ]
    model.train()
    return {
        k: dict(hidden=int(a[0]), decisions=int(a[6]), ownerTop=round(a[1] / a[0], 4), ownerDraw=round(a[2] / a[0], 4), ownerNll=round(a[3] / a[0], 4),
                uniformDraw=round(a[4] / a[0], 4), armyBinTop=round(a[5] / a[0], 4))
        for k, a in sorted(acc.items())
    }


def export(model, path, f_territory, f_global, T=42):
    model = model.cpu().eval()
    args = (torch.zeros(2, T, f_territory), torch.zeros(2, f_global), torch.ones(T, T))
    torch.onnx.export(
        model,
        args,
        path,
        input_names=["territory", "global", "adj"],
        output_names=["guess"],
        dynamic_axes={"territory": {0: "B", 1: "T"}, "global": {0: "B"}, "adj": {0: "T", 1: "T"}, "guess": {0: "B", 1: "T"}},
        opset_version=17,
        dynamo=False,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--per", type=int, default=15000, help="training decisions sampled per dataset (held-out: per/5)")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--bin-weight", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    data = [Data(f, a.per, rng) for f in a.data]
    print(f"loaded {len(data)} datasets, {sum(len(d.parts['train']['owner']) for d in data)} training decisions in {time.time() - t0:.0f}s", flush=True)
    f_territory, f_global = data[0].parts["train"]["t"].shape[-1], data[0].parts["train"]["g"].shape[-1]
    model = GuessNet(f_territory, f_global, a.hidden, a.rounds).to(a.device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    steps_per_epoch = sum(len(d.parts["train"]["owner"]) // a.batch for d in data)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * steps_per_epoch + 1)
    print("before", json.dumps(evaluate(model, data, a.device)), flush=True)
    for epoch in range(a.epochs):
        jobs = [(i, s) for i, d in enumerate(data) for s in range(len(d.parts["train"]["owner"]) // a.batch)]
        rng.shuffle(jobs)
        perms = [torch.from_numpy(rng.permutation(len(d.parts["train"]["owner"]))) for d in data]
        tot = np.zeros(2)
        for i, s in jobs:
            idx = perms[i][s * a.batch : (s + 1) * a.batch]
            lo, lb, _, _ = losses(model, data[i].parts["train"], idx, data[i].adj, a.device)
            loss = lo + a.bin_weight * lb
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += [lo.item(), lb.item()]
        print(f"epoch {epoch + 1}: owner {tot[0] / len(jobs):.4f} bins {tot[1] / len(jobs):.4f} ({time.time() - t0:.0f}s)", flush=True)
    metrics = evaluate(model, data, a.device)
    print("after", json.dumps(metrics), flush=True)
    torch.save({"config": model.config, "state": model.state_dict()}, a.out + ".pt")
    with open(a.out + ".json", "w") as f:
        json.dump(dict(fogGuessVersion=FOG_GUESS_VERSION, config=model.config, owners=OWNERS, armyBins=ARMY_BINS, data=a.data, per=a.per, epochs=a.epochs,
                       metrics=metrics), f, indent=1)
    export(model, a.out + ".onnx", f_territory, f_global)
    print("wrote", a.out + ".onnx", flush=True)


if __name__ == "__main__":
    main()
