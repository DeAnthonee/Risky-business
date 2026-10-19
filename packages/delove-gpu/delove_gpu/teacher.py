"""The hand-coded teacher (packages/delove/src/teacher.ts, teacherPickWith(params)) in the fused CUDA kernel.

TRAINING ONLY, like the rules mirror: teacher.ts is the authority and tests/teacher_replay.py checks that this picks
the logged candidate at every step of logged teacher games. It must be exact, not merely close: the teacher breaks
ties with 1e-3 of jitter from the seeded random source and compares scores built from odds, shares and products, so
every double here is computed with the same operations in the same order as the TypeScript (NVRTC with --fmad=false,
so no fused multiply-adds), draws its jitter from the same mulberry32 stream, and visits candidates in the order
actions.ts lists them (fortify destinations in the engine's connected-search order, not territory order).

Covered: what the GPU rules cover (Classic, 2 players and the Neutral, default options: no capitals, blizzards or
balanced blitz). One thread per game, like the rules.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import torch

from . import odds as odds_mod
from .fingerprint import REPO, require_verified
from .fused import STATE_FIELDS, FusedEngine, _source, compile_kernels

TEACHER_TS = REPO / "packages" / "delove" / "src" / "teacher.ts"

# TeacherParams keys in the order the kernel reads them (prm[i]).
PARAM_KEYS = [
    "targetShare", "targetBonusPerBorder", "targetEnemyRatio", "targetMissing", "defenseGapPad", "defenseBase",
    "defenseStakeDiv", "cardFloor", "cardDiv", "captureBase", "completeBonus", "targetCapture", "breakBonus", "elimBase",
    "capitalValue", "placeOffenseArmy", "placeDefenseMult", "rivalLoss2", "rivalLossMulti", "neutralLoss", "ownLoss",
    "minWin", "minEv", "exposureBase", "exposureThreat", "exposureNeed", "fortifyThreat", "interiorBonus", "lateRound",
    "lateRamp",
]

ODDS_A, ODDS_D = 2000, 2000


def default_params() -> dict[str, float]:
    """DEFAULT_TEACHER_PARAMS (delove-teacher@1), read from teacher.ts itself so the two cannot drift."""
    src = TEACHER_TS.read_text(encoding="utf8")
    m = re.search(r"DEFAULT_TEACHER_PARAMS: TeacherParams = \{(.*?)\};", src, re.S)
    if not m:
        raise RuntimeError(f"DEFAULT_TEACHER_PARAMS not found in {TEACHER_TS}")
    out = {k: float(v) for k, v in re.findall(r"(\w+):\s*(-?[\d.e+-]+)", m.group(1))}
    missing = [k for k in PARAM_KEYS if k not in out]
    if missing or len(out) != len(PARAM_KEYS):
        raise RuntimeError(f"teacher.ts params changed (missing here: {missing}; there: {sorted(set(out) - set(PARAM_KEYS))})")
    return out


def load_params(path: str | Path | None) -> dict[str, float]:
    """A tuned teacher's JSON (models/delove/delove-teacher@N.json) over the defaults, as register.ts does."""
    p = default_params()
    if path:
        for k, v in json.loads(Path(path).read_text(encoding="utf8")).items():
            if k not in p:
                raise ValueError(f"{path}: unknown teacher parameter {k}")
            p[k] = float(v)
    return p


def _consts(e) -> str:
    m = e.m
    cmax = max(len(ts) for _, _, ts in m.continents)
    rows = [ts + [-1] * (cmax - len(ts)) for _, _, ts in m.continents]
    body = ",".join("{" + ",".join(map(str, r)) + "}" for r in rows)
    borders = []
    for _, _, ts in m.continents:
        inside = set(ts)
        borders.append(sum(1 for t in ts if any(n not in inside for n in m.adj[t])))
    names = [re.sub(r"([A-Z])", r"_\1", k).upper() for k in PARAM_KEYS]
    defs = "\n".join(f"#define P_{n} {i}" for i, n in enumerate(names))
    return f"""
#define CMAX {cmax}
#define DINF __longlong_as_double(0x7ff0000000000000LL)
#define ODDS_A {ODDS_A}
#define ODDS_D {ODDS_D}
__constant__ int CMEM[K][CMAX] = {{{body}}};
__constant__ int CBORD[K] = {{{",".join(map(str, borders))}}};
{defs}
"""


