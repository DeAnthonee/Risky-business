"""The same rules as engine.py, one CUDA thread per game: a whole move (legal moves, blitz, cards, turn flow) is one
kernel launch for every game at once instead of hundreds of small tensor operations.

TRAINING ONLY, like engine.py: a mirror of packages/engine checked by tests/replay.py --fused (the same replay test,
bit for bit: the kernels draw from each game's mulberry32 stream exactly like the TypeScript engine). FusedEngine
works on the very tensors Engine holds, so the encoder, snapshots and network player run unchanged on top of it.

The kernels are compiled at first use with NVRTC through torch.cuda._compile_kernel (no CUDA toolkit or C++ compiler
needed; NVRTC ships with PyTorch). Map data is baked into the source as constants.
"""
from __future__ import annotations

import os
from pathlib import Path

import torch

from .engine import ATTACK, FINISHED, FORTIFY, REINFORCE, SETUP, Engine

_INCLUDE_STUB = Path(__file__).resolve().parent / "_nvrtc_home"
_cache: dict[str, dict] = {}

STATE_FIELDS = [
    ("owner", "i64"), ("armies", "i64"), ("alive", "u8"), ("atp", "i64"), ("hand", "i64"), ("hand_n", "i64"),
    ("trades_made", "i64"), ("trade_count", "i64"), ("deck", "i64"), ("deck_n", "i64"), ("discard", "i64"),
    ("discard_n", "i64"), ("order", "i64"), ("cur_pos", "i64"), ("phase", "i64"), ("turn", "i64"), ("round", "i64"),
    ("pend_from", "i64"), ("pend_to", "i64"), ("pend_min", "i64"), ("pend_max", "i64"), ("conquered", "u8"),
    ("fortified", "u8"), ("fort_src", "i64"), ("rng", "i64"), ("winner", "i64"), ("done", "u8"),
]


def _carr(name: str, rows) -> str:
    if rows and isinstance(rows[0], (list, tuple)):
        body = ",".join("{" + ",".join(str(int(v)) for v in r) + "}" for r in rows)
        return f"__constant__ int {name}[{len(rows)}][{len(rows[0])}] = {{{body}}};"
    return f"__constant__ int {name}[{len(rows)}] = {{{','.join(str(int(v)) for v in rows)}}};"


def _source(e: Engine) -> str:
    m, L = e.m, e.L
    T, D = m.T, m.D
    nbr = [a + [0] * (D - len(a)) for a in m.adj]
    ebase, acc = [], 0
    for a in m.adj:
        ebase.append(acc)
        acc += len(a)
    cont_of = m.cont_of.tolist()
    defs = {
        "T": T, "NC": m.NC, "NS": e.n, "P": e.P, "NEU": e.NEU, "H": e.H, "E": m.E, "A": L.A, "D": D, "K": m.K,
        "TRADE": L.TRADE, "ATTACK": L.ATTACK, "OCCUPY": L.OCCUPY, "FFROM": L.FFROM, "FTO": L.FTO, "END": L.END,
        "SETUP": SETUP, "REINFORCE": REINFORCE, "ATTACK_PH": ATTACK, "FORTIFY": FORTIFY, "FINISHED": FINISHED,
        "START_ARMIES": m.starting_armies[e.n], "SETUP_BATCH": e.setup_batch, "FIRST_ROUND_BONUS": int(e.first_round_bonus),
    }
    head = "\n".join(f"#define {k} {v}" for k, v in defs.items())
    consts = "\n".join([
        _carr("NBR", nbr), _carr("DEG", [len(a) for a in m.adj]), _carr("EBASE", ebase),
        _carr("EFROM", [x for x, _ in m.edges]), _carr("ETO", [y for _, y in m.edges]),
        _carr("CONT_OF", cont_of), _carr("CBONUS", m.cont_bonus.tolist()), _carr("CSIZE", m.cont_size.tolist()),
        _carr("TRI5", L.trade_tri.tolist()),
    ])
    args = ", ".join(f"{'long long' if t == 'i64' else 'unsigned char'}* {n}_" for n, t in STATE_FIELDS)
    make = "\n".join(
        f"  s.{n} = {n}_ + (long long)b * {stride};"
        for n, stride in [
            ("owner", "T"), ("armies", "T"), ("alive", "P"), ("atp", "P"), ("hand", "P * H"), ("hand_n", "P"),
            ("trades_made", "P"), ("trade_count", "1"), ("deck", "NC"), ("deck_n", "1"), ("discard", "NC"),
            ("discard_n", "1"), ("order", "NS"), ("cur_pos", "1"), ("phase", "1"), ("turn", "1"), ("round", "1"),
            ("pend_from", "1"), ("pend_to", "1"), ("pend_min", "1"), ("pend_max", "1"), ("conquered", "1"),
            ("fortified", "1"), ("fort_src", "1"), ("rng", "1"), ("winner", "1"), ("done", "1"),
        ]
    )
    return f"""
{head}
{consts}
typedef long long i64;
typedef unsigned char u8;
struct S {{
  i64 *owner, *armies, *atp, *hand, *hand_n, *trades_made, *trade_count, *deck, *deck_n, *discard, *discard_n, *order,
      *cur_pos, *phase, *turn, *round, *pend_from, *pend_to, *pend_min, *pend_max, *fort_src, *rng, *winner;
  u8 *alive, *conquered, *fortified, *done;
}};
#define STATE_ARGS {args}
#define MAKE_S(b) S s; {{ {make.replace(chr(10), ' ')} }}
{_BODY}
"""


