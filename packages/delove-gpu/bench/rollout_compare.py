"""Which rollout player makes the stronger branch-and-score teacher: Jacob Sensei, or a Delove network (every seat, or
the decider's seat only), and how many options per decision.

`jobs` writes a jobs file for delove_gpu.generate (or cloud/remote.py): every variant plays the SAME games (same tables,
seeds and seats; only the branch seat's id differs, e.g. delove-branch@1:teacher / :net / :netself / :net:o4), so the
comparison is paired game by game.

- 4-10 players: one branch seat (moving round the table) among Jacob Sensei and the ranker network, as a cycle's
  tables seat it, on league settings; compared on the branch seat's leaderboard points (placement + kills).
- 2 players: two variants head to head, both seat orders (mirrored), compared on win share.

`report` reads the games' results (generate --results, or the results.jsonl files of a cloud run) and prints, per table
size, each variant's mean points per game with a 95% interval, and each variant's paired difference to the baseline
(game i of one variant against game i of the baseline, the same seed and seat), and the 2-player win shares.

    python bench/rollout_compare.py jobs --variants teacher,net,netself --games 500 --out runs/netroll/compare.jobs
    python -m delove_gpu.generate --jobs runs/netroll/compare.jobs --rollout-net delove@5 --ranker delove@5 \\
        --teacher jacob-sensei@1 --horizon 1 --margin 0.01 --seed 401 --results runs/netroll/results.jsonl
    python bench/rollout_compare.py report runs/netroll/results.jsonl --baseline teacher
"""
from __future__ import annotations

import argparse
import glob
import json
import math
from collections import defaultdict

BRANCH = "delove-branch@1"
J, N = "jacob-sensei@1", "delove@5"

# league settings (docs/game-settings.md), as cycle 8's tables use them
LEAGUE = [
    {"autoSetup": True, "balancedBlitz": True, "chooseCapitals": True, "cardValues": "progressive", "capitals": True, "blizzards": 8},
    {"autoSetup": True, "balancedBlitz": True, "chooseCapitals": True, "cardValues": "fixed", "capitals": True},
    {"autoSetup": True, "balancedBlitz": True, "chooseCapitals": True, "cardValues": "exponential", "blizzards": 8},
    {"autoSetup": True, "balancedBlitz": True, "chooseCapitals": True, "cardValues": "progressive"},
]

# (name, map, seats, branch seat per half): two halves per configuration, the branch seat elsewhere, other settings
MULTI = [
    ("c4", "classic", 4, (1, 3)),
    ("fa4", "fantasy", 4, (0, 2)),
    ("w6", "world", 6, (3, 5)),
    ("ge6", "greater_europe", 6, (2, 4)),
    ("w10", "world", 10, (2, 4)),
    ("fa10", "fantasy", 10, (0, 2)),
]
DUEL = [("c2", "classic"), ("w2", "world")]


def fillers(n: int, branch_seat: int, filler: list[str]) -> list[str]:
    """Jacob Sensei and the network alternating round the table (Jacob first), the branch seat at `branch_seat`."""
    seats, k = [], 0
    for s in range(n):
        if s == branch_seat:
            seats.append(BRANCH)
        else:
            seats.append(filler[k % len(filler)])
            k += 1
    return seats


def seat_id(variant: str) -> str:
    return f"{BRANCH}:{variant}"


def jobs(args) -> list[str]:
    variants = args.variants.split(",")
    sizes = {int(x) for x in args.sizes.split(",")}
    out = [f"# rollout_compare.py jobs --variants {args.variants} --games {args.games} --duel-games {args.duel_games} --sizes {args.sizes}"]
    half = args.games // 2
    for name, mp, n, bseats in MULTI:
        if n not in sizes:
            continue
        for h, bs in enumerate(bseats):
            opts = {"map": mp, **LEAGUE[(h + n) % len(LEAGUE)]}
            base = fillers(n, bs, [J, N])
            for v in variants:
                seats = [seat_id(v) if a == BRANCH else a for a in base]
                out.append(f"{name}{'ab'[h]}-{v.replace(':', '_')} {half} {','.join(seats)} {json.dumps(opts, separators=(',', ':'))}")
    if 2 in sizes:
        pairs = [(a, b) for i, a in enumerate(variants) for b in variants[i + 1:] if args.baseline in (a, b)]
        for name, mp in DUEL:
            opts = {"map": mp, **LEAGUE[3]}
            for a, b in pairs:
                tag = f"{a}-vs-{b}".replace(":", "_")
                o = json.dumps(opts, separators=(",", ":"))
                out.append(f"{name}x-{tag} {args.duel_games // 2} {seat_id(a)},{seat_id(b)} {o}")
                out.append(f"{name}y-{tag} {args.duel_games // 2} {seat_id(b)},{seat_id(a)} {o}")
    return out


