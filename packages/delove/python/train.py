"""Train a Delove version on exported self-play decisions (`npm run delove -- export`).

    .venv/Scripts/python packages/delove/python/train.py --data data/delove/teacher-01/classic \
        --out models/delove/delove@1 [--init models/delove/delove@0] [--epochs 3]

    # Stage 2: several exports of the same map; ":winners" learns the policy mostly from the side that won
    .venv/Scripts/python packages/delove/python/train.py --data data/delove/s2-teacher/classic \
        --data data/delove/s2-self/classic:winners --init models/delove/delove@1.pt --out models/delove/delove@2

Policy: cross-entropy on the candidate that was played, weighted per decision (mode "imitate": every move counts
fully; mode "winners": weight loser_weight + (1 - loser_weight) * z, so mostly the winner's moves; mode
"advantage": weight exp((z - V) / beta), V the model's own current value for the position (no gradient), so a move
counts more the better the game went than expected from there, and weights are normalised per batch). Value: binary
cross-entropy on the game result `z`, on every decision.
Writes <out>.pt (weights + config) and <out>.json (training settings and validation metrics).

A dataset spec can end in #F (e.g. data/delove/c4-classic2/classic#0.4): each epoch then trains on a fresh random F of
that dataset's training decisions, so older cycles keep their influence at a fraction of their cost. --amp runs the
network in bfloat16 (mixed precision; losses, optimizer and weights stay float32). --branch-weights W0,W1,W2 weights
the policy loss by what branch and score did at each decision (branch_tag.npy, written by delove_gpu.generate): 0 the
teacher's move played without comparing options, 1 options compared and the teacher's move kept, 2 the move changed;
datasets without branch_tag.npy keep weight 1.
"""
import contextlib
import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn.functional as F

from delove_model import DeloveNet, segment_log_softmax

SUPPORTED_ENCODER = 2
MODES = ("imitate", "winners", "advantage")


class Data:
    def __init__(self, folder, mode="imitate", loser_weight=0.1, target="z", fraction=1.0, branch_weights=None):
        if mode not in MODES:
            raise SystemExit(f"{folder}: unknown mode {mode!r} ({', '.join(MODES)})")
        if not 0 < fraction <= 1:
            raise SystemExit(f"{folder}: fraction {fraction} must be in (0, 1]")
        self.name, self.mode, self.loser_weight, self.fraction = folder, mode, loser_weight, fraction
        with open(os.path.join(folder, "features.json")) as f:
            self.info = json.load(f)
        if self.info["encoderVersion"] != SUPPORTED_ENCODER:
            raise SystemExit(f"{folder}: encoder v{self.info['encoderVersion']}, this trainer reads v{SUPPORTED_ENCODER}")
        load = lambda name: np.load(os.path.join(folder, name + ".npy"), mmap_mode="r")
        self.territory, self.glob, self.cand = load("territory"), load("global"), load("cand")
        self.cand_from, self.cand_to, self.offset = load("cand_from"), load("cand_to"), np.asarray(load("cand_offset"))
        self.choice, self.z, self.game = np.asarray(load("choice")), np.asarray(load("z")), np.asarray(load("game"))
        # target "points": the value head (and :advantage / :winners weights) learn leaderboard points scaled to 0..1
        # (points01.npy, log v3) instead of win/loss; decisions without points (v2 logs) keep z.
        self.target = "z"
        if target == "points" and os.path.exists(os.path.join(folder, "points01.npy")):
            p01 = np.asarray(load("points01"))
            if np.isfinite(p01).any():
                self.z = np.where(np.isfinite(p01), p01, self.z).astype(np.float32)
                self.target = "points"
        self.tag_weight = None
        tag_path = os.path.join(folder, "branch_tag.npy")
        if branch_weights is not None and os.path.exists(tag_path):
            self.tag_weight = np.asarray(branch_weights, dtype=np.float32)[np.asarray(np.load(tag_path, mmap_mode="r")).clip(0, 2)]
        T = len(self.info["territoryIds"])
        adj = np.zeros((T, T), dtype=np.float32)
        for i, ns in enumerate(self.info["adjacency"]):
            adj[i, ns] = 1.0
        self.adj = adj

    def __len__(self):
        return len(self.choice)

    def policy_weight(self, ks):
        z = self.z[ks].astype(np.float32)
        w = self.loser_weight + (1 - self.loser_weight) * z if self.mode == "winners" else np.ones_like(z)
        return w * self.tag_weight[ks] if self.tag_weight is not None else w

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
            w=t(self.policy_weight(ks)),
            advantage=self.mode == "advantage",
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


