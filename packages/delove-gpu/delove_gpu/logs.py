"""Reading self-play decision logs (format v2, packages/selfplay/src/log.ts) and mapping them onto the GPU engine."""
from __future__ import annotations

import gzip
import json
import re
from pathlib import Path
from typing import Iterator


from .engine import FINISHED, Engine

OWNER_NONE, OWNER_NEUTRAL = -1, -2


def shards(log_dir: str | Path) -> list[Path]:
    d = Path(log_dir)
    return sorted(p for p in d.iterdir() if re.match(r"^decisions-.*\.jsonl(\.gz)?$", p.name))


def games(log_dir: str | Path) -> Iterator[list[dict]]:
    """Each game's records, in log order (the runner writes a game's records together)."""
    for shard in shards(log_dir):
        opener = gzip.open if shard.suffix == ".gz" else open
        cur: list[dict] = []
        key = None
        with opener(shard, "rt", encoding="utf8") as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                k = (r["game"], r["seed"])
                if key is not None and k != key:
                    yield cur
                    cur = []
                key = k
                cur.append(r)
        if cur:
            yield cur


class Snapshot:
    """The engine state of every game on the CPU, for comparing with logged records."""

    def __init__(self, e: Engine):
        import torch

        ar = e.ar
        self.cur = e.cur.cpu().numpy()
        self.owner = e.owner.cpu().numpy()
        self.armies = e.armies.cpu().numpy()
        self.alive = e.alive.cpu().numpy()
        self.atp = e.atp.cpu().numpy()
        self.hand = e.hand.cpu().numpy()
        self.hand_n = e.hand_n.cpu().numpy()
        self.trades_made = e.trades_made.cpu().numpy()
        self.trade_count = e.trade_count.cpu().numpy()
        self.order = e.order.cpu().numpy()
        self.phase = e.phase.cpu().numpy()
        self.turn = e.turn.cpu().numpy()
        self.round = e.round.cpu().numpy()
        self.pend = torch.stack([e.pend_from, e.pend_to, e.pend_min, e.pend_max], 1).cpu().numpy()
        self.conquered = e.conquered.cpu().numpy()
        self.fortified = e.fortified.cpu().numpy()
        self.fort_src = e.fort_src.cpu().numpy()
        self.winner = e.winner.cpu().numpy()
        self.done = e.done.cpu().numpy()
        self.income = torch.stack([e.reinforcements(ar, torch.full_like(ar, s)) for s in range(e.n)], 1).cpu().numpy()
        self.card_kind = e.m.card_kind.cpu().numpy()
        self.card_terr = e.m.card_terr.cpu().numpy()
        self.n = e.n
        self.NEU = e.NEU

    def encoded(self, b: int) -> dict:
        """The game's state in the decision log's form (log.ts encodeState plus the record's header fields)."""
        n = self.n
        me = int(self.cur[b])
        owner = self.owner[b].copy()
        owner[owner == self.NEU] = OWNER_NEUTRAL
        hn = int(self.hand_n[b, me])
        hand = [[int(c), int(self.card_kind[c]), int(self.card_terr[c])] for c in self.hand[b, me, :hn]]
        pend = self.pend[b]
        return {
            "phase": int(self.phase[b]),
            "turn": int(self.turn[b]),
            "round": int(self.round[b]),
            "seat": me,
            "owner": owner.tolist(),
            "armies": self.armies[b].tolist(),
            "seats": [
                [int(self.alive[b, s]), int(self.hand_n[b, s]), int(self.atp[b, s]), int(self.income[b, s]) if self.alive[b, s] else 0]
                for s in range(n)
            ],
            "hand": hand,
            "tradeCount": int(self.trade_count[b]),
            "personalTrades": self.trades_made[b, :n].tolist(),
            "pending": None if pend[0] < 0 else pend.tolist(),
            "conquered": bool(self.conquered[b]),
            "fortified": bool(self.fortified[b]),
            "order": self.order[b].tolist(),
            "fortifyFrom": int(self.fort_src[b]),
        }


def record_view(r: dict) -> dict:
    """The same fields from a logged record."""
    s = r["state"]
    return {
        "phase": r["phase"],
        "turn": r["turn"],
        "round": r["round"],
        "seat": r["seat"],
        "owner": s["owner"],
        "armies": s["armies"],
        "seats": s["seats"],
        "hand": s["hand"],
        "tradeCount": s["tradeCount"],
        "personalTrades": s.get("personalTrades", [0] * r["players"]),
        "pending": s["pending"],
        "conquered": s["conquered"],
        "fortified": s["fortified"],
        "order": s["order"],
        "fortifyFrom": s["fortifyFrom"],
    }


def cand_to_action(e: Engine, snap: Snapshot, b: int, c: list) -> int:
    """The engine's action index for a logged candidate, or -1 if it has no counterpart."""
    L, m = e.L, e.m
    me = int(snap.cur[b])
    kind = c[0]
    if kind == "place":
        t, n = c[1], c[2]
        a = int(snap.atp[b, me])
        lim = min(a, e.setup_batch) if snap.phase[b] == 1 else a
        for slot, v in enumerate([lim, (lim + 1) // 2, 1]):
            if v == n:
                return L.PLACE + 3 * t + slot
        return -1
    if kind == "trade":
        hn = int(snap.hand_n[b, me])
        hand = list(snap.hand[b, me, :hn])
        try:
            slots = sorted(hand.index(i) for i in c[1])
        except ValueError:
            return -1
        tri = [tuple(x) for x in L.trade_tri.tolist()]
        return L.TRADE + tri.index(tuple(slots)) if tuple(slots) in tri else -1
    if kind == "attack":
        try:
            return L.ATTACK + m.edges.index((c[1], c[2]))
        except ValueError:
            return -1
    if kind == "occupy":
        _, _, mn, mx = snap.pend[b]
        mid = max(mn, (mx + 1) // 2)
        for slot, v in enumerate([mx, mid, mn]):
            if v == c[1]:
                return L.OCCUPY + slot
        return -1
    if kind == "fortify_from":
        return L.FFROM + c[1]
    if kind == "fortify_to":
        src = int(snap.fort_src[b])
        mx = int(snap.armies[b, src]) - 1 if src >= 0 else -1
        for slot, v in enumerate([mx, (mx + 1) // 2]):
            if v == c[2]:
                return L.FTO + 2 * c[1] + slot
        return -1
    if kind == "end_turn":
        return L.END
    return -1


def first_diff(a: dict, b: dict) -> str | None:
    for k in a:
        if a[k] != b[k]:
            return f"{k}: engine {a[k]!r} vs gpu {b[k]!r}"
    return None


def finished_ok(snap: Snapshot, b: int, outcome: dict, max_turns: int) -> str | None:
    """After a game's last record the GPU game must be over the same way."""
    if outcome["winner"] is None:
        if not (snap.done[b] and snap.phase[b] != FINISHED and snap.turn[b] >= max_turns):
            return f"expected the turn limit, gpu phase {snap.phase[b]} turn {snap.turn[b]}"
        return None
    if not (snap.phase[b] == FINISHED and snap.winner[b] == outcome["winner"]):
        return f"expected seat {outcome['winner']} to win, gpu phase {snap.phase[b]} winner {snap.winner[b]}"
    return None
