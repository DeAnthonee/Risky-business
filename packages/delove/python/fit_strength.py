"""Fit Delove's strength meter: which shares of the board predict how a player finishes.

    .venv/Scripts/python packages/delove/python/fit_strength.py runs/delove/strength/games \
        --out models/delove/strength.json [--every 10]

Reads v3 decision logs (they carry each seat's final leaderboard points), takes every `every`-th decision, and for
the deciding seat computes its share against the players still alive of: armies, income (next turn's reinforcements),
territories, cards and continents held. It then fits the weights w so that sum(w * share) best predicts the seat's
points scaled to 0..1, on 80% of the games, and reports on the other 20%:

  - R^2 and rank correlation of the meter against final points;
  - how often the meter orders two seats of the same game, seen at the same step, the way they finished;
  - the same for the hand-picked weights branch-and-score used so far (armies .3, income .3, territories .15,
    cards .15, continents .1).

The weights are written as JSON for src/branch.ts (DELOVE_STRENGTH=<file>): non-negative, summing to 1, like the
hand-picked ones, so branch scores stay on the same 0..1 scale.
"""
import argparse
import glob
import gzip
import json
import os
import random

import numpy as np

KEYS = ["armies", "income", "territories", "cards", "continents"]
HAND = {"armies": 0.3, "income": 0.3, "territories": 0.15, "cards": 0.15, "continents": 0.1}


def continents_of(meta, map_id):
    return [c["territories"] for c in meta["maps"][map_id]["continents"]]


def shares(rec, conts):
    st = rec["state"]
    owner, armies, seats = st["owner"], st["armies"], st["seats"]
    alive = [s for s, v in enumerate(seats) if v[0]]
    if rec["seat"] not in alive or len(alive) < 2:
        return None
    tot = {k: {s: 0.0 for s in alive} for k in KEYS}
    for t, o in enumerate(owner):
        if o in tot["territories"]:
            tot["territories"][o] += 1
            tot["armies"][o] += armies[t]
    for s in alive:
        tot["armies"][s] += seats[s][2]  # armies still to place
        tot["income"][s] = seats[s][3]
        tot["cards"][s] = seats[s][1]
    for c in conts:
        holders = {owner[t] for t in c}
        if len(holders) == 1:
            h = next(iter(holders))
            if h in tot["continents"]:
                tot["continents"][h] += 1
    out = []
    for k in KEYS:
        total = sum(tot[k].values())
        out.append(tot[k][rec["seat"]] / total if total > 0 else 1.0 / len(alive))
    return out, len(alive)


def load(dirs, every, rng):
    rows = []
    for d in dirs:
        meta = json.load(open(os.path.join(d, "meta.json")))
        for shard in sorted(glob.glob(os.path.join(d, "decisions-*.jsonl.gz"))):
            with gzip.open(shard, "rt") as f:
                for line in f:
                    if rng.random() * every >= 1:
                        continue
                    rec = json.loads(line)
                    o = rec["outcome"]
                    if rec.get("v", 0) < 3 or o.get("points") is None or o["winner"] is None:
                        continue
                    sh = shares(rec, continents_of(meta, rec["map"]))
                    if sh is None:
                        continue
                    n = rec["players"]
                    lo, hi = -int(np.ceil((n - 1) / 2)), int(np.ceil((n - 1) / 2)) + (n - 1)
                    rows.append((f"{d}:{rec['game']}", rec["i"], rec["seat"], sh[0], sh[1], (o["points"] - lo) / (hi - lo), rec["map"], n))
    return rows


