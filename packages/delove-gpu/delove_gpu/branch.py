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
   'kills', the share score plus killCredit; 'long', the share score plus killWeight * killCredit; 'mid', P(top 2)
   mixed with the threat deflection at 3 alive), averaged over the seeds in order; the best option wins unless it
   beats the teacher's move by less than `margin`. Score 'close' is the share score with closeRollouts copies of
   closeHorizon rounds; 'range' picks long / mid / close per decision by the players alive (4+ / 3 / 2), so one
   batch of decisions can run up to three groups of copies (each its own score, rollouts and horizon).

Setup decisions, decisions with one candidate and the `skip` kinds (occupy) are the teacher's move, as in branch.ts.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import torch

from .encode import Encoder
from .engine import ATTACK, FORTIFY, REINFORCE
from .fingerprint import REPO
from .fused import STATE_FIELDS
from .outcome import ranking_constants
from .rng import M32, STEP, hash32
from .teacher import ALL_KEYS, NP0, TeacherEngine

BRANCH_TS = REPO / "packages" / "delove" / "src" / "branch.ts"
SCORE_PARTS = ["score", "armies", "income", "territories", "cards", "continents", "won", "lost"]
WEIGHT_KEYS = ["armies", "income", "territories", "cards", "continents"]
SCORE_MODES = {"share": 0, "points": 1, "kills": 2, "long": 3, "mid": 4}  # the kernel's modes
SCORES = ["share", "points", "kills", "long", "mid", "close", "range"]  # branch.ts BRANCH_SCORES
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
    score: str = "share"  # one of SCORES (branch.ts BranchOptions.score)
    kill_weight: float = 2.0  # 'long': killWeight
    threat: float = 0.3  # 'mid': threat
    close_rollouts: int = 12  # 'close': closeRollouts / closeHorizon
    close_horizon: int = 2
    # who plays the rollouts (branch.ts rolloutNet): 'teacher', or GpuBranch's roll_net in 'all' seats or the decider's ('self')
    rollout: str = "teacher"
    root: str = "top"  # 'top' or 'gumbel' (branch.ts BranchOptions.root, gumbelRoot)
    gumbel_k: int = 8  # 'gumbel': candidates, the teacher's move included
    copies: int = 0  # 'gumbel': rollout copies per decision; 0 = options x the decision's rollouts
    # T2 (branch.ts BranchOptions.incumbent / styles): the move the margin rule protects, 'teacher' or 'net' (the
    # ranker's top move); opponent styles in the rollouts ('' off, else 'net:0.4,aggr:0.2,...'; styles.ts)
    incumbent: str = "teacher"
    styles: str = ""

    def decision(self, alive: int) -> tuple[int, int, int]:
        """decisionScore in branch.ts: (kernel mode, rollouts, horizon) of a decision with `alive` players alive."""
        sc = self.score
        if sc == "range":
            sc = "long" if alive >= 4 else "mid" if alive == 3 else "close"
        if sc == "close":
            return SCORE_MODES["share"], self.close_rollouts, self.close_horizon
        return SCORE_MODES[sc], self.rollouts, self.horizon


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
                        {k: float(w[k]) for k in WEIGHT_KEYS}, score, num("killWeight"), num("threat"), int(num("closeRollouts")),
                        int(num("closeHorizon")), root=re.search(r"\broot:\s*'(\w+)'", body).group(1), gumbel_k=int(num("gumbelK")),
                        copies=int(num("copies")), incumbent=re.search(r"\bincumbent:\s*'(\w+)'", body).group(1),
                        styles=re.search(r"\bstyles:\s*'([^']*)'", body).group(1))


STYLES_TS = BRANCH_TS.parent / "styles.ts"


def style_scales() -> dict[str, dict[str, float]]:
    """styles.ts STYLE_SCALES: the multipliers of the rollout teacher's numbers per style."""
    src = STYLES_TS.read_text(encoding="utf8")
    body = re.search(r"STYLE_SCALES[^=]*= \{(.*?)\n\};", src, re.S).group(1)
    return {name: {k: float(v) for k, v in re.findall(r"(\w+):\s*(-?[\d.e+-]+)", inner)}
            for name, inner in re.findall(r"(\w+):\s*\{([^}]*)\}", body)}


def style_salt() -> int:
    return int(re.search(r"STYLE_SALT = (0x[0-9a-fA-F]+)", STYLES_TS.read_text(encoding="utf8")).group(1), 16)


def copy_styles(sd: torch.Tensor, me: torch.Tensor, n: int, styles: list[tuple[str, float]], salt: int) -> torch.Tensor:
    """styles.ts copyStyles for copies with seeds `sd` and deciders `me` at n seats: [S, n] style indexes into `styles`,
    -1 for the decider. Seat q: the (q + 1)-th mulberry32 draw of seed ^ salt times the weights' total, then the first
    style whose running weight sum (added in order, as the TypeScript does) exceeds it, else the last."""
    dev = sd.device
    total, cum = 0.0, []
    for _, w in styles:
        total += w
    c = 0.0
    for _, w in styles:
        c += w
        cum.append(c)
    st = (sd ^ salt) & M32
    q = torch.arange(n, dtype=torch.long, device=dev)
    u = hash32((st[:, None] + STEP * (q[None, :] + 1)) & M32).double() / 4294967296.0 * total
    hit = u[:, :, None] < torch.tensor(cum, dtype=torch.float64, device=dev)[None, None, :]
    idx = torch.where(hit.any(-1), hit.long().argmax(-1), len(styles) - 1)
    idx[torch.arange(sd.numel(), device=dev), me] = -1
    return idx


