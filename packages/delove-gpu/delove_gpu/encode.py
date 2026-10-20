"""The board encoder (packages/selfplay/src/encode.ts, ENCODER_VERSION 2) on GPU tensors, for every game at once.

encode.ts stays the definition; tests/replay.py --export checks this against the arrays `npm run delove -- export`
writes from the same logged decisions. Everything the rules kernel covers is encoded (capitals, blizzards, card values,
the rule flags; neutral traits); fog of war is not mirrored.

Candidates are the engine's fixed action space: features for all A moves, the caller picks the legal ones.
"""
from __future__ import annotations

import torch

from .engine import K_ATTACK, K_CAPITAL, K_END, K_FFROM, K_FTO, K_OCCUPY, K_PLACE, K_TRADE, SETUP, State, trade_bonus

ENCODER_VERSION = 2
MAX_SLOTS = 10
N_PHASES = 7
N_TRAITS = 6
N_RULES = 6
F_TERRITORY = 27
F_GLOBAL = N_PHASES + N_TRAITS + 6 * MAX_SLOTS + 3 + 4 + 3 + 4 + 2 + N_RULES  # 95
F_CAND = 13
# CANDIDATE_KINDS order in actions.ts: place, trade, capital, attack, occupy, fortify, end_turn, fortify_from, fortify_to
CAND_KIND_INDEX = {K_PLACE: 0, K_TRADE: 1, K_CAPITAL: 2, K_ATTACK: 3, K_OCCUPY: 4, K_END: 6, K_FFROM: 7, K_FTO: 8}
# log.ts RULE_KEYS: capitals, fixedCards, adjacentFortify, fogOfWar, balancedBlitz, exponentialCards


