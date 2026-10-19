"""Branch and score (packages/delove/src/branch.ts, branchAgent) on the GPU, for every game that needs it at once.

TRAINING ONLY. branch.ts is the authority; tests/branch_replay.py checks this against logged branch games (option
lists, mean scores and picks, with the CPU's DELOVE_BRANCH_TRACE). Per decision of the branching player:

1. the teacher's own move first (the GPU teacher, on the seat's stream), then the ranker network's favourites, as
   branch.ts orders them (logits descending, ties in candidate order);
2. each option completed to an engine action (a fortify_from gets the teacher's fortify_to, on the same stream), then
   `rollouts` seeds drawn from it: Math.floor(random() * 0xffffffff);
3. options x seeds copies of the board, each with rngState = seed and its deck reshuffled with mulberry32(seed ^
   0x5bd1e995) (common random numbers: the same copies for every option), the option played, then `horizon` rounds of
   the teacher in every seat on one stream seeded with the seed (k_branch_sim, one CUDA thread per copy);
4. positionScore of each end position from the decider's side (in double precision, the same operations as the
   TypeScript), averaged over the seeds in order; the best option wins unless it beats the teacher's move by less than
   `margin`.

Setup decisions, decisions with one candidate and the `skip` kinds (occupy) are the teacher's move, as in branch.ts.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import torch

from .engine import ATTACK, FORTIFY, REINFORCE
from .fingerprint import REPO
from .fused import STATE_FIELDS
from .teacher import TeacherEngine

BRANCH_TS = REPO / "packages" / "delove" / "src" / "branch.ts"
SCORE_PARTS = ["score", "armies", "income", "territories", "cards", "continents", "won", "lost"]
WEIGHT_KEYS = ["armies", "income", "territories", "cards", "continents"]
BIG_TURNS = 0x7FFFFFFF
MAX_ROLLOUT_STEPS = 4000


@dataclass
class BranchConfig:
    options: int
    rollouts: int
    horizon: int
    margin: float
    skip: list[str]
    weights: dict[str, float] = field(default_factory=dict)


def default_branch() -> BranchConfig:
    """DEFAULT_BRANCH, read from branch.ts so the two cannot drift."""
    src = BRANCH_TS.read_text(encoding="utf8")
    m = re.search(r"DEFAULT_BRANCH: BranchOptions = \{(.*?)\n\};", src, re.S)
    if not m:
        raise RuntimeError(f"DEFAULT_BRANCH not found in {BRANCH_TS}")
    body = m.group(1)
    num = lambda k: float(re.search(rf"\b{k}:\s*(-?[\d.e+-]+)", body).group(1))  # noqa: E731
    skip = re.findall(r"'(\w+)'", re.search(r"skip:\s*\[(.*?)\]", body).group(1))
    w = dict(re.findall(r"(\w+):\s*(-?[\d.]+)", re.search(r"weights:\s*\{(.*?)\}", body).group(1)))
    if mv := re.search(r"valueWeight:\s*(-?[\d.]+)", body):
        if float(mv.group(1)) != 0:
            raise RuntimeError("branch.ts blends the value head in by default; the GPU branch does not mirror that")
    return BranchConfig(int(num("options")), int(num("rollouts")), int(num("horizon")), num("margin"), skip,
                        {k: float(w[k]) for k in WEIGHT_KEYS})


BRANCH_BODY = r"""
// ---- branch and score (packages/delove/src/branch.ts) ------------------------------------------------------------
// positionScore(state, me, weights): out = score, armies, income, territories, cards, continents, won, lost.
__device__ void position_score(S& s, int me, const double* w, double* out) {
  if (*s.phase == FINISHED) {
    double v = *s.winner == me ? 1.0 : 0.0;
    for (int i = 0; i < 7; i++) out[i] = v;
    out[7] = 1.0 - v;
    return;
  }
  if (!s.alive[me]) { for (int i = 0; i < 7; i++) out[i] = 0.0; out[7] = 1.0; return; }
  int terr[NS], arm[NS], inc[NS], con[NS], cards[NS], n = 0;
  int sum[5] = {0, 0, 0, 0, 0};
  for (int q = 0; q < NS; q++) {
    terr[q] = 0; arm[q] = 0;
    if (!s.alive[q]) continue;
    n++;
    for (int t = 0; t < T; t++) if (s.owner[t] == q) { terr[q]++; arm[q] += (int)s.armies[t]; }
    inc[q] = reinforcements(s, q);
    con[q] = 0;
    for (int c = 0; c < K; c++) {
      bool all = true;
      for (int i = 0; i < CSIZE[c]; i++) if (s.owner[CMEM[c][i]] != q) { all = false; break; }
      if (all) con[q]++;
    }
    cards[q] = (int)s.hand_n[q];
    sum[0] += arm[q]; sum[1] += inc[q]; sum[2] += terr[q]; sum[3] += cards[q]; sum[4] += con[q];
  }
  int mine[5] = {arm[me], inc[me], terr[me], cards[me], con[me]};
  double sc[5];
  for (int k = 0; k < 5; k++) sc[k] = sum[k] > 0 ? (double)mine[k] / (double)sum[k] : 1.0 / (double)n;
  out[0] = w[0] * sc[0] + w[1] * sc[1] + w[2] * sc[2] + w[3] * sc[3] + w[4] * sc[4];
  for (int k = 0; k < 5; k++) out[1 + k] = sc[k];
  out[6] = 0.0; out[7] = 0.0;
}