def parse_styles(spec: str) -> list[tuple[str, float]]:
    """styles.ts parseStyles: 'net:0.4,aggr:0.2' -> [('net', 0.4), ('aggr', 0.2)] ('' -> [])."""
    if not spec:
        return []
    known = ["net", *style_scales()]
    out = []
    for part in spec.split(","):
        name, w = part.split(":")
        if name not in known or any(n == name for n, _ in out):
            raise ValueError(f"branch styles: unknown or repeated style {name}")
        if not float(w) > 0:
            raise ValueError(f"branch styles: weight of {name} must be > 0")
        out.append((name, float(w)))
    return out


BRANCH_BODY = r"""
// ---- branch and score (packages/delove/src/branch.ts) ------------------------------------------------------------
// positionScore(state, me, weights, mode): out = score, armies, income, territories, cards, continents, won, lost.
// mode 1 ('points'): score = pointsScore, with place = placementPoints(1..NS, NS) then KILL_POINTS (place[NS]).
// mode 2 ('kills'): score = the share score + killCredit. mode 3 ('long'): the share score + rw[0] * killCredit.
// mode 4 ('mid'): 3 alive: (1 - rw[1]) * P(top 2) + rw[1] * threat deflection; 2 alive: 1; out: 0; 4+: the share score.
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

// threatDeflection: the share of the strongest rival's (largest army + territory share, first on a tie) border armies
// that face the third player rather than me; 0.5 when it touches neither.
__device__ double threat_deflection(S& s, int me, const double* str) {
  int lead = -1, third = -1;
  double best = -DINF;
  for (int q = 0; q < NS; q++)
    if (s.alive[q] && q != me && str[q] > best) { best = str[q]; lead = q; }
  for (int q = 0; q < NS; q++)
    if (s.alive[q] && q != me && q != lead) { third = q; break; }
  long long on_me = 0, on_third = 0;
  for (int t = 0; t < T; t++) {
    if (s.owner[t] != lead) continue;
    bool m1 = false, t1 = false;
    for (int k = 0; k < DEG[t]; k++) {
      int o = (int)s.owner[NBR[t][k]];
      if (o == me) m1 = true;
      else if (o == third) t1 = true;
    }
    if (m1) on_me += s.armies[t];
    if (t1) on_third += s.armies[t];
  }
  long long tot = on_me + on_third;
  return tot > 0 ? (double)on_third / (double)tot : 0.5;
}

__device__ void position_score(S& s, int me, const double* w, int mode, const double* place, const double* rw, double* out) {
  if (*s.phase == FINISHED) {
    bool won = *s.winner == me;
    double v = won ? 1.0 : 0.0;
    for (int i = 0; i < 7; i++) out[i] = v;
    out[7] = 1.0 - v;
    if (mode == 1) out[0] = points_score(s, me, place, won ? 1.0 : -1.0);
    if (mode == 2) out[0] = v + kill_credit(s, me, place);
    if (mode == 3) out[0] = v + rw[0] * kill_credit(s, me, place);
    return;
  }
  if (!s.alive[me]) {
    for (int i = 0; i < 7; i++) out[i] = 0.0;
    out[7] = 1.0;
    if (mode == 1) out[0] = points_score(s, me, place, -1.0);
    if (mode == 2) out[0] = 0.0 + kill_credit(s, me, place);
    if (mode == 3) out[0] = 0.0 + rw[0] * kill_credit(s, me, place);
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
  double ws[NS], str[NS];
  for (int q = 0; q < NS; q++) {
    if (!s.alive[q]) continue;
    int mine[5] = {arm[q], inc[q], terr[q], cards[q], con[q]};
    double sc[5];
    for (int k = 0; k < 5; k++) sc[k] = sum[k] > 0 ? (double)mine[k] / (double)sum[k] : 1.0 / (double)n;
    ws[q] = w[0] * sc[0] + w[1] * sc[1] + w[2] * sc[2] + w[3] * sc[3] + w[4] * sc[4];
    str[q] = sc[0] + sc[2];
    if (q == me) for (int k = 0; k < 5; k++) out[1 + k] = sc[k];
  }
  out[0] = ws[me];
  out[6] = 0.0; out[7] = 0.0;
  if (mode == 2) out[0] = ws[me] + kill_credit(s, me, place);
  if (mode == 3) out[0] = ws[me] + rw[0] * kill_credit(s, me, place);
  if (mode == 4 && n <= 2) out[0] = 1.0;
  if (mode == 4 && n == 3) {
    // P(top 2) = 1 - P(both rivals finish above me), each read off the share-score gap
    double last = 1.0;
    for (int q = 0; q < NS; q++) {
      if (!s.alive[q] || q == me) continue;
      double beat = 0.5 + 0.5 * (double)n * (ws[me] - ws[q]);
      last *= 1.0 - (beat < 0.0 ? 0.0 : beat > 1.0 ? 1.0 : beat);
    }
    double top2 = 1.0 - last;
    out[0] = (1.0 - rw[1]) * top2 + rw[1] * threat_deflection(s, me, str);
  }
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

// Math.log as V8 computes it (src/base/ieee754.cc: FreeBSD's fdlibm e_log.c), operation for operation (as log1p_fd).
__device__ double log_fd(double x) {
  const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, two54 = 1.80143985094819840000e+16,
               Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01,
               Lg4 = 2.222219843214978396e-01, Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
               Lg7 = 1.479819860511658591e-01;
  double hfsq, f, s, z, R, w, t1, t2, dk;
  int k, hx, i, j;
  unsigned int lx;
  hx = __double2hiint(x);
  lx = (unsigned int)__double2loint(x);
  k = 0;
  if (hx < 0x00100000) {                       // x < 2**-1022
    if (((hx & 0x7fffffff) | lx) == 0) return -DINF;
    if (hx < 0) return (x - x) / 0.0;          // log(-#) = NaN
    k -= 54;
    x *= two54;                                // subnormal: scale up
    hx = __double2hiint(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  i = (hx + 0x95f64) & 0x100000;
  x = __hiloint2double(hx | (i ^ 0x3ff00000), __double2loint(x));  // normalize x or x/2
  k += (i >> 20);
  f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {           // -2**-20 <= f < 2**-20
    if (f == 0.0) {
      if (k == 0) return 0.0;
      dk = (double)k;
      return dk * ln2_hi + dk * ln2_lo;
    }
    R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k == 0) return f - R;
    dk = (double)k;
    return dk * ln2_hi - ((R - dk * ln2_lo) - f);
  }
  s = f / (2.0 + f);
  dk = (double)k;
  z = s * s;
  i = hx - 0x6147a;
  w = z * z;
  j = 0x6b851 - hx;
  t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    hfsq = 0.5 * f * f;
    if (k == 0) return f - (hfsq - s * (hfsq + R));
    return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
  }
  if (k == 0) return f - s * (f - R);
  return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

// log_fd for the tests (against Node's Math.log).
extern "C" __global__ void k_log_fd(const double* x, double* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = log_fd(x[i]);
}

// The Gumbel root's noise (branch.ts gumbelRoot): counts[i] draws -log(-log(u)) from the decider's stream of main game
// games[i], one per candidate in candidate order, after the teacher's pick and before k_branch_prep.
extern "C" __global__ void k_branch_gumbel(STATE_ARGS, i64* arng, int rstride, const i64* games, const i64* counts, double* out,
                                           int maxc, int ng) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= ng) return;
  int b = (int)games[i];
  MAKE_S(b);
  i64* rng = agent_rng(arng, rstride, b, cur(s));
  for (int c = 0; c < counts[i]; c++) out[(i64)i * maxc + c] = -log_fd(-log_fd(rnd(rng)));
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
                                        const double* w, int mode, const double* place, const double* rw, int horizon, double* out,
                                        i64* moves_out, int n) {
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
    position_score(s, (int)mes[j], w, mode, place, rw, o);
    moves_out[j] = moves;
  }
}

// ---- rollouts played by a network (branch.ts rolloutNet): k_branch_sim in three parts, the network's moves made in
// between from Python. live[j]: the copy still plays (0: no such option, or a seat had no move); ar[j]: the copy's
// teacher stream; stop[j]: the round it stops at.
// Start each copy: reseed, reshuffle the deck, play the option (one or two steps). One thread per copy.
extern "C" __global__ void k_branch_start(STATE_ARGS, const i64* seeds, const i64* a1, const i64* a2, i64* ar, i64* moves,
                                          i64* stop, u8* live, int horizon, int n) {
  int j = blockIdx.x * blockDim.x + threadIdx.x;
  if (j >= n) return;
  moves[j] = 0;
  live[j] = a1[j] >= 0;
  if (a1[j] < 0) return;
  MAKE_S(j);
  unsigned int seed = (unsigned int)seeds[j];
  *s.rng = (i64)seed;
  i64 st = (i64)(seed ^ 0x5bd1e995u);
  shuffle(s.deck, (int)*s.deck_n, &st);
  apply(s, (int)a1[j], BIG_TURNS);
  if (a2[j] >= 0) apply(s, (int)a2[j], BIG_TURNS);
  ar[j] = (i64)seed;
  stop[j] = *s.round + horizon;
}

// The teacher plays the copy on (k_branch_sim's loop, SIM_G lanes per copy) until the rollout ends or a seat the
// network plays is to move: every seat with net == 1, the decider's (mes[j]) with net == 2; with net == 3 (T2 styles)
// the seats whose code scode[j * NS + seat] is 255, the others playing the teacher row their code names (seat_tp).
extern "C" __global__ void k_branch_roll(STATE_ARGS, TP_ARGS, i64* ar, i64* moves, const i64* stop, u8* live, const i64* mes,
                                         int net, const u8* scode, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x, j = i / SIM_G;
  if (j >= n) return;  // the whole group
  Grp g = make_grp(i, SIM_G);
  bool lead = g.lane == 0;
  if (!live[j] || net == 1) return;
  MAKE_S(j);
  TP_MAKE
  i64 r = ar[j];
  int mv = (int)moves[j];
  bool dead = false;
  while (!*s.done && *s.round < stop[j] && mv < MAX_ROLLOUT_STEPS && !(net == 2 && cur(s) == (int)mes[j]) &&
         !(net == 3 && scode[(i64)j * NS + cur(s)] == 255)) {
    int a = teacher_pick_g<SIM_G>(s, net == 3 ? seat_tp(tp, scode, j, cur(s)) : tp, &r, g);
    if (a < 0) { dead = true; break; }
    __syncwarp(g.mask);  // every lane has read the board for this pick
    if (lead) apply(s, a, BIG_TURNS);
    __syncwarp(g.mask);  // the move is on the board for every lane
    if (!(a >= FFROM && a < FTO)) mv++;  // a fortify is one move of two steps
  }
  if (lead) {
    ar[j] = r;
    moves[j] = mv;
    if (dead) live[j] = 0;
  }
}

// positionScore of each copy's end position for mes[j]; a copy with no option (a1 < 0) scores -inf. One thread per copy.
extern "C" __global__ void k_branch_score(STATE_ARGS, const i64* a1, const i64* mes, const double* w, int mode, const double* place,
                                          const double* rw, double* out, int n) {
  int j = blockIdx.x * blockDim.x + threadIdx.x;
  if (j >= n) return;
  double* o = out + (i64)j * 8;
  if (a1[j] < 0) { o[0] = -DINF; for (int k = 1; k < 8; k++) o[k] = 0.0; return; }
  MAKE_S(j);
  position_score(s, (int)mes[j], w, mode, place, rw, o);
}

"""