def exp_bonus(i: torch.Tensor) -> torch.Tensor:
    """cards.ts exponentialTradeBonus: 5, then ceil(v * 13 / 10) for the first 24 trades, then +1000 per trade."""
    v = torch.full_like(i, 5)
    for k in range(24):
        v = torch.where(i > k, (v * 13 + 9) // 10, v)
    return v + (i - 24).clamp(min=0) * 1000


FIXED_VALUE = [4, 6, 8]


# Features are computed in float64 and rounded to float32 once at the end, as encode.ts does (JavaScript doubles
# stored into a Float32Array), so the arrays match export's bit for bit rather than to float32 rounding.
F64 = torch.float64


def div(x: torch.Tensor, c) -> torch.Tensor:
    """x / c with true division. A CUDA tensor divided by a Python number is multiplied by the reciprocal instead,
    which can differ from JavaScript's x / c in the last bit."""
    return x / torch.full_like(x, c)


def log1(x: torch.Tensor) -> torch.Tensor:
    return div(torch.log1p(x.clamp(min=0).to(F64)), 5)


class _Subset:
    """The engine fields the encoder reads, for games g only (so the encoder's code runs unchanged on a subset)."""

    FIELDS = ["owner", "armies", "order", "cur_pos", "hand", "hand_n", "pend_from", "pend_to", "pend_min", "pend_max", "fort_src",
              "phase", "alive", "atp", "trade_count", "trades_made", "conquered", "fortified", "turn", "round", "capital", "bliz"]

    def __init__(self, e: State, g: torch.Tensor, inc: torch.Tensor):
        for f in self.FIELDS:
            setattr(self, f, getattr(e, f)[g])
        self.inc = inc[g]
        self.m, self.L, self.dev, self.H, self.n, self.NEU, self.cfg = e.m, e.L, e.dev, e.H, e.n, e.NEU, e.cfg
        self.setup_batch, self.tarange = e.setup_batch, e.tarange
        self.B = g.numel()
        self.ar = torch.arange(self.B, device=e.dev)

    cur = State.cur


class Encoder:
    def __init__(self, e: State, traits: list[float] | None = None):
        self.e = e
        o = e.cfg.opt
        self.card_mode = o("cardValues")
        self.rules = [float(o("capitals")), float(self.card_mode == "fixed"), float(o("fortifyMode") == "adjacent"), 0.0,
                      float(o("balancedBlitz")), float(self.card_mode == "exponential")]
        m, L = e.m, e.L
        dev = e.dev
        self.traits = torch.tensor(traits or [0.5] * N_TRAITS, dtype=torch.float32, device=dev)
        A = L.A
        self.cand_kind_onehot = torch.zeros(A, F_CAND, dtype=torch.float32, device=dev)
        idx = torch.tensor([CAND_KIND_INDEX[int(k)] for k in L.kind.tolist()], device=dev)
        self.cand_kind_onehot[torch.arange(A, device=dev), idx] = 1.0
        self.cont_bonus_t = div(m.cont_bonus[m.cont_of].to(F64), 10)
        # per action: the territory the move is about (for place / fortify_from / fortify_to), else 0
        self.act_t = torch.where((L.kind == K_PLACE) | (L.kind == K_FFROM) | (L.kind == K_FTO), L.arg, 0)

    def encode(self, games: torch.Tensor | None = None):
        """(territory [B, T, 27], global [B, 95]) for every game's decider, or for `games` only (rows in that order;
        self.row_of maps a game to its row); then candidates() for its moves (by row)."""
        inc_all = self.e.income()
        if games is None:
            e = _Subset(self.e, self.e.ar, inc_all)
            self.row_of = self.e.ar
        else:
            e = _Subset(self.e, games, inc_all)
            self.row_of = torch.full((self.e.B,), -1, dtype=torch.long, device=self.e.dev)
            self.row_of[games] = e.ar
        self._src = e
        m, L = e.m, e.L
        B, T, n, NEU, dev = e.B, m.T, e.n, e.NEU, e.dev
        ar = e.ar
        me = e.cur
        owner, armies = e.owner, e.armies
        armies_f = armies.to(F64)

        # seat -> slot relative to the decider, by turn order
        pos = torch.empty_like(e.order).scatter_(1, e.order, torch.arange(n, device=dev).repeat(B, 1))  # pos[b, seat]
        slot_of = (pos - e.cur_pos[:, None]) % n  # [B, n]

        terr = torch.zeros(B, T, F_TERRITORY, dtype=F64, device=dev)
        is_seat = (owner >= 0) & (owner < n)
        oslot = slot_of.gather(1, owner.clamp(0, n - 1))
        terr.scatter_(2, torch.where(is_seat, oslot, 0)[:, :, None], is_seat[:, :, None].to(F64))
        bliz = e.bliz
        terr[:, :, 10] = (owner == NEU).float()
        terr[:, :, 11] = (owner < 0).float()
        terr[:, :, 12] = log1(armies)
        terr[:, :, 13] = div(armies.clamp(max=30).to(F64), 30)
        terr[:, :, 14] = bliz.float()
        # capitals: my_capital / enemy_capital (capital[seat] = territory)
        capt = e.capital  # [B, n]
        is_cap = torch.zeros(B, T + 1, dtype=torch.long, device=dev) - 1
        is_cap.scatter_(1, torch.where(capt >= 0, capt, T), torch.arange(n, device=dev).repeat(B, 1))
        cap_seat = is_cap[:, :T]
        terr[:, :, 15] = ((cap_seat >= 0) & (cap_seat == me[:, None])).float()
        terr[:, :, 16] = ((cap_seat >= 0) & (cap_seat != me[:, None])).float()
        terr[:, :, 17] = self.cont_bonus_t
        openm = m.cont_member[None] & ~bliz[:, None, :]  # [B, K, T] open territories per continent
        nopen = openm.sum(-1)  # [B, K]
        mine_open = (openm & (owner == me[:, None])[:, None, :]).sum(-1)
        share = torch.where(nopen > 0, mine_open.to(F64) / nopen.clamp(min=1).to(F64), 0.0)
        terr[:, :, 18] = share.gather(1, m.cont_of[None].expand(B, -1))
        big = torch.where(openm, owner[:, None, :], 10**6)
        small = torch.where(openm, owner[:, None, :], -(10**6))
        holder = torch.where(big.min(-1).values == small.max(-1).values, big.min(-1).values, -(10**7))  # [B, K]
        hold_t = holder.gather(1, m.cont_of[None].expand(B, -1))
        terr[:, :, 19] = ((owner >= 0) & (hold_t == owner)).float()
        nb = m.nbr.reshape(-1)
        nown = owner[:, nb].view(B, T, m.D)
        narm = armies[:, nb].view(B, T, m.D)
        valid = m.nbr_valid[None] & ~bliz[:, nb].view(B, T, m.D)
        same = (nown == owner[:, :, None]) & valid
        other = (nown != owner[:, :, None]) & valid
        terr[:, :, 20] = (other.any(-1) & (owner >= 0)).float()
        terr[:, :, 21] = log1((narm * other).sum(-1))
        terr[:, :, 22] = log1((narm * same).sum(-1))
        hand = e.hand[ar, me]  # [B, H]
        hn = e.hand_n[ar, me]
        held = torch.arange(e.H, device=dev)[None, :] < hn[:, None]
        hterr = torch.where(held, m.card_terr[hand.clamp(min=0)], -1)
        in_hand = torch.zeros(B, T + 1, dtype=F64, device=dev).scatter_(1, torch.where(hterr >= 0, hterr, T), 1.0)
        terr[:, :, 23] = in_hand[:, :T]
        pend = e.pend_from >= 0
        tt = e.tarange[None, :]
        terr[:, :, 24] = (pend[:, None] & (e.pend_from[:, None] == tt)).float()
        terr[:, :, 25] = (pend[:, None] & (e.pend_to[:, None] == tt)).float()
        terr[:, :, 26] = (e.fort_src[:, None] == tt).float()

        g = torch.zeros(B, F_GLOBAL, dtype=F64, device=dev)
        g[ar, e.phase] = 1.0
        g[:, N_PHASES:N_PHASES + N_TRAITS] = self.traits.to(F64)
        total = armies.sum(1).clamp(min=1).to(F64)
        nopen_t = (T - bliz.sum(1)).to(F64)
        base = N_PHASES + N_TRAITS
        for s in range(n):
            col = base + 6 * slot_of[:, s]
            own_s = owner == s
            alive = e.alive[:, s]
            inc = torch.where(alive, e.inc[:, s], 0)
            vals = torch.stack([
                torch.ones(B, dtype=F64, device=dev),
                alive.to(F64),
                div(e.hand_n[:, s].to(F64), 5),
                own_s.sum(1).to(F64) / nopen_t,
                (armies * own_s).sum(1).to(F64) / total,
                log1(inc),
            ], 1)
            g.scatter_(1, col[:, None] + torch.arange(6, device=dev)[None, :], vals)
        o = base + 6 * MAX_SLOTS
        g[:, o] = (owner == NEU).any(1).float()
        atp_me = e.atp[ar, me]
        g[:, o + 1] = log1(atp_me)
        g[:, o + 2] = div(hn.to(F64), 5)
        hk = torch.where(held, m.card_kind[hand.clamp(min=0)], -1)
        kinds = torch.stack([(hk == k).sum(1) for k in range(4)], 1)
        g[:, o + 3:o + 7] = div(kinds.to(F64), 3)
        has_set = (hn >= 3) & ((kinds[:, 3] >= 1) | (kinds[:, :3] >= 3).any(1) | (kinds[:, :3] >= 1).all(1))
        tc = e.trade_count
        if self.card_mode == "exponential":
            nxt = exp_bonus(e.trades_made[ar, me])
        elif self.card_mode == "fixed":
            nxt = torch.full_like(tc, 10)
        else:
            nxt = trade_bonus(tc)
        if self.card_mode == "fixed":  # the best set in hand by fixedSetValue (hands hold at most 4 cards here)
            tri = L.trade_tri
            ck = m.card_kind[hand[:, tri].clamp(min=0)]  # [B, 10, 3]
            ok = tri[None, :, 2] < hn[:, None]
            k0, k1, k2 = ck.unbind(-1)
            wild = (ck == 3).sum(-1)
            valid = (wild >= 1) | ((k0 == k1) & (k1 == k2)) | ((k0 != k1) & (k1 != k2) & (k0 != k2))
            lo = torch.where(ck == 3, 99, ck).min(-1).values
            hi = torch.where(ck == 3, -1, ck).max(-1).values
            fv = torch.tensor(FIXED_VALUE + [10], device=dev)
            val = torch.where(wild >= 2, 10, torch.where(lo == hi, fv[lo.clamp(max=3)], 10))
            g[:, o + 7] = log1(torch.where(ok & valid, val, 0).max(1).values)
        else:
            g[:, o + 7] = log1(torch.where(has_set, nxt, 0))
        g[:, o + 8] = log1(tc)
        g[:, o + 9] = log1(nxt)
        g[:, o + 10] = e.conquered.float()
        g[:, o + 11] = e.fortified.float()
        g[:, o + 12] = div(e.turn.to(F64), 100)
        g[:, o + 13] = div(e.round.to(F64), 50)
        g[:, o + 14] = n / MAX_SLOTS
        g[:, o + 15] = T / 120
        g[:, o + 16:o + 16 + N_RULES] = torch.tensor(self.rules, dtype=F64, device=dev)

        self._ctx = (me, atp_me, hand, armies_f, pend)
        return terr.float(), g.float()

    def candidates(self, b: torch.Tensor, a: torch.Tensor):
        """Features of move a[i] in row b[i] of the last encode(): (cand [M, 13], cand_from [M], cand_to [M])."""
        e, m, L = self._src, self.e.m, self.e.L
        me, atp_me, hand, armies_f, pend = self._ctx
        M = b.shape[0]
        dev = e.dev
        kind, slot, arg = L.kind[a], L.slot[a], L.arg[a]
        cand = self.cand_kind_onehot[a].to(F64)
        cf = torch.full((M,), -1, dtype=torch.long, device=dev)
        ct = torch.full((M,), -1, dtype=torch.long, device=dev)
        amount = torch.zeros(M, dtype=torch.long, device=dev)
        pool = torch.zeros(M, dtype=torch.long, device=dev)

        # place: amount all / half / 1 of what may be placed now, out of max(amount, armies to place)
        atp = atp_me[b]
        lim = torch.where(e.phase[b] == SETUP, torch.clamp(atp, max=e.setup_batch), atp)
        n = torch.where(slot == 0, lim, torch.where(slot == 1, (lim + 1) // 2, 1))
        k = kind == K_PLACE
        claim = k & (e.phase[b] == SETUP) & (e.owner[b, arg.clamp(max=m.T - 1)] < 0)  # claiming: one army
        n = torch.where(claim, 1, n)
        amount = torch.where(k, n, amount)
        pool = torch.where(k, torch.maximum(n, atp), pool)
        ct = torch.where(k, arg, ct)

        # attack: from -> to, log army ratio
        k = kind == K_ATTACK
        ef, et = m.edge_from[arg.clamp(max=m.E - 1)], m.edge_to[arg.clamp(max=m.E - 1)]
        cf = torch.where(k, ef, cf)
        ct = torch.where(k, et, ct)
        ratio = torch.log((armies_f[b, ef] - 1) / armies_f[b, et].clamp(min=1)).clamp(-3, 3)
        cand[:, 11] = torch.where(k, ratio, 0.0)

        # occupy: max / max(min, half) / min of the pending conquest
        k = (kind == K_OCCUPY) & pend[b]
        mx, mn = e.pend_max[b], e.pend_min[b]
        n = torch.where(slot == 0, mx, torch.where(slot == 1, torch.maximum(mn, (mx + 1) // 2), mn))
        amount = torch.where(k, n, amount)
        pool = torch.where(k, mx, pool)
        cf = torch.where(k, e.pend_from[b], cf)
        ct = torch.where(k, e.pend_to[b], ct)

        cf = torch.where(kind == K_FFROM, arg, cf)
        ct = torch.where(kind == K_CAPITAL, arg, ct)

        # fortify_to: all / half of what may leave the source
        k = kind == K_FTO
        src = e.fort_src[b]
        fmax = armies_f[b, src.clamp(min=0)].long() - 1
        n = torch.where(slot == 0, fmax, (fmax + 1) // 2)
        amount = torch.where(k, n, amount)
        pool = torch.where(k, torch.where(src >= 0, fmax, n), pool)
        cf = torch.where(k, src, cf)
        ct = torch.where(k, arg, ct)

        # trade: share of the set's cards showing a territory I own
        k = kind == K_TRADE
        cards = hand[b][torch.arange(M, device=dev)[:, None], L.trade_tri[arg.clamp(max=L.trade_tri.shape[0] - 1)]]
        cterr = m.card_terr[cards.clamp(min=0)]
        owned = (cterr >= 0) & (e.owner[b[:, None], cterr.clamp(min=0)] == me[b][:, None])
        cand[:, 12] = torch.where(k, div(owned.sum(-1).to(F64), 3), 0.0)

        has = amount > 0
        cand[:, 9] = torch.where(has, torch.where(pool > 0, amount.to(F64) / pool.clamp(min=1).to(F64), 1.0), 0.0)
        cand[:, 10] = torch.where(has, log1(amount), 0.0)
        return cand.float(), cf, ct

    def encode_dense(self):
        """Every move of every game (for checks): territory, global, cand [B, A, 13], cand_from [B, A], cand_to [B, A]."""
        e = self.e
        terr, g = self.encode()
        A = e.L.A
        b = torch.arange(e.B, device=e.dev).repeat_interleave(A)
        a = torch.arange(A, device=e.dev).repeat(e.B)
        cand, cf, ct = self.candidates(b, a)
        return terr, g, cand.view(e.B, A, -1), cf.view(e.B, A), ct.view(e.B, A)
