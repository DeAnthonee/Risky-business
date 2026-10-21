"""The hand-coded teachers in the fused CUDA kernel: Sensei (packages/delove/src/teacher.ts, teacherPickWith(params):
delove-teacher@N) and Jacob Sensei (packages/delove/src/jacob.ts, jacobPickWith(params): jacob-sensei@N, with @2's
terms from RISK_LEARNINGS.md sections 7-21: each is off at 0, as in jacob-sensei@1's row).

TRAINING ONLY, like the rules mirror: teacher.ts is the authority and the replay tests (tests/replay.py --teacher,
tests/teacher_replay.py) check that this picks the logged candidate at every step of logged teacher games. It must be
exact, not merely close: the teacher breaks ties with 1e-3 of jitter from the seeded random source and compares scores
built from odds, shares and products, so every double here is computed with the same operations in the same order as
the TypeScript (NVRTC with --fmad=false, so no fused multiply-adds), draws its jitter from the same mulberry32 stream,
and visits candidates in the order actions.ts lists them (fortify destinations in the engine's connected-search order,
or adjacency order with adjacent fortify).

Covered: everything the rules kernel covers (every map and table size; capitals and chosen capitals, card values,
adjacent fortify, balanced blitz, blizzards, the claiming phase, neutrals). One thread per game, like the rules.

A teacher version is one row of numbers: a main half (PARAM_KEYS, JACOB_KEYS, the Jacob flag, the staged flag) and a
duel half laid out the same way (NP = 2 x NP0). Sensei's rows have the Jacob terms at 0 and the flag off, and the
kernel takes Jacob's code paths (the table-wide player stats, the leader, the hunt, the card urge, the stack ramp, the
late win floor, the front pull, @2's terms) only where the flag is on. A staged version (jacob.ts jacobPickWith(params,
duel), jacob-sensei@2) has the staged flag on: once one rival is left the kernel reads the duel half instead; other
versions repeat their numbers in the duel half, which is never read. An engine holds
one or more rows; `tver[b, seat]` says which row plays a seat in k_teacher / k_teacher_run (row 0, the rollout
teacher, by default; branch rollouts always play row 0). Math.log1p (the stack ramp) is V8's fdlibm log1p, ported
below, so the last bit matches.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import torch

from . import odds as odds_mod
from .fingerprint import REPO, require_verified
from .fused import FusedEngine, _source, compile_kernels

TEACHER_TS = REPO / "packages" / "delove" / "src" / "teacher.ts"
JACOB_TS = REPO / "packages" / "delove" / "src" / "jacob.ts"
JACOB_PREFIX = "jacob-sensei@"

# TeacherParams keys in the order the kernel reads them (prm[i]).
PARAM_KEYS = [
    "targetShare", "targetBonusPerBorder", "targetEnemyRatio", "targetMissing", "defenseGapPad", "defenseBase",
    "defenseStakeDiv", "cardFloor", "cardDiv", "captureBase", "completeBonus", "targetCapture", "breakBonus", "elimBase",
    "capitalValue", "placeOffenseArmy", "placeDefenseMult", "rivalLoss2", "rivalLossMulti", "neutralLoss", "ownLoss",
    "minWin", "minEv", "exposureBase", "exposureThreat", "exposureNeed", "fortifyThreat", "interiorBonus", "lateRound",
    "lateRamp",
]
# JacobParams' own keys (after TeacherParams'), then the flag that selects Jacob's code paths.
JACOB_KEYS = [
    "powerIncome", "powerCards", "leaderLoss", "leaderCapture", "huntRatio", "huntValue", "cardUrge", "stackRamp", "stackFree",
    "lateWin", "minWinFloor", "frontPull",
    # jacob-sensei@2's terms (0 in @1's row)
    "killWin", "killPath", "killCarry", "leaderPunch", "borderDelta", "dormantWake", "holdEv", "cardTight", "duelDeny",
    "duelEv", "capitalPad",
]
ALL_KEYS = PARAM_KEYS + JACOB_KEYS + ["jacob", "staged"]
NP0 = len(ALL_KEYS)  # one half of a row
NP = 2 * NP0  # main half, then the duel half


def _numbers(path: Path, name: str) -> dict[str, float]:
    """The numbers of an object literal `name: Type = { key: number, ... };` in a TypeScript file."""
    m = re.search(rf"{name}: \w+ = \{{(.*?)\}};", path.read_text(encoding="utf8"), re.S)
    if not m:
        raise RuntimeError(f"{name} not found in {path}")
    return {k: float(v) for k, v in re.findall(r"(\w+):\s*(-?[\d.e+-]+)", m.group(1))}


def _check_keys(out: dict, want: list[str], what: str):
    missing = [k for k in want if k not in out]
    if missing or len(out) != len(want):
        raise RuntimeError(f"{what} changed (missing here: {missing}; there: {sorted(set(out) - set(want))})")


def default_params() -> dict[str, float]:
    """DEFAULT_TEACHER_PARAMS (delove-teacher@1), read from teacher.ts itself so the two cannot drift."""
    out = _numbers(TEACHER_TS, "DEFAULT_TEACHER_PARAMS")
    _check_keys(out, PARAM_KEYS, "teacher.ts params")
    return {**out, **{k: 0.0 for k in JACOB_KEYS}, "jacob": 0.0, "staged": 0.0}


def jacob_default_params() -> dict[str, float]:
    """DEFAULT_JACOB_PARAMS ({...DEFAULT_TEACHER_PARAMS, overrides}), read from jacob.ts."""
    if "DEFAULT_JACOB_PARAMS: JacobParams = {\n  ...DEFAULT_TEACHER_PARAMS," not in JACOB_TS.read_text(encoding="utf8").replace("\r\n", "\n"):
        raise RuntimeError(f"DEFAULT_JACOB_PARAMS in {JACOB_TS} no longer starts from DEFAULT_TEACHER_PARAMS")
    out = {**{k: v for k, v in default_params().items() if k in PARAM_KEYS}, **_numbers(JACOB_TS, "DEFAULT_JACOB_PARAMS")}
    _check_keys(out, PARAM_KEYS + JACOB_KEYS, "jacob.ts DEFAULT_JACOB_PARAMS")
    return {**out, "jacob": 1.0, "staged": 0.0}


def jacob_sensei_1_params() -> dict[str, float]:
    """JACOB_SENSEI_1_PARAMS: jacob-sensei@1's numbers, fixed in jacob.ts (register.ts ignores jacob-sensei@1.json)."""
    out = _numbers(JACOB_TS, "JACOB_SENSEI_1_PARAMS")
    _check_keys(out, PARAM_KEYS + JACOB_KEYS, "jacob.ts JACOB_SENSEI_1_PARAMS")
    return {**out, "jacob": 1.0, "staged": 0.0}


