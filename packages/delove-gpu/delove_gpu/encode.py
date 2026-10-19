"""The board encoder (packages/selfplay/src/encode.ts, ENCODER_VERSION 2) on GPU tensors, for every game at once.

encode.ts stays the definition; tests/replay.py --export checks this against the arrays `npm run delove -- export`
writes from the same logged decisions. Only what the GPU engine covers is encoded (no capitals, blizzards or fog;
default rules, neutral traits).

Candidates are the engine's fixed action space: features for all A moves, the caller picks the legal ones.
"""
from __future__ import annotations

import torch

from .engine import K_ATTACK, K_END, K_FFROM, K_FTO, K_OCCUPY, K_PLACE, K_TRADE, SETUP, Engine, trade_bonus

ENCODER_VERSION = 2
MAX_SLOTS = 10
N_PHASES = 7
N_TRAITS = 6
N_RULES = 6
F_TERRITORY = 27
F_GLOBAL = N_PHASES + N_TRAITS + 6 * MAX_SLOTS + 3 + 4 + 3 + 4 + 2 + N_RULES  # 95
F_CAND = 13
# CANDIDATE_KINDS order in actions.ts: place, trade, capital, attack, occupy, fortify, end_turn, fortify_from, fortify_to
CAND_KIND_INDEX = {K_PLACE: 0, K_TRADE: 1, K_ATTACK: 3, K_OCCUPY: 4, K_END: 6, K_FFROM: 7, K_FTO: 8}


def log1(x: torch.Tensor) -> torch.Tensor:
    return torch.log1p(x.clamp(min=0).float()) / 5