def rank_corr(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def pair_accuracy(rows, score):
    """Same game, steps close together: does the meter order two seats the way they finished?"""
    by_game = {}
    for r, s in zip(rows, score):
        by_game.setdefault(r[0], []).append((r[1], r[2], s, r[5]))
    right = total = 0
    for items in by_game.values():
        items.sort()
        for (i1, s1, m1, p1), (i2, s2, m2, p2) in zip(items, items[1:]):
            if s1 == s2 or p1 == p2 or abs(i1 - i2) > 40:
                continue
            total += 1
            right += (m1 - m2) * (p1 - p2) > 0
    return right / max(1, total), total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", help="folder holding log directories (searched recursively for meta.json)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--every", type=float, default=10)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    dirs = sorted({os.path.dirname(p) for p in glob.glob(os.path.join(args.logs, "**", "meta.json"), recursive=True)})
    rows = load(dirs, args.every, rng)
    games = sorted({r[0] for r in rows})
    random.Random(args.seed).shuffle(games)
    test_games = set(games[: len(games) // 5])
    train = [r for r in rows if r[0] not in test_games]
    test = [r for r in rows if r[0] in test_games]
    X = lambda rs: np.array([r[3] for r in rs])
    y = lambda rs: np.array([r[5] for r in rs])

    # Non-negative least squares on the shares (a projected gradient keeps every weight >= 0), no intercept beyond
    # what the shares carry: an even position (every share 1/n) must score the same for every n.
    Xt, yt = X(train), y(train)
    w = np.full(len(KEYS), 1.0 / len(KEYS))
    b = 0.0
    for _ in range(20000):
        pred = Xt @ w + b
        g = Xt.T @ (pred - yt) / len(yt)
        w = np.maximum(0.0, w - 0.5 * g)
        b -= 0.5 * float(np.mean(pred - yt))
    fitted = {k: float(v) for k, v in zip(KEYS, w / w.sum())}

    # Pairwise fit: what branch and score needs is ordering, so also fit logistic regression on share differences
    # between two seats of the same game seen close together, predicting which one finished higher.
    def pairs_of(rs):
        by_game = {}
        for r in rs:
            by_game.setdefault(r[0], []).append(r)
        dx, dy = [], []
        for items in by_game.values():
            items.sort(key=lambda r: r[1])
            for a, b in zip(items, items[1:]):
                if a[2] == b[2] or a[5] == b[5] or abs(a[1] - b[1]) > 40:
                    continue
                dx.append(np.array(a[3]) - np.array(b[3]))
                dy.append(1.0 if a[5] > b[5] else 0.0)
        return np.array(dx), np.array(dy)

    px, py = pairs_of(train)
    # Shares differ by ~0.1-0.4 between seats, so the logistic needs a large step to converge.
    wp = np.zeros(len(KEYS))
    for _ in range(20000):
        p = 1 / (1 + np.exp(-(px @ wp)))
        wp -= 20.0 * (px.T @ (p - py)) / len(py)
    # Branch scores need weights >= 0 summing to 1 (a share score on the 0..1 scale): clip, then renormalise.
    wp = np.maximum(wp, 0.0)
    pairwise = {k: float(v) for k, v in zip(KEYS, wp / max(wp.sum(), 1e-9))}

    def report(weights):
        wv = np.array([weights[k] for k in KEYS])
        s = X(test) @ wv
        yy = y(test)
        a = np.polyfit(s, yy, 1)
        resid = yy - np.polyval(a, s)
        r2 = 1 - resid.var() / yy.var()
        acc, pairs = pair_accuracy(test, s)
        return dict(r2=round(float(r2), 4), rank_corr=round(rank_corr(s, yy), 4), pair_accuracy=round(acc, 4), pairs=pairs)

    maps = sorted({r[6] for r in rows})
    candidates = {"regression": fitted, "pairwise": pairwise, "hand": HAND}
    reports = {name: report(wts) for name, wts in candidates.items()}
    # The weights written out: whichever orders held-out pairs best (the job branch and score gives them).
    best = max(reports, key=lambda n: reports[n]["pair_accuracy"])
    result = dict(
        weights=candidates[best],
        chosen=best,
        candidates=candidates,
        reports=reports,
        fit=report(fitted),
        hand=report(HAND),
        hand_weights=HAND,
        decisions=len(rows),
        games=len(games),
        maps=maps,
        players=sorted({r[7] for r in rows}),
        per_map={m: {n: report_subset(test, wts, m) for n, wts in candidates.items()} for m in maps},
    )
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump(result, open(args.out, "w"), indent=2)
    print(json.dumps({k: result[k] for k in ("chosen", "weights", "reports", "decisions", "games", "maps", "players")}, indent=2))


def report_subset(test, weights, map_id):
    sub = [r for r in test if r[6] == map_id]
    if len(sub) < 50:
        return None
    wv = np.array([weights[k] for k in KEYS])
    s = np.array([r[3] for r in sub]) @ wv
    acc, pairs = pair_accuracy(sub, s)
    return dict(rank_corr=round(rank_corr(s, np.array([r[5] for r in sub])), 4), pair_accuracy=round(acc, 4), pairs=pairs)


if __name__ == "__main__":
    main()
