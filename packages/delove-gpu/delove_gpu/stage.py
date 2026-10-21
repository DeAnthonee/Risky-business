"""Stage-focused games for the Delove range specialists (packages/selfplay/src/positions.ts on the GPU).

A stage table's agents are written `LEAD>STAGE`:

- `A,B,C,D,E,F>X,Y,Z`: a lead-in. Seats A..F play a normal game until 3 real players are left (as many as STAGE
  lists), then X, Y, Z take the survivors' seats and only from then on are decisions recorded.
- `pos:FILE>X,Y`: games start from a positions file's moments with 2 players alive (`npm run selfplay -- positions`
  writes them from game records). Game i plays position i mod count, with its own dice from the game seed.

Who plays which survivor (stage_seats) and how a position is reseeded (load_positions) match positions.ts, so a
stage game here is the same game as `npm run selfplay -- play` plays (tests/stage_check.py compares the data).
"""
from __future__ import annotations

import json
from pathlib import Path

import torch

from .config import COVERED, GameConfig
NEUTRAL = "neutral"
PHASE_NAMES = ["lobby", "setup", "capitals", "reinforce", "attack", "fortify", "finished"]  # engine.py LOBBY..FINISHED, log.ts PHASES


def parse_agents(token: str) -> tuple[list[str] | None, str | None, list[str] | None]:
    """'A,B>X,Y' -> (lead-in agents, None, stage agents); 'pos:FILE>X,Y' -> (None, FILE, stage agents); 'A,B' ->
    (agents, None, None)."""
    lead, sep, stage = token.partition(">")
    st = [a.strip() for a in stage.split(",")] if sep else None
    if lead.startswith("pos:"):
        if not st:
            raise ValueError(f"{token!r}: a positions table needs its stage agents after '>'")
        return None, lead[4:], st
    return [a.strip() for a in lead.split(",")], None, st


def read_positions(path: str | Path, alive: int) -> list[dict]:
    """A positions file's moments with `alive` real players left, in file order (positions.ts readPositions)."""
    out = []
    for line in Path(path).read_text(encoding="utf8").splitlines():
        if line.strip():
            p = json.loads(line)
            if p["alive"] == alive:
                out.append(p)
    if not out:
        raise SystemExit(f"{path} has no position with {alive} players alive")
    return out


def position_config(pos: dict) -> GameConfig:
    """The table a position is played at: its map, seats and the settings the mirror covers (fog is off in every
    position; the others, e.g. turn timers, do not change a game played by bots)."""
    o = pos["state"]["options"]
    if o.get("fogOfWar"):
        raise ValueError(f"{pos['source']}: fog of war is not mirrored")
    return GameConfig.make(pos["seats"], {k: o[k] for k in COVERED if k in o})


def mulberry_shuffle(arr: list, seed: int) -> list:
    """rng.ts shuffle(createRng(seed), arr)."""
    a, st = list(arr), seed & 0xFFFFFFFF
    for i in range(len(a) - 1, 0, -1):
        st = (st + 0x6D2B79F5) & 0xFFFFFFFF
        t = st
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        u = (t ^ (t >> 14)) & 0xFFFFFFFF
        j = (u * (i + 1)) >> 32
        a[i], a[j] = a[j], a[i]
    return a


