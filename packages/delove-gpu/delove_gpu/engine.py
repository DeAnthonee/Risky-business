"""A vectorised mirror of the Risk rules (packages/engine/src/engine.ts) for N games at once, as GPU tensors.

TRAINING ONLY. The TypeScript engine is the authority on the rules. This mirror exists to run self-play
simulations fast, and is trusted only as far as the replay tests (tests/replay.py) show it plays exactly the same
game: same deal, same dice, same cards, same phases, same legal moves at every step of logged self-play games. A
mismatch is a bug here, never a reason to change packages/engine. Never use it to run a live game.

Covered: the classic map, 2 players plus the classic Neutral, DEFAULT_OPTIONS (random deal, setup batch 1,
progressive cards, connected fortify, first-round bonus, no capitals / fog / blizzards / balanced blitz).
Moves are the self-play action space (packages/selfplay/src/actions.ts): place (all / half / 1), trade a set,
blitz attack, occupy (max / half / min), fortify in two steps (source, then destination and all / half), end turn.

Every game has its own mulberry32 stream seeded like createGame(seed), so a game here and in the TypeScript engine
with the same seed and the same choices are identical.

Shapes: B games, T territories, P = seats + 1 player slots (the last slot is the Neutral), H hand slots.
Players are numbered by seat (seating order, as in the decision logs); `order` holds seats in turn order.
"""
from __future__ import annotations

import torch

from . import rng as R
from .fingerprint import require_verified
from .config import GameConfig
from .mapdata import WILD, MapData, triples

# packages/selfplay/src/log.ts PHASES
LOBBY, SETUP, CAPITALS, REINFORCE, ATTACK, FORTIFY, FINISHED = range(7)
FORCED_TRADE_CARDS = 5

# Action kinds (fixed layout below). Values are internal; CANDIDATE_KINDS order lives in encode.py.
K_PLACE, K_TRADE, K_ATTACK, K_OCCUPY, K_FFROM, K_FTO, K_END, K_CAPITAL = range(8)
KIND_NAMES = ["place", "trade", "attack", "occupy", "fortify_from", "fortify_to", "end_turn", "capital"]

# One round of 3 attack dice against 2 defence dice (of 7776 rolls): defender loses 2, each loses 1, attacker loses 2.
P_DEF2, P_SPLIT = 2890 / 7776, 2611 / 7776
# 3 dice against 1: the attacker wins the round (855 of 1296 rolls).
P_WIN_3V1 = 855 / 1296

# Trades are offered only while a hand is below FORCED_TRADE_CARDS (forced trades are automatic), so sets come
# from the first TRADE_SLOTS hand slots.
TRADE_SLOTS = 5


class Layout:
    """The fixed action space: every move any game could make, one index each. Legal moves are a [B, A] mask.

    place        T x 3   territory, amount slot (all, half, 1) as in actions.ts amounts()
    trade        10      hand-slot triple among the first 5 slots, findSets order
    attack       E       directed edge, in legalMoves order
    occupy       3       max, max(min, half), min
    fortify_from T
    fortify_to   T x 2   destination, amount slot (all, half)
    end_turn     1
    capital      T       choose this territory as my capital (capitals phase)
    """

    def __init__(self, m: MapData):
        T, E = m.T, m.E
        self.trade_tri = triples(TRADE_SLOTS, m.device)
        nt = self.trade_tri.shape[0]
        self.PLACE = 0
        self.TRADE = self.PLACE + 3 * T
        self.ATTACK = self.TRADE + nt
        self.OCCUPY = self.ATTACK + E
        self.FFROM = self.OCCUPY + 3
        self.FTO = self.FFROM + T
        self.END = self.FTO + 2 * T
        self.CAP = self.END + 1
        self.A = self.CAP + T
        kind, arg, slot = [], [], []
        for t in range(T):
            for s in range(3):
                kind.append(K_PLACE), arg.append(t), slot.append(s)
        for k in range(nt):
            kind.append(K_TRADE), arg.append(k), slot.append(0)
        for e in range(E):
            kind.append(K_ATTACK), arg.append(e), slot.append(0)
        for s in range(3):
            kind.append(K_OCCUPY), arg.append(0), slot.append(s)
        for t in range(T):
            kind.append(K_FFROM), arg.append(t), slot.append(0)
        for t in range(T):
            for s in range(2):
                kind.append(K_FTO), arg.append(t), slot.append(s)
        kind.append(K_END), arg.append(0), slot.append(0)
        for t in range(T):
            kind.append(K_CAPITAL), arg.append(t), slot.append(0)
        d = m.device
        self.kind = torch.tensor(kind, dtype=torch.long, device=d)
        self.arg = torch.tensor(arg, dtype=torch.long, device=d)
        self.slot = torch.tensor(slot, dtype=torch.long, device=d)


