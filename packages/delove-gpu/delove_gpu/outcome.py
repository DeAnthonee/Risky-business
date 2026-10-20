"""A finished game's outcome as self-play records it (packages/selfplay/src/game.ts, log v3): z, and the leaderboard's
final placements, kills and points (packages/engine/src/ranking.ts finalPlacements / gamePoints).

The points table (placementPoints for every table size) and KILL_POINTS are read from the built engine, so the
scoring itself is never re-implemented; only finalPlacements' ordering is mirrored here, from the GPU state (the
kernel records who eliminated whom and in which order). The replay test compares all of it with v3 logs.
"""
from __future__ import annotations

import json
import os
import subprocess
from functools import cmp_to_key, lru_cache

from .fingerprint import REPO


@lru_cache(maxsize=1)
def ranking_constants() -> dict:
    js = ("import * as e from './packages/engine/dist/index.js'; const place = {};"
          "for (let n = 2; n <= 10; n++) place[n] = Array.from({length: n}, (_, i) => e.placementPoints(i + 1, n));"
          "console.log(JSON.stringify({killPoints: e.KILL_POINTS, place}));")
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        raise RuntimeError(f"reading the engine's ranking constants failed (npm run build first?): {r.stderr}")
    c = json.loads(r.stdout)
    return {"kill": c["killPoints"], "place": {int(k): v for k, v in c["place"].items()}}


def outcome(winner: int | None, alive: list[bool], elim_seq: list[int], elim_by: list[int], turn_pos: list[int],
            territories: list[int], armies: list[int]) -> dict:
    """Per seat: z, placement, kills, points, points01 (as export.ts scales them). Seats are 0..n-1; elim_by may name
    the Neutral (an index >= n), which credits nobody."""
    n = len(alive)
    c = ranking_constants()

    def cmp(a: int, b: int) -> int:
        if a == winner:
            return -1
        if b == winner:
            return 1
        if alive[a] != alive[b]:
            return -1 if alive[a] else 1
        if not alive[a]:
            return (elim_seq[b] - elim_seq[a]) or (turn_pos[a] - turn_pos[b])
        return (territories[b] - territories[a]) or (armies[b] - armies[a]) or (turn_pos[a] - turn_pos[b])

    ranked = sorted(range(n), key=cmp_to_key(cmp))
    placement = [0] * n
    for i, s in enumerate(ranked):
        placement[s] = i + 1
    kills = [sum(1 for v in range(n) if not alive[v] and elim_by[v] == s) for s in range(n)]
    place = c["place"][n]
    points = [place[n - 1] if winner is None else place[placement[s] - 1] + c["kill"] * kills[s] for s in range(n)]
    lo, hi = place[n - 1], place[0] + c["kill"] * (n - 1)
    survivors = sum(alive)
    z = [(1.0 if s == winner else 0.0) if winner is not None else (1.0 / survivors if alive[s] else 0.0) for s in range(n)]
    return {"z": z, "placement": placement, "kills": kills, "points": points, "points01": [(p - lo) / (hi - lo) for p in points]}


def game_outcome(e, b: int) -> dict:
    """outcome() of game b of a FusedEngine (state copied to the host)."""
    n = e.n
    won = int(e.phase[b]) == 6
    owner = e.owner[b].tolist()
    arm = e.armies[b].tolist()
    order = e.order[b].tolist()
    turn_pos = [order.index(s) for s in range(n)]
    terr = [sum(1 for o in owner if o == s) for s in range(n)]
    armies = [sum(a for o, a in zip(owner, arm) if o == s) for s in range(n)]
    return outcome(int(e.winner[b]) if won else None, [bool(x) for x in e.alive[b, :n].tolist()], e.elim_seq[b, :n].tolist(),
                   e.elim_by[b, :n].tolist(), turn_pos, terr, armies)