// Complete each game's options (a fortify_from gets the teacher's fortify_to, on the decider's stream, in option
// order) and draw its rollout seeds after them, as branchAgent does. games: the main-game slots to work on.
extern "C" __global__ void k_branch_prep(STATE_ARGS, const double* prm, const double* ow, const double* ola, const double* old,
                                         unsigned long long* tstats, i64* arng, int rstride, const i64* games, const i64* opts,
                                         i64* act2, const i64* nseeds, i64* seeds, int nopt, int maxseeds, int ng) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= ng) return;
  int b = (int)games[i];
  MAKE_S(b);
  TP tp = {prm, ow, ola, old, tstats};
  i64* rng = agent_rng(arng, rstride, b, cur(s));
  for (int k = 0; k < nopt; k++) {
    int a = (int)opts[i * nopt + k];
    act2[i * nopt + k] = -1;
    if (a >= FFROM && a < FTO) {
      *s.fort_src = a - FFROM;
      act2[i * nopt + k] = teacher_pick(s, tp, rng);
      *s.fort_src = -1;
    }
  }
  for (int r = 0; r < nseeds[i]; r++) seeds[i * maxseeds + r] = (i64)(unsigned int)floor(rnd(rng) * 4294967295.0);
}

// One copy per thread: reseed, reshuffle the deck, play the option (one or two steps), roll out `horizon` rounds
// with the teacher in every seat, and score the end position for `me`. a1 < 0: no such option (score -inf).
extern "C" __global__ void k_branch_sim(STATE_ARGS, const double* prm, const double* ow, const double* ola, const double* old,
                                        unsigned long long* tstats, const i64* seeds, const i64* a1, const i64* a2, const i64* mes,
                                        const double* w, int horizon, double* out, i64* moves_out, int n) {
  int j = blockIdx.x * blockDim.x + threadIdx.x;
  if (j >= n) return;
  double* o = out + (i64)j * 8;
  if (a1[j] < 0) { o[0] = -DINF; for (int k = 1; k < 8; k++) o[k] = 0.0; moves_out[j] = 0; return; }
  MAKE_S(j);
  TP tp = {prm, ow, ola, old, tstats};
  unsigned int seed = (unsigned int)seeds[j];
  *s.rng = (i64)seed;
  i64 st = (i64)(seed ^ 0x5bd1e995u);
  shuffle(s.deck, (int)*s.deck_n, &st);
  apply(s, (int)a1[j], BIG_TURNS);
  if (a2[j] >= 0) apply(s, (int)a2[j], BIG_TURNS);
  i64 stop = *s.round + horizon, ar = (i64)seed;
  int moves = 0;
  while (!*s.done && *s.round < stop && moves < MAX_ROLLOUT_STEPS) {
    int a = teacher_pick(s, tp, &ar);
    if (a < 0) break;
    apply(s, a, BIG_TURNS);
    if (!(a >= FFROM && a < FTO)) moves++;  // a fortify is one move of two steps
  }
  position_score(s, (int)mes[j], w, o);
  moves_out[j] = moves;
}