BRANCH_KERNELS = ("k_branch_prep", "k_branch_sim", "k_branch_start", "k_branch_roll", "k_branch_score", "k_log_fd", "k_branch_gumbel")
ROLL_TEACHER, ROLL_ALL, ROLL_SELF, ROLL_STYLES = 0, 1, 2, 3  # T2 styles: the network in 'net' seats, style teachers elsewhere; who plays the rollouts: the teacher; a network in every seat; in the decider's
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

    def log(self, x: torch.Tensor) -> torch.Tensor:
        """log_fd (V8's Math.log) of a float64 tensor, for tests/log1p_check.py."""
        x = x.to(self.dev, torch.float64).contiguous()
        out = torch.empty_like(x)
        self._launch_t("k_log_fd", x.numel(), x, out, x.numel())
        return out

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
    rollouts: torch.Tensor  # copies per option of each branched decision (0 where not branched)
    scores: torch.Tensor | None = None  # [n, OPT, max rollouts] each copy's score (nan where not branched or past R), for the tests
    copies: torch.Tensor | None = None  # 'gumbel': [n, K] copies each candidate got (the 'top' root: rollouts each)


ROLLOUT_MODES = {"teacher": ROLL_TEACHER, "all": ROLL_ALL, "self": ROLL_SELF}


