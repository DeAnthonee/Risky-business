"""Compare two branch-and-score settings on the GPU by leaderboard points: one delove-branch@1 seat against a fixed
field (delove@3 and one Sensei 2), the same games (seeds, seats, opponents) played once per setting, so each game is a paired comparison.

    python scripts/score_compare.py jobs OUT.jobs [--scale 1]       # the tables: 2p Classic, 4/6/10p on four maps
    python -m delove_gpu.generate --jobs OUT.jobs --seed 7 --horizon 1 --margin 0.01 --ranker delove@3 \\
        --teacher delove-teacher@2 --score share  --results share.jsonl
    python -m delove_gpu.generate ... --score points --results points.jsonl
    python scripts/score_compare.py report share.jsonl points.jsonl

Or head to head, every score at the same tables (GPU-only seats delove-branch@1:share / :points / :kills, spread
round the table in every order, from every seat; one run instead of one per score, and each game is still a pair):

    python scripts/score_compare.py h2h-jobs OUT.jobs [--variants share,points,kills] [--sizes 4:520,6:528] [--maps world]
    python -m delove_gpu.generate --jobs OUT.jobs ... --results h2h.jsonl
    python scripts/score_compare.py h2h-report h2h.jsonl

The report gives, per table size, the branch seat's mean points (placement + kills, finalPlacements / gamePoints as
the leaderboard scores them; a turn-limit game scores last place for everyone), the paired difference B - A with a
95% interval, win share, kills per game and the turn-limit rate.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict

BR = "delove-branch@1"
# The field: delove@3 seats and one Sensei 2 (the seat after the branch player). Fields with Sensei 2 in half the seats
# stall: 35% of World 4-player games reached the 500-turn limit, and each table took 4x as long.
NET, SENSEI = "delove@3", "delove-teacher@2"
MAPS = {4: ["world", "classic", "fantasy", "greater_europe"], 6: ["world", "classic", "fantasy", "greater_europe"],
        10: ["world", "fantasy", "greater_europe"]}


def make_jobs(scale: float) -> list[str]:
    lines = []
    # 2 players, Classic: against the network and against Sensei 2, the branch player first and second
    for opp, tag in [("delove@3", "n"), ("delove-teacher@2", "t")]:
        for k in range(2):
            seats = [BR, opp] if k == 0 else [opp, BR]
            lines.append(f"c2{tag}{k} {int(250 * scale)} {','.join(seats)} {k * 100000} {{}}")
    # 4, 6 and 10 players: the branch player in every seat in turn, then Sensei 2, the other seats delove@3
    for n, maps in MAPS.items():
        per_map = {4: 260, 6: 264, 10: 340}[n]
        for m in maps:
            for k in range(n):
                seats = [NET] * n
                seats[k] = BR
                seats[(k + 1) % n] = SENSEI
                games = max(1, int(per_map * scale) // n)
                lines.append(f"{m[:2]}{n}s{k} {games} {','.join(seats)} {k * 100000} {json.dumps({'map': m})}")
    return lines


def make_h2h_jobs(scale: float, variants: list[str], sizes: dict[int, int], maps: dict[int, list[str]]) -> list[str]:
    """Every variant at each table, spread evenly round it (variant j at seat k + j * n / V), in every cyclic order
    and from every seat k; the seat after the first variant's is Sensei 2, the rest delove@3."""
    lines = []
    V = len(variants)
    for n, per_map in sizes.items():
        for m in maps[n]:
            for k in range(n):
                for rot in range(V):
                    seats = [NET] * n
                    seats[(k + 1) % n] = SENSEI
                    for j in range(V):
                        seats[(k + j * n // V) % n] = f"{BR}:{variants[(j + rot) % V]}"
                    games = max(1, int(per_map * scale) // (V * n))
                    lines.append(f"{m[:2]}{n}s{k}{'abcdef'[rot]} {games} {','.join(seats)} {k * 100000 + rot * 20000} {json.dumps({'map': m})}")
    return lines


def h2h_report(paths: list[str]):
    rows = [json.loads(line) for p in paths for line in open(p, encoding="utf8")]
    variants = sorted({a.split(":", 1)[1] for r in rows for a in r["agents"] if a.startswith(BR + ":")}, key=lambda v: (v != "share", v))
    by = defaultdict(list)
    for r in rows:
        by[len(r["agents"])].append(r)
        by[(len(r["agents"]), r["table"][:2])].append(r)
    base = variants[0]
    print(f"{len(rows)} games, every score at every table ({', '.join(variants)}); differences against {base}, paired by game\n")
    head = " | ".join(f"{v} points" for v in variants) + " | " + " | ".join(f"{v} - {base} (95%)" for v in variants[1:])
    head += " | " + " | ".join(f"{v} wins" for v in variants) + " | " + " | ".join(f"{v} kills" for v in variants)
    print(f"| table | games | {head} | turn limit |")
    print("|---|---|" + "---|" * (4 * len(variants) - 1) + "---|")
    for key in sorted(by, key=lambda k: (k if isinstance(k, int) else k[0], 0 if isinstance(k, int) else 1, str(k))):
        rs = by[key]
        st = {}
        for v in variants:
            seat = [r["agents"].index(f"{BR}:{v}") for r in rs]
            st[v] = ([r["points"][i] for r, i in zip(rs, seat)], sum(r["winner"] == i for r, i in zip(rs, seat)) / len(rs),
                     sum(r["kills"][i] for r, i in zip(rs, seat)) / len(rs))
        cells = [f"{ci(st[v][0])[0]:+.3f} ± {ci(st[v][0])[1]:.3f}" for v in variants]
        for v in variants[1:]:
            d = ci([b - a for a, b in zip(st[base][0], st[v][0])])
            cells.append(f"**{d[0]:+.3f} ± {d[1]:.3f}**")
        cells += [f"{st[v][1]:.3f}" for v in variants] + [f"{st[v][2]:.2f}" for v in variants]
        lim = sum(r["winner"] is None for r in rs) / len(rs)
        name = f"**{key} players**" if isinstance(key, int) else f"{key[1]} {key[0]}p"
        print(f"| {name} | {len(rs)} | {' | '.join(cells)} | {lim:.1%} |")


def load(path: str) -> dict:
    out = {}
    for line in open(path, encoding="utf8"):
        r = json.loads(line)
        out[(r["table"], r["index"])] = r
    return out


def ci(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    return m, 1.96 * sd / math.sqrt(n)


def report(a_path: str, b_path: str, a_name: str, b_name: str):
    a, b = load(a_path), load(b_path)
    keys = sorted(set(a) & set(b))
    by = defaultdict(list)
    for k in keys:
        by[len(a[k]["agents"])].append(k)
    print(f"{len(keys)} paired games ({len(a)} in {a_name}, {len(b)} in {b_name})\n")
    print(f"| players | games | {a_name} points | {b_name} points | {b_name} - {a_name} (95%) | {a_name} wins | {b_name} wins"
          f" | {a_name} kills | {b_name} kills | {a_name} turn limit | {b_name} turn limit |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for n in sorted(by):
        ks = by[n]
        stats = {}
        for name, d in [(a_name, a), (b_name, b)]:
            pts, wins, kills, lim = [], 0, 0, 0
            for k in ks:
                r = d[k]
                s = r["agents"].index(BR)
                pts.append(r["points"][s])
                wins += r["winner"] == s
                kills += r["kills"][s]
                lim += r["winner"] is None
            stats[name] = (ci(pts), wins / len(ks), kills / len(ks), lim / len(ks), pts)
        diff = ci([y - x for x, y in zip(stats[a_name][4], stats[b_name][4])])
        (ma, ea), wa, ka, la, _ = stats[a_name]
        (mb, eb), wb, kb, lb, _ = stats[b_name]
        print(f"| {n} | {len(ks)} | {ma:+.3f} ± {ea:.3f} | {mb:+.3f} ± {eb:.3f} | **{diff[0]:+.3f} ± {diff[1]:.3f}** | {wa:.3f} | {wb:.3f}"
              f" | {ka:.2f} | {kb:.2f} | {la:.1%} | {lb:.1%} |")
    # per map and size, for the multiplayer tables
    print(f"\n| table | games | {b_name} - {a_name} points (95%) | {a_name} turn limit | {b_name} turn limit |")
    print("|---|---|---|---|---|")
    groups = defaultdict(list)
    for k in keys:
        r = a[k]
        groups[(len(r["agents"]), k[0][:2])].append(k)
    for (n, m), ks in sorted(groups.items()):
        s = [a[k]["agents"].index(BR) for k in ks]
        d = ci([b[k]["points"][i] - a[k]["points"][i] for k, i in zip(ks, s)])
        la = sum(a[k]["winner"] is None for k in ks) / len(ks)
        lb = sum(b[k]["winner"] is None for k in ks) / len(ks)
        print(f"| {m} {n}p | {len(ks)} | {d[0]:+.3f} ± {d[1]:.3f} | {la:.1%} | {lb:.1%} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("jobs")
    j.add_argument("out")
    j.add_argument("--scale", type=float, default=1.0)
    r = sub.add_parser("report")
    r.add_argument("a")
    r.add_argument("b")
    r.add_argument("--names", default="share,points")
    hj = sub.add_parser("h2h-jobs")
    hj.add_argument("out")
    hj.add_argument("--scale", type=float, default=1.0)
    hj.add_argument("--variants", default="share,points", help="scores at each table (delove-branch@1:<score> seats)")
    hj.add_argument("--sizes", default="4:520,6:528,10:500", help="players:games per map")
    hj.add_argument("--maps", default="", help="only these maps (comma-separated)")
    hr = sub.add_parser("h2h-report")
    hr.add_argument("results", nargs="+")
    args = ap.parse_args()
    if args.cmd == "h2h-report":
        h2h_report(args.results)
    elif args.cmd in ("jobs", "h2h-jobs"):
        if args.cmd == "jobs":
            lines = make_jobs(args.scale)
        else:
            sizes = {int(a): int(b) for a, b in (x.split(":") for x in args.sizes.split(","))}
            only = set(args.maps.split(",")) - {""}
            maps = {n: [m for m in MAPS[n] if not only or m in only] for n in sizes}
            lines = make_h2h_jobs(args.scale, args.variants.split(","), sizes, maps)
        with open(args.out, "w", encoding="utf8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"{len(lines)} tables, {sum(int(x.split()[1]) for x in lines)} games -> {args.out}")
    else:
        an, bn = args.names.split(",")
        report(args.a, args.b, an, bn)


if __name__ == "__main__":
    main()
