"""Ladder matches (candidate vs best, mirrored pairs) on the GPU: the same games as `npm run delove -- ladder`.

EVALUATION ONLY. A match here is packages/selfplay/src/ladder.ts's `runMatch` played by the GPU mirror: game i is
seeded gameSeed(seed, floor(i / 2)) and seated by `matchSeats` (the candidate on even seats in even games, on odd
seats in odd games), the turn limit is a draw, and the result is `summarizeMatch` plus the leaderboard view (points,
bestPoints, pointsDiff, meanPlacement, killsPerGame) and `promotionDecision`, printed as the CLI prints it. Network
seats play from their `.pt` weights in fp32 (the ONNX model's top move but for rare near-ties, tests/replay.py --net).

    python -m delove_gpu.ladder --models models/delove --candidate c5-candidate --best delove@3 --players 6 \\
        --games 200 --seed 42 --options '{"map":"world"}'

Many matches at once (cycle.sh's gates): `--gates FILE --out DIR`, one match per line
`I K BEST PLAYERS GAMES SEED [OPTIONS JSON]`, each written to DIR/gI-K.json (skipped when it exists). Every match of
one configuration (map, seats, settings) shares one engine, with as many games in flight as fit in --gpu-gb.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import subprocess
import sys
from pathlib import Path

from . import teacher as _teacher
from .branch import default_branch
from .fingerprint import REPO
from .generate import BRANCH_ID, Run, Table

# A hand-coded seat (tuned teacher, and Jacob Sensei where the mirror has it); anything else is a network (.pt).
is_teacher = getattr(_teacher, "is_teacher", lambda a: a.startswith("delove-teacher@"))

MAX_ELO = 800


def js_round(x: float) -> float:
    """JavaScript's Math.round (halves toward +infinity)."""
    return float(math.floor(x + 0.5))


def r3(x: float) -> float:
    return js_round(x * 1000) / 1000


def elo_from_score(s: float) -> float:
    if s <= 0:
        return -MAX_ELO
    if s >= 1:
        return MAX_ELO
    return max(-MAX_ELO, min(MAX_ELO, 400 * math.log10(s / (1 - s))))