class GpuBranch:
    """branchAgent over a BranchEngine of main games. `ranker(games, mask)` gives [n, A] logits (-inf where illegal).
    `roll_net` (a Delove network, fp32) plays the rollouts when cfg.rollout is 'all' or 'self' (branch.ts rolloutNet)."""

    def __init__(self, main: BranchEngine, ranker, cfg: BranchConfig, max_games: int | None = None, roll_net=None):
        self.e, self.ranker, self.cfg = main, ranker, cfg
        if cfg.rollout not in ROLLOUT_MODES:
            raise ValueError(f"branch rollout {cfg.rollout!r}: one of {list(ROLLOUT_MODES)}")
        self.roll = ROLLOUT_MODES[cfg.rollout]
        if cfg.incumbent not in ("teacher", "net"):
            raise ValueError(f"branch incumbent {cfg.incumbent!r}: 'teacher' or 'net'")
        if cfg.incumbent == "net" and cfg.root != "top":
            raise ValueError("branch: incumbent 'net' needs the 'top' root")
        self.styles = parse_styles(cfg.styles)
        if self.styles:
            if cfg.root != "top":
                raise ValueError("branch: styles need the 'top' root")
            self.roll = ROLL_STYLES
        if self.roll != ROLL_TEACHER and roll_net is None:
            raise ValueError(f"branch rollout {cfg.rollout!r}{' with styles' if self.styles else ''} needs a rollout network")
        self.roll_net = roll_net
        self.w = torch.tensor([cfg.weights[k] for k in WEIGHT_KEYS], dtype=torch.float64, device=main.dev)
        if cfg.score not in SCORES:
            raise ValueError(f"branch score {cfg.score!r}: one of {SCORES}")
        if cfg.root not in ("top", "gumbel"):
            raise ValueError(f"branch root {cfg.root!r}: 'top' or 'gumbel'")
        # per decision (players alive 2..10): kernel mode, rollouts, horizon (BranchConfig.decision)
        self.by_alive = {a: cfg.decision(a) for a in range(2, main.n + 1)}
        self.max_r = max(r for _, r, _ in self.by_alive.values())
        self.rw = torch.tensor([cfg.kill_weight, cfg.threat], dtype=torch.float64, device=main.dev)
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
        # copies for max_games decisions at cfg.rollouts; a group with more rollouts (close) runs in chunks that fit
        self.sims = SimPool(main, max(max_games * cfg.options * cfg.rollouts, cfg.options * self.max_r))
        if self.styles:
            self._style_setup()
        else:
            self.scode = torch.zeros(1, dtype=torch.uint8, device=main.dev)  # unused (k_branch_roll net != 3)
        if self.roll != ROLL_TEACHER:
            self.roll_enc = Encoder(self.sims.e)
            self.roll_adj = self.sims.e.m.adj_matrix.float()
            self.roll_order = cpu_order(self.sims.e.L, main.dev)
        self.roll_steps = 0  # lockstep network steps of the rollouts (for timing)

    def _style_setup(self):
        """T2 styles (styles.ts): each teacher style's row (the rollout teacher's row 0, both halves, with the style's
        multipliers) appended to the copies' teacher rows, and the code of every style: 255 'net', else its row."""
        se, base = self.sims.e, self.e.prm
        base = base if base.dim() == 2 else base[None]
        scales = style_scales()
        rows, codes = [], {}
        for name, _ in self.styles:
            if name == "net":
                codes[name] = 255
                continue
            r = base[0].clone()
            for k, m in scales[name].items():
                i = ALL_KEYS.index(k)
                r[i] = r[i] * m  # both halves, in float64 as the TypeScript multiplies
                r[NP0 + i] = r[NP0 + i] * m
            codes[name] = base.shape[0] + len(rows)
            rows.append(r)
        if base.shape[0] + len(rows) > 255:
            raise ValueError("too many teacher rows for the style codes")
        se.prm = torch.cat([base, torch.stack(rows)]) if rows else base
        self.style_code = torch.tensor([codes[n] for n, _ in self.styles], dtype=torch.uint8, device=self.e.dev)
        cum, c = [], 0.0
        for _, w in self.styles:
            c += w  # the TypeScript's running sum, in the same order
            cum.append(c)
        self.style_total = c
        self.style_cum = torch.tensor(cum, dtype=torch.float64, device=self.e.dev)
        self.style_salt = style_salt()

    def _style_codes(self, sd: torch.Tensor, me: torch.Tensor) -> torch.Tensor:
        """copy_styles for every copy as codes: [S, NS] uint8, 255 for 'net' (the decider's seat always), else the row."""
        idx = copy_styles(sd, me, self.e.n, self.styles, self.style_salt)
        code = self.style_code[idx.clamp(min=0)]
        code[idx < 0] = 255
        return code.contiguous()

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
        if self.cfg.root == "gumbel":
            return self._decide_gumbel(games, mask, tact)
        e, cfg, dev = self.e, self.cfg, self.e.dev
        n, OPT = games.numel(), cfg.options
        imp = self.important(games, mask, tact)
        opts = torch.full((n, OPT), -1, dtype=torch.long, device=dev)
        opts[:, 0] = tact[games]
        ig = imp.nonzero(as_tuple=True)[0]
        if ig.numel():
            lg = self.ranker(games[ig], mask)  # [k, A]
            # logits descending, ties in candidate order (Array.prototype.sort is stable)
            order = self.cpu_order[torch.sort(-lg[:, self.cpu_order], dim=1, stable=True).indices[:, : OPT + 2]]
            t = tact[games[ig]]
            ok = torch.isfinite(lg.gather(1, order)) & (order != t[:, None])
            first = 1  # the first column the ranker's favourites fill
            if cfg.incumbent == "net":
                # branch.ts: the ranker's top move (ties: first in candidate order), then the teacher's, then the rest
                top = order[:, 0]
                opts[ig, 0] = top
                two = t != top
                if OPT > 1:
                    opts[ig, 1] = torch.where(two, t, -1)
                ok &= order != top[:, None]
                first = 1 + two.long()
            else:
                first = torch.ones_like(t)
            # the legal entries not yet taken, in ranking order, into the columns from `first` on
            pos = torch.cumsum(ok.long(), 1) - 1 + first[:, None]
            sel = ok & (pos <= OPT - 1)
            for k in range(1, OPT):
                hit = sel & (pos == k)
                col = order.gather(1, hit.long().argmax(1, keepdim=True)).squeeze(1)
                opts[ig, k] = torch.where(hit.any(1), col, opts[ig, k])
        # each decision's objective by the players alive (score 'range'; one group for a fixed score)
        alive = e.alive[games, : e.n].long().sum(1).clamp(min=2)
        key = torch.zeros(n, dtype=torch.long, device=dev)  # index into keys
        keys = sorted(set(self.by_alive.values()))
        gr = torch.zeros(n, dtype=torch.long, device=dev)
        for a, k in self.by_alive.items():
            hit = alive == a
            key[hit] = keys.index(k)
            gr[hit] = k[1]
        nseeds = torch.where(imp, gr, 0).long()
        act2 = torch.full((n, OPT), -1, dtype=torch.long, device=dev)
        seeds = torch.zeros(n, self.max_r, dtype=torch.long, device=dev)
        e._launch_t("k_branch_prep", n, *e._state(), *e._tp(), e.arng, e.n, games.contiguous(), opts.contiguous(), act2,
                    nseeds.contiguous(), seeds, OPT, self.max_r, n)
        act1_out = opts[:, 0].clone()
        act2_out = act2[:, 0].clone()
        means = torch.full((n, OPT, 8), float("nan"), dtype=torch.float64, device=dev)
        best = torch.zeros(n, dtype=torch.long, device=dev)
        scores = torch.full((n, OPT, self.max_r), float("nan"), dtype=torch.float64, device=dev)
        moves = 0
        for ki, (mode, R, H) in enumerate(keys):
            sel = ig[key[ig] == ki]
            per = self.sims.capacity // (OPT * R)  # decisions per chunk of copies
            for lo in range(0, sel.numel(), per):
                moves += self._run(games, sel[lo:lo + per], opts, act2, seeds, mode, R, H, means, best, act1_out, act2_out, scores)
        return Decision(games, act1_out, act2_out, imp, imp & (best != 0), opts, means, best, moves, nseeds, scores)

    def _run(self, games, ig, opts, act2, seeds, mode, R, H, means, best, act1_out, act2_out, scores) -> int:
        """Play and score the copies of decisions `ig` (rows of games) with one objective; fills their means, best
        option and pick. Returns the rollout moves played."""
        e, cfg, dev = self.e, self.cfg, self.e.dev
        OPT, k = cfg.options, ig.numel()
        # copies: game-major, then option, then seed
        src = games[ig].repeat_interleave(OPT * R)
        self.sims.load(src)
        a1 = opts[ig].repeat_interleave(R, dim=1).reshape(-1)
        a2 = act2[ig].repeat_interleave(R, dim=1).reshape(-1)
        sd = seeds[ig, :R].repeat(1, OPT).reshape(-1)
        me = e.cur[games[ig]].repeat_interleave(OPT * R)
        S = k * OPT * R
        out = torch.empty(S, 8, dtype=torch.float64, device=dev)
        mv = torch.empty(S, dtype=torch.long, device=dev)
        if self.roll == ROLL_TEACHER:
            self.sims.e.branch_sim(S, sd.contiguous(), a1.contiguous(), a2.contiguous(), me.contiguous(), self.w, mode, self.place,
                                   self.rw, H, out, mv)
        else:
            self._net_rollouts(S, sd.contiguous(), a1.contiguous(), a2.contiguous(), me.contiguous(), out, mv, mode, H)
        parts = out.view(k, OPT, R, 8)
        scores[ig, :, :R] = parts[:, :, :, 0]
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
        return int(mv.sum())

    def _copies(self, src, a1, a2, sd, me, mode: int, H: int):
        """Play and score copies (one per entry: main-game slot, option's first and second step, seed, decider) with one
        objective, in chunks that fit the copy pool. Returns (out [S, 8], moves played)."""
        dev, S = self.e.dev, src.numel()
        out = torch.empty(S, 8, dtype=torch.float64, device=dev)
        moves = 0
        cap = self.sims.capacity
        for lo in range(0, S, cap):
            hi = min(S, lo + cap)
            self.sims.load(src[lo:hi])
            o = torch.empty(hi - lo, 8, dtype=torch.float64, device=dev)
            mv = torch.empty(hi - lo, dtype=torch.long, device=dev)
            args = (sd[lo:hi].contiguous(), a1[lo:hi].contiguous(), a2[lo:hi].contiguous(), me[lo:hi].contiguous())
            if self.roll == ROLL_TEACHER:
                self.sims.e.branch_sim(hi - lo, *args, self.w, mode, self.place, self.rw, H, o, mv)
            else:
                self._net_rollouts(hi - lo, *args, o, mv, mode, H)
            out[lo:hi] = o
            moves += int(mv.sum())
        return out, moves

    def _decide_gumbel(self, games: torch.Tensor, mask: torch.Tensor, tact: torch.Tensor) -> Decision:
        """branch.ts gumbelRoot for the games deciding now: Gumbel draws per candidate (k_branch_gumbel), the teacher's
        move and the K - 1 best of g + logit, k_branch_prep's completions and seeds, then sequential halving
        (gumbelSchedule) over common-random-number copies, all games at once round by round: copy sums added seed by
        seed (as the TypeScript adds them), priorities g + logit + (C_VISIT + most copies) * C_SCALE * mean, the
        others halved after each round, the final pick and the margin rule against the teacher's move."""
        e, cfg, dev = self.e, self.cfg, self.e.dev
        n, K = games.numel(), cfg.gumbel_k
        imp = self.important(games, mask, tact)
        opts = torch.full((n, K), -1, dtype=torch.long, device=dev)
        opts[:, 0] = tact[games]
        ig = imp.nonzero(as_tuple=True)[0]
        k = ig.numel()
        A = mask.shape[1]
        co = self.cpu_order
        keyopt = torch.full((k, K), float("-inf"), dtype=torch.float64, device=dev)
        if k:
            lg = self.ranker(games[ig], mask)  # [k, A], -inf where illegal
            legal = torch.isfinite(lg)[:, co]  # in candidate order
            cnt = legal.sum(1)
            maxc = max(1, int(cnt.max()))
            draws = torch.empty(k, maxc, dtype=torch.float64, device=dev)
            e._launch_t("k_branch_gumbel", k, *e._state(), e.arng, e.n, games[ig].contiguous(), cnt.contiguous(), draws, maxc, k)
            pos = (torch.cumsum(legal.long(), 1) - 1).clamp(min=0, max=maxc - 1)
            g_co = torch.where(legal, draws.gather(1, pos), float("-inf"))
            key_co = g_co + lg[:, co].double()  # g + logit, candidate order
            t = tact[games[ig]]
            ok = legal & (co[None, :] != t[:, None])
            order = torch.sort(-key_co, dim=1, stable=True).indices  # g + logit descending, ties in candidate order
            oks = ok.gather(1, order)
            rank = torch.cumsum(oks.long(), 1)
            for j in range(1, K):
                hit = oks & (rank == j)
                col = torch.where(hit.any(1), co[order.gather(1, hit.long().argmax(1, keepdim=True)).squeeze(1)], -1)
                opts[ig, j] = col
            key_act = torch.empty_like(key_co)
            key_act[:, co] = key_co  # back to action order
            keyopt = torch.where(opts[ig] >= 0, key_act.gather(1, opts[ig].clamp(min=0)), float("-inf"))
        # the decision's objective (score, rollouts, horizon) by the players alive, its budget and halving plan
        alive = e.alive[games, : e.n].long().sum(1).clamp(min=2)
        keys = sorted(set(self.by_alive.values()))
        gkey = torch.zeros(n, dtype=torch.long, device=dev)
        for a, kk in self.by_alive.items():
            gkey[alive == a] = keys.index(kk)
        m = (opts >= 0).sum(1)
        mk, gk = m[ig].tolist(), gkey[ig].tolist()
        plans, plan_of = {}, []
        for mi, ki in zip(mk, gk):
            budget = cfg.copies if cfg.copies > 0 else cfg.options * keys[ki][1]
            pk = (mi, budget)
            if pk not in plans:
                plans[pk] = gumbel_schedule(mi, budget)
            plan_of.append(plans[pk])
        rmax = max((len(p) for p in plan_of), default=0)
        sizes = torch.zeros(k, max(1, rmax), dtype=torch.long, device=dev)
        per = torch.zeros(k, max(1, rmax), dtype=torch.long, device=dev)
        for i, p in enumerate(plan_of):
            sizes[i, : len(p)] = torch.tensor([r[0] for r in p])
            per[i, : len(p)] = torch.tensor([r[1] for r in p])
        total = per.sum(1)
        nseeds = torch.zeros(n, dtype=torch.long, device=dev)
        if k:
            nseeds[ig] = total
        maxs = max(1, int(nseeds.max()))
        act2 = torch.full((n, K), -1, dtype=torch.long, device=dev)
        seeds = torch.zeros(n, maxs, dtype=torch.long, device=dev)
        e._launch_t("k_branch_prep", n, *e._state(), *e._tp(), e.arng, e.n, games.contiguous(), opts.contiguous(), act2,
                    nseeds.contiguous(), seeds, K, maxs, n)
        act1_out = opts[:, 0].clone()
        act2_out = act2[:, 0].clone()
        means = torch.full((n, K, 8), float("nan"), dtype=torch.float64, device=dev)
        scores = torch.full((n, K, maxs), float("nan"), dtype=torch.float64, device=dev)
        copies = torch.zeros(n, K, dtype=torch.long, device=dev)
        best = torch.zeros(n, dtype=torch.long, device=dev)
        moves = 0
        if k:
            sums = torch.zeros(k, K, 8, dtype=torch.float64, device=dev)
            got = torch.zeros(k, K, dtype=torch.long, device=dev)  # copies so far
            live = opts[ig] >= 0
            cols = torch.arange(K, device=dev)
            gm, me_all = games[ig], e.cur[games[ig]]
            sc_k = torch.full((k, K, maxs), float("nan"), dtype=torch.float64, device=dev)

            def priority():
                mean = sums[:, :, 0] / got.clamp(min=1).double()
                most = got.max(1).values.double()
                return keyopt + ((GUMBEL_C_VISIT + most) * GUMBEL_C_SCALE)[:, None] * mean

            for r in range(rmax):
                c_r = per[:, r]
                gi, oi = (live & (c_r > 0)[:, None]).nonzero(as_tuple=True)  # (game row, option) pairs this round
                if gi.numel():
                    reps = c_r[gi]
                    pg, po = gi.repeat_interleave(reps), oi.repeat_interleave(reps)
                    first = torch.cumsum(reps, 0) - reps
                    pc = torch.arange(pg.numel(), device=dev) - first.repeat_interleave(reps)  # copy within this round
                    ps = got[pg, po] + pc  # seed index
                    out = torch.empty(pg.numel(), 8, dtype=torch.float64, device=dev)
                    for ki, (mode, R, H) in enumerate(keys):
                        sel = (gkey[ig][pg] == ki).nonzero(as_tuple=True)[0]
                        if sel.numel() == 0:
                            continue
                        o, mv = self._copies(gm[pg[sel]], opts[ig][pg[sel], po[sel]], act2[ig][pg[sel], po[sel]],
                                             seeds[ig][pg[sel], ps[sel]], me_all[pg[sel]], mode, H)
                        out[sel] = o
                        moves += mv
                    sc_k[pg, po, ps] = out[:, 0]
                    for c in range(int(reps.max())):  # sums[k] += sc[k], seed by seed (the TypeScript's order)
                        at = (pc == c).nonzero(as_tuple=True)[0]
                        sums[pg[at], po[at]] = sums[pg[at], po[at]] + out[at]
                    got[gi, oi] += c_r[gi]
                # halve the others of games with a next round (the teacher's move always stays)
                if r + 1 < rmax:
                    nxt = sizes[:, r + 1]
                    go = nxt > 0
                    pr = priority()
                    others = live & (cols[None, :] > 0)
                    prm = torch.where(others, pr, float("-inf"))
                    ordr = torch.sort(-prm, dim=1, stable=True).indices  # priority descending, ties by option index
                    os_ = others.gather(1, ordr)
                    rk = torch.cumsum(os_.long(), 1)
                    keep = os_ & (rk <= (nxt - 1)[:, None])
                    newlive = torch.zeros_like(live)
                    newlive.scatter_(1, ordr, keep)
                    newlive[:, 0] = live[:, 0]
                    live = torch.where(go[:, None], newlive, live)
            pr = priority()
            mean = sums / got.clamp(min=1).double()[:, :, None]  # true division, as JavaScript's
            mean[:, :, 0] = torch.where(got > 0, mean[:, :, 0], float("nan"))
            bi = torch.zeros(k, dtype=torch.long, device=dev)
            for j in range(1, K):  # the first live candidate with the highest priority
                better = live[:, j] & (pr[:, j] > pr.gather(1, bi[:, None]).squeeze(1))
                bi = torch.where(better, j, bi)
            gain = mean[:, :, 0].gather(1, bi[:, None]).squeeze(1) - mean[:, 0, 0]
            bi = torch.where((bi != 0) & (gain < cfg.margin), 0, bi)
            means[ig] = torch.where((got > 0)[:, :, None], mean, float("nan"))
            scores[ig] = sc_k
            copies[ig] = got
            best[ig] = bi
            act1_out[ig] = opts[ig].gather(1, bi[:, None]).squeeze(1)
            act2_out[ig] = act2[ig].gather(1, bi[:, None]).squeeze(1)
        return Decision(games, act1_out, act2_out, imp, imp & (best != 0), opts, means, best, moves, nseeds, scores, copies)

    @torch.inference_mode()
    def _net_rollouts(self, S: int, sd, a1, a2, me, out, mv, mode: int, horizon: int, max_rows: int = 262_144):
        """k_branch_sim with the network playing its seats: the copies start (k_branch_start), then, in lockstep, the
        teacher plays the other seats on (k_branch_roll) and every copy whose network seat is to move gets the
        network's top move (one batched forward pass per step; ties to the first candidate, as net-agent.ts), until
        every copy's rollout is over; then each is scored (k_branch_score)."""
        se, dev, cfg, L = self.sims.e, self.e.dev, self.cfg, self.sims.e.L
        ar = torch.zeros(S, dtype=torch.long, device=dev)
        stop = torch.zeros(S, dtype=torch.long, device=dev)
        live = torch.zeros(S, dtype=torch.uint8, device=dev)
        se._launch_t("k_branch_start", S, *se._state(), sd, a1, a2, ar, mv, stop, live, horizon, S)
        per = max(1, max_rows // se.m.T)
        act = torch.full((S,), -1, dtype=torch.long, device=dev)
        grid, block = ((S + se.BLOCK - 1) // se.BLOCK, 1, 1), (se.BLOCK, 1, 1)  # the rules kernels over the S copies only
        scode = self._style_codes(sd, me) if self.roll == ROLL_STYLES else self.scode
        crow = torch.arange(S, device=dev)  # copy index (rows below is the encoder's)
        while True:
            if self.roll in (ROLL_SELF, ROLL_STYLES):
                se._launch_t("k_branch_roll", S * se.sim_lanes, *se._state(), *se._tp(), ar, mv, stop, live, me, self.roll, scode, S)
            cur = se.cur[:S]
            need = (live.bool() & ~se.done[:S].bool() & (se.round[:S] < stop) & (mv < MAX_ROLLOUT_STEPS))
            if self.roll == ROLL_SELF:
                need &= cur == me
            elif self.roll == ROLL_STYLES:
                need &= scode[crow, cur.long()] == 255
            idx = need.nonzero(as_tuple=True)[0]
            if idx.numel() == 0:
                break
            se.k["k_legal"](grid=grid, block=block, args=[*se._state(), se._mask, S])
            mask = se._mask
            nl = mask[idx].sum(1)
            live[idx[nl == 0]] = 0  # no move: the rollout ends (branch.ts: no candidates)
            act.fill_(-1)
            one = idx[nl == 1]
            act[one] = mask[one].long().argmax(1)
            many = idx[nl > 1]
            for lo in range(0, many.numel(), per):
                g = many[lo:lo + per]
                terr, glob = self.roll_enc.encode(g)
                rows = self.roll_enc.row_of[g]
                bi, a = mask[g].nonzero(as_tuple=True)
                cand, cf, ct = self.roll_enc.candidates(rows[bi], a)
                lg, _ = self.roll_net(terr, glob, self.roll_adj, cand, cf, ct, bi)
                full = torch.full((g.numel(), mask.shape[1]), float("-inf"), device=dev)
                full[bi, a] = lg.float()
                act[g] = first_max(full, self.roll_order)
            mv += ((act >= 0) & ~((act >= L.FFROM) & (act < L.FTO))).long()  # a fortify is one move of two steps
            se.k["k_step"](grid=grid, block=block, args=[*se._state(), act, S, BIG_TURNS])
            self.roll_steps += 1
        se._launch_t("k_branch_score", S, *se._state(), a1, me, self.w, mode, self.place, self.rw, out, S)


GUMBEL_C_VISIT, GUMBEL_C_SCALE = 50.0, 1.0  # branch.ts GUMBEL_C_VISIT / GUMBEL_C_SCALE


def gumbel_schedule(m: int, budget: int) -> list[tuple[int, int]]:
    """branch.ts gumbelSchedule: per round (candidates searched, new copies each) for m candidates within `budget`."""
    sizes, others = [], m - 1
    while True:
        sizes.append(1 + others)
        if others <= 1:
            break
        others = -(-others // 2)
    return [(sz, max(1, budget // (len(sizes) * sz))) for sz in sizes]


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