def trade_bonus(i: torch.Tensor) -> torch.Tensor:
    """cards.ts tradeBonus: 4, 6, 8, 10, 12, 15, then +5 each."""
    table = torch.tensor([4, 6, 8, 10, 12, 15], dtype=torch.long, device=i.device)
    return torch.where(i < 6, table[i.clamp(max=5)], 15 + 5 * (i - 5))


def valid_set(kinds: torch.Tensor) -> torch.Tensor:
    """cards.ts isValidSet over the last dim (3 card kinds): any wild, three of a kind, or one of each."""
    k0, k1, k2 = kinds.unbind(-1)
    wild = (kinds == WILD).any(-1)
    same = (k0 == k1) & (k1 == k2)
    diff = (k0 != k1) & (k1 != k2) & (k0 != k2)
    return wild | same | diff


class State:
    """The state of B games of one configuration (map, seats, settings) as tensors, shared by both rules
    implementations (engine.py's tensor ops for Classic 2-player, fused.py's CUDA kernels for every configuration),
    the encoder and the players.

    Hand slots: a player holds at most 4 cards when deciding and 5 between turns, so taking an eliminated player's hand
    reaches at most 9 before the automatic trades: 12 slots."""

    MIRROR = "?"

    def __init__(self, B: int, cfg: GameConfig | None = None, device="cuda", max_turns: int = 500, hand_slots: int = 12,
                 seed: int = 0, allow_unverified: bool = False, map_id: str | None = None, n_seats: int | None = None):
        """Raises fingerprint.StaleMirror when the engine files changed since the mirror was last verified (verify.py),
        unless allow_unverified=True (the replay test and benchmarks; never for training data)."""
        if not allow_unverified:
            require_verified(self.MIRROR)
        if cfg is None:
            cfg = GameConfig.make(n_seats or 2, {"map": map_id or "classic"})
        self.cfg = cfg
        n_seats = cfg.seats
        self.m = m = MapData(cfg.map, device)
        self.L = Layout(m)
        self.B, self.n, self.P, self.NEU, self.H = B, n_seats, n_seats + 1, n_seats, hand_slots
        self.max_turns = max_turns
        self.setup_batch = cfg.opt("setupBatch")
        self.first_round_bonus = cfg.opt("firstRoundBonus")
        self.dev = dev = m.device
        self.gen = torch.Generator(device=dev).manual_seed(seed)
        T, P, H, NC = m.T, self.P, self.H, m.NC
        lz = lambda *s: torch.zeros(*s, dtype=torch.long, device=dev)
        bz = lambda *s: torch.zeros(*s, dtype=torch.bool, device=dev)
        self.ar = torch.arange(B, device=dev)
        self.tarange = torch.arange(T, device=dev)
        self.owner = lz(B, T) - 1
        self.armies = lz(B, T)
        self.alive = bz(B, P)
        self.atp = lz(B, P)  # armies to place
        self.hand = lz(B, P, H) - 1  # card ids in the order they were received
        self.hand_n = lz(B, P)
        self.trades_made = lz(B, P)
        self.trade_count = lz(B)
        self.deck = lz(B, NC)
        self.deck_n = lz(B)
        self.discard = lz(B, NC)
        self.discard_n = lz(B)
        self.order = lz(B, self.n)
        self.cur_pos = lz(B)
        self.phase = lz(B) + FINISHED
        self.turn = lz(B)
        self.round = lz(B)
        self.pend_from = lz(B) - 1
        self.pend_to = lz(B) - 1
        self.pend_min = lz(B)
        self.pend_max = lz(B)
        self.conquered = bz(B)
        self.fortified = bz(B)
        self.fort_src = lz(B) - 1
        self.rng = lz(B)
        self.seed = lz(B)
        self.winner = lz(B) - 1
        self.done = torch.ones(B, dtype=torch.bool, device=dev)
        self.capital = lz(B, self.n) - 1  # capital territory per seat (-1 = none)
        self.bliz = bz(B, T)  # blizzards: impassable for the whole game
        self.tri_by_h = {h: triples(h, dev) for h in range(3, H + 1)}

    @property
    def cur(self) -> torch.Tensor:
        return self.order.gather(1, self.cur_pos[:, None]).squeeze(1)

    def income(self) -> torch.Tensor:
        """[B, seats]: reinforcementsFor(seat).total for every seat (the decision log's income, before alive)."""
        raise NotImplementedError