// The legal moves of every game in actions.ts candidate order (fortify destinations in the engine's connected-search
// order), for the training arrays: ord[b, :cnt[b]].
extern "C" __global__ void k_cand_order(STATE_ARGS, i64* ord, i64* cnt, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  u8 m[A];
  int n = legal(s, m), k = 0;
  i64* o = ord + (i64)b * A;
  if (*s.fort_src >= 0 && n > 0) {
    int src = (int)*s.fort_src, me = cur(s);
    u8 seen[T];
    int stack[T], sp = 0;
    for (int t = 0; t < T; t++) seen[t] = 0;
    seen[src] = 1; stack[sp++] = src;
    while (sp) {
      int u = stack[--sp];
      for (int q = 0; q < DEG[u]; q++) {
        int v = NBR[u][q];
        if (!seen[v] && s.owner[v] == me) {
          seen[v] = 1; stack[sp++] = v;
          for (int sl = 0; sl < 2; sl++) if (m[FTO + 2 * v + sl]) o[k++] = FTO + 2 * v + sl;
        }
      }
    }
  } else {  // actions.ts: trades, then placements, then attacks, occupy, fortify sources, end turn
    for (int a = TRADE; a < ATTACK; a++) if (m[a]) o[k++] = a;
    for (int a = 0; a < TRADE; a++) if (m[a]) o[k++] = a;
    for (int a = ATTACK; a < A; a++) if (m[a]) o[k++] = a;
  }
  cnt[b] = k;
}
"""

BRANCH_KERNELS = ("k_branch_prep", "k_branch_sim", "k_cand_order")
BRANCH_DEFS = f"#define BIG_TURNS {BIG_TURNS}\n#define MAX_ROLLOUT_STEPS {MAX_ROLLOUT_STEPS}\n"


class BranchEngine(TeacherEngine):
    """TeacherEngine plus the branch-and-score kernels."""

    MIRROR = "branch"

    def __init__(self, B: int, **kw):
        super().__init__(B, extra_source=BRANCH_DEFS + BRANCH_BODY, extra_kernels=BRANCH_KERNELS, **kw)

    def cand_order(self) -> tuple[torch.Tensor, torch.Tensor]:
        ord_ = torch.full((self.B, self.L.A), -1, dtype=torch.long, device=self.dev)
        cnt = torch.zeros(self.B, dtype=torch.long, device=self.dev)
        self._launch_t("k_cand_order", self.B, *self._state(), ord_, cnt, self.B)
        return ord_, cnt


class SimPool:
    """Copies of main-game boards for the rollouts (a BranchEngine of `capacity` games, refilled every decision)."""

    def __init__(self, main: BranchEngine, capacity: int):
        self.main = main
        self.e = BranchEngine(capacity, params=None, device=main.dev, allow_unverified=True)
        self.e.prm, self.e.ow, self.e.ola, self.e.old, self.e.tstats = main.prm, main.ow, main.ola, main.old, main.tstats
        self.capacity = capacity

    def load(self, src: torch.Tensor):
        n = src.numel()
        if n > self.capacity:
            raise ValueError(f"{n} rollout copies, capacity {self.capacity}")
        for name, _ in STATE_FIELDS:
            getattr(self.e, name)[:n] = getattr(self.main, name)[src]


@dataclass
class Decision:
    """What branch and score decided for a batch of games (all on the device)."""

    games: torch.Tensor  # main-game slots
    act1: torch.Tensor  # first step
    act2: torch.Tensor  # fortify_to after a fortify_from, else -1
    branched: torch.Tensor  # bool: options were compared
    changed: torch.Tensor  # bool: the pick is not the teacher's move
    options: torch.Tensor  # [n, OPT] first-step actions (-1 = none)
    means: torch.Tensor  # [n, OPT, 8] mean score parts per option (score -inf = none)
    best: torch.Tensor  # index of the pick among the options
    moves: int  # rollout moves played


class GpuBranch:
    """branchAgent over a BranchEngine of main games. `ranker(games, mask)` gives [n, A] logits (-inf where illegal)."""

    def __init__(self, main: BranchEngine, ranker, cfg: BranchConfig, max_games: int | None = None):
        self.e, self.ranker, self.cfg = main, ranker, cfg
        self.w = torch.tensor([cfg.weights[k] for k in WEIGHT_KEYS], dtype=torch.float64, device=main.dev)
        L = main.L
        self.skip_lo_hi = []
        for kind in cfg.skip:
            rng = {"occupy": (L.OCCUPY, L.FFROM), "place": (L.PLACE, L.TRADE), "trade": (L.TRADE, L.ATTACK),
                   "attack": (L.ATTACK, L.OCCUPY), "fortify_from": (L.FFROM, L.FTO), "end_turn": (L.END, L.END + 1)}.get(kind)
            if rng is None:
                raise ValueError(f"skip kind {kind!r} not covered")
            self.skip_lo_hi.append(rng)
        # first-step actions in actions.ts candidate order (trades before placements)
        self.cpu_order = cpu_order(L, main.dev)
        max_games = max_games or main.B
        self.sims = SimPool(main, max_games * cfg.options * cfg.rollouts)

    def important(self, games: torch.Tensor, mask: torch.Tensor, tact: torch.Tensor) -> torch.Tensor:
        e = self.e
        ph = e.phase[games]
        imp = ((ph == REINFORCE) | (ph == ATTACK) | (ph == FORTIFY)) & (mask[games].sum(1) > 1)
        t = tact[games]
        for lo, hi in self.skip_lo_hi:
            imp &= ~((t >= lo) & (t < hi))
        return imp

    def decide(self, games: torch.Tensor, mask: torch.Tensor, tact: torch.Tensor) -> Decision:
        """games: main slots where the branching player decides now; tact: the teacher's pick there (already drawn
        from the decider's stream, as branchAgent's first teacher() call)."""
        e, cfg, dev = self.e, self.cfg, self.e.dev
        n, OPT, R = games.numel(), cfg.options, cfg.rollouts
        imp = self.important(games, mask, tact)
        opts = torch.full((n, OPT), -1, dtype=torch.long, device=dev)
        opts[:, 0] = tact[games]
        ig = imp.nonzero(as_tuple=True)[0]
        if ig.numel():
            lg = self.ranker(games[ig], mask)  # [k, A]
            # logits descending, ties in candidate order (Array.prototype.sort is stable)
            order = self.cpu_order[torch.sort(-lg[:, self.cpu_order], dim=1, stable=True).indices[:, : OPT + 1]]
            ok = torch.isfinite(lg.gather(1, order)) & (order != tact[games[ig]][:, None])
            # first OPT-1 legal non-teacher entries, in ranking order
            pos = torch.cumsum(ok.long(), 1)
            sel = ok & (pos <= OPT - 1)
            for k in range(1, OPT):
                hit = sel & (pos == k)
                col = torch.where(hit.any(1), order.gather(1, hit.long().argmax(1, keepdim=True)).squeeze(1), -1)
                opts[ig, k] = col
        nseeds = torch.where(imp, R, 0).long()
        act2 = torch.full((n, OPT), -1, dtype=torch.long, device=dev)
        seeds = torch.zeros(n, R, dtype=torch.long, device=dev)
        e._launch_t("k_branch_prep", n, *e._state(), *e._tp(), e.arng, e.n, games.contiguous(), opts.contiguous(), act2,
                    nseeds.contiguous(), seeds, OPT, R, n)
        act1_out = opts[:, 0].clone()
        act2_out = act2[:, 0].clone()
        means = torch.full((n, OPT, 8), float("nan"), dtype=torch.float64, device=dev)
        best = torch.zeros(n, dtype=torch.long, device=dev)
        moves = 0
        if ig.numel():
            k = ig.numel()
            # copies: game-major, then option, then seed
            src = games[ig].repeat_interleave(OPT * R)
            self.sims.load(src)
            a1 = opts[ig].repeat_interleave(R, dim=1).reshape(-1)
            a2 = act2[ig].repeat_interleave(R, dim=1).reshape(-1)
            sd = seeds[ig].repeat(1, OPT).reshape(-1)
            me = e.cur[games[ig]].repeat_interleave(OPT * R)
            S = k * OPT * R
            out = torch.empty(S, 8, dtype=torch.float64, device=dev)
            mv = torch.empty(S, dtype=torch.long, device=dev)
            se = self.sims.e
            se._launch_t("k_branch_sim", S, *se._state(), *se._tp(), sd.contiguous(), a1.contiguous(), a2.contiguous(),
                         me.contiguous(), self.w, cfg.horizon, out, mv, S)
            moves = int(mv.sum())
            parts = out.view(k, OPT, R, 8)
            acc = torch.zeros(k, OPT, 8, dtype=torch.float64, device=dev)
            for r in range(R):  # parts[k] += sc[k], seed by seed, then / seeds.length
                acc = acc + parts[:, :, r, :]
            mean = acc / torch.full_like(acc, R)  # true division, as JavaScript's (not times 1/R)
            mean[:, :, 0] = torch.where(opts[ig] >= 0, mean[:, :, 0], float("-inf"))
            sc = mean[:, :, 0]
            bi = torch.zeros(k, dtype=torch.long, device=dev)
            for j in range(1, OPT):
                better = sc[:, j] > sc.gather(1, bi[:, None]).squeeze(1)
                bi = torch.where(better, j, bi)
            gain = sc.gather(1, bi[:, None]).squeeze(1) - sc[:, 0]
            bi = torch.where((bi != 0) & (gain < cfg.margin), 0, bi)
            means[ig] = mean
            best[ig] = bi
            act1_out[ig] = opts[ig].gather(1, bi[:, None]).squeeze(1)
            act2_out[ig] = act2[ig].gather(1, bi[:, None]).squeeze(1)
        return Decision(games, act1_out, act2_out, imp, imp & (best != 0), opts, means, best, moves)


def cpu_order(L, device) -> torch.Tensor:
    """The action space in actions.ts candidate order for a first step: trades, placements, then the rest."""
    idx = list(range(L.TRADE, L.ATTACK)) + list(range(L.PLACE, L.TRADE)) + list(range(L.ATTACK, L.A))
    return torch.tensor(idx, dtype=torch.long, device=device)


def first_max(lg: torch.Tensor, order: torch.Tensor) -> torch.Tensor:
    """argmax over the last dim with ties going to the first candidate in `order` (net-agent.ts argmax)."""
    return order[lg[:, order].argmax(1)]


def net_ranker(enc, net, adj, precision: str = "fp32"):
    """ranker(games, mask): a Delove network's logits over the legal moves of `games` (after enc.encode())."""
    dtype = torch.float16 if precision == "fp16" else torch.float32

    @torch.inference_mode()
    def rank(games: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        terr, glob = enc.last
        rows = enc.row_of[games]
        m = mask[games]
        bi, a = m.nonzero(as_tuple=True)
        cand, cf, ct = enc.candidates(rows[bi], a)
        lg, _ = net(terr[rows].to(dtype), glob[rows].to(dtype), adj.to(dtype), cand.to(dtype), cf, ct, bi)
        out = torch.full(m.shape, float("-inf"), device=m.device)
        out[bi, a] = lg.float()
        return out

    return rank