class Encoder:
    def __init__(self, e: Engine, traits: list[float] | None = None):
        self.e = e
        m, L = e.m, e.L
        dev = e.dev
        self.traits = torch.tensor(traits or [0.5] * N_TRAITS, dtype=torch.float32, device=dev)
        A = L.A
        self.cand_kind_onehot = torch.zeros(A, F_CAND, dtype=torch.float32, device=dev)
        idx = torch.tensor([CAND_KIND_INDEX[int(k)] for k in L.kind.tolist()], device=dev)
        self.cand_kind_onehot[torch.arange(A, device=dev), idx] = 1.0
        self.cont_bonus_t = (m.cont_bonus[m.cont_of].float() / 10)
        # per action: the territory the move is about (for place / fortify_from / fortify_to), else 0
        self.act_t = torch.where((L.kind == K_PLACE) | (L.kind == K_FFROM) | (L.kind == K_FTO), L.arg, 0)

    def encode(self):
        """(territory [B, T, 27], global [B, 95]) for every game's decider; then candidates() for its moves."""
        e, m, L = self.e, self.e.m, self.e.L
        B, T, n, NEU, dev = e.B, m.T, e.n, e.NEU, e.dev
        ar = e.ar
        me = e.cur
        owner, armies = e.owner, e.armies
        armies_f = armies.float()

        # seat -> slot relative to the decider, by turn order
        pos = torch.empty_like(e.order).scatter_(1, e.order, torch.arange(n, device=dev).repeat(B, 1))  # pos[b, seat]
        slot_of = (pos - e.cur_pos[:, None]) % n  # [B, n]

        terr = torch.zeros(B, T, F_TERRITORY, dtype=torch.float32, device=dev)
        is_seat = (owner >= 0) & (owner < n)
        oslot = slot_of.gather(1, owner.clamp(0, n - 1))
        terr.scatter_(2, torch.where(is_seat, oslot, 0)[:, :, None], is_seat[:, :, None].float())
        terr[:, :, 10] = (owner == NEU).float()
        terr[:, :, 11] = (owner < 0).float()
        terr[:, :, 12] = log1(armies)
        terr[:, :, 13] = armies.clamp(max=30).float() / 30
        terr[:, :, 17] = self.cont_bonus_t
        mine = (owner == me[:, None]).float()
        share = (mine @ m.cont_member.T.float()) / m.cont_size.float()  # [B, K]
        terr[:, :, 18] = share[:, m.cont_of]
        big = torch.where(m.cont_member[None], owner[:, None, :], 10**6)
        small = torch.where(m.cont_member[None], owner[:, None, :], -(10**6))
        uniform = big.min(-1).values == small.max(-1).values  # [B, K]
        terr[:, :, 19] = (uniform[:, m.cont_of] & (owner >= 0)).float()
        nb = m.nbr.reshape(-1)
        nown = owner[:, nb].view(B, T, m.D)
        narm = armies[:, nb].view(B, T, m.D)
        valid = m.nbr_valid[None]
        same = (nown == owner[:, :, None]) & valid
        other = (nown != owner[:, :, None]) & valid
        terr[:, :, 20] = (other.any(-1) & (owner >= 0)).float()
        terr[:, :, 21] = log1((narm * other).sum(-1))
        terr[:, :, 22] = log1((narm * same).sum(-1))
        hand = e.hand[ar, me]  # [B, H]
        hn = e.hand_n[ar, me]
        held = torch.arange(e.H, device=dev)[None, :] < hn[:, None]
        hterr = torch.where(held, m.card_terr[hand.clamp(min=0)], -1)
        in_hand = torch.zeros(B, T + 1, dtype=torch.float32, device=dev).scatter_(1, torch.where(hterr >= 0, hterr, T), 1.0)
        terr[:, :, 23] = in_hand[:, :T]
        pend = e.pend_from >= 0
        tt = e.tarange[None, :]
        terr[:, :, 24] = (pend[:, None] & (e.pend_from[:, None] == tt)).float()
        terr[:, :, 25] = (pend[:, None] & (e.pend_to[:, None] == tt)).float()
        terr[:, :, 26] = (e.fort_src[:, None] == tt).float()

        g = torch.zeros(B, F_GLOBAL, dtype=torch.float32, device=dev)
        g[ar, e.phase] = 1.0
        g[:, N_PHASES:N_PHASES + N_TRAITS] = self.traits
        total = armies.sum(1).clamp(min=1).float()
        base = N_PHASES + N_TRAITS
        for s in range(n):
            col = base + 6 * slot_of[:, s]
            own_s = owner == s
            alive = e.alive[:, s]
            inc = torch.where(alive, e.reinforcements(ar, torch.full_like(ar, s)), 0)
            vals = torch.stack([
                torch.ones(B, device=dev),
                alive.float(),
                e.hand_n[:, s].float() / 5,
                own_s.sum(1).float() / T,
                (armies * own_s).sum(1).float() / total,
                log1(inc),
            ], 1)
            g.scatter_(1, col[:, None] + torch.arange(6, device=dev)[None, :], vals)
        o = base + 6 * MAX_SLOTS
        g[:, o] = (owner == NEU).any(1).float()
        atp_me = e.atp[ar, me]
        g[:, o + 1] = log1(atp_me)
        g[:, o + 2] = hn.float() / 5
        hk = torch.where(held, m.card_kind[hand.clamp(min=0)], -1)
        kinds = torch.stack([(hk == k).sum(1) for k in range(4)], 1)
        g[:, o + 3:o + 7] = kinds.float() / 3
        has_set = (hn >= 3) & ((kinds[:, 3] >= 1) | (kinds[:, :3] >= 3).any(1) | (kinds[:, :3] >= 1).all(1))
        tc = e.trade_count
        nxt = trade_bonus(tc)
        g[:, o + 7] = log1(torch.where(has_set, nxt, 0))
        g[:, o + 8] = log1(tc)
        g[:, o + 9] = log1(nxt)
        g[:, o + 10] = e.conquered.float()
        g[:, o + 11] = e.fortified.float()
        g[:, o + 12] = e.turn.float() / 100
        g[:, o + 13] = e.round.float() / 50
        g[:, o + 14] = n / MAX_SLOTS
        g[:, o + 15] = T / 120
        # rules (o + 16 ..): all off under the default options

        self._ctx = (me, atp_me, hand, armies_f, pend)
        return terr, g

    def candidates(self, b: torch.Tensor, a: torch.Tensor):
        """Features of move a[i] in game b[i] (after encode()): (cand [M, 13], cand_from [M], cand_to [M])."""
        e, m, L = self.e, self.e.m, self.e.L
        me, atp_me, hand, armies_f, pend = self._ctx
        M = b.shape[0]
        dev = e.dev
        kind, slot, arg = L.kind[a], L.slot[a], L.arg[a]
        cand = self.cand_kind_onehot[a].clone()
        cf = torch.full((M,), -1, dtype=torch.long, device=dev)
        ct = torch.full((M,), -1, dtype=torch.long, device=dev)
        amount = torch.zeros(M, dtype=torch.long, device=dev)
        pool = torch.zeros(M, dtype=torch.long, device=dev)

        # place: amount all / half / 1 of what may be placed now, out of max(amount, armies to place)
        atp = atp_me[b]
        lim = torch.where(e.phase[b] == SETUP, torch.clamp(atp, max=e.setup_batch), atp)
        n = torch.where(slot == 0, lim, torch.where(slot == 1, (lim + 1) // 2, 1))
        k = kind == K_PLACE
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
        cand[:, 12] = torch.where(k, owned.sum(-1).float() / 3, 0.0)

        has = amount > 0
        cand[:, 9] = torch.where(has, torch.where(pool > 0, amount.float() / pool.clamp(min=1).float(), 1.0), 0.0)
        cand[:, 10] = torch.where(has, log1(amount), 0.0)
        return cand, cf, ct

    def encode_dense(self):
        """Every move of every game (for checks): territory, global, cand [B, A, 13], cand_from [B, A], cand_to [B, A]."""
        e = self.e
        terr, g = self.encode()
        A = e.L.A
        b = torch.arange(e.B, device=e.dev).repeat_interleave(A)
        a = torch.arange(A, device=e.dev).repeat(e.B)
        cand, cf, ct = self.candidates(b, a)
        return terr, g, cand.view(e.B, A, -1), cf.view(e.B, A), ct.view(e.B, A)
