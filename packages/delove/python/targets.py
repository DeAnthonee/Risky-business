"""Value targets for the range specialists (train.py --value-target / --range).

The owner's objectives (2026-10-20), one per stage of a game, all learned from the same pool of generated games:

- **Long Range** (4+ players alive): reach the last 3 with as many kills as possible, i.e. the most leaderboard points.
  Target "points": the decider's leaderboard points (placement points + kills) scaled to 0..1 (points01.npy).
- **Mid Range** (3 alive): finish top 2. Target "top2": 1 when the decider finished 1st or 2nd of a decided game
  (placement.npy, written by delove_gpu.generate). Its edge is steering, so `threat` > 0 mixes in a credit for
  positions where the strongest rival's armies face the third player rather than us (threat_deflection).
- **Close Range** (2 alive): win the duel at all costs. Target "win": 1 for a sole win; a turn-limit share is no win.

A game that hits the turn limit counts as last place for "points" and as no top 2 / no win, so stalling never pays.
"""
import os

import numpy as np

TARGETS = ("z", "points", "top2", "win")

# train.py --range presets. credit_beta: the temperature of range credit (each copied move weighted by
# exp((target - V) / credit_beta)); smaller = the moves that went well for the objective count more.
RANGES = {
    "long": dict(alive="4-10", value_target="points", threat_credit=0.0, credit_beta=0.5),
    "mid": dict(alive="3-3", value_target="top2", threat_credit=0.3, credit_beta=0.5),
    "close": dict(alive="2-2", value_target="win", threat_credit=0.0, credit_beta=0.5),
}


def placement_points(placement, players):
    """packages/engine/src/ranking.ts placementPoints (vectorised): +3 +2 +1 -1 -2 -3 at six seats, 0 in the middle
    of an odd table."""
    centered = (np.asarray(players, dtype=np.float64) + 1) / 2 - placement
    return np.sign(centered) * np.ceil(np.abs(centered))


def _slot_cols(names, suffix):
    return [names.index(f"slot{i}_{suffix}") for i in range(10) if f"slot{i}_{suffix}" in names]


def alive_counts(glob, names, chunk=1 << 20):
    """Players alive at each decision (sum of the slot<i>_alive global features), as int8."""
    cols = _slot_cols(names, "alive")
    out = np.zeros(len(glob), dtype=np.int8)
    for i in range(0, len(glob), chunk):
        out[i : i + chunk] = np.rint(np.asarray(glob[i : i + chunk][:, cols]).sum(1))
    return out


def _present_counts(glob, names, chunk=1 << 20):
    cols = _slot_cols(names, "present")
    out = np.zeros(len(glob), dtype=np.int8)
    for i in range(0, len(glob), chunk):
        out[i : i + chunk] = np.rint(np.asarray(glob[i : i + chunk][:, cols]).sum(1))
    return out


def _load(d, name):
    path = os.path.join(d.name, name + ".npy")
    return np.asarray(np.load(path, mmap_mode="r")) if os.path.exists(path) else None


def top2_target(d):
    """(top2 per decision, note). Exact from placement.npy. Older exports (no placement.npy) estimate a loser's place
    as the players alive at its seat's last recorded decision (a decided game eliminates every loser, so a seat whose
    last decision saw 2 alive finished 2nd; it is off only when several players fall between that decision and its
    own elimination). Without seat.npy: 'points at least 2nd place's'; v2 exports without points keep z."""
    p01 = _load(d, "points01")
    decided = np.isfinite(p01) & (p01 > 0) if p01 is not None else np.ones(len(d.z), dtype=bool)  # 0 = last place's points
    placement = _load(d, "placement")
    if placement is not None:
        return ((placement >= 1) & (placement <= 2) & decided).astype(np.float32), ""
    seat = _load(d, "seat")
    if seat is not None:
        place = np.where(d.z >= 1 - 1e-6, 1, d.alive[last_decision(d.game, seat)])
        return ((place <= 2) & decided).astype(np.float32), "estimated top2 (no placement.npy): alive at the seat's last decision"
    points = _load(d, "points")
    if points is None or not np.isfinite(points).any():
        return d.z.astype(np.float32), "no points or placement: z"
    n = _present_counts(d.glob, d.info["globalFeatures"])
    second = placement_points(2, np.maximum(n, 2))
    approx = np.where(np.isfinite(points), (points >= second) & decided, d.z >= 1)
    return approx.astype(np.float32), "approximate top2 (no placement.npy): points >= 2nd place's"