def step_loss(model, b, adj, value_weight, beta=0.3, amp=False):
    ctx = torch.autocast("cuda", dtype=torch.bfloat16) if amp else contextlib.nullcontext()
    with ctx:
        logits, value = model(b["territory"], b["glob"], adj, b["cand"], b["cand_from"], b["cand_to"], b["cand_batch"])
    logits, value = logits.float(), value.float()
    logp = segment_log_softmax(logits, b["cand_batch"], b["n"])
    w = b["w"]
    if b["advantage"]:
        w = torch.exp(((b["z"] - value.detach()) / beta).clamp(-3.0, 2.0))
        w = w / w.mean()
    policy_loss = -(logp[b["target"]] * w).sum() / w.sum().clamp(min=1e-6)
    value_loss = F.binary_cross_entropy(value.clamp(1e-6, 1 - 1e-6), b["z"])
    # Top-1: the played candidate has the highest logit in its decision.
    mx = torch.full((b["n"],), float("-inf"), device=logits.device).scatter_reduce(0, b["cand_batch"], logits, reduce="amax")
    acc = (logits[b["target"]] >= mx).float().mean()
    return policy_loss + value_weight * value_loss, policy_loss, value_loss, acc


@torch.no_grad()
def evaluate(model, data, idx, device, batch_size, value_weight, beta=0.3, amp=False):
    adj = torch.as_tensor(data.adj, device=device)
    model.eval()
    tot = np.zeros(4)
    n = 0
    for i in range(0, len(idx), batch_size):
        b = data.batch(idx[i : i + batch_size], device)
        losses = step_loss(model, b, adj, value_weight, beta, amp)
        tot += np.array([x.item() for x in losses]) * b["n"]
        n += b["n"]
    model.train()
    loss, pl, vl, acc = tot / max(1, n)
    return dict(loss=loss, policy_loss=pl, value_loss=vl, top1=acc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, action="append",
                    help="export folder for one map, optionally :imitate (default), :winners or :advantage; repeat to mix exports of the same map")
    ap.add_argument("--beta", type=float, default=0.3, help="temperature of :advantage weights (smaller = sharper)")
    ap.add_argument("--value-target", choices=["z", "points"], default="z",
                    help="what the value head learns: z (win 1 / loss 0) or points (leaderboard points scaled 0..1)")
    ap.add_argument("--loser-weight", type=float, default=0.1, help="policy weight of a losing side's moves in :winners data")
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
    ap.add_argument("--amp", action="store_true", help="mixed precision: the network in bfloat16 (CUDA only)")
    ap.add_argument("--branch-weights", help="W0,W1,W2: policy weight of teacher-only, compared-and-kept and changed decisions")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    amp = args.amp and device == "cuda"
    bw = [float(x) for x in args.branch_weights.split(",")] if args.branch_weights else None
    if bw is not None and len(bw) != 3:
        raise SystemExit("--branch-weights needs three numbers")

    def parse(spec):
        fraction = 1.0
        if "#" in spec:
            spec, f = spec.rsplit("#", 1)
            fraction = float(f)
        for mode in MODES:
            if spec.endswith(":" + mode):
                return Data(spec[: -len(mode) - 1], mode, args.loser_weight, args.value_target, fraction, bw)
        return Data(spec, "imitate", args.loser_weight, args.value_target, fraction, bw)

    datasets = [parse(d) for d in args.data]
    first = datasets[0]
    # Maps can differ between datasets: every batch comes from one dataset and uses that map's adjacency.
    adjs = [torch.as_tensor(d.adj, device=device) for d in datasets]
    splits = []
    for d in datasets:
        tr, va = split_by_game(d.game, args.val, args.seed)
        cap = max(1, args.max_val // len(datasets))
        if len(va) > cap:
            va = np.sort(rng.choice(va, cap, replace=False))
        splits.append((tr, va))
    # Decisions per epoch: a dataset with a fraction contributes that share of its training decisions.
    n_train = int(sum(len(tr) * d.fraction for d, (tr, _) in zip(datasets, splits)))
    f_t, f_g, f_c = first.territory.shape[-1], first.glob.shape[-1], first.cand.shape[-1]

    if args.init:
        ck = torch.load(args.init, map_location=device)
        model = DeloveNet(**ck["config"]).to(device)
        model.load_state_dict(ck["state"])
    else:
        model = DeloveNet(f_t, f_g, f_c, hidden=args.hidden, rounds=args.rounds).to(device)
    params = sum(p.numel() for p in model.parameters())
    steps_total = int(args.epochs * n_train / args.batch)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=max(1, steps_total), pct_start=0.05)
    print(json.dumps(dict(device=device, datasets={d.name: dict(mode=d.mode, target=d.target, decisions=len(d), fraction=d.fraction, tagged=d.tag_weight is not None) for d in datasets},
                          train=n_train, params=params, steps=steps_total, amp=amp)))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    step, t0, history = 0, time.time(), []
    block = 32  # decisions per contiguous read

    def batches():
        """One epoch: every dataset's blocks shuffled together; each batch comes from a single dataset."""
        tagged = []
        for di, (tr, _) in enumerate(splits):
            bl = blocks(tr, block, rng)
            if datasets[di].fraction < 1:  # a fresh random share of this dataset's blocks each epoch
                bl = bl[: max(1, round(len(bl) * datasets[di].fraction))]
            tagged += [(di, blk) for blk in bl]
        buffers = [[] for _ in datasets]
        for j in rng.permutation(len(tagged)):
            di, blk = tagged[j]
            buffers[di].append(blk)
            if sum(len(x) for x in buffers[di]) >= args.batch:
                yield di, np.concatenate(buffers[di])[: args.batch]
                buffers[di] = []

    def label(d):
        # "<dataset>/<map>" (one dataset can hold several maps, e.g. a GPU step's big tables).
        parts = os.path.normpath(d.name).split(os.sep)
        return "/".join(parts[-2:]) if len(parts) >= 2 else d.name

    def validate():
        per = {}
        tot, n = np.zeros(4), 0
        for d, (_, va) in zip(datasets, splits):
            m = evaluate(model, d, va, device, args.batch, args.value_weight, args.beta, amp)
            per[label(d)] = m
            tot += np.array([m["loss"], m["policy_loss"], m["value_loss"], m["top1"]]) * len(va)
            n += len(va)
        loss, pl, vl, acc = tot / max(1, n)
        return dict(loss=loss, policy_loss=pl, value_loss=vl, top1=acc, per_dataset=per)

    while step < steps_total:
        for di, ks in batches():
            if step >= steps_total:
                break
            b = datasets[di].batch(ks, device)
            loss, pl, vl, acc = step_loss(model, b, adjs[di], args.value_weight, args.beta, amp)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            if step % 200 == 0:
                print(f"step {step}/{steps_total} policy {pl.item():.3f} value {vl.item():.3f} top1 {acc.item():.3f} {(time.time() - t0) / 60:.1f} min", flush=True)
            if step % 2000 == 0 or step == steps_total:
                m = validate()
                m["step"] = step
                history.append(m)
                summary = {k: round(float(v), 4) for k, v in m.items() if k != "per_dataset"}
                summary["top1_by_dataset"] = {k: round(float(v["top1"]), 4) for k, v in m["per_dataset"].items()}
                print("val", json.dumps(summary), flush=True)
                torch.save(dict(config=model.config, state=model.state_dict()), args.out + ".pt")

    torch.save(dict(config=model.config, state=model.state_dict()), args.out + ".pt")
    with open(args.out + ".json", "w") as f:
        json.dump(dict(args=vars(args), params=params, decisions={d.name: len(d) for d in datasets}, minutes=(time.time() - t0) / 60,
                       history=history, map=first.info["map"], encoderVersion=first.info["encoderVersion"]), f, indent=2, default=float)
    print("saved", args.out + ".pt")


if __name__ == "__main__":
    main()