def mean_ci(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    m = sum(xs) / n
    if n < 2:
        return m, float("nan")
    var = sum((x - m) ** 2 for x in xs) / (n - 1)
    return m, 1.96 * math.sqrt(var / n)


def report(args):
    rows = []
    for pat in args.results:
        for f in sorted(glob.glob(pat)):
            rows += [json.loads(line) for line in open(f, encoding="utf8") if line.strip()]
    # multiplayer: (config half, game index) -> variant -> the branch seat's points
    multi: dict[tuple, dict[str, float]] = defaultdict(dict)
    size_of: dict[str, int] = {}
    duel: dict[str, list] = defaultdict(list)  # "a vs b" -> [(index, a won 1 / lost 0 / 0.5 limit)]
    for r in rows:
        table, _, rest = r["table"].partition("-")
        agents = r["agents"]
        bs = [i for i, a in enumerate(agents) if a.startswith(BRANCH)]
        if len(bs) == 1:
            v = agents[bs[0]].split(":", 1)[1]
            multi[(table, r["index"])][v] = r["points"][bs[0]]
            size_of[table] = len(agents)
        elif len(bs) == 2:
            a, b = (agents[i].split(":", 1)[1] for i in bs)
            w = r["winner"]
            key = tuple(sorted((a, b), key=lambda x: x != args.baseline))  # (baseline, other)
            other = key[1]
            won = 0.5 if w is None else float(agents[w] == seat_id(other))
            duel[f"{table[:-1]} {other} vs {key[0]}"].append(won)
    variants = sorted({v for d in multi.values() for v in d}, key=lambda v: (v != args.baseline, v))
    print(f"Multiplayer: the branch seat's mean leaderboard points per game, and the paired difference to {args.baseline} (95%)")
    print("| players | tables | variant | games | mean points | vs " + args.baseline + " |")
    print("| --- | --- | --- | --- | --- | --- |")
    by_size = defaultdict(list)
    for key in multi:
        by_size[size_of[key[0]]].append(key)
    for n in sorted(by_size):
        keys = by_size[n]
        tables = sorted({k[0][:-1] for k in keys})
        for v in variants:
            pts = [multi[k][v] for k in keys if v in multi[k]]
            if not pts:
                continue
            m, ci = mean_ci(pts)
            diff = ""
            if v != args.baseline:
                d = [multi[k][v] - multi[k][args.baseline] for k in keys if v in multi[k] and args.baseline in multi[k]]
                if d:
                    dm, dci = mean_ci(d)
                    diff = f"{dm:+.3f} ± {dci:.3f} ({len(d)} pairs)"
            print(f"| {n} | {', '.join(tables)} | {v} | {len(pts)} | {m:+.3f} ± {ci:.3f} | {diff} |")
    if duel:
        print("\n2 players, head to head (both seat orders): the variant's win share against " + args.baseline)
        print("| table | games | win share (95%) | turn limit |")
        print("| --- | --- | --- | --- |")
        for k in sorted(duel):
            xs = duel[k]
            m, ci = mean_ci(xs)
            print(f"| {k} | {len(xs)} | {m:.3f} ± {ci:.3f} | {sum(1 for x in xs if x == 0.5)} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("jobs")
    j.add_argument("--variants", default="teacher,net,netself", help="branch seat suffixes (generate.branch_variant), baseline first")
    j.add_argument("--baseline", default="teacher")
    j.add_argument("--games", type=int, default=500, help="games per multiplayer configuration and variant (two halves)")
    j.add_argument("--duel-games", type=int, default=1000, help="2-player games per pairing and map (both seat orders)")
    j.add_argument("--sizes", default="2,4,6,10")
    j.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("results", nargs="+", help="results JSONL files or globs")
    r.add_argument("--baseline", default="teacher")
    args = ap.parse_args()
    if args.cmd == "jobs":
        lines = jobs(args)
        with open(args.out, "w", encoding="utf8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        print(f"{len(lines) - 1} tables -> {args.out}")
    else:
        report(args)


if __name__ == "__main__":
    main()