def jacob_sensei_2_params() -> dict:
    """jacob-sensei@2, staged: JACOB_SENSEI_2_PARAMS while two or more rivals are alive, JACOB_SENSEI_2_DUEL_PARAMS
    once one is left; fixed in jacob.ts (register.ts ignores jacob-sensei@2.json)."""
    out = _numbers(JACOB_TS, "JACOB_SENSEI_2_PARAMS")
    _check_keys(out, PARAM_KEYS + JACOB_KEYS, "jacob.ts JACOB_SENSEI_2_PARAMS")
    duel = _numbers(JACOB_TS, "JACOB_SENSEI_2_DUEL_PARAMS")
    _check_keys(duel, PARAM_KEYS + JACOB_KEYS, "jacob.ts JACOB_SENSEI_2_DUEL_PARAMS")
    return {**out, "jacob": 1.0, "staged": 1.0, "duel": {**duel, "jacob": 1.0, "staged": 0.0}}


FIXED_JACOBS = {JACOB_PREFIX + "1": jacob_sensei_1_params, JACOB_PREFIX + "2": jacob_sensei_2_params}


def is_jacob(agent: str) -> bool:
    return agent.startswith(JACOB_PREFIX)


def is_teacher(agent: str) -> bool:
    """A hand-coded teacher seat the kernel plays: delove-teacher@N or jacob-sensei@N."""
    return agent.startswith("delove-teacher@") or is_jacob(agent)


def load_params(path: str | Path | None, jacob: bool = False) -> dict[str, float]:
    """A tuned teacher's JSON (models/delove/delove-teacher@N.json; with jacob, jacob-sensei@N.json) over the defaults
    (DEFAULT_TEACHER_PARAMS; with jacob, DEFAULT_JACOB_PARAMS), as register.ts does. A Jacob JSON may hold a "duel"
    object: the numbers (over DEFAULT_JACOB_PARAMS) of a staged version once one rival is left."""
    p = jacob_default_params() if jacob else default_params()
    if path:
        for k, v in json.loads(Path(path).read_text(encoding="utf8")).items():
            if jacob and k == "duel":
                d = jacob_default_params()
                for dk, dv in v.items():
                    if dk not in d or dk in ("jacob", "staged"):
                        raise ValueError(f"{path}: unknown teacher parameter duel.{dk}")
                    d[dk] = float(dv)
                p["duel"], p["staged"] = d, 1.0
                continue
            if k not in p or k in ("jacob", "staged") or (not jacob and k in JACOB_KEYS):
                raise ValueError(f"{path}: unknown teacher parameter {k}")
            p[k] = float(v)
    return p


def agent_params(agent: str, models: str | Path | None = None, path: str | Path | None = None) -> dict[str, float]:
    """The numbers register.ts plays `agent` with: delove-teacher@1 the defaults, delove-teacher@N models/<agent>.json,
    jacob-sensei@1 / @2 JACOB_SENSEI_1_PARAMS / JACOB_SENSEI_2_PARAMS (any JSON ignored, as register.ts does),
    jacob-sensei@N (N >= 3) DEFAULT_JACOB_PARAMS + models/<agent>.json. `path` names the JSON file instead of `models`."""
    if agent in FIXED_JACOBS:
        return FIXED_JACOBS[agent]()
    if not path and models is not None and agent != "delove-teacher@1":
        path = Path(models) / f"{agent}.json"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing (the numbers of {agent})")
    return load_params(path or None, jacob=is_jacob(agent))


def param_row(p: dict) -> list[float]:
    """A version's row: its numbers, then its duel numbers (its own again when it is not staged)."""
    duel = p["duel"] if p.get("staged") else p
    return [float(p[k]) for k in ALL_KEYS] + [float(duel[k]) if k != "staged" else 0.0 for k in ALL_KEYS]


def params_tensor(params: dict | list[dict], device) -> torch.Tensor:
    """One teacher version's row [NP], or several versions' rows [V, NP] (row v plays the seats with tver == v)."""
    rows = params if isinstance(params, list) else [params]
    t = torch.tensor([param_row(p) for p in rows], dtype=torch.float64, device=device)
    return t if isinstance(params, list) else t[0]


def _consts(e) -> str:
    names = [re.sub(r"([A-Z])", r"_\1", k).upper() for k in ALL_KEYS]
    defs = "\n".join(f"#define P_{n} {i}" for i, n in enumerate(names))
    return f"""
#define DINF __longlong_as_double(0x7ff0000000000000LL)
#define ODDS_DMAX {odds_mod.DMAX}
#define NP {NP}
#define NP0 {NP0}
{defs}
"""


