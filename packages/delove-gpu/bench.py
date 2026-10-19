"""Measure GPU self-play throughput: decisions and finished games per second at several batch sizes.

    python bench.py --engine fused --policy random --batch 1024,4096,16384,65536
    python bench.py --engine fused --policy net --model C:/.../models/delove/delove@2.pt --batch 1024,4096,16384 [--precision fp16]
    python bench.py --engine tensor-fast --policy random --batch 1024,65536

Engines: `tensor` (engine.py, exact mulberry32 dice), `tensor-fast` (engine.py, multinomial blitz), `fused` (fused.py,
one CUDA thread per game, exact dice). With `--engine fused --policy random` the moves are chosen inside the kernel
too, so whole stretches of play run without returning to Python.

Finished games restart with a new seed. games/s counts the games that finished inside the timed window (after a
warm-up, so starts are spread out); decisions/s counts every move made in the window. Both seats use the same policy.
"""
from __future__ import annotations

import argparse
import json
import time

import torch

from delove_gpu.engine import Engine
from delove_gpu.play import NetPlayer, load_delove, random_moves


def make_engine(kind: str, B: int, max_turns: int):
    if kind == "fused":
        from delove_gpu.fused import FusedEngine

        return FusedEngine(B, max_turns=max_turns)
    return Engine(B, max_turns=max_turns, exact=(kind == "tensor"), seed=1)


def bench_fused_random(B: int, seconds: float, warmup: float, max_turns: int, chunk: int) -> dict:
    e = make_engine("fused", B, max_turns)
    e.reset(torch.arange(B, device=e.dev), torch.arange(B) * 2654435761)
    stats = torch.zeros(4, dtype=torch.long, device=e.dev)
    counter = torch.zeros(1, dtype=torch.long, device=e.dev)
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < warmup:
        e.play_random(chunk, stats, counter)
        torch.cuda.synchronize()
    stats.zero_()
    t0 = time.perf_counter()
    launches = 0
    while time.perf_counter() - t0 < seconds:
        e.play_random(chunk, stats, counter)
        torch.cuda.synchronize()
        launches += 1
    span = time.perf_counter() - t0
    games, game_dec, turns, decided = stats.tolist()
    return {
        "engine": "fused", "policy": "random (in kernel)", "batch": B, "seconds": round(span, 1),
        "decisions_per_s": round(B * chunk * launches / span), "games_per_s": round(games / span, 1),
        "finished_games": games, "decisions_per_game": round(game_dec / max(1, games), 1),
        "turns_per_game": round(turns / max(1, games), 1), "turn_limit_share": round(1 - decided / max(1, games), 3),
    }


def bench_stepwise(kind: str, B: int, policy: str, seconds: float, warmup: float, model: str | None, precision: str, max_turns: int) -> dict:
    dev = "cuda"
    e = make_engine(kind, B, max_turns)
    gen = torch.Generator(device=dev).manual_seed(1)
    if policy == "net":
        choose = NetPlayer(e, load_delove(model, dev), temperature=0.0, precision=precision)
    else:
        choose = lambda mask: random_moves(mask, gen)  # noqa: E731
    seed = [12345]

    def restart(idx):
        e.reset(idx, (torch.arange(seed[0], seed[0] + len(idx)) * 2654435761) & 0xFFFFFFFF)
        seed[0] += len(idx)

    restart(torch.arange(B, device=dev))
    dec = torch.zeros(B, dtype=torch.long, device=dev)
    t_start = time.perf_counter()
    counting_from = t_start + warmup
    games = decisions = game_dec = turns = decided = 0
    while True:
        live = ~e.done
        mask = e.legal()
        e.step(choose(mask))
        dec += live.long()
        now = time.perf_counter()
        counting = now >= counting_from
        if counting:
            decisions += int(live.sum())
        if int(e.done.sum()) >= max(1, B // 32):
            idx = e.done.nonzero().squeeze(1)
            if counting:
                games += len(idx)
                game_dec += int(dec[idx].sum())
                turns += int(e.turn[idx].sum())
                decided += int((e.winner[idx] >= 0).sum())
            dec[idx] = 0
            restart(idx)
        if counting and now - counting_from >= seconds:
            break
    torch.cuda.synchronize()
    span = time.perf_counter() - counting_from
    return {
        "engine": kind, "policy": policy + (f"-{precision}" if policy == "net" else ""), "batch": B, "seconds": round(span, 1),
        "decisions_per_s": round(decisions / span), "games_per_s": round(games / span, 1), "finished_games": games,
        "decisions_per_game": round(game_dec / max(1, games), 1), "turns_per_game": round(turns / max(1, games), 1),
        "turn_limit_share": round(1 - decided / max(1, games), 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["tensor", "tensor-fast", "fused"], default="fused")
    ap.add_argument("--policy", choices=["random", "net"], default="random")
    ap.add_argument("--model")
    ap.add_argument("--batch", default="1024,4096,16384,65536")
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--warmup", type=float, default=30)
    ap.add_argument("--chunk", type=int, default=32, help="fused random: decisions per kernel launch")
    ap.add_argument("--precision", choices=["fp32", "tf32", "fp16"], default="fp32", help="network precision (play.py NetPlayer)")
    ap.add_argument("--max-turns", type=int, default=500)
    args = ap.parse_args()
    for B in [int(x) for x in args.batch.split(",")]:
        try:
            if args.engine == "fused" and args.policy == "random":
                r = bench_fused_random(B, args.seconds, args.warmup, args.max_turns, args.chunk)
            else:
                r = bench_stepwise(args.engine, B, args.policy, args.seconds, args.warmup, args.model, args.precision, args.max_turns)
        except torch.OutOfMemoryError:
            r = {"engine": args.engine, "policy": args.policy, "batch": B, "error": "out of GPU memory"}
        print(json.dumps(r), flush=True)
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
