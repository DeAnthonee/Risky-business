"""Branch and score (packages/delove/src/branch.ts, branchAgent) on the GPU, for every game that needs it at once.

TRAINING ONLY. branch.ts is the authority; tests/branch_replay.py checks this against logged branch games (option
lists, mean scores and picks, with the CPU's DELOVE_BRANCH_TRACE). Per decision of the branching player:

1. the teacher's own move first (the GPU teacher, on the seat's stream), then the ranker network's favourites, as
   branch.ts orders them (logits descending, ties in candidate order);
2. each option completed to an engine action (a fortify_from gets the teacher's fortify_to, on the same stream), then
   `rollouts` seeds drawn from it: Math.floor(random() * 0xffffffff);
3. options x seeds copies of the board, each with rngState = seed and its deck reshuffled with mulberry32(seed ^
   0x5bd1e995) (common random numbers: the same copies for every option), the option played, then `horizon` rounds of
   the teacher in every seat on one stream seeded with the seed (k_branch_sim, one group of SIM_LANES lanes per copy);
4. positionScore of each end position from the decider's side (in double precision, the same operations as the
   TypeScript; with score 'points', pointsScore: placement points interpolated at the expected place plus kills; with
   'kills', the share score plus killCredit),
   averaged over the seeds in order; the best option wins unless it beats the teacher's move by less than
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
from .outcome import ranking_constants
from .teacher import TeacherEngine

BRANCH_TS = REPO / "packages" / "delove" / "src" / "branch.ts"
SCORE_PARTS = ["score", "armies", "income", "territories", "cards", "continents", "won", "lost"]
WEIGHT_KEYS = ["armies", "income", "territories", "cards", "continents"]
SCORE_MODES = {"share": 0, "points": 1, "kills": 2}
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
    score: str = "share"  # 'share', 'points' or 'kills' (branch.ts BranchOptions.score)


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
    score = re.search(r"\bscore:\s*'(\w+)'", body).group(1)
    return BranchConfig(int(num("options")), int(num("rollouts")), int(num("horizon")), num("margin"), skip,
                        {k: float(w[k]) for k in WEIGHT_KEYS}, score)


BRANCH_BODY = r"""
// ---- branch and score (packages/delove/src/branch.ts) ------------------------------------------------------------
// positionScore(state, me, weights, mode): out = score, armies, income, territories, cards, continents, won, lost.
// mode 1 ('points'): score = pointsScore, with place = placementPoints(1..NS, NS) then KILL_POINTS (place[NS]).
// mode 2 ('kills'): score = the share score + killCredit.
__device__ double kill_credit(S& s, int me, const double* place) {
  int kills = 0;
  for (int q = 0; q < NS; q++) if (!s.alive[q] && s.elim_by[q] == me) kills++;
  return place[NS] * (double)kills / (place[0] - place[NS - 1]);
}

__device__ double points_score(S& s, int me, const double* place, double at) {
  int kills = 0, alive = 0;
  for (int q = 0; q < NS; q++) {
    if (s.alive[q]) alive++;
    else if (s.elim_by[q] == me) kills++;
  }
  double pts;
  if (at < 0.0) {
    pts = place[(alive + 1 > NS ? NS : alive + 1) - 1];
  } else {
    double fl = floor(at);
    int i = (int)fl;
    double f = at - fl;
    pts = i >= NS ? place[NS - 1] : place[i - 1] + f * (place[i] - place[i - 1]);
  }
  return (pts + place[NS] * (double)kills - place[NS - 1]) / (place[0] - place[NS - 1]);
}