TEACHER_BODY = r"""
// ---- the teacher (packages/delove/src/teacher.ts) ---------------------------------------------------------------
// prm: the teacher's numbers; the odds tables of both defence-dice limits (rows d of limit 2, then of limit 3).
#define TP_ARGS const double* prm, const double* ow, const double* ola, const double* old, const double* obw, const i64* ooff, const i64* olen, unsigned long long* tstats
#define TP_PASS prm, ow, ola, old, obw, ooff, olen, tstats
struct TP { const double* p; const double* ow; const double* ola; const double* old; const double* obw; const i64* ooff; const i64* olen; unsigned long long* stats; };
#define TP_MAKE TP tp = {prm, ow, ola, old, obw, ooff, olen, tstats};

__device__ __forceinline__ double rnd(i64* st) { return (double)mb_next(st) / 4294967296.0; }

// ---- lane groups: G lanes of a warp make one pick together (branch.py's rollouts, k_teacher_run; G = 1 in the other
// kernels). Every lane of the group runs the same code on the same board; only the candidate loops are split,
// candidate c to lane c % G.
// A loop's jitter draws keep their order: mulberry32 adds 0x6D2B79F5 to its state per draw, so the k-th draw of the
// loop comes from st0 + k * 0x6D2B79F5, and a lane works out k from how many earlier candidates draw (a ballot).
// The best candidate is reduced over the group with the loop's own rule (the higher score, the earlier candidate on a
// tie), so the pick, the scores and the stream are the ones the one-thread loop gives.
struct Grp { int lane; unsigned mask, below; };  // lane in the group, the group's lanes and those before this one
__device__ __forceinline__ double rnd_at(unsigned st0, int k) {  // the k-th draw from state st0 (k = 0: the next one)
  i64 st = (i64)(unsigned)(st0 + (unsigned)k * 0x6D2B79F5u);
  return rnd(&st);
}
__device__ __forceinline__ void rnd_skip(i64* st, int k) { *st = (i64)(unsigned)((unsigned)*st + (unsigned)k * 0x6D2B79F5u); }
// Thread i's place in its group of G lanes (blocks a multiple of 32, so groups never straddle warps).
__device__ __forceinline__ Grp make_grp(int i, int G) {
  Grp g;
  g.lane = i % G;
  int wl = threadIdx.x & 31;
  g.mask = G == 32 ? 0xffffffffu : ((1u << G) - 1u) << (wl - g.lane);
  g.below = g.mask & ((1u << wl) - 1u);
  return g;
}
// Draws of the lanes before this one (and of the whole group in *total): `n` (0..3) draws per lane, as two ballots.
template <int G> __device__ __forceinline__ int draws_before(const Grp& g, int n, int* total) {
  if (G == 1) { *total = n; return 0; }
  unsigned b0 = __ballot_sync(g.mask, n & 1) & g.mask, b1 = __ballot_sync(g.mask, n & 2) & g.mask;
  *total = __popc(b0) + 2 * __popc(b1);
  return __popc(b0 & g.below) + 2 * __popc(b1 & g.below);
}
// The group's best (best, score) by `j > bs` in candidate order: the higher score, the lower action on a tie (-1: none).
template <int G> __device__ __forceinline__ void best_of(const Grp& g, int* best, double* bs) {
  if (G == 1) return;
  for (int off = G / 2; off > 0; off >>= 1) {
    int ob = __shfl_xor_sync(g.mask, *best, off);
    double os = __shfl_xor_sync(g.mask, *bs, off);
    if (ob >= 0 && (*best < 0 || os > *bs || (os == *bs && ob < *best))) { *best = ob; *bs = os; }
  }
}
__device__ __forceinline__ double dmax(double a, double b) { return a > b ? a : (b > a ? b : a); }  // Math.max (no NaN here)
__device__ __forceinline__ double dmin(double a, double b) { return a < b ? a : (b < a ? b : a); }

struct Odds { double win, bwin, la, ld; };

// blitzOdds(a, d, dlim) of odds.ts: fit()'s proportional scaling above MAX_ODDS_CELLS, then the exact table cell.
__device__ Odds odds(const TP& tp, int a, int d, int dlim) {
  Odds o;
  if (d <= 0) { o.win = 1; o.bwin = 1; o.la = 0; o.ld = 0; return o; }
  int oa = a, od = d;
  double scale = 1.0;
  double cells = (double)(a + 1) * (double)(d + 1);
  if (cells > 250000.0) {
    scale = sqrt(250000.0 / cells);
    double x = floor((double)a * scale + 0.5), y = floor((double)d * scale + 0.5);
    oa = x < 2.0 ? 2 : (int)x;
    od = y < 1.0 ? 1 : (int)y;
  }
  int row = (dlim == 3 ? ODDS_DMAX + 1 : 0) + (od > ODDS_DMAX ? ODDS_DMAX : od);
  if (od > ODDS_DMAX || oa >= tp.olen[row]) {  // outside the tables (never seen): counted, and clamped
    atomicAdd(&tp.stats[0], 1ull);
    if (oa >= tp.olen[row]) oa = (int)tp.olen[row] - 1;
  }
  i64 k = tp.ooff[row] + oa;
  o.win = tp.ow[k];
  o.bwin = tp.obw[k];
  o.la = tp.ola[k] / scale;
  o.ld = tp.old[k] / scale;
  return o;
}

// Math.log1p as V8 computes it (src/base/ieee754.cc: FreeBSD's fdlibm s_log1p.c), operation for operation.
__device__ double log1p_fd(double x) {
  const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, two54 = 1.80143985094819840000e+16,
               Lp1 = 6.666666666666735130e-01, Lp2 = 3.999999999940941908e-01, Lp3 = 2.857142874366239149e-01,
               Lp4 = 2.222219843214978396e-01, Lp5 = 1.818357216161805012e-01, Lp6 = 1.531383769920937332e-01,
               Lp7 = 1.479819860511658591e-01;
  double hfsq, f = 0.0, c = 0.0, s, z, R, u;
  int k, hx, hu = 0, ax;
  hx = __double2hiint(x);
  ax = hx & 0x7fffffff;
  k = 1;
  if (hx < 0x3FDA827A) {                       // 1+x < sqrt(2)+
    if (ax >= 0x3ff00000) {                    // x <= -1.0
      if (x == -1.0) return -DINF;
      return (x - x) / (x - x);
    }
    if (ax < 0x3e200000) {                     // |x| < 2**-29
      if (two54 + x > 0.0 && ax < 0x3c900000) return x;
      return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= (int)0xbfd2bec4) { k = 0; f = x; hu = 1; }  // sqrt(2)/2- <= 1+x < sqrt(2)+
  }
  if (hx >= 0x7ff00000) return x + x;
  if (k != 0) {
    if (hx < 0x43400000) {
      u = 1.0 + x;
      hu = __double2hiint(u);
      k = (hu >> 20) - 1023;
      c = (k > 0) ? 1.0 - (u - x) : x - (u - 1.0);  // correction term
      c /= u;
    } else {
      u = x;
      hu = __double2hiint(u);
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    if (hu < 0x6a09e) {                        // u ~< sqrt(2): normalize u
      u = __hiloint2double(hu | 0x3ff00000, __double2loint(u));
    } else {                                   // normalize u/2
      k += 1;
      u = __hiloint2double(hu | 0x3fe00000, __double2loint(u));
      hu = (0x00100000 - hu) >> 2;
    }
    f = u - 1.0;
  }
  hfsq = 0.5 * f * f;
  if (hu == 0) {                               // |f| < 2**-20
    if (f == 0.0) {
      if (k == 0) return 0.0;
      c += k * ln2_lo;
      return k * ln2_hi + c;
    }
    R = hfsq * (1.0 - 0.66666666666666666 * f);
    if (k == 0) return f - R;
    return k * ln2_hi - ((R - (k * ln2_lo + c)) - f);
  }
  s = f / (2.0 + f);
  z = s * s;
  R = z * (Lp1 + z * (Lp2 + z * (Lp3 + z * (Lp4 + z * (Lp5 + z * (Lp6 + z * Lp7))))));
  if (k == 0) return f - (hfsq - s * (hfsq + R));
  return k * ln2_hi - ((hfsq - (s * (hfsq + R) + (k * ln2_lo + c))) - f);
}

// Board of teacher.ts (and jacob.ts), from `me`'s side, over one game's state. jac: the version's Jacob flag; then
// sarm / pow / mean are jacob.ts's stats() (armies and power of every living seat, the mean power), sinc[me] my income.
struct Board {
  int me, own[T], arm[T], thr[T], nen[T], holder[K], tcount[P], target, rivals;
  double cv;
  const double* p;
  S* s;
  bool jac;
  int sarm[NS], myinc;
  double pow[NS], mean;
  double capv[T];  // captureValue(u, true), filled on first use (capf)
  u8 capf[T];
};

__device__ __forceinline__ bool is_rival(const Board& b, int o) { return o >= 0 && o != b.me && o != NEU; }

__device__ void board_init(Board& b, S& s, int me, const double* p) {
  b.me = me; b.p = p; b.s = &s;
  b.jac = p[P_JACOB] != 0.0;
  for (int t = 0; t < T; t++) b.capf[t] = 0;
  for (int t = 0; t < T; t++) { b.own[t] = (int)s.owner[t]; b.arm[t] = (int)s.armies[t]; }
  for (int q = 0; q < P; q++) b.tcount[q] = 0;
  for (int t = 0; t < T; t++) {
    int th = 0, ne = 0;
    for (int k = 0; k < DEG[t]; k++) {
      int n = NBR[t][k], o = b.own[n];
      if (is_rival(b, o)) th += b.arm[n] - 1;
      if (o >= 0 && o != me) ne++;  // enemyNeighbours: blizzards and unclaimed land are nobody's
    }
    b.thr[t] = th; b.nen[t] = ne;
    if (b.own[t] >= 0) b.tcount[b.own[t]]++;
  }
  // holds(c, p): every open territory of c is p's (the holder; -1 if none or mixed)
  for (int c = 0; c < K; c++) {
    int o = -2;
    for (int i = 0; i < CSIZE[c]; i++) {
      int t = CMEM[c][i];
      if (s.bliz[t]) continue;
      if (o == -2) o = b.own[t];
      else if (b.own[t] != o) { o = -1; break; }
    }
    b.holder[c] = o < 0 ? -1 : o;
  }
  // cardValue(): max(cardFloor, nextTradeValue(mode, tradeCount, my trades) / cardDiv)
  b.cv = dmax(p[P_CARD_FLOOR], (double)next_value(s, me) / p[P_CARD_DIV]);
  b.rivals = 0;
  for (int q = 0; q < NS; q++) if (q != me && s.alive[q]) b.rivals++;
  // target(): the continent to take
  int best = -1;
  double bs = -DINF;
  for (int c = 0; c < K; c++) {
    if (b.holder[c] == me) continue;
    int n = 0, mine = 0, myA = 0, theirA = 0;
    bool touching = false;
    for (int i = 0; i < CSIZE[c]; i++) {
      int t = CMEM[c][i];
      if (s.bliz[t]) continue;
      n++;
      if (b.own[t] == me) { mine++; myA += b.arm[t]; } else theirA += b.arm[t];
    }
    if (n == 0) continue;
    if (mine > 0) touching = true;
    for (int i = 0; i < CSIZE[c] && !touching; i++) {
      int t = CMEM[c][i];
      if (s.bliz[t]) continue;
      for (int k = 0; k < DEG[t]; k++) if (b.own[NBR[t][k]] == me) { touching = true; break; }
    }
    if (!touching) continue;
    int borders = CBORD[c] > 1 ? CBORD[c] : 1;
    double score = ((double)mine / (double)n) * p[P_TARGET_SHARE] + ((double)CBONUS[c] / (double)borders) * p[P_TARGET_BONUS_PER_BORDER]
                 - ((double)theirA / (double)(myA + 2)) * p[P_TARGET_ENEMY_RATIO] - (double)(n - mine) * p[P_TARGET_MISSING];
    if (score > bs) { bs = score; best = c; }
  }
  b.target = best;
  if (b.jac) {  // jacob.ts stats(): every living seat (the Neutral excluded), in seat order
    for (int q = 0; q < NS; q++) b.sarm[q] = 0;
    for (int t = 0; t < T; t++) { int o = b.own[t]; if (o >= 0 && o < NS && s.alive[o]) b.sarm[o] += b.arm[t]; }
    double total = 0.0;
    int n = 0;
    b.myinc = 0;
    for (int q = 0; q < NS; q++) {
      b.pow[q] = 0.0;
      if (!s.alive[q]) continue;
      int inc = b.tcount[q] > 0 ? reinforcements(s, q) : 0;
      if (q == me) b.myinc = inc;
      b.pow[q] = (double)b.sarm[q] + p[P_POWER_INCOME] * (double)inc + p[P_POWER_CARDS] * (double)s.hand_n[q] * b.cv;
      total += b.pow[q];
      n++;
    }
    b.mean = n ? total / (double)n : 0.0;
  }
}

// jacob.ts lead(p): how far a rival's power is above the mean (0 when not), capped at 2.
__device__ double lead(const Board& b, int o) {
  if (!is_rival(b, o) || o >= NS || !b.s->alive[o] || b.mean <= 0) return 0.0;
  return dmin(2.0, dmax(0.0, b.pow[o] / b.mean - 1.0));
}

// jacob.ts elimValue(o): base plus their cards at card value.
__device__ __forceinline__ double elim_value(const Board& b, int o) { return b.p[P_ELIM_BASE] + (double)b.s->hand_n[o] * b.cv; }

// jacob.ts hunt(o, stack): a share of the elimination when `stack` outweighs o's whole army.
__device__ double hunt(const Board& b, int o, int stack) {
  if (!is_rival(b, o) || b.p[P_HUNT_VALUE] <= 0) return 0.0;
  if (o >= NS || !b.s->alive[o]) return 0.0;
  if (b.tcount[o] <= 1 || (double)stack < b.p[P_HUNT_RATIO] * (double)b.sarm[o]) return 0.0;
  return (b.p[P_HUNT_VALUE] * elim_value(b, o)) / (double)b.tcount[o];
}

// ---- jacob-sensei@2's helpers (jacob.ts) ----
// heldCapital(t): a capital (any player's) that I hold.
__device__ __forceinline__ bool held_capital(const Board& b, int t) { return OPT_CAPITALS && b.own[t] == b.me && is_capital(*b.s, t); }

// killable(o): a rival on one territory, or on 3 or fewer with 3+ cards.
__device__ __forceinline__ bool killable(const Board& b, int o) {
  if (!is_rival(b, o) || o >= NS) return false;
  int n = b.tcount[o];
  return n == 1 || (n > 1 && n <= 3 && b.s->hand_n[o] >= 3);
}

// killPath(u, stack): the best share of a killable rival's elimination that taking u (not theirs) opens.
__device__ double kill_path(const Board& b, S& s, int u, int stack) {
  if (b.p[P_KILL_PATH] <= 0) return 0.0;
  int owner = b.own[u];
  double best = 0.0;
  for (int k = 0; k < DEG[u]; k++) {
    int n = NBR[u][k];
    if (s.bliz[n]) continue;
    int v = b.own[n];
    if (v == owner || !killable(b, v)) continue;
    if ((double)stack < b.p[P_HUNT_RATIO] * (double)b.sarm[v] + (double)b.arm[u]) continue;
    best = dmax(best, (b.p[P_KILL_PATH] * elim_value(b, v)) / (double)b.tcount[v]);
  }
  return best;
}

// strategic(u): taking u completes or breaks a continent, lands in the target one, kills, or takes a capital.
__device__ bool strategic(const Board& b, S& s, int u) {
  int owner = b.own[u], c = CONT_OF[u];
  bool others = true;
  for (int i = 0; i < CSIZE[c]; i++) { int t = CMEM[c][i]; if (s.bliz[t]) continue; if (t != u && b.own[t] != b.me) { others = false; break; } }
  if (others) return true;
  if (b.target == c) return true;
  if (is_rival(b, owner) && b.holder[c] == owner) return true;
  if (is_rival(b, owner) && b.tcount[owner] == 1) return true;
  return OPT_CAPITALS && owner >= 0 && owner < NS && s.capital[owner] == u;
}

__device__ double defense_need(const Board& b, int t) {
  int th = b.thr[t];
  if (th <= 0) return 0.0;
  double gap = (double)(th - b.arm[t]) + b.p[P_DEFENSE_GAP_PAD];
  if (b.p[P_CAPITAL_PAD] > 0 && held_capital(b, t)) gap = gap + b.p[P_CAPITAL_PAD];  // jacob.ts heldCapital
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
  for (int i = 0; i < CSIZE[c]; i++) { int t = CMEM[c][i]; if (s.bliz[t]) continue; if (t != u && b.own[t] != b.me) { others = false; break; } }
  if (others) v += (double)CBONUS[c] * p[P_COMPLETE_BONUS];
  else if (b.target == c) v += p[P_TARGET_CAPTURE];
  if (is_rival(b, owner) && b.holder[c] == owner) v += (double)CBONUS[c] * p[P_BREAK_BONUS];
  if (is_rival(b, owner) && b.tcount[owner] == 1) v += p[P_ELIM_BASE] + (double)s.hand_n[owner] * b.cv;
  if (b.jac) v += lead(b, owner) * p[P_LEADER_CAPTURE];
  if (OPT_CAPITALS && owner >= 0 && owner < NS && s.capital[owner] == u) v += p[P_CAPITAL_VALUE];
  if (p[P_LEADER_PUNCH] > 0 && is_rival(b, owner) && b.arm[u] <= 2) {  // punch through 1s to the leader
    double ld = lead(b, owner);
    if (ld > 0) {
      int bonus = 0;
      for (int k = -1; k < DEG[u]; k++) {  // u, then its neighbours
        int t = k < 0 ? u : NBR[u][k];
        if (s.bliz[t]) continue;
        int ct = CONT_OF[t];
        if (b.holder[ct] == owner && CBONUS[ct] > bonus) bonus = CBONUS[ct];
      }
      if (bonus > 0) v += p[P_LEADER_PUNCH] * ld * (double)bonus;
    }
  }
  if (p[P_BORDER_DELTA] != 0) {  // border territories the capture adds minus the ones it closes
    int delta = b.nen[u] > 0 ? 1 : 0;
    for (int k = 0; k < DEG[u]; k++) { int n = NBR[u][k]; if (!s.bliz[n] && b.own[n] == b.me && b.nen[n] == 1) delta--; }
    v -= p[P_BORDER_DELTA] * (double)delta;
  }
  if (p[P_DORMANT_WAKE] > 0 && b.rivals >= 2 && !(is_rival(b, owner) && b.tcount[owner] == 1)) {  // caged stacks it wakes
    int wake = 0;
    for (int k = 0; k < DEG[u]; k++) {
      int n = NBR[u][k];
      if (s.bliz[n] || !is_rival(b, b.own[n]) || b.arm[n] < 5) continue;
      bool touch = false;
      for (int j = 0; j < DEG[n]; j++) { int x = NBR[n][j]; if (!s.bliz[x] && b.own[x] == b.me) { touch = true; break; } }
      if (!touch) wake += b.arm[n] - 1;
    }
    v -= p[P_DORMANT_WAKE] * (double)wake;
  }
  if (p[P_DUEL_DENY] > 0 && b.rivals <= 1 && is_rival(b, owner)) {  // scorched earth in the duel
    int n = b.tcount[owner];
    v += p[P_DUEL_DENY] * (n >= 12 && n % 3 == 0 ? 1.0 : 0.25);
  }
  return v;
}

// captureValue(u, true), worked out once per pick (placement scores ask for it many times).
__device__ __forceinline__ double capture_card(Board& b, S& s, int u) {
  if (!b.capf[u]) { b.capv[u] = capture_value(b, s, u, true); b.capf[u] = 1; }
  return b.capv[u];
}

// placementScore(b, t, placing): `placing` is jacob.ts's armies about to land on t (its hunt term); Sensei ignores it.
__device__ double placement_score(Board& b, S& s, int t, int placing) {
  if (b.own[t] < 0) {  // claiming phase: grow next to my territories, inside continents I can hope to hold
    int c = CONT_OF[t], near = 0, mine_in = 0, total = 0;
    for (int k = 0; k < DEG[t]; k++) if (b.own[NBR[t][k]] == b.me) near++;
    for (int i = 0; i < CSIZE[c]; i++) { int x = CMEM[c][i]; if (s.bliz[x]) continue; total++; if (b.own[x] == b.me) mine_in++; }
    int borders = CBORD[c] > 1 ? CBORD[c] : 1;
    return (double)near + (total ? ((double)mine_in / (double)total) * 3.0 : 0.0) + (double)CBONUS[c] / (double)borders;
  }
  if (b.nen[t] == 0) return (double)(-50 - b.arm[t]);
  double defense = defense_need(b, t), offense = 0.0;
  int stack = b.arm[t] + placing - 1;
  for (int k = 0; k < DEG[t]; k++) {
    int u = NBR[t][k], o = b.own[u];
    if (o < 0 || o == b.me) continue;
    double value = capture_card(b, s, u);
    if (b.jac) value = value + hunt(b, o, stack);
    if (b.p[P_KILL_PATH] > 0) value = value + kill_path(b, s, u, stack);
    int gap = b.arm[u] - b.arm[t];
    offense = dmax(offense, value - (double)(gap > 0 ? gap : 0) * b.p[P_PLACE_OFFENSE_ARMY]);
  }
  return dmax(defense * b.p[P_PLACE_DEFENSE_MULT], offense);
}

// The fortify destinations legalMoves lists for src, in its order: ConnectedSearch.from(src) (connected fortify) or
// src's neighbours of mine in adjacency order (adjacent fortify).
__device__ int fortify_targets(const Board& b, int src, int* out) {
  int n = 0;
  if (FORT_ADJ) {
    for (int k = 0; k < DEG[src]; k++) { int v = NBR[src][k]; if (b.own[v] == b.me) out[n++] = v; }
    return n;
  }
  u8 seen[T];
  int stack[T], sp = 0;
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
__device__ void best_fortify(Board& b, S& s, int* bf, int* bt) {
  *bf = -1; *bt = -1;
  double best = 0.0;
  bool any_real = false;
  for (int t = 0; t < T; t++) if (b.own[t] == b.me && b.thr[t] > 0) { any_real = true; break; }
  int tg[T];
  for (int f = 0; f < T; f++) {
    if (b.own[f] != b.me || b.arm[f] < 2) continue;
    if (b.thr[f] > 0) continue;
    bool interior = b.nen[f] == 0;
    if (!any_real && !interior) continue;
    int n = fortify_targets(b, f, tg);
    int mx = b.arm[f] - 1;
    for (int i = 0; i < n; i++) {
      int to = tg[i];
      double score;
      if (b.jac) {  // jacob.ts: as Sensei, plus an interior stack always pulled to a front, toward the best attack there
        score = 0.0;
        if (any_real) {
          double need = defense_need(b, to) + (double)b.thr[to] * b.p[P_FORTIFY_THREAT];
          if (need > 0) score = need * dmin((double)mx, 1.0 + need);
        } else if (b.nen[to] > 0) {
          score = placement_score(b, s, to, 0) * (double)mx * 0.1;
        }
        if (interior) {
          score *= b.p[P_INTERIOR_BONUS];
          if (b.nen[to] > 0)
            score = dmax(score, b.p[P_FRONT_PULL] * (double)mx * 0.1 * (1.0 + dmax(0.0, placement_score(b, s, to, mx))));
        }
      } else {
        if (any_real) {
          double need = defense_need(b, to) + (double)b.thr[to] * b.p[P_FORTIFY_THREAT];
          if (need <= 0) continue;
          score = need * dmin((double)mx, 1.0 + need);
        } else {
          if (b.nen[to] == 0) continue;
          score = placement_score(b, s, to, 0) * (double)mx * 0.1;
        }
        if (interior) score *= b.p[P_INTERIOR_BONUS];
      }
      if (score > best) { best = score; *bf = f; *bt = to; }
    }
  }
}

// One step of teacherPickWith(params): the action index of the candidate it picks (-1 if there is none). G lanes of a
// group make it together (see Grp); the result, the board and *rng are the same in every lane.
template <int G> __device__ int teacher_pick_g(S& s, const TP& tp, i64* rng, const Grp& g) {
  u8 m[A];
  int cnt = legal(s, m);
  if (cnt == 0) return -1;
  int me = cur(s), ph = (int)*s.phase;
  const double* p = tp.p;
  if (p[P_STAGED] != 0) {  // jacobPickWith(params, duel): the duel half once one rival is left
    int rv = 0;
    for (int q = 0; q < NS; q++) if (q != me && s.alive[q]) rv++;
    if (rv <= 1) p = p + NP0;
  }
  Board b;
  board_init(b, s, me, p);

  if (*s.fort_src >= 0) {  // the fortify_to step
    int src = (int)*s.fort_src, bf, bt;
    best_fortify(b, s, &bf, &bt);
    int dest = bf == src ? bt : -1;
    int tg[T];
    int n = fortify_targets(b, src, tg), best = -1;
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
    bool carry = false;  // jacob.ts: carry the spearhead next to a rival on killCarry territories or fewer
    if (p[P_KILL_CARRY] > 0)
      for (int k = 0; k < DEG[to]; k++) { int o = b.own[NBR[to][k]]; if (is_rival(b, o) && (double)b.tcount[o] <= p[P_KILL_CARRY]) { carry = true; break; } }
    if (carry) want = mx;
    else if (!from_exposed) want = mx;
    else if (!to_front) want = lo;
    else if (b.thr[from] == 0) want = mx;
    else want = middle;
    if (want == mx) return OCCUPY;
    if (want == mid) return OCCUPY + 1;
    return OCCUPY + 2;
  }

  if (ph == CAPITALS) {  // capital: well garrisoned, few enemy neighbours, little threat
    int best = -1;
    double bs = -DINF;
    for (int t = 0; t < T; t++) {
      if (!m[CAP + t]) continue;
      double sc = (double)(b.arm[t] * 2 - b.nen[t]) - (double)b.thr[t] / 4.0;
      double j = sc + rnd(rng) * 1e-3;
      if (j > bs) { bs = j; best = CAP + t; }
    }
    return best;
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
    int placing = 0;  // jacob.ts: the largest amount any place candidate puts down
    if (b.jac)
      for (int t = 0; t < T; t++) {
        bool claim = b.own[t] < 0;
        for (int sl = 0; sl < 3; sl++) {
          if (!m[3 * t + sl]) continue;
          int amount = claim ? 1 : (sl == 0 ? lim : (sl == 1 ? (lim + 1) / 2 : 1));
          if (amount > placing) placing = amount;
        }
      }
    int best = -1;
    double bs = -DINF;
    unsigned st0 = (unsigned)*rng;
    int drawn = 0;
    for (int t0 = 0; t0 < T; t0 += G) {  // territory t on lane t % G
      int t = t0 + g.lane;
      int n = t < T && m[3 * t] ? m[3 * t] + m[3 * t + 1] + m[3 * t + 2] : 0;  // its draws: one per legal slot
      int total, k = drawn + draws_before<G>(g, n, &total);
      drawn += total;
      if (n == 0) continue;
      double sc = placement_score(b, s, t, placing);
      bool claim = b.own[t] < 0;
      for (int sl = 0; sl < 3; sl++) {
        int a = 3 * t + sl;
        if (!m[a]) continue;
        int amount = claim ? 1 : (sl == 0 ? lim : (sl == 1 ? (lim + 1) / 2 : 1));
        double j = (sc + (double)amount * 1e-6) + rnd_at(st0, k++) * 1e-3;
        if (j > bs) { bs = j; best = a; }
      }
    }
    rnd_skip(rng, drawn);
    best_of<G>(g, &best, &bs);
    return best;
  }

  {  // bestAttack
    bool card = !*s.conquered;
    double rival_loss = b.rivals <= 1 ? p[P_RIVAL_LOSS2] : p[P_RIVAL_LOSS_MULTI];
    double late = dmax(0.0, (double)*s.round - p[P_LATE_ROUND]) * p[P_LATE_RAMP];
    double min_ev = b.jac ? p[P_MIN_EV] - late - (card ? p[P_CARD_URGE] : 0.0) : p[P_MIN_EV] - late;
    double min_win = b.jac ? dmax(dmin(p[P_MIN_WIN], p[P_MIN_WIN_FLOOR]), p[P_MIN_WIN] - late * p[P_LATE_WIN]) : p[P_MIN_WIN];
    if (p[P_DUEL_EV] > 0 && b.rivals <= 1) min_ev = min_ev - p[P_DUEL_EV];
    bool hold = p[P_HOLD_EV] > 0 && !card && b.rivals >= 2;  // take and hold, once the card is earned
    bool tight = p[P_CARD_TIGHT] > 0 && s.hand_n[me] >= 4;
    double own_loss = p[P_OWN_LOSS] / (1.0 + late);
    int income = b.myinc > 3 ? b.myinc : 3;  // jacob.ts: Math.max(3, my income)
    int best = -1;
    double best_ev = 0.0;
    unsigned st0 = (unsigned)*rng;
    int drawn = 0;
    for (int e0 = 0; e0 < E; e0 += G) {  // edge e on lane e % G
      int e = e0 + g.lane, a = ATTACK + e, from = 0, to = 0, fa = 0;
      bool go = e < E && m[a];
      if (go) { from = EFROM[e]; to = ETO[e]; fa = b.arm[from]; go = fa >= 2; }
      Odds o;
      double pw = 0.0;
      if (go) {
        o = odds(tp, fa, b.arm[to], OPT_CAPITALS && is_capital(s, to) ? 3 : 2);
        pw = BALANCED ? o.bwin : o.win;
        go = !(pw < min_win) || (p[P_KILL_WIN] > 0 && pw >= p[P_KILL_WIN] && killable(b, b.own[to]));  // the 2v1 kill
      }
      int total, k = drawn + draws_before<G>(g, go ? 1 : 0, &total);  // the attacks weighed draw, in edge order
      drawn += total;
      if (!go) continue;
      int owner = b.own[to];
      double value = capture_value(b, s, to, card);
      double exposure = (1.0 - pw) * (p[P_EXPOSURE_BASE] + (double)b.thr[from] * p[P_EXPOSURE_THREAT] + defense_need(b, from) * p[P_EXPOSURE_NEED]);
      if (tight) exposure = exposure * (1.0 + p[P_CARD_TIGHT]);
      double dw = is_rival(b, owner) ? rival_loss : p[P_NEUTRAL_LOSS];
      double ol = own_loss, surplus = 0.0, hv = 0.0, kp = 0.0;
      if (b.jac) {
        hv = hunt(b, owner, fa - 1);
        value = value + hv;
        if (p[P_KILL_PATH] > 0) { kp = kill_path(b, s, to, fa - 1); value = value + kp; }
        if (is_rival(b, owner)) dw = rival_loss + lead(b, owner) * p[P_LEADER_LOSS];
        // armies beyond what the border needs, in turns of income: losing them costs less
        surplus = dmax(0.0, (double)(fa - b.thr[from]) / (double)income - p[P_STACK_FREE]);
        ol = p[P_OWN_LOSS] / (1.0 + late) / (1.0 + p[P_STACK_RAMP] * log1p_fd(surplus));
      }
      double ev = pw * value + o.ld * dw - o.la * ol - exposure + rnd_at(st0, k) * 1e-3;
      // take and hold: a non-strategic attack from a stack without surplus needs holdEv more
      double bar = hold && surplus <= 0 && hv <= 0 && kp <= 0 && !strategic(b, s, to) ? min_ev + p[P_HOLD_EV] : min_ev;
      if (ev > bar && (best < 0 || ev > best_ev)) { best = a; best_ev = ev; }
    }
    rnd_skip(rng, drawn);
    best_of<G>(g, &best, &best_ev);
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

__device__ __forceinline__ int teacher_pick(S& s, const TP& tp, i64* rng) {
  Grp g = {0, 1u, 0u};
  return teacher_pick_g<1>(s, tp, rng, g);
}

__device__ __forceinline__ i64* agent_rng(i64* arng, int rstride, int b, int seat) {
  return arng + (i64)b * rstride + (rstride > 1 ? seat : 0);
}

// The teacher version (row of prm) that plays `seat` of game b: tver[b * NS + seat].
__device__ __forceinline__ TP seat_tp(const TP& tp, const u8* tver, int b, int seat) {
  TP t = tp;
  t.p = tp.p + (i64)NP * tver[(i64)b * NS + seat];
  return t;
}

// The teacher's pick for every active game (the decider's stream: arng[b * rstride + seat], or one stream per game
// when rstride == 1; the decider's version: tver). out[b] = -1 when inactive or there is no move.
extern "C" __global__ void k_teacher(STATE_ARGS, TP_ARGS, i64* arng, int rstride, const u8* tver, const u8* active, i64* out, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  if (!active[b] || *s.done) { out[b] = -1; return; }
  TP_MAKE
  out[b] = teacher_pick(s, seat_tp(tp, tver, b, cur(s)), agent_rng(arng, rstride, b, cur(s)));
}

// Teachers play every seat (each its tver version) for up to `steps` steps per game (bench / whole games). stats: [2] steps.
extern "C" __global__ void k_teacher_play(STATE_ARGS, TP_ARGS, i64* arng, int rstride, const u8* tver, int steps, int max_turns, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  TP_MAKE
  for (int i = 0; i < steps && !*s.done; i++) {
    int a = teacher_pick(s, seat_tp(tp, tver, b, cur(s)), agent_rng(arng, rstride, b, cur(s)));
    if (a < 0) break;
    apply(s, a, max_turns);
    atomicAdd(&tstats[2], 1ull);
  }
}

// Teacher seats play on, in place, until a seat that is not a teacher (tseat[b * NS + seat] == 0) is to move, the game
// ends, or max_steps steps (each on the seat's own stream, exactly as one k_teacher + k_step per step). dec[b] counts
// decisions as game.ts does (a fortify is one); steps[b] the steps played. RUN_G lanes per game (Grp): each lane picks
// on its own copy of the seat's stream, lane 0 writes the stream back and makes the move.
extern "C" __global__ void k_teacher_run(STATE_ARGS, TP_ARGS, i64* arng, int rstride, const u8* tver, const u8* tseat, const u8* active,
                                         i64* dec, i64* steps, int max_steps, int max_turns, int B) {
  int i = blockIdx.x * blockDim.x + threadIdx.x, b = i / RUN_G;
  if (b >= B) return;  // the whole group
  Grp g = make_grp(i, RUN_G);
  bool lead = g.lane == 0;
  MAKE_S(b);
  TP_MAKE
  int n = 0;
  if (active[b]) {
    while (n < max_steps && !*s.done && tseat[(i64)b * NS + cur(s)]) {
      i64* rp = agent_rng(arng, rstride, b, cur(s));
      i64 r = *rp;
      int a = teacher_pick_g<RUN_G>(s, seat_tp(tp, tver, b, cur(s)), &r, g);
      __syncwarp(g.mask);  // every lane has read the board and the stream
      if (lead) {
        *rp = r;
        if (a >= 0) {
          if (!(a >= FTO && a < END)) dec[b] += 1;
          apply(s, a, max_turns);
        }
      }
      __syncwarp(g.mask);
      if (a < 0) break;
      n++;
    }
  }
  if (lead) steps[b] = n;
}

// Odds as the kernel computes them, for the tests: out = win, balancedWin, attacker losses, defender losses.
extern "C" __global__ void k_odds(TP_ARGS, const i64* a, const i64* d, const i64* dl, double* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  TP_MAKE
  Odds o = odds(tp, (int)a[i], (int)d[i], (int)dl[i]);
  out[4 * i] = o.win; out[4 * i + 1] = o.bwin; out[4 * i + 2] = o.la; out[4 * i + 3] = o.ld;
}

// log1p_fd for the tests (against Node's Math.log1p).
extern "C" __global__ void k_log1p(const double* x, double* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = log1p_fd(x[i]);
}
"""

