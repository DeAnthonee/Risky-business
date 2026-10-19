"""Train a Delove version on exported self-play decisions (`npm run delove -- export`).

    .venv/Scripts/python packages/delove/python/train.py --data data/delove/teacher-01/classic \
        --out models/delove/delove@1 [--init models/delove/delove@0] [--epochs 3]

Policy: cross-entropy on the candidate that was played. Value: binary cross-entropy on the game result `z`.
Writes <out>.pt (weights + config) and <out>.json (training settings and validation metrics).
"""
import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn.functional as F

from delove_model import DeloveNet, segment_log_softmax

SUPPORTED_ENCODER = 2


class Data:
    def __init__(self, folder):
        with open(os.path.join(folder, "features.json")) as f:
            self.info = json.load(f)
        if self.info["encoderVersion"] != SUPPORTED_ENCODER:
            raise SystemExit(f"{folder}: encoder v{self.info['encoderVersion']}, this trainer reads v{SUPPORTED_ENCODER}")
        load = lambda name: np.load(os.path.join(folder, name + ".npy"), mmap_mode="r")
        self.territory, self.glob, self.cand = load("territory"), load("global"), load("cand")
        self.cand_from, self.cand_to, self.offset = load("cand_from"), load("cand_to"), np.asarray(load("cand_offset"))
        self.choice, self.z, self.game = np.asarray(load("choice")), np.asarray(load("z")), np.asarray(load("game"))
        T = len(self.info["territoryIds"])
        adj = np.zeros((T, T), dtype=np.float32)
        for i, ns in enumerate(self.info["adjacency"]):
            adj[i, ns] = 1.0
        self.adj = adj

    def __len__(self):
        return len(self.choice)

    def batch(self, ks, device):
        """Tensors for decisions `ks` (sorted for faster memmap reads)."""
        ks = np.sort(ks)
        starts, ends = self.offset[ks], self.offset[ks + 1]
        counts = (ends - starts).astype(np.int64)
        rows = np.concatenate([np.arange(s, e) for s, e in zip(starts, ends)])
        seg = np.repeat(np.arange(len(ks)), counts)
        first = np.concatenate([[0], np.cumsum(counts)[:-1]])
        target = first + self.choice[ks]
        t = lambda a, dt=torch.float32: torch.as_tensor(np.ascontiguousarray(a), dtype=dt, device=device)
        return dict(
            territory=t(self.territory[ks]),
            glob=t(self.glob[ks]),
            cand=t(self.cand[rows]),
            cand_from=t(self.cand_from[rows], torch.int64),
            cand_to=t(self.cand_to[rows], torch.int64),
            cand_batch=t(seg, torch.int64),
            target=t(target, torch.int64),
            z=t(self.z[ks]),
            n=len(ks),
        )


def split_by_game(game, val_fraction, seed=0):
    games = np.unique(game)
    rng = np.random.default_rng(seed)
    val_games = rng.choice(games, size=max(1, int(len(games) * val_fraction)), replace=False)
    is_val = np.isin(game, val_games)
    return np.nonzero(~is_val)[0], np.nonzero(is_val)[0]


def blocks(idx, block, rng):
    """Shuffle in contiguous blocks of decisions: random enough for SGD, sequential enough for a memmap on disk."""
    chunks = [idx[i : i + block] for i in range(0, len(idx), block)]
    order = rng.permutation(len(chunks))
    return [chunks[i] for i in order]


def step_loss(model, b, adj, value_weight):
    logits, value = model(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"])
    logp = segment_log_softmax(logits, b["cand_batch"], b["n"])
    policy_loss = -logp[b["target"]].mean()
    value_loss = F.binary_cross_entropy(value.clamp(1e-6, 1 - 1e-6), b["z"])
    # Top-1: the played candidate has the highest logit in its decision.
    mx = torch.full((b["n"],), float("-inf"), device=logits.device).scatter_reduce(0, b["cand_batch"], logits, reduce="amax")
    acc = (logits[b["target"]] >= mx).float().mean()
    return policy_loss + value_weight * value_loss, policy_loss, value_loss, acc


@torch.no_grad()
def evaluate(model, data, idx, adj, device, batch_size, value_weight):
    model.eval()
    tot = np.zeros(4)
    n = 0
    for i in range(0, len(idx), batch_size):
        b = data.batch(idx[i : i + batch_size], device)
        losses = step_loss(model, b, adj, value_weight)
        tot += np.array([x.item() for x in losses]) * b["n"]
        n += b["n"]
    model.train()
    loss, pl, vl, acc = tot / max(1, n)
    return dict(loss=loss, policy_loss=pl, value_loss=vl, top1=acc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="export folder for one map, e.g. data/delove/teacher-01/classic")
    ap.add_argument("--out", required=True, help="output path without extension, e.g. models/delove/delove@1")
    ap.add_argument("--init", help="start from these weights (<path>.pt)")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--value-weight", type=float, default=0.5)
    ap.add_argument("--val", type=float, default=0.05)
    ap.add_argument("--max-val", type=int, default=100_000, help="cap on validation decisions per evaluation")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    data = Data(args.data)
    adj = torch.as_tensor(data.adj, device=device)
    train_idx, val_idx = split_by_game(data.game, args.val, args.seed)
    if len(val_idx) > args.max_val:
        val_idx = np.sort(rng.choice(val_idx, args.max_val, replace=False))
    f_t, f_g, f_c = data.territory.shape[-1], data.glob.shape[-1], data.cand.shape[-1]

    if args.init:
        ck = torch.load(args.init, map_location=device)
        model = DeloveNet(**ck["config"]).to(device)
        model.load_state_dict(ck["state"])
    else:
        model = DeloveNet(f_t, f_g, f_c, hidden=args.hidden, rounds=args.rounds).to(device)
    params = sum(p.numel() for p in model.parameters())
    steps_total = int(args.epochs * len(train_idx) / args.batch)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=max(1, steps_total), pct_start=0.05)
    print(json.dumps(dict(device=device, decisions=len(data), train=len(train_idx), val=len(val_idx), params=params, steps=steps_total)))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    step, t0, history = 0, time.time(), []
    block = 32  # decisions per contiguous read
    while step < steps_total:
        order = np.concatenate(blocks(train_idx, block, rng))
        for i in range(0, len(order) - args.batch + 1, args.batch):
            if step >= steps_total:
                break
            b = data.batch(order[i : i + args.batch], device)
            loss, pl, vl, acc = step_loss(model, b, adj, args.value_weight)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            if step % 200 == 0:
                print(f"step {step}/{steps_total} policy {pl.item():.3f} value {vl.item():.3f} top1 {acc.item():.3f} {(time.time() - t0) / 60:.1f} min", flush=True)
            if step % 2000 == 0 or step == steps_total:
                m = evaluate(model, data, val_idx, adj, device, args.batch, args.value_weight)
                m["step"] = step
                history.append(m)
                print("val", json.dumps({k: round(float(v), 4) for k, v in m.items()}), flush=True)
                torch.save(dict(config=model.config, state=model.state_dict()), args.out + ".pt")

    torch.save(dict(config=model.config, state=model.state_dict()), args.out + ".pt")
    with open(args.out + ".json", "w") as f:
        json.dump(dict(args=vars(args), params=params, decisions=len(data), minutes=(time.time() - t0) / 60, history=history,
                       map=data.info["map"], encoderVersion=data.info["encoderVersion"]), f, indent=2, default=float)
    print("saved", args.out + ".pt")


if __name__ == "__main__":
    main()
