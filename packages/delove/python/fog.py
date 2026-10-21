"""Fog inputs for training: packages/selfplay/src/fog.ts on numpy batches (fog dropout, train.py --fog-dropout).

The seat view of a decision under fog of war, computed from its full-board features alone: hidden territories (not
the decider's, not next to one of its, not a blizzard) lose owner, armies and capital marks; continent holders, borders,
neighbour army sums and each seat slot's territory and army shares are recomputed from what is visible; one column is
appended to each territory (`hidden`) and to the globals (`hidden_share`). A decision that is not fogged keeps its
features with the two new columns at 0, so a network widened with zero weights for them (widen_state) plays exactly as
before. fog.ts is the definition (the seat player uses it); test_fog.py checks this file against it, bit for bit.
"""
import json
import os

import numpy as np
import torch

FOG_INPUT_VERSION = 1
MAX_SLOTS = 10
NEUTRAL, NONE = -2, -1
GENERATED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine", "src", "generated")


def map_continents(map_id, territory_ids):
    """Continent membership (territory indexes) from the engine's generated map file."""
    with open(os.path.join(GENERATED, f"{map_id}.json"), encoding="utf8") as f:
        raw = json.load(f)
    idx = {t: i for i, t in enumerate(territory_ids)}
    return [[idx[t] for t in c["territories"]] for c in raw["continents"]]


class FogMap:
    """What the transform needs about one dataset's map and feature layout (from its features.json)."""

    def __init__(self, info):
        tf, gf = info["territoryFeatures"], info["globalFeatures"]
        self.TF, self.GF = len(tf), len(gf)
        self.t = {n: i for i, n in enumerate(tf)}
        self.g = {n: i for i, n in enumerate(gf)}
        T = len(info["territoryIds"])
        adj = np.zeros((T, T), dtype=bool)
        for i, ns in enumerate(info["adjacency"]):
            adj[i, ns] = True
        self.adj = adj
        conts = map_continents(info["map"], info["territoryIds"])
        self.cont_of = np.zeros(T, dtype=np.int64)
        for c, ts in enumerate(conts):
            self.cont_of[ts] = c
        self.cont_member = np.zeros((len(conts), T), dtype=bool)
        for c, ts in enumerate(conts):
            self.cont_member[c, ts] = True


def _log1(x):
    return np.log1p(np.maximum(0.0, x)) / 5