_BODY = r"""
// ---- mulberry32 (packages/engine/src/rng.ts)
__device__ __forceinline__ unsigned int mb_next(i64* st) {
  unsigned int s = (unsigned int)(*st) + 0x6D2B79F5u;
  *st = (i64)s;
  unsigned int t = s;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return t ^ (t >> 14);
}
__device__ __forceinline__ int mb_int(i64* st, int n) { return (int)(((unsigned long long)mb_next(st) * (unsigned long long)n) >> 32); }

__device__ __forceinline__ int cur(S& s) { return (int)s.order[*s.cur_pos]; }
__device__ __forceinline__ int ckind(int c) { return c < T ? c % 3 : 3; }
__device__ __forceinline__ int cterr(int c) { return c < T ? c : -1; }
__device__ __forceinline__ int trade_bonus(int i) {
  const int tb[6] = {4, 6, 8, 10, 12, 15};
  return i < 6 ? tb[i] : 15 + 5 * (i - 5);
}
__device__ __forceinline__ bool valid_set(int a, int b, int c) {
  if (a == 3 || b == 3 || c == 3) return true;
  return (a == b && b == c) || (a != b && b != c && a != c);
}

__device__ int reinforcements(S& s, int p) {
  int cnt = 0;
  int held[K];
  for (int c = 0; c < K; c++) held[c] = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == p) { cnt++; held[CONT_OF[t]]++; }
  int tot = cnt / 3;
  if (tot < 3) tot = 3;
  for (int c = 0; c < K; c++) if (held[c] == CSIZE[c]) tot += CBONUS[c];
  return tot;
}

__device__ void remove_hand(S& s, int p, int i, int j, int k) {
  i64* h = s.hand + p * H;
  int n = (int)s.hand_n[p], w = 0;
  for (int r = 0; r < n; r++) if (r != i && r != j && r != k) h[w++] = h[r];
  for (int r = w; r < n; r++) h[r] = -1;
  s.hand_n[p] = w;
}
__device__ __forceinline__ void append_hand(S& s, int p, i64 c) {
  int n = (int)s.hand_n[p];
  if (n < H) { s.hand[p * H + n] = c; s.hand_n[p] = n + 1; }
}

__device__ void trade_set(S& s, int p, int i, int j, int k, bool by_id) {
  i64* h = s.hand + p * H;
  int c[3] = {(int)h[i], (int)h[j], (int)h[k]};
  if (by_id) {
    if (c[0] > c[1]) { int x = c[0]; c[0] = c[1]; c[1] = x; }
    if (c[1] > c[2]) { int x = c[1]; c[1] = c[2]; c[2] = x; }
    if (c[0] > c[1]) { int x = c[0]; c[0] = c[1]; c[1] = x; }
  }
  int tc = (int)*s.trade_count;
  s.atp[p] += trade_bonus(tc);
  *s.trade_count = tc + 1;
  s.trades_made[p] += 1;
  remove_hand(s, p, i, j, k);
  for (int q = 0; q < 3; q++) s.discard[(*s.discard_n)++] = c[q];
  for (int q = 0; q < 3; q++) {
    int t = cterr(c[q]);
    if (t >= 0 && s.owner[t] == p) { s.armies[t] += 2; break; }
  }
}

// engine.ts autoTrade + bestSet (progressive values are equal, so: shows an owned territory, then fewest wilds, then first)
__device__ void auto_trade(S& s, int p) {
  while (s.hand_n[p] >= 5) {
    int n = (int)s.hand_n[p];
    i64* h = s.hand + p * H;
    int best = -1, bi = 0, bj = 0, bk = 0;
    for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) for (int k = j + 1; k < n; k++) {
      int c0 = (int)h[i], c1 = (int)h[j], c2 = (int)h[k];
      int k0 = ckind(c0), k1 = ckind(c1), k2 = ckind(c2);
      if (!valid_set(k0, k1, k2)) continue;
      int t0 = cterr(c0), t1 = cterr(c1), t2 = cterr(c2);
      int bonus = (t0 >= 0 && s.owner[t0] == p) || (t1 >= 0 && s.owner[t1] == p) || (t2 >= 0 && s.owner[t2] == p);
      int wilds = (k0 == 3) + (k1 == 3) + (k2 == 3);
      int key = bonus * 4 + 3 - wilds;
      if (key > best) { best = key; bi = i; bj = j; bk = k; }
    }
    if (best < 0) return;
    trade_set(s, p, bi, bj, bk, false);
  }
}

__device__ void begin_turn(S& s, int pos) {
  *s.cur_pos = pos;
  int p = (int)s.order[pos];
  *s.turn += 1;
  *s.phase = REINFORCE;
  *s.pend_from = -1;
  *s.pend_to = -1;
  *s.fortified = 0;
  *s.conquered = 0;
  int tot = reinforcements(s, p);
  if (FIRST_ROUND_BONUS && *s.round == 1 && pos + 1 > tot) tot = pos + 1;
  s.atp[p] = tot;
  auto_trade(s, p);
}

__device__ void begin_first_turn(S& s) {
  *s.turn = 0;
  *s.round = 1;
  for (int i = 0; i < NS; i++) if (s.alive[s.order[i]]) { begin_turn(s, i); return; }
}

__device__ void advance_setup(S& s) {
  int idx = (int)*s.cur_pos;
  bool any = false;
  for (int i = 0; i < NS; i++) { int q = (int)s.order[i]; if (s.alive[q] && s.atp[q] > 0) any = true; }
  if (!any) { begin_first_turn(s); return; }
  for (int i = 1; i <= NS; i++) {
    int j = (idx + i) % NS;
    int q = (int)s.order[j];
    if (s.alive[q] && s.atp[q] > 0) { *s.cur_pos = j; return; }
  }
}

__device__ void next_turn(S& s) {
  int idx = (int)*s.cur_pos;
  for (int i = 1; i <= NS; i++) {
    int j = (idx + i) % NS;
    if (s.alive[s.order[j]]) {
      if (j <= idx) *s.round += 1;
      begin_turn(s, j);
      return;
    }
  }
}

__device__ void shuffle(i64* arr, int n, i64* rng) {
  for (int i = n - 1; i > 0; i--) {
    int j = mb_int(rng, i + 1);
    i64 x = arr[i]; arr[i] = arr[j]; arr[j] = x;
  }
}

__device__ void draw(S& s, int p) {
  if (*s.deck_n == 0) {
    int n = (int)*s.discard_n;
    if (n == 0) return;
    for (int i = 0; i < n; i++) s.deck[i] = s.discard[i];
    shuffle(s.deck, n, s.rng);
    *s.deck_n = n;
    *s.discard_n = 0;
  }
  *s.deck_n -= 1;
  append_hand(s, p, s.deck[*s.deck_n]);
}

__device__ void end_turn(S& s) {
  int p = cur(s);
  if (*s.conquered) draw(s, p);
  next_turn(s);
}

__device__ void attack(S& s, int e) {
  int from = EFROM[e], to = ETO[e], p = cur(s);
  int fa = (int)s.armies[from], ta = (int)s.armies[to], last = 0;
  while (fa >= 2 && ta > 0) {
    int ad = fa - 1 < 3 ? fa - 1 : 3, dd = ta < 2 ? ta : 2;
    int a[3] = {0, 0, 0}, d[2] = {0, 0};
    for (int q = 0; q < ad; q++) a[q] = 1 + mb_int(s.rng, 6);
    for (int q = 0; q < dd; q++) d[q] = 1 + mb_int(s.rng, 6);
    if (a[0] < a[1]) { int x = a[0]; a[0] = a[1]; a[1] = x; }
    if (a[1] < a[2]) { int x = a[1]; a[1] = a[2]; a[2] = x; }
    if (a[0] < a[1]) { int x = a[0]; a[0] = a[1]; a[1] = x; }
    if (d[0] < d[1]) { int x = d[0]; d[0] = d[1]; d[1] = x; }
    int pairs = ad < dd ? ad : dd;
    for (int q = 0; q < pairs; q++) { if (a[q] > d[q]) ta--; else fa--; }
    last = ad;
  }
  s.armies[from] = fa;
  s.armies[to] = ta;
  if (ta > 0) return;
  int def = (int)s.owner[to];
  s.owner[to] = p;
  *s.conquered = 1;
  *s.pend_from = from;
  *s.pend_to = to;
  int mn = last < fa - 1 ? last : fa - 1;
  *s.pend_min = mn < 1 ? 1 : mn;
  *s.pend_max = fa - 1;
  for (int t = 0; t < T; t++) if (s.owner[t] == def) return;
  s.alive[def] = 0;
  int dn = (int)s.hand_n[def];
  if (dn > 0) {
    for (int q = 0; q < dn; q++) append_hand(s, p, s.hand[def * H + q]);
    for (int q = 0; q < dn; q++) s.hand[def * H + q] = -1;
    s.hand_n[def] = 0;
    auto_trade(s, p);
  }
}

__device__ void occupy(S& s, int slot) {
  int mx = (int)*s.pend_max, mn = (int)*s.pend_min;
  int mid = (mx + 1) / 2;
  if (mid < mn) mid = mn;
  int n = slot == 0 ? mx : (slot == 1 ? mid : mn);
  s.armies[*s.pend_from] -= n;
  s.armies[*s.pend_to] += n;
  *s.pend_from = -1;
  *s.pend_to = -1;
  int alive = 0, who = -1;
  for (int q = 0; q < NS; q++) if (s.alive[q]) { alive++; who = q; }
  if (alive == 1) { *s.phase = FINISHED; *s.winner = who; }
}

__device__ void place(S& s, int t, int slot) {
  int p = cur(s);
  int a = (int)s.atp[p], ph = (int)*s.phase;
  int lim = ph == SETUP ? (a < SETUP_BATCH ? a : SETUP_BATCH) : a;
  int n = slot == 0 ? lim : (slot == 1 ? (lim + 1) / 2 : 1);
  s.armies[t] += n;
  s.atp[p] = a - n;
  if (ph == SETUP) advance_setup(s);
  else if (ph == REINFORCE && a - n == 0) *s.phase = ATTACK_PH;
}

__device__ void fortify_to(S& s, int t, int slot) {
  int src = (int)*s.fort_src;
  int mx = (int)s.armies[src] - 1;
  int n = slot == 0 ? mx : (mx + 1) / 2;
  s.armies[src] -= n;
  s.armies[t] += n;
  *s.fortified = 1;
  *s.fort_src = -1;
  *s.phase = FORTIFY;
  end_turn(s);
}

__device__ void apply(S& s, int a, int max_turns) {
  if (*s.done) return;
  if (a < TRADE) place(s, a / 3, a % 3);
  else if (a < ATTACK) { int k = a - TRADE; trade_set(s, cur(s), TRI5[k][0], TRI5[k][1], TRI5[k][2], true); }
  else if (a < OCCUPY) attack(s, a - ATTACK);
  else if (a < FFROM) occupy(s, a - OCCUPY);
  else if (a < FTO) *s.fort_src = a - FFROM;
  else if (a < END) fortify_to(s, (a - FTO) / 2, (a - FTO) % 2);
  else end_turn(s);
  if (*s.phase == FINISHED || *s.turn >= max_turns) *s.done = 1;
}

// Same-owner regions: lab[t] = smallest territory index of t's region, size[t] = region size.
__device__ void components(S& s, int* lab, int* size) {
  int stack[T];
  for (int t = 0; t < T; t++) lab[t] = -1;
  for (int t = 0; t < T; t++) {
    if (lab[t] >= 0) continue;
    int o = (int)s.owner[t], sp = 0, n = 0;
    lab[t] = t; stack[sp++] = t;
    while (sp) {
      int u = stack[--sp]; n++;
      for (int k = 0; k < DEG[u]; k++) { int v = NBR[u][k]; if (lab[v] < 0 && s.owner[v] == o) { lab[v] = t; stack[sp++] = v; } }
    }
    size[t] = n;
  }
  for (int t = 0; t < T; t++) size[t] = size[lab[t]];
}

// candidates() of actions.ts over the fixed action space; returns how many moves are legal.
__device__ int legal(S& s, u8* m) {
  for (int a = 0; a < A; a++) m[a] = 0;
  if (*s.done) return 0;
  int me = cur(s), ph = (int)*s.phase, atp = (int)s.atp[me], hn = (int)s.hand_n[me], cnt = 0;
  bool must = (ph == REINFORCE || ph == ATTACK_PH) && hn >= 5;
  if (*s.pend_from >= 0) {
    int mx = (int)*s.pend_max, mn = (int)*s.pend_min;
    int mid = (mx + 1) / 2; if (mid < mn) mid = mn;
    if (mx >= 1) { m[OCCUPY] = 1; cnt++; }
    if (mid != mx) { m[OCCUPY + 1] = 1; cnt++; }
    if (mn != mx && mn != mid) { m[OCCUPY + 2] = 1; cnt++; }
    return cnt;
  }
  int lab[T], size[T];
  if (*s.fort_src >= 0) {
    int src = (int)*s.fort_src;
    components(s, lab, size);
    int fmax = (int)s.armies[src] - 1;
    bool ok0 = fmax >= 1, ok1 = (fmax + 1) / 2 != fmax;
    for (int t = 0; t < T; t++) if (t != src && lab[t] == lab[src] && s.owner[t] == me) {
      if (ok0) { m[FTO + 2 * t] = 1; cnt++; }
      if (ok1) { m[FTO + 2 * t + 1] = 1; cnt++; }
    }
    return cnt;
  }
  if (ph == SETUP || (ph == REINFORCE && !must) || (ph == ATTACK_PH && !must && atp > 0)) {
    int lim = ph == SETUP ? (atp < SETUP_BATCH ? atp : SETUP_BATCH) : atp;
    int half = (lim + 1) / 2;
    bool ok0 = lim >= 1, ok1 = half != lim, ok2 = lim != 1 && half != 1;
    for (int t = 0; t < T; t++) if (s.owner[t] == me) {
      if (ok0) { m[3 * t] = 1; cnt++; }
      if (ok1) { m[3 * t + 1] = 1; cnt++; }
      if (ok2) { m[3 * t + 2] = 1; cnt++; }
    }
  }
  if (ph == REINFORCE || (ph == ATTACK_PH && must)) {
    i64* h = s.hand + me * H;
    for (int k = 0; k < 10; k++) {
      if (TRI5[k][2] >= hn) continue;
      if (valid_set(ckind((int)h[TRI5[k][0]]), ckind((int)h[TRI5[k][1]]), ckind((int)h[TRI5[k][2]]))) { m[TRADE + k] = 1; cnt++; }
    }
  }
  bool att = ph == ATTACK_PH && !must && atp == 0, fph = ph == FORTIFY;
  if (att) {
    for (int t = 0; t < T; t++) if (s.owner[t] == me && s.armies[t] >= 2)
      for (int k = 0; k < DEG[t]; k++) if (s.owner[NBR[t][k]] != me) { m[ATTACK + EBASE[t] + k] = 1; cnt++; }
  }
  if ((att || fph) && !*s.fortified) {
    components(s, lab, size);
    for (int t = 0; t < T; t++) if (s.owner[t] == me && s.armies[t] >= 2 && size[t] >= 2) { m[FFROM + t] = 1; cnt++; }
  }
  if (att || fph) { m[END] = 1; cnt++; }
  return cnt;
}

// createGame(seed) + startGame with a random deal (engine.ts), for the 2-player classic setup.
__device__ void reset_game(S& s, unsigned int seed) {
  i64 st = (i64)seed;
  s.order[0] = 0; s.order[1] = 1;
  shuffle(s.order, NS, &st);
  for (int i = 0; i < NC; i++) s.deck[i] = i;
  shuffle(s.deck, NC, &st);
  i64 perm[T];
  for (int i = 0; i < T; i++) perm[i] = i;
  shuffle(perm, T, &st);
  int dealt[NS + 1];
  for (int d = 0; d <= NS; d++) dealt[d] = 0;
  for (int i = 0; i < T; i++) {
    int d = i % (NS + 1);
    int who = d < NS ? (int)s.order[d] : NEU;
    s.owner[perm[i]] = who;
    s.armies[perm[i]] = 1;
    dealt[d]++;
  }
  for (int d = 0; d < NS; d++) s.atp[s.order[d]] = START_ARMIES - dealt[d];
  s.atp[NEU] = 0;
  // the Neutral's remaining armies, spread evenly from a random start (distributeEvenly)
  int ln = dealt[NS], extra = START_ARMIES - ln;
  int i0 = mb_int(&st, ln);
  int q = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == NEU) {
    int r = (q - i0) % ln; if (r < 0) r += ln;
    s.armies[t] += extra / ln + (r < extra % ln ? 1 : 0);
    q++;
  }
  for (int p = 0; p < P; p++) { s.alive[p] = 1; s.hand_n[p] = 0; s.trades_made[p] = 0; for (int h = 0; h < H; h++) s.hand[p * H + h] = -1; }
  *s.trade_count = 0; *s.deck_n = NC; *s.discard_n = 0; *s.cur_pos = 0; *s.phase = SETUP; *s.turn = 0; *s.round = 0;
  *s.pend_from = -1; *s.pend_to = -1; *s.pend_min = 0; *s.pend_max = 0; *s.conquered = 0; *s.fortified = 0;
  *s.fort_src = -1; *s.rng = st; *s.winner = -1; *s.done = 0;
}

extern "C" __global__ void k_legal(STATE_ARGS, u8* mask, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  legal(s, mask + (i64)b * A);
}

extern "C" __global__ void k_step(STATE_ARGS, i64* action, int B, int max_turns) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  apply(s, (int)action[b], max_turns);
}

extern "C" __global__ void k_reset(STATE_ARGS, i64* seeds, u8* which, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B || !which[b]) return;
  MAKE_S(b);
  reset_game(s, (unsigned int)seeds[b]);
}

// Self-play with uniformly random legal moves, `steps` decisions per game without leaving the GPU. A finished game is
// counted (stats: games, decisions, turns, decided games) and restarted with the next seed of `seed_counter`.
extern "C" __global__ void k_random_play(STATE_ARGS, i64* agent_rng, i64* dec, unsigned long long* stats, unsigned long long* seed_counter,
                                         int B, int steps, int max_turns, int seed_base) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  u8 m[A];
  i64 ar = agent_rng[b];
  i64 d = dec[b];
  for (int i = 0; i < steps; i++) {
    if (*s.done) {
      atomicAdd(&stats[0], 1ull);
      atomicAdd(&stats[1], (unsigned long long)d);
      atomicAdd(&stats[2], (unsigned long long)*s.turn);
      if (*s.winner >= 0) atomicAdd(&stats[3], 1ull);
      unsigned long long k = atomicAdd(seed_counter, 1ull);
      i64 hs = (i64)((unsigned int)seed_base ^ (unsigned int)(k * 2654435761ull));
      reset_game(s, mb_next(&hs));
      d = 0;
    }
    int n = legal(s, m);
    int r = mb_int(&ar, n), a = 0;
    for (a = 0; a < A; a++) if (m[a] && r-- == 0) break;
    apply(s, a, max_turns);
    d++;
  }
  agent_rng[b] = ar;
  dec[b] = d;
}
"""


