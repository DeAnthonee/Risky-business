"""Decision records and GPU game states as flat integer vectors, for replaying many games quickly.

`pack_record` turns a logged record (log.ts encodeState plus the header fields) into one int64 vector, `pack_states`
turns every GPU game's state into the same layout at once, so a whole batch is compared in a few numpy operations per
step. Candidates are [kind, x, y, z] rows in the log's order (`cand_rows`), compared with the GPU's legal moves in
actions.ts order (FusedEngine.cand_tuples): the same list in the same order, which is what the training arrays and
every network's tie-breaking rely on.

Layout (W = 13 + 7 * seats + H + 3 * T): phase, turn, round, seat, tradeCount, conquered, fortified, fortifyFrom,
pending (from, to, min, max; -1s when none), hand size, then per seat order, capitals, personal trades, alive, cards,
armies to place, income (0 when out); the decider's hand (card ids, -1 padded to H); owner (seat, -1 none or
blizzard, -2 Neutral), armies, blizzard flags.
"""
from __future__ import annotations

import numpy as np
import torch

CAND_KINDS = {"place": 0, "trade": 1, "capital": 2, "attack": 3, "occupy": 4, "fortify": 5, "end_turn": 6, "fortify_from": 7, "fortify_to": 8}
FIELD_NAMES = ["phase", "turn", "round", "seat", "tradeCount", "conquered", "fortified", "fortifyFrom", "pending", "pending", "pending",
               "pending", "hand size", "-"]


def width(n: int, H: int, T: int) -> int:
    return 13 + 7 * n + H + 3 * T


def field_name(i: int, n: int, H: int, T: int) -> str:
    if i < 13:
        return FIELD_NAMES[i]
    i -= 13
    for name, size in [("order", n), ("capitals", n), ("personalTrades", n), ("seat alive", n), ("seat cards", n),
                       ("seat armiesToPlace", n), ("seat income", n), ("hand", H), ("owner", T), ("armies", T), ("blizzards", T)]:
        if i < size:
            return f"{name}[{i}]"
        i -= size
    return "?"


def pack_record(r: dict, H: int) -> np.ndarray:
    s = r["state"]
    n = r["players"]
    T = len(s["owner"])
    v = np.full(width(n, H, T), -1, dtype=np.int64)
    pend = s["pending"] or [-1, -1, -1, -1]
    hand = [h[0] for h in s["hand"]]
    v[:13] = [r["phase"], r["turn"], r["round"], r["seat"], s["tradeCount"], int(s["conquered"]), int(s["fortified"]), s["fortifyFrom"],
              *pend, len(hand)]
    o = 13
    v[o:o + n] = s["order"]
    v[o + n:o + 2 * n] = s["capitals"]
    v[o + 2 * n:o + 3 * n] = s.get("personalTrades", [0] * n)
    seats = np.array(s["seats"], dtype=np.int64).reshape(n, 4)
    v[o + 3 * n:o + 7 * n] = seats.T.reshape(-1)
    o += 7 * n
    v[o:o + len(hand)] = hand
    o += H
    v[o:o + T] = s["owner"]
    v[o + T:o + 2 * T] = s["armies"]
    bl = np.zeros(T, dtype=np.int64)
    bl[s["blizzards"]] = 1
    v[o + 2 * T:o + 3 * T] = bl
    return v


def cand_rows(cands: list) -> np.ndarray:
    out = np.zeros((len(cands), 4), dtype=np.int32)
    for i, c in enumerate(cands):
        k = c[0]
        out[i, 0] = CAND_KINDS[k]
        if k == "trade":
            out[i, 1:4] = sorted(c[1])
        else:
            rest = c[1:]
            out[i, 1:1 + len(rest)] = rest
    return out


def pack_states(e) -> torch.Tensor:
    """Every game's state in pack_record's layout, on the device ([B, W] int64)."""
    B, n, T, H = e.B, e.n, e.m.T, e.H
    ar = e.ar
    me = e.cur
    inc = e.income()
    pend = torch.stack([e.pend_from, e.pend_to, e.pend_min, e.pend_max], 1)
    pend = torch.where((e.pend_from >= 0)[:, None], pend, -1)
    hn = e.hand_n[ar, me]
    head = torch.stack([e.phase, e.turn, e.round, me, e.trade_count, e.conquered.long(), e.fortified.long(), e.fort_src], 1)
    alive = e.alive[:, :n].long()
    seats = torch.cat([alive, e.hand_n[:, :n], e.atp[:, :n], inc * alive], 1)
    owner = torch.where(e.owner == e.NEU, -2, e.owner)
    return torch.cat([head, pend, hn[:, None], e.order, e.capital, e.trades_made[:, :n], seats, e.hand[ar, me], owner, e.armies,
                      e.bliz.long()], 1)