TEACHER_KERNELS = ("k_teacher", "k_teacher_play", "k_odds", "k_teacher_run", "k_log1p")
FMAD_OFF = ["--fmad=false"]

_odds_dev: dict = {}


def odds_tensors(device) -> list[torch.Tensor]:
    """[win, la, ld, bwin, off, len] for both defence-dice limits on the device, shared by every engine."""
    key = str(device)
    if key not in _odds_dev:
        t2, t3 = odds_mod.tables(2), odds_mod.tables(3)
        n2 = t2["win"].shape[0]
        cat = lambda k: torch.from_numpy(__import__("numpy").concatenate([t2[k], t3[k]])).to(device).contiguous()  # noqa: E731
        off = torch.from_numpy(__import__("numpy").concatenate([t2["off"], t3["off"] + n2])).to(device).contiguous()
        _odds_dev[key] = [cat("win"), cat("la"), cat("ld"), cat("bwin"), off, cat("len")]
    return _odds_dev[key]


RUN_LANES = 8  # lanes per game in k_teacher_run (Grp)


def teacher_source(e, run_lanes: int = 1) -> str:
    return _source(e) + _consts(e) + f"#define RUN_G {run_lanes}\n" + TEACHER_BODY


class TeacherEngine(FusedEngine):
    """FusedEngine plus the teachers. `params` is a teacher's numbers (agent_params / load_params), or a list of
    versions' numbers: row 0 is the rollout teacher, `tver[b, seat]` the row that plays each seat (0 by default)."""

    MIRROR = "teacher"

    def __init__(self, B: int, cfg=None, params: dict[str, float] | list[dict[str, float]] | None = None, extra_source: str = "",
                 extra_kernels=(), run_lanes: int = RUN_LANES, **kw):
        allow = kw.get("allow_unverified", False)
        kw["allow_unverified"] = True  # checked below under this mirror's own name
        super().__init__(B, cfg, **kw)
        if not allow:  # every layer this one stands on: the rules kernel, the teacher, and this mirror itself
            for name in dict.fromkeys(["fused.py", "teacher", self.MIRROR]):
                require_verified(name)
        rows = params if isinstance(params, list) else [params or default_params()]
        self.prm = params_tensor(rows, self.dev).contiguous()  # [V, NP]
        self.tver = torch.zeros(B, self.n, dtype=torch.uint8, device=self.dev)
        self._tver0 = torch.zeros(B, self.n, dtype=torch.uint8, device=self.dev)
        self.ow, self.ola, self.old, self.obw, self.ooff, self.olen = odds_tensors(self.dev)
        self.tstats = torch.zeros(4, dtype=torch.int64, device=self.dev)  # [odds outside the tables, -, steps, -]
        if run_lanes not in (1, 2, 4, 8, 16, 32):
            raise ValueError(f"run_lanes {run_lanes}: want a power of two up to 32")
        self.run_lanes = run_lanes
        self.tk = compile_kernels(teacher_source(self, run_lanes) + extra_source, TEACHER_KERNELS + tuple(extra_kernels), FMAD_OFF)
        # per (game, seat) agent streams, seeded like playGame: mixSeed(seed, 0x5eed + seat)
        self.arng = torch.zeros(B, self.n, dtype=torch.long, device=self.dev)

    def _tp(self, prm: torch.Tensor | None = None) -> list:
        return [self.prm if prm is None else prm, self.ow, self.ola, self.old, self.obw, self.ooff, self.olen, self.tstats]

    def _launch_t(self, name: str, n: int, *args):
        grid = ((n + self.BLOCK - 1) // self.BLOCK, 1, 1)
        self.tk[name](grid=grid, block=(self.BLOCK, 1, 1), args=list(args))

    def seat_streams(self, g: torch.Tensor, seeds: torch.Tensor):
        """Agent random streams for games g as playGame seeds them (mixSeed(seed, 0x5eed + seat))."""
        for seat in range(self.n):
            self.arng[g, seat] = torch.tensor([mix_seed(int(x), 0x5EED + seat) for x in seeds.tolist()], dtype=torch.long, device=self.dev)

    def teacher(self, active: torch.Tensor | None = None, arng: torch.Tensor | None = None, prm: torch.Tensor | None = None,
                tver: torch.Tensor | None = None) -> torch.Tensor:
        """The teacher's action for the decider of every (active) game, advancing its stream; -1 where none. The
        decider's version is its tver row (this engine's tver unless `tver` is given; `prm`: another teacher version's
        numbers (params_tensor), then every seat plays that one)."""
        out = torch.empty(self.B, dtype=torch.long, device=self.dev)
        ar = self.arng if arng is None else arng
        rstride = ar.shape[1] if ar.dim() == 2 else 1
        act = active.to(torch.uint8).contiguous() if active is not None else torch.ones(self.B, dtype=torch.uint8, device=self.dev)
        tv = self._tver0 if prm is not None else (self.tver if tver is None else tver.to(torch.uint8).contiguous())
        self._launch_t("k_teacher", self.B, *self._state(), *self._tp(prm), ar, rstride, tv, act, out, self.B)
        return out

    def teacher_run(self, tseat: torch.Tensor, active: torch.Tensor, dec: torch.Tensor, max_steps: int = 100_000) -> torch.Tensor:
        """Teacher seats (tseat [B, seats] bool, each playing its tver version) play on in every active game until
        another seat is to move; returns the steps each game played. dec (int64 [B]) gains the decisions played."""
        steps = torch.zeros(self.B, dtype=torch.long, device=self.dev)
        self._launch_t("k_teacher_run", self.B * self.run_lanes, *self._state(), *self._tp(), self.arng, self.n, self.tver, tseat.to(torch.uint8).contiguous(),
                       active.to(torch.uint8).contiguous(), dec, steps, max_steps, self.max_turns, self.B)
        return steps

    def play_teacher(self, steps: int):
        self._launch_t("k_teacher_play", self.B, *self._state(), *self._tp(), self.arng, self.n, self.tver, steps, self.max_turns, self.B)

    def log1p(self, x: torch.Tensor) -> torch.Tensor:
        x = x.to(self.dev, torch.float64).contiguous()
        out = torch.empty_like(x)
        self._launch_t("k_log1p", x.numel(), x, out, x.numel())
        return out

    def odds(self, a: torch.Tensor, d: torch.Tensor, dlim: torch.Tensor | int = 2) -> torch.Tensor:
        n = a.numel()
        out = torch.empty(n, 4, dtype=torch.float64, device=self.dev)
        dl = torch.as_tensor(dlim, device=self.dev).long().expand(n).contiguous()
        self._launch_t("k_odds", n, *self._tp(), a.to(self.dev).long().contiguous(), d.to(self.dev).long().contiguous(), dl, out, n)
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