class Engine(State):
    """The rules as batched tensor operations: the readable reference, Classic 2-player with DEFAULT_OPTIONS only
    (fused.py covers every configuration)."""

    MIRROR = "engine.py"  # the name verify.py records when it has replayed logs through this implementation

    def __init__(self, B: int, cfg: GameConfig | None = None, exact: bool = True, **kw):
        """exact=True draws every die and shuffle from each game's mulberry32 stream, as the TypeScript engine does
        (the replay tests need it). exact=False is for speed: torch's generator, shuffles by sorting random keys, and
        blitzes that resolve whole runs of 3-against-2 rounds with one multinomial draw. Same rules, same
        probabilities, different random numbers (tests/blitz_stats.py checks the battle outcomes match)."""
        super().__init__(B, cfg, **kw)
        if self.cfg != GameConfig.make(2):
            raise NotImplementedError("engine.py covers Classic 2-player with the default settings; use fused.py")
        self.exact = exact

    def income(self) -> torch.Tensor:
        return torch.stack([self.reinforcements(self.ar, torch.full_like(self.ar, s)) for s in range(self.n)], 1)

    # ------------------------------------------------------------------ helpers

    def _shuffle(self, arr: torch.Tensor, s: torch.Tensor, lens: torch.Tensor | None = None):
        """rng.ts shuffle (Fisher-Yates from the end) on each row; rows shorter than the width use `lens`."""
        L = arr.shape[1]
        if not self.exact:
            keys = torch.rand(arr.shape, device=arr.device, generator=self.gen)
            if lens is not None:
                keys = torch.where(torch.arange(L, device=arr.device)[None, :] < lens[:, None], keys, 2.0)
            return arr.gather(1, keys.argsort(1)), s
        rows = torch.arange(arr.shape[0], device=arr.device)
        for i in range(L - 1, 0, -1):
            j = R.to_int(R.nth(s, 1), i + 1)
            if lens is None:
                s = R.advance(s, 1)
                act = None
            else:
                act = i < lens
                s = torch.where(act, R.advance(s, 1), s)
                j = torch.where(act, j, i)
            ai = arr[:, i].clone()
            aj = arr[rows, j]
            arr[:, i] = aj
            arr[rows, j] = ai
        return arr, s

    def _append_hand(self, g, p, cards, counts):
        """Append cards[:, :counts] (in order) to the hands of players p in games g."""
        H = self.H
        k = cards.shape[1]
        hn = self.hand_n[g, p]
        pos = hn[:, None] + torch.arange(k, device=self.dev)
        ok = torch.arange(k, device=self.dev)[None, :] < counts[:, None]
        pos = torch.where(ok, pos, H)
        h = torch.cat([self.hand[g, p], torch.full((len(g), 1), -1, dtype=torch.long, device=self.dev)], 1)
        h.scatter_(1, pos, torch.where(ok, cards, -1))
        self.hand[g, p] = h[:, :H]
        self.hand_n[g, p] = hn + counts

    def _remove_hand(self, g, p, slots):
        """Drop hand slots (stable: the rest keep their order, as Array.filter)."""
        H = self.H
        h = self.hand[g, p]
        hn = self.hand_n[g, p]
        rm = torch.zeros(len(g), H, dtype=torch.bool, device=self.dev).scatter_(1, slots, True)
        keep = (torch.arange(H, device=self.dev)[None, :] < hn[:, None]) & ~rm
        pos = torch.where(keep, keep.long().cumsum(1) - 1, H)
        out = torch.full((len(g), H + 1), -1, dtype=torch.long, device=self.dev)
        out.scatter_(1, pos, torch.where(keep, h, -1))
        self.hand[g, p] = out[:, :H]
        self.hand_n[g, p] = keep.sum(1)

    def reinforcements(self, g, p) -> torch.Tensor:
        """engine.ts reinforcementsFor(...).total: max(3, territories / 3) + continent bonuses (no capitals)."""
        owned = self.owner[g] == p[:, None]
        cnt = owned.sum(1)
        held = owned.float() @ self.m.cont_member.T.float()
        full = held.long() == self.m.cont_size[None, :]
        return torch.clamp(cnt // 3, min=3) + (full.long() * self.m.cont_bonus[None, :]).sum(1)

    # ------------------------------------------------------------------ start

    def reset(self, g: torch.Tensor, seeds: torch.Tensor):
        """createGame(seed) + addPlayer x2 + startGame for games g (engine.ts startGame, random deal)."""
        m, dev, n, NEU, T, NC = self.m, self.dev, self.n, self.NEU, self.m.T, self.m.NC
        G = len(g)
        if G == 0:
            return
        s = seeds.to(dev).long() & R.M32
        self.seed[g] = s
        order, s = self._shuffle(torch.arange(n, device=dev).repeat(G, 1), s)
        deck, s = self._shuffle(torch.arange(NC, device=dev).repeat(G, 1), s)
        perm, s = self._shuffle(torch.arange(T, device=dev).repeat(G, 1), s)
        k = n + 1
        deal_order = torch.cat([order, torch.full((G, 1), NEU, device=dev, dtype=torch.long)], 1)
        by_pos = deal_order[:, torch.arange(T, device=dev) % k]
        owner = torch.empty(G, T, dtype=torch.long, device=dev).scatter_(1, perm, by_pos)
        start = self.cfg.starting_armies
        dealt = torch.tensor([len(range(d, T, k)) for d in range(k)], device=dev)
        atp = torch.zeros(G, self.P, dtype=torch.long, device=dev)
        atp.scatter_(1, order, (start - dealt[:n]).repeat(G, 1))
        # The Neutral spreads its remaining armies evenly from a random start (distributeEvenly).
        neu = owner == NEU
        Ln = neu.sum(1)
        if self.exact:
            i0 = R.to_int(R.nth(s, 1), Ln)
        else:
            i0 = (torch.rand(G, device=dev, generator=self.gen) * Ln).long().clamp(max=Ln - 1)
        s = R.advance(s, 1)
        extra_n = start - Ln
        q = neu.long().cumsum(1) - 1
        extra = extra_n[:, None] // Ln[:, None] + (((q - i0[:, None]) % Ln[:, None]) < (extra_n % Ln)[:, None]).long()
        armies = 1 + torch.where(neu, extra, 0)

        self.owner[g] = owner
        self.armies[g] = armies
        self.alive[g] = True
        self.atp[g] = atp
        self.hand[g] = -1
        self.hand_n[g] = 0
        self.trades_made[g] = 0
        self.trade_count[g] = 0
        self.deck[g] = deck
        self.deck_n[g] = NC
        self.discard[g] = 0
        self.discard_n[g] = 0
        self.order[g] = order
        self.cur_pos[g] = 0
        self.phase[g] = SETUP
        self.turn[g] = 0
        self.round[g] = 0
        self.pend_from[g] = -1
        self.pend_to[g] = -1
        self.pend_min[g] = 0
        self.pend_max[g] = 0
        self.conquered[g] = False
        self.fortified[g] = False
        self.fort_src[g] = -1
        self.rng[g] = s
        self.winner[g] = -1
        self.done[g] = False

    # ------------------------------------------------------------------ legal moves

    def components(self) -> torch.Tensor:
        """Connected same-owner regions: label = smallest territory index in the region, [B, T]."""
        m = self.m
        B, T, D = self.B, m.T, m.D
        nbr = m.nbr.reshape(1, -1).expand(B, -1)
        same = (self.owner.gather(1, nbr).view(B, T, D) == self.owner[:, :, None]) & m.nbr_valid[None]
        lab = self.tarange.repeat(B, 1)
        for it in range(T):
            nl = lab.gather(1, nbr).view(B, T, D)
            nl = torch.where(same, nl, T).min(-1).values
            new = torch.minimum(lab, nl)
            new = new.gather(1, new)  # pointer jump: a label is always a territory of the same region
            if it % 3 == 2 and torch.equal(new, lab):
                break
            lab = new
        return lab

    def legal(self) -> torch.Tensor:
        """[B, A] mask of the moves legal now (all False for finished games); the candidates() of actions.ts."""
        m, L, B, T = self.m, self.L, self.B, self.m.T
        ar = self.ar
        cur = self.cur
        live = ~self.done
        ph = self.phase
        owned = self.owner == cur[:, None]
        atp = self.atp[ar, cur]
        hn = self.hand_n[ar, cur]
        pend = self.pend_from >= 0
        fsrc = self.fort_src >= 0
        must = ((ph == REINFORCE) | (ph == ATTACK)) & (hn >= FORCED_TRADE_CARDS)
        free = live & ~pend & ~fsrc
        mask = torch.zeros(B, L.A, dtype=torch.bool, device=self.dev)

        # place: amounts all / half / 1, deduplicated
        lim = torch.where(ph == SETUP, torch.clamp(atp, max=self.setup_batch), atp)
        can_place = free & ((ph == SETUP) | ((ph == REINFORCE) & ~must) | ((ph == ATTACK) & ~must & (atp > 0)))
        half = (lim + 1) // 2
        slot_ok = torch.stack([lim >= 1, half != lim, (lim != 1) & (half != 1)], 1)  # [B, 3]
        place = (can_place[:, None] & owned)[:, :, None] & slot_ok[:, None, :]
        mask[:, L.PLACE:L.TRADE] = place.reshape(B, 3 * T)

        # trade: sets among the first TRADE_SLOTS cards
        can_trade = free & ((ph == REINFORCE) | ((ph == ATTACK) & must))
        hand = self.hand[ar, cur]
        tri = L.trade_tri
        cards = hand[:, tri]  # [B, nt, 3]
        ok = (tri[None, :, 2] < hn[:, None]) & valid_set(m.card_kind[cards.clamp(min=0)])
        mask[:, L.TRADE:L.ATTACK] = can_trade[:, None] & ok

        # attack, fortify_from and end_turn (attack phase, nothing to place, no forced trade)
        att = free & (ph == ATTACK) & ~must & (atp == 0)
        fort_phase = free & (ph == FORTIFY)
        ef, et = m.edge_from, m.edge_to
        mask[:, L.ATTACK:L.OCCUPY] = att[:, None] & owned[:, ef] & (self.armies[:, ef] >= 2) & (self.owner[:, et] != cur[:, None])
        need_comp = (att | fort_phase | (live & fsrc)) & ~self.fortified
        lab = self.components()
        size = torch.zeros(B, T, dtype=torch.long, device=self.dev).scatter_add_(1, lab, torch.ones_like(lab)).gather(1, lab)
        mask[:, L.FFROM:L.FTO] = (need_comp & ~fsrc)[:, None] & owned & (self.armies >= 2) & (size >= 2)
        mask[:, L.END] = att | fort_phase

        # occupy: max, max(min, half), min, deduplicated
        occ = live & pend
        mx, mn = self.pend_max, self.pend_min
        mid = torch.maximum(mn, (mx + 1) // 2)
        mask[:, L.OCCUPY:L.FFROM] = occ[:, None] & torch.stack([mx >= 1, mid != mx, (mn != mx) & (mn != mid)], 1)

        # fortify_to: the region of the chosen source, all or half of what may move
        src = self.fort_src.clamp(min=0)
        ft = live & fsrc
        fmax = self.armies[ar, src] - 1
        to_ok = (lab == lab[ar, src][:, None]) & (self.tarange[None, :] != src[:, None]) & owned
        fslot = torch.stack([fmax >= 1, (fmax + 1) // 2 != fmax], 1)
        mask[:, L.FTO:L.END] = ((ft[:, None] & to_ok)[:, :, None] & fslot[:, None, :]).reshape(B, 2 * T)
        return mask

    # ------------------------------------------------------------------ moves

    def step(self, action: torch.Tensor):
        """Apply one move per game (ignored for finished games). The caller guarantees it is legal."""
        L = self.L
        live = ~self.done
        kind = torch.where(live, L.kind[action], -1)
        arg = L.arg[action]
        slot = L.slot[action]
        kinds = torch.bincount(kind + 1, minlength=8)[1:].tolist()
        handlers = [self._place, self._trade, self._attack, self._occupy, self._ffrom, self._fto, self._end]
        for k, h in enumerate(handlers):
            if kinds[k]:
                g = torch.nonzero(kind == k).squeeze(1)
                h(g, arg[g], slot[g])
        self.done |= (self.phase == FINISHED) | (self.turn >= self.max_turns)

    def _place(self, g, t, slot):
        p = self.cur[g]
        a = self.atp[g, p]
        ph = self.phase[g]
        lim = torch.where(ph == SETUP, torch.clamp(a, max=self.setup_batch), a)
        n = torch.where(slot == 0, lim, torch.where(slot == 1, (lim + 1) // 2, 1))
        self.armies[g, t] += n
        self.atp[g, p] = a - n
        setup = ph == SETUP
        if setup.any():
            self._advance_setup(g[setup])
        done_placing = (ph == REINFORCE) & (a - n == 0)
        self.phase[g[done_placing]] = ATTACK

    def _advance_setup(self, g):
        """engine.ts advanceSetup (no claiming: the deal is random)."""
        n = self.n
        order = self.order[g]
        need = self.alive[g].gather(1, order) & (self.atp[g].gather(1, order) > 0)
        fin = ~need.any(1)
        if fin.any():
            self._begin_first_turn(g[fin])
        go = ~fin
        if go.any():
            gg = g[go]
            idx = (self.cur_pos[gg][:, None] + torch.arange(1, n + 1, device=self.dev)) % n
            first = need[go].gather(1, idx).long().argmax(1)
            self.cur_pos[gg] = idx.gather(1, first[:, None]).squeeze(1)

    def _begin_first_turn(self, g):
        self.turn[g] = 0
        self.round[g] = 1
        alive_o = self.alive[g].gather(1, self.order[g])
        self._begin_turn(g, alive_o.long().argmax(1))

    def _begin_turn(self, g, pos):
        self.cur_pos[g] = pos
        p = self.order[g].gather(1, pos[:, None]).squeeze(1)
        self.turn[g] += 1
        self.phase[g] = REINFORCE
        self.pend_from[g] = -1
        self.pend_to[g] = -1
        self.fortified[g] = False
        self.conquered[g] = False
        total = self.reinforcements(g, p)
        if self.first_round_bonus:
            total = torch.where(self.round[g] == 1, torch.maximum(total, pos + 1), total)
        self.atp[g, p] = total
        self._auto_trade(g, p)

    def _trade(self, g, k, slot):
        p = self.cur[g]
        self._trade_set(g, p, self.L.trade_tri[k], by_id=True)

    def _trade_set(self, g, p, slots, by_id: bool):
        """engine.ts tradeSet. A chosen trade lists its cards by id (the candidate is sorted); an automatic one in
        hand order. The order decides which owned territory gets the +2."""
        cards = self.hand[g, p].gather(1, slots)
        if by_id:
            cards = cards.sort(1).values
        tc = self.trade_count[g]
        self.atp[g, p] += trade_bonus(tc)
        self.trade_count[g] = tc + 1
        self.trades_made[g, p] += 1
        self._remove_hand(g, p, slots)
        pos = self.discard_n[g][:, None] + torch.arange(3, device=self.dev)
        self.discard[g[:, None], pos] = cards
        self.discard_n[g] += 3
        terr = self.m.card_terr[cards]
        own = (terr >= 0) & (self.owner[g[:, None], terr.clamp(min=0)] == p[:, None])
        has = own.any(1)
        if has.any():
            first = own.long().argmax(1)
            tt = terr.gather(1, first[:, None]).squeeze(1)
            self.armies[g[has], tt[has]] += 2

    def _auto_trade(self, g, p):
        """engine.ts autoTrade with bestSet: most armies, then a set showing an owned territory, then fewest wilds;
        ties go to the first set in findSets order."""
        while len(g):
            need = self.hand_n[g, p] >= FORCED_TRADE_CARDS
            if not need.any():
                return
            g, p = g[need], p[need]
            hn = self.hand_n[g, p]
            tri = self.tri_by_h[int(hn.max())]
            hand = self.hand[g, p]
            cards = hand[:, tri]  # [G, R, 3]
            ok = (tri[None, :, 2] < hn[:, None]) & valid_set(self.m.card_kind[cards.clamp(min=0)])
            terr = self.m.card_terr[cards.clamp(min=0)]
            own_t = torch.gather(self.owner[g], 1, terr.clamp(min=0).reshape(len(g), -1)).reshape(terr.shape)
            bonus = ((terr >= 0) & (own_t == p[:, None, None])).any(-1)
            wilds = (self.m.card_kind[cards.clamp(min=0)] == WILD).sum(-1)
            R_ = tri.shape[0]
            key = (bonus.long() * 4 + (3 - wilds)) * 1024 + (R_ - torch.arange(R_, device=self.dev))[None, :]
            key = torch.where(ok, key, -1)
            best = key.argmax(1)
            self._trade_set(g, p, tri[best], by_id=False)

    def _blitz_fast(self, fa, ta, s):
        """The same battle as _blitz, in distribution, in a handful of GPU steps instead of one per roll.

        While the attacker rolls 3 dice and the defender 2 (fa >= 4, ta >= 2) rounds are independent and identical,
        so k of them (k small enough that neither side can leave that regime) are one multinomial draw. 3 dice
        against 1 defender ends at the first round the attacker wins, a geometric draw. The few rolls left (attacker
        down to 1 or 2 dice) are rolled one by one."""
        G = fa.shape[0]
        dev, gen = self.dev, self.gen
        last = torch.zeros(G, dtype=torch.long, device=dev)
        while True:
            reg = (fa >= 4) & (ta >= 2)
            if not reg.any():
                break
            k = torch.where(reg, torch.minimum((fa - 4) // 2, (ta - 2) // 2) + 1, 0).float()
            n_dd = torch.binomial(k, torch.full_like(k, P_DEF2), generator=gen)
            n_s = torch.binomial(k - n_dd, torch.full_like(k, P_SPLIT / (1 - P_DEF2)), generator=gen)
            n_aa = k - n_dd - n_s
            fa = fa - (2 * n_aa + n_s).long()
            ta = ta - (2 * n_dd + n_s).long()
            last = torch.where(reg, 3, last)
        reg = (fa >= 4) & (ta == 1)
        if reg.any():
            u = torch.rand(G, device=dev, generator=gen).clamp(min=1e-12)
            fails = torch.floor(torch.log(u) / torch.log(torch.tensor(1 - P_WIN_3V1, device=dev))).long()
            win = reg & (fails <= fa - 4)
            fa = torch.where(win, fa - fails, torch.where(reg, 3, fa))
            ta = torch.where(win, 0, ta)
            last = torch.where(reg, 3, last)
        k3 = torch.arange(3, device=dev)
        active = (fa >= 2) & (ta > 0)
        while active.any():
            ad = torch.clamp(fa - 1, max=3)
            dd = torch.clamp(ta, max=2)
            dice = torch.randint(1, 7, (G, 5), device=dev, generator=gen)
            a = torch.where(k3[None, :] < ad[:, None], dice[:, :3], 0).sort(1, descending=True).values
            d = torch.where(k3[None, :2] < dd[:, None], dice[:, 3:], 0).sort(1, descending=True).values
            cmp = k3[None, :2] < torch.minimum(ad, dd)[:, None]
            dl = (cmp & (a[:, :2] > d)).sum(1)
            al = (cmp & (a[:, :2] <= d)).sum(1)
            fa = torch.where(active, fa - al, fa)
            ta = torch.where(active, ta - dl, ta)
            last = torch.where(active, ad, last)
            active = active & (ta > 0) & (fa >= 2)
        return fa, ta, s, last

    def _blitz(self, fa, ta, s):
        """rollBattle(..., blitz, stopAt 1): roll until the defender is gone or the attacker is down to 1.
        Each roll draws the attacker's dice, then the defender's, from the game's stream."""
        G = fa.shape[0]
        dev = self.dev
        last = torch.zeros(G, dtype=torch.long, device=dev)
        offs = torch.arange(1, 6, device=dev)
        k3 = torch.arange(3, device=dev)
        active = (fa >= 2) & (ta > 0)
        while active.any():
            ad = torch.clamp(fa - 1, max=3)
            dd = torch.clamp(ta, max=2)
            dice = 1 + R.to_int(R.nth(s[:, None], offs[None, :]), 6)  # [G, 5]
            a = torch.where(k3[None, :] < ad[:, None], dice[:, :3], 0).sort(1, descending=True).values
            didx = (ad[:, None] + k3[None, :2]).clamp(max=4)
            d = torch.where(k3[None, :2] < dd[:, None], dice.gather(1, didx), 0).sort(1, descending=True).values
            pairs = torch.minimum(ad, dd)
            cmp = k3[None, :2] < pairs[:, None]
            dl = (cmp & (a[:, :2] > d)).sum(1)
            al = (cmp & (a[:, :2] <= d)).sum(1)
            fa = torch.where(active, fa - al, fa)
            ta = torch.where(active, ta - dl, ta)
            s = torch.where(active, R.advance(s, ad + dd), s)
            last = torch.where(active, ad, last)
            active = active & (ta > 0) & (fa >= 2)
        return fa, ta, s, last

    def _attack(self, g, e, slot):
        m = self.m
        p = self.cur[g]
        frm, to = m.edge_from[e], m.edge_to[e]
        blitz = self._blitz if self.exact else self._blitz_fast
        fa, ta, s, last = blitz(self.armies[g, frm], self.armies[g, to], self.rng[g])
        self.armies[g, frm] = fa
        self.armies[g, to] = ta
        self.rng[g] = s
        won = ta == 0
        if not won.any():
            return
        g, p, frm, to, fa, last = g[won], p[won], frm[won], to[won], fa[won], last[won]
        defender = self.owner[g, to]
        self.owner[g, to] = p
        self.conquered[g] = True
        self.pend_from[g] = frm
        self.pend_to[g] = to
        self.pend_min[g] = torch.clamp(torch.minimum(last, fa - 1), min=1)
        self.pend_max[g] = fa - 1
        left = (self.owner[g] == defender[:, None]).sum(1)
        elim = left == 0
        if elim.any():
            g, p, defender = g[elim], p[elim], defender[elim]
            self.alive[g, defender] = False
            dn = self.hand_n[g, defender]
            cap = dn > 0
            if cap.any():
                gc, pc, dc = g[cap], p[cap], defender[cap]
                self._append_hand(gc, pc, self.hand[gc, dc], self.hand_n[gc, dc])
                self.hand[gc, dc] = -1
                self.hand_n[gc, dc] = 0
                self._auto_trade(gc, pc)

    def _occupy(self, g, _, slot):
        mx, mn = self.pend_max[g], self.pend_min[g]
        mid = torch.maximum(mn, (mx + 1) // 2)
        n = torch.where(slot == 0, mx, torch.where(slot == 1, mid, mn))
        pf, pt = self.pend_from[g], self.pend_to[g]
        self.armies[g, pf] -= n
        self.armies[g, pt] += n
        self.pend_from[g] = -1
        self.pend_to[g] = -1
        # checkVictory: one real player left
        seats_alive = self.alive[g, : self.n]
        won = seats_alive.sum(1) == 1
        if won.any():
            gw = g[won]
            self.phase[gw] = FINISHED
            self.winner[gw] = seats_alive[won].long().argmax(1)

    def _ffrom(self, g, t, slot):
        self.fort_src[g] = t

    def _fto(self, g, t, slot):
        src = self.fort_src[g]
        mx = self.armies[g, src] - 1
        n = torch.where(slot == 0, mx, (mx + 1) // 2)
        self.armies[g, src] -= n
        self.armies[g, t] += n
        self.fortified[g] = True
        self.fort_src[g] = -1
        self.phase[g] = FORTIFY
        self._end_turn(g)

    def _end(self, g, t, slot):
        self._end_turn(g)

    def _end_turn(self, g):
        p = self.cur[g]
        c = self.conquered[g]
        if c.any():
            self._draw(g[c], p[c])
        self._next_turn(g)

    def _draw(self, g, p):
        empty = (self.deck_n[g] == 0) & (self.discard_n[g] > 0)
        if empty.any():
            ge = g[empty]
            dn = self.discard_n[ge]
            deck, s = self._shuffle(self.discard[ge].clone(), self.rng[ge], dn)
            self.deck[ge] = deck
            self.deck_n[ge] = dn
            self.discard_n[ge] = 0
            self.rng[ge] = s
        has = self.deck_n[g] > 0
        g, p = g[has], p[has]
        if len(g) == 0:
            return
        top = self.deck_n[g] - 1
        card = self.deck[g, top]
        self.deck_n[g] = top
        self._append_hand(g, p, card[:, None], torch.ones_like(card))

    def _next_turn(self, g):
        n = self.n
        idx = self.cur_pos[g]
        cand = (idx[:, None] + torch.arange(1, n + 1, device=self.dev)) % n
        alive_o = self.alive[g].gather(1, self.order[g]).gather(1, cand)
        j = cand.gather(1, alive_o.long().argmax(1)[:, None]).squeeze(1)
        self.round[g] += (j <= idx).long()
        self._begin_turn(g, j)