__device__ void position_score(S& s, int me, const double* w, int mode, const double* place, double* out) {
  if (*s.phase == FINISHED) {
    bool won = *s.winner == me;
    double v = won ? 1.0 : 0.0;
    for (int i = 0; i < 7; i++) out[i] = v;
    out[7] = 1.0 - v;
    if (mode == 1) out[0] = points_score(s, me, place, won ? 1.0 : -1.0);
    if (mode == 2) out[0] = v + kill_credit(s, me, place);
    return;
  }
  if (!s.alive[me]) {
    for (int i = 0; i < 7; i++) out[i] = 0.0;
    out[7] = 1.0;
    if (mode == 1) out[0] = points_score(s, me, place, -1.0);
    if (mode == 2) out[0] = 0.0 + kill_credit(s, me, place);
    return;
  }
  int terr[NS], arm[NS], inc[NS], con[NS], cards[NS], n = 0;
  long long sum[5] = {0, 0, 0, 0, 0};
  for (int q = 0; q < NS; q++) {
    terr[q] = 0; arm[q] = 0;
    if (!s.alive[q]) continue;
    n++;
    for (int t = 0; t < T; t++) if (s.owner[t] == q) { terr[q]++; arm[q] += (int)s.armies[t]; }
    inc[q] = reinforcements(s, q);
    con[q] = continents_held(s, q);
    cards[q] = (int)s.hand_n[q];
    sum[0] += arm[q]; sum[1] += inc[q]; sum[2] += terr[q]; sum[3] += cards[q]; sum[4] += con[q];
  }
  double ws[NS];
  for (int q = 0; q < NS; q++) {
    if (!s.alive[q]) continue;
    int mine[5] = {arm[q], inc[q], terr[q], cards[q], con[q]};
    double sc[5];
    for (int k = 0; k < 5; k++) sc[k] = sum[k] > 0 ? (double)mine[k] / (double)sum[k] : 1.0 / (double)n;
    ws[q] = w[0] * sc[0] + w[1] * sc[1] + w[2] * sc[2] + w[3] * sc[3] + w[4] * sc[4];
    if (q == me) for (int k = 0; k < 5; k++) out[1 + k] = sc[k];
  }
  out[0] = ws[me];
  out[6] = 0.0; out[7] = 0.0;
  if (mode == 2) out[0] = ws[me] + kill_credit(s, me, place);
  if (mode == 1) {
    // expected place among the players alive: 1 + each rival's chance of finishing above, from the share-score gap
    double at = 1.0;
    for (int q = 0; q < NS; q++) {
      if (!s.alive[q] || q == me) continue;
      double beat = 0.5 + 0.5 * (double)n * (ws[me] - ws[q]);
      at += 1.0 - (beat < 0.0 ? 0.0 : beat > 1.0 ? 1.0 : beat);
    }
    out[0] = points_score(s, me, place, at);
  }
}

// Complete each game's options (a fortify_from gets the teacher's fortify_to, on the decider's stream, in option
// order) and draw its rollout seeds after them, as branchAgent does. games: the main-game slots to work on.
extern "C" __global__ void k_branch_prep(STATE_ARGS, TP_ARGS, i64* arng, int rstride, const i64* games, const i64* opts,
                                         i64* act2, const i64* nseeds, i64* seeds, int nopt, int maxseeds, int ng) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= ng) return;
  int b = (int)games[i];
  MAKE_S(b);
  TP_MAKE
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

// One copy per group of SIM_G lanes (Grp in teacher.py): reseed, reshuffle the deck, play the option (one or two
// steps), roll out `horizon` rounds with the teacher in every seat, and score the end position for `me`. Every lane
// makes each pick (its candidate loops split over the lanes); lane 0 alone changes the board, between two
// __syncwarp()s. a1 < 0: no such option (score -inf). Launched with n * SIM_G threads, blocks a multiple of 32.
extern "C" __global__ void k_branch_sim(STATE_ARGS, TP_ARGS, const i64* seeds, const i64* a1, const i64* a2, const i64* mes,
                                        const double* w, int mode, const double* place, int horizon, double* out, i64* moves_out,
                                        int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x, j = i / SIM_G;
  if (j >= n) return;  // the whole group
  Grp g = make_grp(i, SIM_G);
  bool lead = g.lane == 0;
  double* o = out + (i64)j * 8;
  if (a1[j] < 0) {
    if (lead) { o[0] = -DINF; for (int k = 1; k < 8; k++) o[k] = 0.0; moves_out[j] = 0; }
    return;
  }
  MAKE_S(j);
  TP_MAKE
  unsigned int seed = (unsigned int)seeds[j];
  if (lead) {
    *s.rng = (i64)seed;
    i64 st = (i64)(seed ^ 0x5bd1e995u);
    shuffle(s.deck, (int)*s.deck_n, &st);
    apply(s, (int)a1[j], BIG_TURNS);
    if (a2[j] >= 0) apply(s, (int)a2[j], BIG_TURNS);
  }
  __syncwarp(g.mask);
  i64 stop = *s.round + horizon, ar = (i64)seed;
  int moves = 0;
  while (!*s.done && *s.round < stop && moves < MAX_ROLLOUT_STEPS) {
    int a = teacher_pick_g<SIM_G>(s, tp, &ar, g);
    if (a < 0) break;
    __syncwarp(g.mask);  // every lane has read the board for this pick
    if (lead) apply(s, a, BIG_TURNS);
    __syncwarp(g.mask);  // the move is on the board for every lane
    if (!(a >= FFROM && a < FTO)) moves++;  // a fortify is one move of two steps
  }
  if (lead) {
    position_score(s, (int)mes[j], w, mode, place, o);
    moves_out[j] = moves;
  }
}