def _kernels(e: Engine) -> dict:
    src = _source(e)
    if src in _cache:
        return _cache[src]
    import torch.utils.cpp_extension as cpp

    if cpp.CUDA_HOME is None:  # NVRTC needs no headers here; torch only wants an include dir to pass along
        (_INCLUDE_STUB / "include").mkdir(parents=True, exist_ok=True)
        cpp.CUDA_HOME = str(_INCLUDE_STUB)
        os.environ.setdefault("CUDA_HOME", str(_INCLUDE_STUB))
    ks = {name: torch.cuda._compile_kernel(src, name) for name in ("k_legal", "k_step", "k_reset", "k_random_play")}
    _cache[src] = ks
    return ks


class FusedEngine(Engine):
    """Engine with legal(), step() and reset() as single CUDA kernels (always exact: mulberry32 like the engine)."""

    BLOCK = 128

    def __init__(self, B: int, **kw):
        kw["exact"] = True
        super().__init__(B, **kw)
        self.k = _kernels(self)
        self._mask = torch.zeros(B, self.L.A, dtype=torch.bool, device=self.dev)
        self.agent_rng = torch.arange(B, dtype=torch.long, device=self.dev) * 7919 + 17
        self.dec = torch.zeros(B, dtype=torch.long, device=self.dev)

    def _state(self) -> list:
        return [getattr(self, n) for n, _ in STATE_FIELDS]

    def _launch(self, name: str, *extra):
        grid = ((self.B + self.BLOCK - 1) // self.BLOCK, 1, 1)
        self.k[name](grid=grid, block=(self.BLOCK, 1, 1), args=[*self._state(), *extra])

    def legal(self) -> torch.Tensor:
        self._launch("k_legal", self._mask, self.B)
        return self._mask

    def step(self, action: torch.Tensor):
        self._launch("k_step", action.to(torch.long).contiguous(), self.B, self.max_turns)

    def reset(self, g: torch.Tensor, seeds: torch.Tensor):
        which = torch.zeros(self.B, dtype=torch.bool, device=self.dev)
        which[g] = True
        full = torch.zeros(self.B, dtype=torch.long, device=self.dev)
        full[g] = seeds.to(self.dev).long() & 0xFFFFFFFF
        self.seed[g] = full[g]
        self._launch("k_reset", full, which, self.B)

    def play_random(self, steps: int, stats: torch.Tensor, seed_counter: torch.Tensor, seed_base: int = 0x9E3779B9):
        """`steps` random-move decisions in every game, restarting finished games; stats (uint64 [4]) accumulates
        finished games, their decisions, their turns and how many had a winner."""
        self._launch("k_random_play", self.agent_rng, self.dec, stats, seed_counter, self.B, steps, self.max_turns, seed_base & 0x7FFFFFFF)