TEACHER_BODY = r"""
// ---- the teacher (packages/delove/src/teacher.ts) ---------------------------------------------------------------
struct TP { const double* p; const double* ow; const double* ola; const double* old; unsigned long long* stats; };

__device__ __forceinline__ double rnd(i64* st) { return (double)mb_next(st) / 4294967296.0; }
__device__ __forceinline__ double dmax(double a, double b) { return a > b ? a : (b > a ? b : a); }  // Math.max (no NaN here)
__device__ __forceinline__ double dmin(double a, double b) { return a < b ? a : (b < a ? b : a); }

struct Odds { double win, la, ld; };

// blitzOdds(a, d, 2) of odds.ts: exact tables up to ODDS_A x ODDS_D, fit()'s proportional scaling above MAX_ODDS_CELLS.
__device__ Odds odds(const TP& tp, int a, int d) {
  Odds o;
  if (d <= 0) { o.win = 1; o.la = 0; o.ld = 0; return o; }
  int oa = a, od = d;
  double scale = 1.0;
  double cells = (double)(a + 1) * (double)(d + 1);
  if (cells > 250000.0) {
    scale = sqrt(250000.0 / cells);
    double x = floor((double)a * scale + 0.5), y = floor((double)d * scale + 0.5);
    oa = x < 2.0 ? 2 : (int)x;
    od = y < 1.0 ? 1 : (int)y;
  }
  if (oa > ODDS_A || od > ODDS_D) {  // outside the tables: counted, and clamped (never seen in Classic 2-player games)
    atomicAdd(&tp.stats[0], 1ull);
    if (oa > ODDS_A) oa = ODDS_A;
    if (od > ODDS_D) od = ODDS_D;
  }
  i64 k = (i64)oa * (ODDS_D + 1) + od;
  o.win = tp.ow[k];
  o.la = tp.ola[k] / scale;
  o.ld = tp.old[k] / scale;
  return o;
}

// Board of teacher.ts, from `me`'s side, over one game's state.
struct Board {
  int me, own[T], arm[T], thr[T], nen[T], holder[K], tcount[P], target, rivals;
  double cv;
  const double* p;
};

__device__ __forceinline__ bool is_rival(const Board& b, int o) { return o >= 0 && o != b.me && o != NEU; }

__device__ void board_init(Board& b, S& s, int me, const double* p) {
  b.me = me; b.p = p;
  for (int t = 0; t < T; t++) { b.own[t] = (int)s.owner[t]; b.arm[t] = (int)s.armies[t]; }
  for (int q = 0; q < P; q++) b.tcount[q] = 0;
  for (int t = 0; t < T; t++) {
    int th = 0, ne = 0;
    for (int k = 0; k < DEG[t]; k++) {
      int n = NBR[t][k], o = b.own[n];
      if (is_rival(b, o)) th += b.arm[n] - 1;
      if (o >= 0 && o != me) ne++;
    }
    b.thr[t] = th; b.nen[t] = ne;
    if (b.own[t] >= 0) b.tcount[b.own[t]]++;
  }
  for (int c = 0; c < K; c++) {
    int o = b.own[CMEM[c][0]];
    for (int i = 1; i < CSIZE[c]; i++) if (b.own[CMEM[c][i]] != o) { o = -1; break; }
    b.holder[c] = o;
  }
  // cardValue(): max(cardFloor, nextTradeValue(progressive) / cardDiv)
  b.cv = dmax(p[P_CARD_FLOOR], (double)trade_bonus((int)*s.trade_count) / p[P_CARD_DIV]);
  b.rivals = 0;
  for (int q = 0; q < NS; q++) if (q != me && s.alive[q]) b.rivals++;
  // target(): the continent to take
  int best = -1;
  double bs = -DINF;
  for (int c = 0; c < K; c++) {
    if (b.holder[c] == me) continue;
    int n = CSIZE[c], mine = 0, myA = 0, theirA = 0;
    bool touching = false;
    for (int i = 0; i < n; i++) {
      int t = CMEM[c][i];
      if (b.own[t] == me) { mine++; myA += b.arm[t]; } else theirA += b.arm[t];
    }
    if (mine > 0) touching = true;
    for (int i = 0; i < n && !touching; i++) {
      int t = CMEM[c][i];
      for (int k = 0; k < DEG[t]; k++) if (b.own[NBR[t][k]] == me) { touching = true; break; }
    }
    if (!touching) continue;
    int borders = CBORD[c] > 1 ? CBORD[c] : 1;
    double score = ((double)mine / (double)n) * p[P_TARGET_SHARE] + ((double)CBONUS[c] / (double)borders) * p[P_TARGET_BONUS_PER_BORDER]
                 - ((double)theirA / (double)(myA + 2)) * p[P_TARGET_ENEMY_RATIO] - (double)(n - mine) * p[P_TARGET_MISSING];
    if (score > bs) { bs = score; best = c; }
  }
  b.target = best;
}

__device__ double defense_need(const Board& b, int t) {
  int th = b.thr[t];
  if (th <= 0) return 0.0;
  double gap = (double)(th - b.arm[t]) + b.p[P_DEFENSE_GAP_PAD];
  if (gap <= 0) return 0.0;
  int c = CONT_OF[t];
  double stake = b.holder[c] == b.me ? (double)CBONUS[c] : 0.0;
  return gap * (b.p[P_DEFENSE_BASE] + stake / b.p[P_DEFENSE_STAKE_DIV]);
}

__device__ double capture_value(const Board& b, S& s, int u, bool card) {
  const double* p = b.p;
  int owner = b.own[u];
  double v = p[P_CAPTURE_BASE];
  if (card) v += b.cv;
  int c = CONT_OF[u];
  bool others = true;
  for (int i = 0; i < CSIZE[c]; i++) { int t = CMEM[c][i]; if (t != u && b.own[t] != b.me) { others = false; break; } }
  if (others) v += (double)CBONUS[c] * p[P_COMPLETE_BONUS];
  else if (b.target == c) v += p[P_TARGET_CAPTURE];
  if (is_rival(b, owner) && b.holder[c] == owner) v += (double)CBONUS[c] * p[P_BREAK_BONUS];
  if (is_rival(b, owner) && b.tcount[owner] == 1) v += p[P_ELIM_BASE] + (double)s.hand_n[owner] * b.cv;
  return v;
}

__device__ double placement_score(const Board& b, S& s, int t) {
  if (b.nen[t] == 0) return (double)(-50 - b.arm[t]);
  double defense = defense_need(b, t), offense = 0.0;
  for (int k = 0; k < DEG[t]; k++) {
    int u = NBR[t][k], o = b.own[u];
    if (o < 0 || o == b.me) continue;
    double value = capture_value(b, s, u, true);
    int gap = b.arm[u] - b.arm[t];
    offense = dmax(offense, value - (double)(gap > 0 ? gap : 0) * b.p[P_PLACE_OFFENSE_ARMY]);
  }
  return dmax(defense * b.p[P_PLACE_DEFENSE_MULT], offense);
}

// ConnectedSearch.from(src) of engine.ts: my territories reachable from src, in the engine's visiting order.
__device__ int connected_from(const Board& b, int src, int* out) {
  u8 seen[T];
  int stack[T], sp = 0, n = 0;
  for (int t = 0; t < T; t++) seen[t] = 0;
  seen[src] = 1;
  stack[sp++] = src;
  while (sp) {
    int cur = stack[--sp];
    for (int k = 0; k < DEG[cur]; k++) {
      int v = NBR[cur][k];
      if (!seen[v] && b.own[v] == b.me) { seen[v] = 1; stack[sp++] = v; out[n++] = v; }
    }
  }
  return n;
}

// bestFortify(): {from, to} or from = -1. Only called where legalMoves lists fortifies.
__device__ void best_fortify(const Board& b, S& s, int* bf, int* bt) {
  *bf = -1; *bt = -1;
  double best = 0.0;
  bool any_real = false;
  for (int t = 0; t < T; t++) if (b.own[t] == b.me && b.thr[t] > 0) { any_real = true; break; }
  int tg[T];
  for (int f = 0; f < T; f++) {
    if (b.own[f] != b.me || b.arm[f] < 2) continue;
    if (b.thr[f] > 0) continue;
    if (!any_real && b.nen[f] > 0) continue;
    int n = connected_from(b, f, tg);
    int mx = b.arm[f] - 1;
    for (int i = 0; i < n; i++) {
      int to = tg[i];
      double score;
      if (any_real) {
        double need = defense_need(b, to) + (double)b.thr[to] * b.p[P_FORTIFY_THREAT];
        if (need <= 0) continue;
        score = need * dmin((double)mx, 1.0 + need);
      } else {
        if (b.nen[to] == 0) continue;
        score = placement_score(b, s, to) * (double)mx * 0.1;
      }
      if (b.nen[f] == 0) score *= b.p[P_INTERIOR_BONUS];
      if (score > best) { best = score; *bf = f; *bt = to; }
    }
  }
}

// One step of teacherPickWith(params): the action index of the candidate it picks (-1 if there is none).
__device__ int teacher_pick(S& s, const TP& tp, i64* rng) {
  u8 m[A];
  int cnt = legal(s, m);
  if (cnt == 0) return -1;
  int me = cur(s), ph = (int)*s.phase;
  const double* p = tp.p;
  Board b;
  board_init(b, s, me, p);

  if (*s.fort_src >= 0) {  // the fortify_to step
    int src = (int)*s.fort_src, bf, bt;
    best_fortify(b, s, &bf, &bt);
    int dest = bf == src ? bt : -1;
    int tg[T];
    int n = connected_from(b, src, tg), best = -1;
    double bs = -DINF;
    int mx = b.arm[src] - 1;
    for (int i = 0; i < n; i++) {
      int u = tg[i];
      for (int sl = 0; sl < 2; sl++) {
        int a = FTO + 2 * u + sl;
        if (!m[a]) continue;
        int amount = sl == 0 ? mx : (mx + 1) / 2;
        double sc = (u == dest ? 10.0 : defense_need(b, u)) + (double)amount * 1e-6;
        double j = sc + rnd(rng) * 1e-3;
        if (j > bs) { bs = j; best = a; }
      }
    }
    if (best >= 0) return best;
    for (int a = 0; a < A; a++) if (m[a]) return a;
    return -1;
  }

  if (*s.pend_from >= 0) {  // pickOccupy
    int from = (int)*s.pend_from, to = (int)*s.pend_to;
    int mx = (int)*s.pend_max, mn = (int)*s.pend_min;
    int mid = (mx + 1) / 2; if (mid < mn) mid = mn;
    // amounts = dedup of [mx, mid, mn] (descending); max = mx, min = smallest listed, middle = the other one or max
    int lo = mn, middle = (mid != mx && mid != lo) ? mid : mx;
    bool from_exposed = b.thr[from] > 0;
    for (int k = 0; k < DEG[from] && !from_exposed; k++) { int n = NBR[from][k], o = b.own[n]; if (o >= 0 && o != me && n != to) from_exposed = true; }
    bool to_front = false;
    for (int k = 0; k < DEG[to]; k++) { int n = NBR[to][k], o = b.own[n]; if (n != from && o >= 0 && o != me) { to_front = true; break; } }
    int want;
    if (!from_exposed) want = mx;
    else if (!to_front) want = lo;
    else if (b.thr[from] == 0) want = mx;
    else want = middle;
    if (want == mx) return OCCUPY;
    if (want == mid) return OCCUPY + 1;
    return OCCUPY + 2;
  }

  if (ph == REINFORCE) {  // trades first (the GPU rules make forced trades themselves)
    int best = -1;
    double bs = -DINF;
    i64* h = s.hand + me * H;
    for (int k = 0; k < 10; k++) {
      int a = TRADE + k;
      if (!m[a]) continue;
      int on = 0;
      for (int q = 0; q < 3; q++) { int t = cterr((int)h[TRI5[k][q]]); if (t >= 0 && b.own[t] == me) on++; }
      double j = (double)on + rnd(rng) * 1e-3;
      if (j > bs) { bs = j; best = a; }
    }
    if (best >= 0) return best;
  }

  bool any_place = false;
  for (int a = 0; a < TRADE; a++) if (m[a]) { any_place = true; break; }
  if (any_place) {  // pickPlace
    int a0 = (int)s.atp[me];
    int lim = ph == SETUP ? (a0 < SETUP_BATCH ? a0 : SETUP_BATCH) : a0;
    int best = -1;
    double bs = -DINF;
    for (int t = 0; t < T; t++) {
      if (!m[3 * t]) continue;
      double sc = placement_score(b, s, t);
      for (int sl = 0; sl < 3; sl++) {
        int a = 3 * t + sl;
        if (!m[a]) continue;
        int amount = sl == 0 ? lim : (sl == 1 ? (lim + 1) / 2 : 1);
        double j = (sc + (double)amount * 1e-6) + rnd(rng) * 1e-3;
        if (j > bs) { bs = j; best = a; }
      }
    }
    return best;
  }

  {  // bestAttack
    bool card = !*s.conquered;
    double rival_loss = b.rivals <= 1 ? p[P_RIVAL_LOSS2] : p[P_RIVAL_LOSS_MULTI];
    double late = dmax(0.0, (double)*s.round - p[P_LATE_ROUND]) * p[P_LATE_RAMP];
    double min_ev = p[P_MIN_EV] - late;
    double own_loss = p[P_OWN_LOSS] / (1.0 + late);
    int best = -1;
    double best_ev = 0.0;
    for (int e = 0; e < E; e++) {
      int a = ATTACK + e;
      if (!m[a]) continue;
      int from = EFROM[e], to = ETO[e];
      int fa = b.arm[from];
      if (fa < 2) continue;
      Odds o = odds(tp, fa, b.arm[to]);
      double pw = o.win;
      if (pw < p[P_MIN_WIN]) continue;
      double value = capture_value(b, s, to, card);
      double exposure = (1.0 - pw) * (p[P_EXPOSURE_BASE] + (double)b.thr[from] * p[P_EXPOSURE_THREAT] + defense_need(b, from) * p[P_EXPOSURE_NEED]);
      double dw = is_rival(b, b.own[to]) ? rival_loss : p[P_NEUTRAL_LOSS];
      double ev = pw * value + o.ld * dw - o.la * own_loss - exposure + rnd(rng) * 1e-3;
      if (ev > min_ev && (best < 0 || ev > best_ev)) { best = a; best_ev = ev; }
    }
    if (best >= 0) return best;
  }

  if (!*s.fortified && (ph == ATTACK_PH || ph == FORTIFY)) {
    int bf, bt;
    best_fortify(b, s, &bf, &bt);
    if (bf >= 0 && m[FFROM + bf]) return FFROM + bf;
  }
  if (m[END]) return END;
  for (int a = 0; a < A; a++) if (m[a]) return a;
  return -1;
}

__device__ __forceinline__ i64* agent_rng(i64* arng, int rstride, int b, int seat) {
  return arng + (i64)b * rstride + (rstride > 1 ? seat : 0);
}

// The teacher's pick for every active game (the decider's stream: arng[b * rstride + seat], or one stream per game
// when rstride == 1). out[b] = -1 when inactive or there is no move.
extern "C" __global__ void k_teacher(STATE_ARGS, const double* prm, const double* ow, const double* ola, const double* old,
                                     unsigned long long* tstats, i64* arng, int rstride, const u8* active, i64* out, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  if (!active[b] || *s.done) { out[b] = -1; return; }
  TP tp = {prm, ow, ola, old, tstats};
  out[b] = teacher_pick(s, tp, agent_rng(arng, rstride, b, cur(s)));
}

// Teacher plays every seat for up to `steps` steps per game (bench / whole games). stats: finished games, steps.
extern "C" __global__ void k_teacher_play(STATE_ARGS, const double* prm, const double* ow, const double* ola, const double* old,
                                          unsigned long long* tstats, i64* arng, int rstride, int steps, int max_turns) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= gridDim.x * blockDim.x) return;
  MAKE_S(b);
  TP tp = {prm, ow, ola, old, tstats};
  for (int i = 0; i < steps && !*s.done; i++) {
    int a = teacher_pick(s, tp, agent_rng(arng, rstride, b, cur(s)));
    if (a < 0) break;
    apply(s, a, max_turns);
    atomicAdd(&tstats[2], 1ull);
  }
}

// Odds as the kernel computes them, for the tests.
extern "C" __global__ void k_odds(const double* ow, const double* ola, const double* old, unsigned long long* tstats,
                                  const i64* a, const i64* d, double* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  TP tp = {0, ow, ola, old, tstats};
  Odds o = odds(tp, (int)a[i], (int)d[i]);
  out[3 * i] = o.win; out[3 * i + 1] = o.la; out[3 * i + 2] = o.ld;
}
"""