def load_positions(e, slots: list[int], positions: list[dict], seeds: list[int]):
    """Put positions[k] into game slot slots[k] of engine e (every State field), ready to play as game seeds[k]:
    rngState = the seed and the undrawn deck reshuffled with mulberry32(seed ^ 0x5bd1e995) (positions.ts startState).
    The agent streams are seeded as for any game (seat_streams)."""
    n, NEU, T, H = e.n, e.NEU, e.m.T, e.H
    tid = {t: i for i, t in enumerate(e.m.territory_ids)}
    seat = {f"s{i}": i for i in range(n)}
    seat[NEUTRAL] = NEU
    rows: dict[str, list] = {f: [] for f in ("owner", "armies", "alive", "atp", "hand", "hand_n", "trades_made", "trade_count", "deck", "deck_n",
                                              "discard", "discard_n", "order", "cur_pos", "phase", "turn", "round", "pend", "conquered",
                                              "fortified", "rng", "capital", "bliz", "elim_by", "elim_seq", "elim_n")}
    for pos, seed in zip(positions, seeds):
        s = pos["state"]
        players = {p["id"]: p for p in s["players"]}
        if [p["id"] for p in s["players"] if not p["isNeutral"]] != [f"s{i}" for i in range(n)]:
            raise ValueError(f"{pos['source']}: seats are not s0..s{n - 1}")
        owner, armies = [-1] * T, [0] * T
        for t, ts in s["territories"].items():
            owner[tid[t]] = -1 if ts["owner"] is None else seat[ts["owner"]]
            armies[tid[t]] = ts["armies"]
        alive = [bool(players[f"s{i}"]["alive"]) for i in range(n)] + [bool(players[NEUTRAL]["alive"]) if NEUTRAL in players else False]
        atp = [players[f"s{i}"]["armiesToPlace"] for i in range(n)] + [players[NEUTRAL]["armiesToPlace"] if NEUTRAL in players else 0]
        hand, hand_n, trades = [], [], []
        for p in range(e.P):
            cards = [c["id"] for c in players[f"s{p}" if p < n else NEUTRAL]["cards"]] if (p < n or NEUTRAL in players) else []
            if len(cards) > H:
                raise ValueError(f"{pos['source']}: a hand of {len(cards)} cards")
            hand.append(cards + [-1] * (H - len(cards)))
            hand_n.append(len(cards))
            trades.append(players[f"s{p}"].get("tradesMade", 0) if p < n else 0)
        deck = [c["id"] for c in mulberry_shuffle(s["deck"], (seed ^ 0x5BD1E995) & 0xFFFFFFFF)]
        discard = [c["id"] for c in s["discard"]]
        order = [seat[p] for p in s["turnOrder"]]
        cur = s["currentPlayer"]
        pc = s["pendingConquest"]
        out_order = pos["eliminated"]
        elim_by, elim_seq = [-1] * e.P, [-1] * e.P
        for k, pid in enumerate(out_order):
            q = seat[pid]
            elim_seq[q] = k
            by = players[pid].get("eliminatedBy")
            elim_by[q] = seat[by] if by is not None else -1
        rows["owner"].append(owner)
        rows["armies"].append(armies)
        rows["alive"].append(alive)
        rows["atp"].append(atp)
        rows["hand"].append(hand)
        rows["hand_n"].append(hand_n)
        rows["trades_made"].append(trades)
        rows["trade_count"].append(s["tradeCount"])
        rows["deck"].append(deck + [0] * (e.m.NC - len(deck)))
        rows["deck_n"].append(len(deck))
        rows["discard"].append(discard + [0] * (e.m.NC - len(discard)))
        rows["discard_n"].append(len(discard))
        rows["order"].append(order)
        rows["cur_pos"].append(s["turnOrder"].index(cur))
        rows["phase"].append(PHASE_NAMES.index(s["phase"]))
        rows["turn"].append(s["turnNumber"])
        rows["round"].append(s["round"])
        rows["pend"].append([tid[pc["from"]], tid[pc["to"]], pc["minArmies"], pc["maxArmies"]] if pc else [-1, -1, 0, 0])
        rows["conquered"].append(bool(players[cur]["conqueredThisTurn"]))
        rows["fortified"].append(bool(s["fortifiedThisTurn"]))
        rows["rng"].append(seed & 0xFFFFFFFF)
        caps = [-1] * n
        for p, t in s["capitals"].items():
            caps[seat[p]] = tid[t]
        rows["capital"].append(caps)
        bl = [False] * T
        for t in s["blizzards"]:
            bl[tid[t]] = True
        rows["bliz"].append(bl)
        rows["elim_by"].append(elim_by)
        rows["elim_seq"].append(elim_seq)
        rows["elim_n"].append(len(out_order))
    g = torch.tensor(slots, dtype=torch.long, device=e.dev)
    for f, v in rows.items():
        if f == "pend":
            pv = torch.tensor(v, dtype=torch.long, device=e.dev)
            e.pend_from[g], e.pend_to[g], e.pend_min[g], e.pend_max[g] = pv.unbind(1)
            continue
        dst = getattr(e, f)
        dst[g] = torch.tensor(v, dtype=dst.dtype, device=e.dev)
    e.seed[g] = torch.tensor([x & 0xFFFFFFFF for x in seeds], dtype=torch.long, device=e.dev)
    e.fort_src[g] = -1
    e.winner[g] = -1
    e.done[g] = False


def stage_seats(order: list[int], cur_pos: int, alive: list[bool], k: int, rotate: int) -> dict[int, int]:
    """positions.ts stageSeats: the survivors in turn order from the player to move get stage agent (r + rotate) % k."""
    n = len(order)
    out, r = {}, 0
    for j in range(n):
        q = order[(cur_pos + j) % n]
        if alive[q]:
            out[q] = (r + rotate) % k
            r += 1
    return out