def threat_deflection(d, rows, chunk=4096):
    """For decisions `rows` (3 players alive): the share of the strongest rival's border armies that face the third
    player rather than the decider, in 0..1 (0.5 when the strongest rival touches neither). Strongest = largest army
    share + territory share among the living rivals. Read from the encoded position (slot 0 is the decider)."""
    tf, gf = d.info["territoryFeatures"], d.info["globalFeatures"]
    S = sum(1 for f in tf if f.startswith("owner_slot"))
    owner_cols = [tf.index(f"owner_slot{i}") for i in range(S)]
    arm_col = tf.index("armies_log")
    alive_cols, army_cols, terr_cols = _slot_cols(gf, "alive"), _slot_cols(gf, "army_share"), _slot_cols(gf, "territory_share")
    out = np.zeros(len(rows), dtype=np.float32)
    rows = np.asarray(rows)
    for i in range(0, len(rows), chunk):
        ks = rows[i : i + chunk]
        terr = np.asarray(d.territory[ks], dtype=np.float32)
        g = np.asarray(d.glob[ks], dtype=np.float32)
        own = terr[:, :, owner_cols]  # [r, T, S] one-hot owner slot
        armies = np.expm1(terr[:, :, arm_col] * 5)  # encode.ts: armies_log = log1p(armies) / 5
        rival = g[:, alive_cols] > 0.5
        rival[:, 0] = False
        strength = np.where(rival, g[:, army_cols] + g[:, terr_cols], -np.inf)
        r = np.arange(len(ks))
        lead = strength.argmax(1)
        third_mask = rival.copy()
        third_mask[r, lead] = False
        third = third_mask.argmax(1)
        touches = np.einsum("tu,rus->rts", d.adj, own) > 0  # [r, T, S]: territory t borders a territory of slot s
        lead_armies = own[r, :, lead] * armies
        on_me = (lead_armies * touches[:, :, 0]).sum(1)
        on_third = (lead_armies * touches[r, :, third]).sum(1)
        tot = on_me + on_third
        out[i : i + chunk] = np.where(tot > 0, on_third / np.maximum(tot, 1e-9), 0.5)
    return out


def next_decision(game, seat):
    """Index of the same seat's next decision in the same game (-1 for its last). Rows of one game and seat are in
    play order in every export (export.ts and delove_gpu.generate append as the game runs)."""
    n = len(game)
    order = np.lexsort((np.arange(n), seat, game))
    nxt = np.full(n, -1, dtype=np.int64)
    a, b = order[:-1], order[1:]
    same = (game[a] == game[b]) & (seat[a] == seat[b])
    nxt[a[same]] = b[same]
    return nxt


def last_decision(game, seat):
    """Index of the same seat's last decision in the same game, for every decision."""
    n = len(game)
    order = np.lexsort((np.arange(n), seat, game))
    g, s = game[order], seat[order]
    end = np.ones(n, dtype=bool)  # sorted position k ends its (game, seat) group
    end[:-1] = (g[:-1] != g[1:]) | (s[:-1] != s[1:])
    group = np.cumsum(np.concatenate([[0], end[:-1]]))  # group number of each sorted position
    out = np.empty(n, dtype=np.int64)
    out[order] = order[np.nonzero(end)[0]][group]
    return out


def mid_credit(d, top2):
    """Threat-deflection credit for each 3-alive decision, measured on the position the decision led to (the seat's
    next decision): the deflection there, 1 if a rival fell meanwhile (we're in the last 2), the final top2 if this was
    the seat's last decision. Other decisions get their top2."""
    seat = _load(d, "seat")
    credit = top2.copy()
    if seat is None:
        return credit
    nxt = next_decision(d.game, seat)
    rows = np.nonzero(d.alive == 3)[0]
    j = nxt[rows]
    has = j >= 0
    measure = np.unique(j[has & (d.alive[np.maximum(j, 0)] == 3)])
    defl = np.zeros(len(d.z), dtype=np.float32)
    if len(measure):
        defl[measure] = threat_deflection(d, measure)
    jj = np.maximum(j, 0)
    credit[rows] = np.where(~has, top2[rows], np.where(d.alive[jj] < 3, 1.0, defl[jj]))
    return credit


def range_target(d, target, threat=0.0):
    """(values per decision, target name actually used, note) for dataset d (train.Data: name, info, glob, game,
    alive, z, territory, adj)."""
    z = np.asarray(d.z, dtype=np.float32)
    if target == "z":
        return z, "z", ""
    if target == "win":
        return (z >= 1 - 1e-6).astype(np.float32), "win", ""
    if target == "points":
        p01 = _load(d, "points01")
        if p01 is None or not np.isfinite(p01).any():
            return z, "z", "no points01.npy: z"
        return np.where(np.isfinite(p01), p01, z).astype(np.float32), "points", ""
    if target == "top2":
        top2, note = top2_target(d)
        if threat > 0:
            top2 = ((1 - threat) * top2 + threat * mid_credit(d, top2)).astype(np.float32)
            note = (note + "; " if note else "") + f"threat credit {threat}"
        return top2, "top2", note
    raise SystemExit(f"unknown value target {target!r} ({', '.join(TARGETS)})")