def fog_inputs(territory, glob, fogged, fm):
    """territory [B, T, TF], glob [B, GF] (full-board features), fogged [B] bool -> territory [B, T, TF + 1],
    glob [B, GF + 1]: the seat view for fogged rows, the features with zero fog columns for the others."""
    territory = np.asarray(territory, dtype=np.float32)
    glob = np.asarray(glob, dtype=np.float32)
    B, T, TF = territory.shape
    out_t = np.zeros((B, T, TF + 1), dtype=np.float32)
    out_t[:, :, :TF] = territory
    out_g = np.zeros((B, glob.shape[1] + 1), dtype=np.float32)
    out_g[:, :-1] = glob
    rows = np.nonzero(np.asarray(fogged, dtype=bool))[0]
    if len(rows) == 0:
        return out_t, out_g
    x = territory[rows].astype(np.float64)
    ti = fm.t
    mine = x[:, :, 0] == 1
    visible = mine | ((mine.astype(np.float64) @ fm.adj.astype(np.float64)) > 0)
    bliz = x[:, :, ti["blizzard"]] == 1
    hidden = ~visible & ~bliz
    slots = x[:, :, :MAX_SLOTS] == 1
    owner = np.where(slots.any(-1), slots.argmax(-1), np.where(x[:, :, ti["owner_neutral"]] == 1, NEUTRAL, NONE))
    owner = np.where(hidden, NONE, owner)
    lin = territory[rows][:, :, ti["armies_lin"]]
    armies = np.where(lin < 1, np.round(lin.astype(np.float64) * 30), np.round(np.expm1(territory[rows][:, :, ti["armies_log"]].astype(np.float64) * 5)))
    armies = np.where(hidden, 0.0, armies)

    # continent holders over open territories; none while any open territory of it is hidden
    K = fm.cont_member.shape[0]
    holder = np.full((len(rows), K), NONE, dtype=np.int64)
    for c in range(K):
        ts = np.nonzero(fm.cont_member[c])[0]
        op = ~bliz[:, ts]
        n_open = op.sum(1)
        any_hidden = (hidden[:, ts] & op).any(1)
        o = owner[:, ts]
        big, small = np.iinfo(np.int64).max, np.iinfo(np.int64).min
        hi = np.where(op, o, small).max(1)
        lo = np.where(op, o, big).min(1)
        ok = (n_open > 0) & ~any_hidden & (hi == lo)
        holder[:, c] = np.where(ok, hi, NONE)
    hold_t = holder[:, fm.cont_of]  # [R, T]

    usable = ~bliz & ~hidden  # neighbours that count
    nb = fm.adj[None, :, :] & usable[:, None, :]  # [R, T, T]: i's neighbour j counts
    same = owner[:, :, None] == owner[:, None, :]
    # army sums stay exact in float32 (integers far below 2^24), then go to float64 for the log as in fog.ts
    a32 = armies.astype(np.float32)
    own = np.einsum("rij,rj->ri", (nb & same).astype(np.float32), a32).astype(np.float64)
    enemy = np.einsum("rij,rj->ri", (nb & ~same).astype(np.float32), a32).astype(np.float64)
    border = (nb & ~same).any(-1)

    y = out_t[rows]
    for i_name in [f"owner_slot{k}" for k in range(MAX_SLOTS)] + ["owner_neutral", "owner_none", "armies_log", "armies_lin", "my_capital",
                                                                   "enemy_capital"]:
        y[:, :, ti[i_name]] = np.where(hidden, 0, y[:, :, ti[i_name]])
    y[:, :, ti["continent_held_by_owner"]] = np.where(~hidden & (owner != NONE) & (hold_t == owner), 1, 0)
    y[:, :, ti["border"]] = np.where(~hidden & (owner != NONE) & border, 1, 0)
    y[:, :, ti["enemy_adjacent_log"]] = np.where(hidden, 0, _log1(enemy)).astype(np.float32)
    y[:, :, ti["own_adjacent_log"]] = np.where(hidden, 0, _log1(own)).astype(np.float32)
    y[:, :, TF] = hidden
    out_t[rows] = y

    gi = fm.g
    g = out_g[rows]
    n_open = (~bliz).sum(1).astype(np.float64)
    total = armies.sum(1)
    total = np.where(total == 0, 1.0, total)
    for k in range(MAX_SLOTS):
        present = g[:, gi[f"slot{k}_present"]] == 1
        is_k = owner == k
        terr = is_k.sum(1) / n_open
        arm = (armies * is_k).sum(1) / total
        g[:, gi[f"slot{k}_territory_share"]] = np.where(present, terr, g[:, gi[f"slot{k}_territory_share"]])
        g[:, gi[f"slot{k}_army_share"]] = np.where(present, arm, g[:, gi[f"slot{k}_army_share"]])
    g[:, gi["neutral_present"]] = (owner == NEUTRAL).any(1)
    g[:, -1] = np.where(n_open > 0, hidden.sum(1) / np.maximum(n_open, 1), 0)
    out_g[rows] = g
    return out_t, out_g


def widen_state(state, f_territory, f_global):
    """A checkpoint's weights for the fog input width: the first layers of t_in and g_in gain zero columns for the
    new inputs, so the widened network computes exactly what it did on any decision whose fog columns are 0."""
    out = dict(state)
    for key, width in (("t_in.0.weight", f_territory), ("g_in.0.weight", f_global)):
        w = state[key]
        if w.shape[1] < width:
            pad = w.new_zeros((w.shape[0], width - w.shape[1]))
            out[key] = torch.cat([w, pad], dim=1)
    return out