TEACHER_KERNELS = ("k_teacher", "k_teacher_play", "k_odds")
FMAD_OFF = ["--fmad=false"]


def teacher_source(e) -> str:
    return _source(e) + _consts(e) + TEACHER_BODY


class TeacherEngine(FusedEngine):
    """FusedEngine plus the teacher. `params` is a teacher's judgement numbers (load_params)."""

    MIRROR = "teacher"

    def __init__(self, B: int, params: dict[str, float] | None = None, extra_source: str = "", extra_kernels=(), **kw):
        allow = kw.get("allow_unverified", False)
        kw["allow_unverified"] = True  # checked below under this mirror's own name
        super().__init__(B, **kw)
        if not allow:  # every layer this one stands on: the rules kernel, the teacher, and this mirror itself
            for name in dict.fromkeys(["fused.py", "teacher", self.MIRROR]):
                require_verified(name)
        params = params or default_params()
        self.prm = torch.tensor([params[k] for k in PARAM_KEYS], dtype=torch.float64, device=self.dev)
        w, la, ld = odds_mod.tables(ODDS_A, ODDS_D)
        self.ow, self.ola, self.old = (torch.from_numpy(x).to(self.dev).contiguous() for x in (w, la, ld))
        self.tstats = torch.zeros(4, dtype=torch.int64, device=self.dev)  # [odds outside the tables, -, steps, -]
        self.tk = compile_kernels(teacher_source(self) + extra_source, TEACHER_KERNELS + tuple(extra_kernels), FMAD_OFF)
        # per (game, seat) agent streams, seeded like playGame: mixSeed(seed, 0x5eed + seat)
        self.arng = torch.zeros(B, self.n, dtype=torch.long, device=self.dev)

    def _tp(self) -> list:
        return [self.prm, self.ow, self.ola, self.old, self.tstats]

    def _launch_t(self, name: str, n: int, *args):
        grid = ((n + self.BLOCK - 1) // self.BLOCK, 1, 1)
        self.tk[name](grid=grid, block=(self.BLOCK, 1, 1), args=list(args))

    def seat_streams(self, g: torch.Tensor, seeds: torch.Tensor):
        """Agent random streams for games g as playGame seeds them (mixSeed(seed, 0x5eed + seat))."""
        for seat in range(self.n):
            self.arng[g, seat] = torch.tensor([mix_seed(int(x), 0x5EED + seat) for x in seeds.tolist()], dtype=torch.long, device=self.dev)

    def teacher(self, active: torch.Tensor | None = None, arng: torch.Tensor | None = None) -> torch.Tensor:
        """The teacher's action for the decider of every (active) game, advancing its stream; -1 where none."""
        out = torch.empty(self.B, dtype=torch.long, device=self.dev)
        ar = self.arng if arng is None else arng
        rstride = ar.shape[1] if ar.dim() == 2 else 1
        act = active.to(torch.uint8).contiguous() if active is not None else torch.ones(self.B, dtype=torch.uint8, device=self.dev)
        self._launch_t("k_teacher", self.B, *self._state(), *self._tp(), ar, rstride, act, out, self.B)
        return out

    def play_teacher(self, steps: int):
        grid_b = (self.B + self.BLOCK - 1) // self.BLOCK * self.BLOCK
        if grid_b != self.B:
            raise ValueError(f"play_teacher needs B a multiple of {self.BLOCK}")
        self._launch_t("k_teacher_play", self.B, *self._state(), *self._tp(), self.arng, self.n, steps, self.max_turns)

    def odds(self, a: torch.Tensor, d: torch.Tensor) -> torch.Tensor:
        n = a.numel()
        out = torch.empty(n, 3, dtype=torch.float64, device=self.dev)
        self._launch_t("k_odds", n, self.ow, self.ola, self.old, self.tstats, a.long().contiguous(), d.long().contiguous(), out, n)
        return out


def mix_seed(a: int, b: int) -> int:
    """packages/selfplay/src/seed.ts mixSeed (murmur3 finaliser)."""
    M = 0xFFFFFFFF
    h = (((a & M) * 0x9E3779B1) & M) ^ (b & M)
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & M
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & M
    h ^= h >> 16
    return h