def js_num(x) -> str:
    """A number as JavaScript prints it in a template string (1, not 1.0)."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def summarize(candidate: str, best: str, scores: list[float], turns: list[int], turn_limit: int, pair_size: int = 2) -> dict:
    """ladder.ts summarizeMatch, operation for operation."""
    n = len(scores)
    mean = sum(scores) / n if n else 0.5
    units = []
    for i in range(0, n, pair_size):
        g = scores[i:i + pair_size]
        units.append(sum(g) / len(g))
    u = len(units)
    variance = sum((a - mean) ** 2 for a in units) / (u - 1) if u > 1 else 0.25
    se = math.sqrt(max(variance, 0.09 / pair_size) / max(u, 1))
    lo = max(0, mean - 1.96 * se)
    hi = min(1, mean + 1.96 * se)
    return {
        "candidate": candidate, "best": best, "games": n,
        "wins": sum(1 for s in scores if s == 1), "losses": sum(1 for s in scores if s == 0), "draws": sum(1 for s in scores if s == 0.5),
        "score": r3(mean), "scoreLow": r3(lo), "scoreHigh": r3(hi),
        "elo": js_round(elo_from_score(mean)), "eloLow": js_round(elo_from_score(lo)), "eloHigh": js_round(elo_from_score(hi)),
        "turnLimit": turn_limit, "meanTurns": js_round(sum(turns) / n * 10) / 10 if n else 0,
    }


def promotion(r: dict, min_games: int = 200, threshold: float = 0.55) -> dict:
    """ladder.ts promotionDecision (DEFAULT_PROMOTION)."""
    if r["games"] < min_games:
        return {"promote": False, "reason": f"only {r['games']} games (need {min_games})"}
    if r["score"] < threshold:
        return {"promote": False, "reason": f"score {js_num(r['score'])} below {js_num(threshold)}"}
    if r["scoreLow"] <= 0.5:
        return {"promote": False, "reason": f"95% interval reaches {js_num(r['scoreLow'])}, not clearly better than 0.5"}
    elo = r["elo"]
    return {"promote": True, "reason": f"score {js_num(r['score'])} (95% {js_num(r['scoreLow'])}-{js_num(r['scoreHigh'])}, "
                                       f"{'+' if elo >= 0 else ''}{js_num(elo)} Elo) over {r['games']} games"}


def tidy(d: dict) -> dict:
    """Whole floats as ints, as JSON.stringify writes them."""
    return {k: (int(v) if isinstance(v, float) and v.is_integer() else v) for k, v in d.items()}


class Match:
    """One ladder match: two tables (even games, odd games) on the same seed, pair k = game 2k and 2k+1."""

    def __init__(self, key: str, candidate: str, best: str, players: int, games: int, seed: int, options: dict):
        if players < 2 or players % 2:
            raise SystemExit(f"{key}: --players must be an even number (2, 4, ...) for a ladder match")
        if candidate == best:
            raise SystemExit(f"{key}: candidate and best are the same version")
        self.key, self.candidate, self.best, self.players, self.seed, self.options = key, candidate, best, players, seed, options
        self.line = ""  # its --gates line, to hand it to another process
        self.games = math.ceil(games / 2) * 2
        # matchSeats: seat s of game i is the candidate when (s + i) % 2 == 0
        self.tables = [Table(f"{key}#{p}", self.games // 2, [candidate if (s + p) % 2 == 0 else best for s in range(players)],
                             0, options, seed) for p in (0, 1)]

    def result(self, games: list[dict]) -> dict:
        """runMatch's result from this match's per-game results (any order)."""
        by_i = {}
        for g in games:
            p = int(g["table"].rsplit("#", 1)[1])
            by_i[2 * g["index"] + p] = g
        if sorted(by_i) != list(range(self.games)):
            raise RuntimeError(f"{self.key}: {len(by_i)} of {self.games} games")
        scores, turns, turn_limit = [], [], 0
        pts = {"cand": 0.0, "best": 0.0, "candSeats": 0, "bestSeats": 0, "place": 0, "kills": 0}
        for i in range(self.games):  # game order, seat order: the sums runMatch adds up, in its order
            g = by_i[i]
            w = g["winner"]
            scores.append(0.5 if w is None else (1.0 if (w + i) % 2 == 0 else 0.0))
            turns.append(g["turns"])
            if w is None:
                turn_limit += 1
            for s, p in enumerate(g["points"]):
                if (s + i) % 2 == 0:
                    pts["cand"] += p
                    pts["candSeats"] += 1
                    pts["place"] += g["placement"][s]
                    pts["kills"] += g["kills"][s]
                else:
                    pts["best"] += p
                    pts["bestSeats"] += 1
        points = r3(pts["cand"] / max(1, pts["candSeats"]))
        best_points = r3(pts["best"] / max(1, pts["bestSeats"]))
        out = summarize(self.candidate, self.best, scores, turns, turn_limit, 2)
        out.update({"points": points, "bestPoints": best_points, "pointsDiff": r3(points - best_points),
                    "meanPlacement": r3(pts["place"] / max(1, pts["candSeats"])), "killsPerGame": r3(pts["kills"] / max(1, pts["candSeats"]))})
        return tidy({**out, **promotion(out)})

    def games_of(self, results: list[dict]) -> list[dict]:
        """Per-game rows of this match in game order (i, seed pair, winner, turns, placement, kills, points)."""
        rows = []
        for g in results:
            if g["table"].rsplit("#", 1)[0] == self.key:
                p = int(g["table"].rsplit("#", 1)[1])
                rows.append({"match": self.key, "i": 2 * g["index"] + p, "winner": g["winner"], "turns": g["turns"],
                             "placement": g["placement"], "kills": g["kills"], "points": g["points"]})
        return sorted(rows, key=lambda r: r["i"])


def teacher_of(m: Match, models: Path) -> str:
    """The teacher version a match seats (its opponent, when that is a tuned teacher), else the newest in --models."""
    for a in (m.candidate, m.best):
        if is_teacher(a):
            return a
    vs = sorted((int(p.stem.split("@")[1]), p.stem) for p in models.glob("delove-teacher@*.json"))
    return vs[-1][1] if vs else "delove-teacher@1"


def play(matches: list[Match], models: Path, batch: int | None, gpu_gb: float, max_turns: int, allow_unverified: bool) -> list[dict]:
    """Every match's per-game results. Matches are grouped by teacher version (one per Run), and within a Run every
    match of one configuration shares one engine."""
    results: list[dict] = []
    by_teacher: dict[str, list[Match]] = {}
    for m in matches:
        if BRANCH_ID in (m.candidate, m.best):
            raise SystemExit(f"{m.key}: {BRANCH_ID} is not a ladder seat on the GPU (its ranker would be a guess)")
        by_teacher.setdefault(teacher_of(m, models), []).append(m)
    for teacher, ms in by_teacher.items():
        tables = [t for m in ms for t in m.tables]
        nets = sorted({a for m in ms for a in (m.candidate, m.best) if not is_teacher(a)})
        ranker = nets[0] if nets else "delove@2"  # loaded by Run; no branch seat ever uses it here
        run = Run(tables, 0, models, ranker, teacher, default_branch(), [], None, max_turns, "fp32", "cuda", allow_unverified)
        with contextlib.redirect_stdout(sys.stderr):  # progress lines; stdout is the JSON
            info = run.run(batch, gpu_gb * 2**30)
        print(f"  peak GPU memory per configuration: {[(g['config'], g['peak_gpu_gb']) for g in info['groups']]}", file=sys.stderr)
        results += run.results
    return results


def read_gates(path: str, candidate: str) -> list[Match]:
    out = []
    for line in Path(path).read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 6)
        i, k, best, players, games, seed = parts[:6]
        options = json.loads(parts[6]) if len(parts) > 6 else {}
        m = Match(f"g{i}-{k}", candidate, best, int(players), int(games), int(seed), options)
        m.line = line
        out.append(m)
    return out


def config_key(m: Match) -> tuple:
    return (m.players, json.dumps(m.options, sort_keys=True))


def cost(key: tuple) -> int:
    """Rough GPU time of a configuration: a match lasts as long as its longest game (the lockstep loop's steps), which
    grows with the seats and the board."""
    players, options = key
    board = {"greater_europe": 116, "world_large": 80, "world": 64, "fantasy": 56, "usa": 50, "europe": 48, "asia": 48}
    return players * board.get(json.loads(options).get("map", "classic"), 42)


def split(matches: list[Match], procs: int) -> list[list[Match]]:
    """Whole configurations over `procs` parts, the costliest first, each to the least loaded part."""
    by_cfg: dict[tuple, list[Match]] = {}
    for m in matches:
        by_cfg.setdefault(config_key(m), []).append(m)
    bins: list[tuple[int, list[Match]]] = [(0, []) for _ in range(min(procs, len(by_cfg)))]
    for key in sorted(by_cfg, key=cost, reverse=True):
        j = min(range(len(bins)), key=lambda b: bins[b][0])
        bins[j] = (bins[j][0] + cost(key), bins[j][1] + by_cfg[key])
    return [b[1] for b in bins]


def write_results(path: str, matches: list[Match], results: list[dict]):
    with open(path, "w", encoding="utf8") as f:
        for m in matches:
            for row in m.games_of(results):
                f.write(json.dumps(row) + "\n")


def run_procs(args, matches: list[Match], out: Path) -> int:
    """--procs: the configurations over several processes of this module, each with its own part of the gates."""
    procs = []
    for n, part in enumerate(split(matches, args.procs)):
        f = out / f"gpu-part{n}.txt"
        f.write_text("".join(m.line + "\n" for m in part), encoding="utf8")
        cmd = [sys.executable, "-m", "delove_gpu.ladder", "--candidate", args.candidate, "--gates", str(f), "--out", str(out),
               "--models", args.models, "--batch", str(args.batch), "--gpu-gb", str(args.gpu_gb), "--max-turns", str(args.max_turns)]
        if args.allow_unverified:
            cmd.append("--allow-unverified")
        if args.results:
            cmd += ["--results", f"{args.results}.part{n}"]
        print(f"process {n}: {sorted({config_key(m) for m in part}, key=cost, reverse=True)}", file=sys.stderr, flush=True)
        procs.append(subprocess.Popen(cmd, cwd=Path(__file__).resolve().parent.parent, stdout=subprocess.DEVNULL))
    codes = [p.wait() for p in procs]
    if args.results:
        with open(args.results, "w", encoding="utf8") as f:
            for n in range(len(procs)):
                part = Path(f"{args.results}.part{n}")
                if part.exists():
                    f.write(part.read_text(encoding="utf8"))
                    part.unlink()
    print(json.dumps({"matches": len(matches), "processes": len(procs), "exitCodes": codes}))
    return 1 if any(codes) else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--best", help="one match: the opponent")
    ap.add_argument("--players", type=int, default=2)
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--options", default="{}", help="game settings JSON, as the ladder CLI takes them")
    ap.add_argument("--map", help="shorthand for {\"map\": ...}")
    ap.add_argument("--gates", help="many matches: lines 'I K BEST PLAYERS GAMES SEED [OPTIONS JSON]'")
    ap.add_argument("--out", help="with --gates: write each match's JSON to OUT/gI-K.json")
    ap.add_argument("--models", default=str(REPO / "models" / "delove"))
    ap.add_argument("--batch", type=int, default=0, help="games in flight per configuration (0: sized to --gpu-gb)")
    ap.add_argument("--gpu-gb", type=float, default=3.0)
    ap.add_argument("--max-turns", type=int, default=500)
    ap.add_argument("--results", help="write one JSON line per game here (match, game i, winner, turns, placement, kills, points)")
    ap.add_argument("--allow-unverified", action="store_true", help="run even if the mirror is not verified for this engine")
    ap.add_argument("--procs", type=int, default=1, help="with --gates: GPU processes, each taking whole configurations (a match"
                    " lasts as long as its longest game's steps, so configurations overlap well)")
    args = ap.parse_args()
    models = Path(args.models)
    if args.gates:
        if not args.out:
            ap.error("--gates needs --out")
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        matches = [m for m in read_gates(args.gates, args.candidate) if not (out / f"{m.key}.json").exists()]
        if args.procs > 1 and len({config_key(m) for m in matches}) > 1:
            return run_procs(args, matches, out)
    else:
        if not args.best:
            ap.error("one match needs --best (or --gates)")
        options = json.loads(args.options)
        if args.map:
            options["map"] = args.map
        matches = [Match("match", args.candidate, args.best, args.players, args.games, args.seed, options)]
    results: list[dict] = []
    # one configuration at a time, its gate files written as soon as it is done (a stopped run keeps them)
    for ms in (split(matches, len(matches)) if args.gates else [matches]):
        part = play(ms, models, args.batch or None, args.gpu_gb, args.max_turns, args.allow_unverified)
        results += part
        by_key: dict[str, list[dict]] = {}
        for g in part:
            by_key.setdefault(g["table"].rsplit("#", 1)[0], []).append(g)
        for m in ms:
            res = m.result(by_key.get(m.key, []))
            if args.gates:
                tmp = out / f"{m.key}.json.tmp"
                tmp.write_text(json.dumps(res, indent=2) + "\n", encoding="utf8", newline="\n")  # as Node writes it
                tmp.replace(out / f"{m.key}.json")
            else:
                print(json.dumps(res, indent=2))
    if args.results:
        write_results(args.results, matches, results)
    if args.gates:
        print(json.dumps({"matches": len(matches), "games": len(results)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