"""

BRANCH_KERNELS = ("k_branch_prep", "k_branch_sim")
SIM_LANES = 16  # lanes per rollout copy (k_branch_sim): see "Big tables: lane groups" in the README


def branch_defs(sim_lanes: int) -> str:
    return f"#define BIG_TURNS {BIG_TURNS}\n#define MAX_ROLLOUT_STEPS {MAX_ROLLOUT_STEPS}\n#define SIM_G {sim_lanes}\n"


class BranchEngine(TeacherEngine):
    """TeacherEngine plus the branch-and-score kernels. `sim_lanes` (1, 2, 4, 8, 16 or 32): the lanes that play one
    rollout copy together; any value plays the same moves."""

    MIRROR = "branch"

    def __init__(self, B: int, cfg=None, sim_lanes: int = SIM_LANES, **kw):
        if sim_lanes not in (1, 2, 4, 8, 16, 32):
            raise ValueError(f"sim_lanes {sim_lanes}: want a power of two up to 32")
        self.sim_lanes = sim_lanes
        super().__init__(B, cfg, extra_source=branch_defs(sim_lanes) + BRANCH_BODY, extra_kernels=BRANCH_KERNELS, **kw)

    def branch_sim(self, n: int, *args):
        """k_branch_sim over n copies (sim_lanes lanes each)."""
        self._launch_t("k_branch_sim", n * self.sim_lanes, *self._state(), *self._tp(), *args, n)


class SimPool:
    """Copies of main-game boards for the rollouts (a BranchEngine of `capacity` games, refilled every decision)."""

    def __init__(self, main: BranchEngine, capacity: int):
        self.main = main
        self.e = BranchEngine(capacity, main.cfg, params=None, device=main.dev, allow_unverified=True, max_turns=main.max_turns,
                              sim_lanes=main.sim_lanes)
        self.e.prm, self.e.tstats = main.prm, main.tstats
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
        if cfg.score not in SCORE_MODES:
            raise ValueError(f"branch score {cfg.score!r}: one of {list(SCORE_MODES)}")
        self.mode = SCORE_MODES[cfg.score]
        # pointsScore's table: placementPoints(1..n, n) then KILL_POINTS, read from the built engine (outcome.py)
        rc = ranking_constants()
        self.place = torch.tensor(rc["place"][main.n] + [rc["kill"]], dtype=torch.float64, device=main.dev)
        L = main.L
        self.skip_lo_hi = []
        for kind in cfg.skip:
            rng = {"occupy": (L.OCCUPY, L.FFROM), "place": (L.PLACE, L.TRADE), "trade": (L.TRADE, L.ATTACK),
                   "attack": (L.ATTACK, L.OCCUPY), "fortify_from": (L.FFROM, L.FTO), "end_turn": (L.END, L.END + 1),
                   "capital": (L.CAP, L.A)}.get(kind)
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
            se.branch_sim(S, sd.contiguous(), a1.contiguous(), a2.contiguous(), me.contiguous(), self.w, self.mode, self.place,
                          cfg.horizon, out, mv)
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
    """The action space in actions.ts candidate order for a first step: capitals, trades, placements, then the rest."""
    idx = list(range(L.CAP, L.A)) + list(range(L.TRADE, L.ATTACK)) + list(range(L.PLACE, L.TRADE)) + list(range(L.ATTACK, L.CAP))
    return torch.tensor(idx, dtype=torch.long, device=device)


def first_max(lg: torch.Tensor, order: torch.Tensor) -> torch.Tensor:
    """argmax over the last dim with ties going to the first candidate in `order` (net-agent.ts argmax)."""
    return order[lg[:, order].argmax(1)]


def net_ranker(enc, net, adj, precision: str = "fp32", max_rows: int = 262_144):
    """ranker(games, mask): a Delove network's logits over the legal moves of `games` (after enc.encode()). Games are
    scored in chunks of at most `max_rows` territory rows (games x territories), so big maps fit in GPU memory (a
    chunk's size can change float rounding, as any batch size can: near-ties only, like ONNX against PyTorch)."""
    dtype = torch.float16 if precision == "fp16" else torch.float32
    T = adj.shape[0]
    per = max(1, max_rows // T)

    @torch.inference_mode()
    def rank(games: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        terr, glob = enc.last
        out = torch.full((games.numel(), mask.shape[1]), float("-inf"), device=mask.device)
        for lo in range(0, games.numel(), per):
            gs = games[lo:lo + per]
            rows = enc.row_of[gs]
            m = mask[gs]
            bi, a = m.nonzero(as_tuple=True)
            cand, cf, ct = enc.candidates(rows[bi], a)
            lg, _ = net(terr[rows].to(dtype), glob[rows].to(dtype), adj.to(dtype), cand.to(dtype), cf, ct, bi)
            out[lo + bi, a] = lg.float()
        return out

    return rank
