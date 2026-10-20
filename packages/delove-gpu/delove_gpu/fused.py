"""The rules (packages/engine/src/engine.ts) with one CUDA thread per game, for every map, table size (2-10 seats)
and game setting the mirror covers: a whole move (legal moves, blitz, cards, turn flow) is one kernel launch for every
game at once.

TRAINING ONLY: a mirror of packages/engine checked by the replay tests (tests/replay.py, tests/matrix.py), bit for
bit: the kernels draw from each game's mulberry32 stream exactly like the TypeScript engine, in the same order (deal,
blizzards, neutral territories, dice, reshuffles). The map (territories, adjacency in the engine's own order,
continents), the table size and every setting are compile-time constants of the source: one NVRTC compile per
configuration (GameConfig), its binary cached on disk.

Covered settings: capitals (+ chooseCapitals), card values (progressive, fixed, exponential), fortify mode (connected,
adjacent), balanced blitz, blizzards, firstRoundBonus, setupBatch, autoSetup, randomDeal (the claiming phase),
neutrals / neutralArmies (3+ players; the classic Neutral at 2 players). Not covered: fog of war.

The kernels are compiled at first use with NVRTC through torch.cuda._compile_kernel (no CUDA toolkit or C++ compiler
needed; NVRTC ships with PyTorch).
"""
from __future__ import annotations

import os
from pathlib import Path

import torch

from .engine import ATTACK, CAPITALS, FINISHED, FORTIFY, REINFORCE, SETUP, State

_INCLUDE_STUB = Path(__file__).resolve().parent / "_nvrtc_home"
_cache: dict = {}

STATE_FIELDS = [
    ("owner", "i64"), ("armies", "i64"), ("alive", "u8"), ("atp", "i64"), ("hand", "i64"), ("hand_n", "i64"),
    ("trades_made", "i64"), ("trade_count", "i64"), ("deck", "i64"), ("deck_n", "i64"), ("discard", "i64"),
    ("discard_n", "i64"), ("order", "i64"), ("cur_pos", "i64"), ("phase", "i64"), ("turn", "i64"), ("round", "i64"),
    ("pend_from", "i64"), ("pend_to", "i64"), ("pend_min", "i64"), ("pend_max", "i64"), ("conquered", "u8"),
    ("fortified", "u8"), ("fort_src", "i64"), ("rng", "i64"), ("winner", "i64"), ("done", "u8"), ("capital", "i64"),
    ("bliz", "u8"), ("elim_by", "i64"), ("elim_seq", "i64"), ("elim_n", "i64"),
]
_STRIDES = {
    "owner": "T", "armies": "T", "alive": "P", "atp": "P", "hand": "P * H", "hand_n": "P", "trades_made": "P",
    "deck": "NC", "discard": "NC", "order": "NS", "capital": "NS", "bliz": "T", "elim_by": "P", "elim_seq": "P",
}

CARD_MODES = {"progressive": 0, "fixed": 1, "exponential": 2}


def _carr(name: str, rows) -> str:
    if rows and isinstance(rows[0], (list, tuple)):
        body = ",".join("{" + ",".join(str(int(v)) for v in r) + "}" for r in rows)
        return f"__constant__ int {name}[{len(rows)}][{len(rows[0])}] = {{{body}}};"
    return f"__constant__ int {name}[{len(rows)}] = {{{','.join(str(int(v)) for v in rows)}}};"


def _source(e: State) -> str:
    m, L, cfg = e.m, e.L, e.cfg
    T, D = m.T, m.D
    nbr = [a + [0] * (D - len(a)) for a in m.adj]
    ebase, acc = [], 0
    for a in m.adj:
        ebase.append(acc)
        acc += len(a)
    cmax = max(len(ts) for _, _, ts in m.continents)
    cmem = [ts + [-1] * (cmax - len(ts)) for _, _, ts in m.continents]
    o = cfg.opt
    defs = {
        "T": T, "NC": m.NC, "NS": e.n, "P": e.P, "NEU": e.NEU, "H": e.H, "E": m.E, "A": L.A, "D": D, "K": m.K, "CMAX": cmax,
        "TRADE": L.TRADE, "ATTACK": L.ATTACK, "OCCUPY": L.OCCUPY, "FFROM": L.FFROM, "FTO": L.FTO, "END": L.END, "CAP": L.CAP,
        "SETUP": SETUP, "CAPITALS": CAPITALS, "REINFORCE": REINFORCE, "ATTACK_PH": ATTACK, "FORTIFY": FORTIFY, "FINISHED": FINISHED,
        "START_ARMIES": cfg.starting_armies, "SETUP_BATCH": o("setupBatch"), "FIRST_ROUND_BONUS": int(o("firstRoundBonus")),
        "OPT_CAPITALS": int(o("capitals")), "OPT_CHOOSE_CAPITALS": int(o("chooseCapitals")), "CARD_MODE": CARD_MODES[o("cardValues")],
        "FORT_ADJ": int(o("fortifyMode") == "adjacent"), "BALANCED": int(o("balancedBlitz")), "NBLIZ": o("blizzards"),
        "NEUTRAL_TERR": cfg.neutral_territories, "NEUTRAL_ARMIES": o("neutralArmies"), "HAS_NEUTRAL": int(cfg.has_neutral),
        "RANDOM_DEAL": int(o("randomDeal") or o("autoSetup")), "AUTO_SETUP": int(o("autoSetup")),
    }
    head = "\n".join(f"#define {k} {v}" for k, v in defs.items())
    consts = "\n".join([
        _carr("NBR", nbr), _carr("DEG", [len(a) for a in m.adj]), _carr("EBASE", ebase),
        _carr("EFROM", [x for x, _ in m.edges]), _carr("ETO", [y for _, y in m.edges]),
        _carr("CONT_OF", m.cont_of.tolist()), _carr("CBONUS", m.cont_bonus.tolist()), _carr("CSIZE", m.cont_size.tolist()),
        _carr("CMEM", cmem), _carr("CBORD", m.borders), _carr("TRI5", L.trade_tri.tolist()),
    ])
    args = ", ".join(f"{'long long' if t == 'i64' else 'unsigned char'}* {n}_" for n, t in STATE_FIELDS)
    make = " ".join(f"s.{n} = {n}_ + (long long)b * {_STRIDES.get(n, '1')};" for n, _ in STATE_FIELDS)
    return f"""
{head}
{consts}
typedef long long i64;
typedef unsigned char u8;
struct S {{
  i64 *owner, *armies, *atp, *hand, *hand_n, *trades_made, *trade_count, *deck, *deck_n, *discard, *discard_n, *order,
      *cur_pos, *phase, *turn, *round, *pend_from, *pend_to, *pend_min, *pend_max, *fort_src, *rng, *winner, *capital,
      *elim_by, *elim_seq, *elim_n;
  u8 *alive, *conquered, *fortified, *done, *bliz;
}};
#define STATE_ARGS {args}
#define MAKE_S(b) S s; {{ {make} }}
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
__device__ __forceinline__ bool valid_set(int a, int b, int c) {
  if (a == 3 || b == 3 || c == 3) return true;
  return (a == b && b == c) || (a != b && b != c && a != c);
}

// ---- card values (packages/engine/src/cards.ts)
__device__ __forceinline__ int trade_bonus(int i) {
  const int tb[6] = {4, 6, 8, 10, 12, 15};
  return i < 6 ? tb[i] : 15 + 5 * (i - 5);
}
// exponentialTradeBonus: 5, then ceil(v * 13 / 10) for the first 24 trades, then +1000 per trade
__device__ __forceinline__ int exp_bonus(int i) {
  int v = 5, k = i < 24 ? i : 24;
  for (int q = 0; q < k; q++) v = (v * 13 + 9) / 10;
  return v + (i > 24 ? i - 24 : 0) * 1000;
}
// nextTradeValue(mode, tradeCount, personal trades of p)
__device__ __forceinline__ int next_value(S& s, int p) {
  if (CARD_MODE == 1) return 10;
  if (CARD_MODE == 2) return exp_bonus((int)s.trades_made[p]);
  return trade_bonus((int)*s.trade_count);
}
// setValue(cards, mode, ...): fixedSetValue for fixed cards, else the next trade value
__device__ __forceinline__ int set_value(S& s, int p, int k0, int k1, int k2) {
  if (CARD_MODE != 1) return next_value(s, p);
  int wilds = (k0 == 3) + (k1 == 3) + (k2 == 3);
  if (wilds >= 2) return 10;
  int a = -1;
  bool same = true;
  int ks[3] = {k0, k1, k2};
  for (int q = 0; q < 3; q++) { if (ks[q] == 3) continue; if (a < 0) a = ks[q]; else if (ks[q] != a) same = false; }
  if (same) { const int fv[3] = {4, 6, 8}; return fv[a]; }
  return 10;
}

__device__ __forceinline__ bool is_capital(S& s, int t) {
  if (!OPT_CAPITALS) return false;
  for (int q = 0; q < NS; q++) if (s.capital[q] == t) return true;
  return false;
}

// Open (non-blizzard) territories of continent c.
__device__ __forceinline__ int open_count(S& s, int c) {
  int n = 0;
  for (int i = 0; i < CSIZE[c]; i++) if (!s.bliz[CMEM[c][i]]) n++;
  return n;
}

// Continents p controls (every open territory, at least one): controlsContinent.
__device__ int continents_held(S& s, int p) {
  int held[K];
  for (int c = 0; c < K; c++) held[c] = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == p) held[CONT_OF[t]]++;
  int n = 0;
  for (int c = 0; c < K; c++) { int o = open_count(s, c); if (o > 0 && held[c] == o) n++; }
  return n;
}

// reinforcementsFor(p).total: max(3, territories / 3) + continent bonuses + 2 per capital held (capitals on)
__device__ int reinforcements(S& s, int p) {
  int cnt = 0;
  int held[K];
  for (int c = 0; c < K; c++) held[c] = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == p) { cnt++; held[CONT_OF[t]]++; }
  int tot = cnt / 3;
  if (tot < 3) tot = 3;
  for (int c = 0; c < K; c++) { int o = open_count(s, c); if (o > 0 && held[c] == o) tot += CBONUS[c]; }
  if (OPT_CAPITALS) for (int q = 0; q < NS; q++) { int t = (int)s.capital[q]; if (t >= 0 && s.owner[t] == p) tot += 2; }
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

// tradeSet: the set's value, the counters, the cards to the discard pile, +2 on the first card showing an owned territory
__device__ void trade_set(S& s, int p, int i, int j, int k, bool by_id) {
  i64* h = s.hand + p * H;
  int c[3] = {(int)h[i], (int)h[j], (int)h[k]};
  if (by_id) {
    if (c[0] > c[1]) { int x = c[0]; c[0] = c[1]; c[1] = x; }
    if (c[1] > c[2]) { int x = c[1]; c[1] = c[2]; c[2] = x; }
    if (c[0] > c[1]) { int x = c[0]; c[0] = c[1]; c[1] = x; }
  }
  s.atp[p] += set_value(s, p, ckind(c[0]), ckind(c[1]), ckind(c[2]));
  *s.trade_count += 1;
  s.trades_made[p] += 1;
  remove_hand(s, p, i, j, k);
  for (int q = 0; q < 3; q++) s.discard[(*s.discard_n)++] = c[q];
  for (int q = 0; q < 3; q++) {
    int t = cterr(c[q]);
    if (t >= 0 && s.owner[t] == p) { s.armies[t] += 2; break; }
  }
}

// engine.ts autoTrade + bestSet: the most armies, then a card showing an owned territory, then fewest wilds, then first
__device__ void auto_trade(S& s, int p) {
  while (s.hand_n[p] >= 5) {
    int n = (int)s.hand_n[p];
    i64* h = s.hand + p * H;
    long long best = -1;
    int bi = 0, bj = 0, bk = 0;
    for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) for (int k = j + 1; k < n; k++) {
      int c0 = (int)h[i], c1 = (int)h[j], c2 = (int)h[k];
      int k0 = ckind(c0), k1 = ckind(c1), k2 = ckind(c2);
      if (!valid_set(k0, k1, k2)) continue;
      int t0 = cterr(c0), t1 = cterr(c1), t2 = cterr(c2);
      int bonus = (t0 >= 0 && s.owner[t0] == p) || (t1 >= 0 && s.owner[t1] == p) || (t2 >= 0 && s.owner[t2] == p);
      int wilds = (k0 == 3) + (k1 == 3) + (k2 == 3);
      long long key = (long long)set_value(s, p, k0, k1, k2) * 16 + bonus * 4 + 3 - wilds;
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

__device__ __forceinline__ bool owns_any(S& s, int p) {
  for (int t = 0; t < T; t++) if (s.owner[t] == p) return true;
  return false;
}

// nextCapitalPicker: position in turn order of the first living player with territories and no capital, or -1
__device__ int next_capital_picker(S& s) {
  for (int i = 0; i < NS; i++) {
    int q = (int)s.order[i];
    if (s.alive[q] && s.capital[q] < 0 && owns_any(s, q)) return i;
  }
  return -1;
}

// assignCapitals: in seating order, each player's most garrisoned territory (ties: first in map order), +3 armies
__device__ void assign_capitals(S& s) {
  for (int q = 0; q < NS; q++) {
    if (!s.alive[q] || s.capital[q] >= 0) continue;
    int best = -1;
    for (int t = 0; t < T; t++) if (s.owner[t] == q && (best < 0 || s.armies[t] > s.armies[best])) best = t;
    if (best < 0) continue;
    s.capital[q] = best;
    s.armies[best] += 3;
  }
}

__device__ void begin_first_turn(S& s) {
  *s.turn = 0;
  *s.round = 1;
  if (OPT_CAPITALS) {
    bool none = true;
    for (int q = 0; q < NS; q++) if (s.capital[q] >= 0) none = false;
    if (none) {
      if (OPT_CHOOSE_CAPITALS) {
        int pk = next_capital_picker(s);
        if (pk >= 0) { *s.phase = CAPITALS; *s.cur_pos = pk; return; }
      }
      assign_capitals(s);
    }
  }
  for (int i = 0; i < NS; i++) if (s.alive[s.order[i]]) { begin_turn(s, i); return; }
}

__device__ void choose_capital(S& s, int t) {
  int p = cur(s);
  s.capital[p] = t;
  s.armies[t] += 3;
  int pk = next_capital_picker(s);
  if (pk >= 0) { *s.cur_pos = pk; return; }
  begin_first_turn(s);
}

// distributeEvenly: the player's remaining armies one by one over their territories (map order) from a random start.
// Draws the start even with nothing left to place, as the engine does.
__device__ void distribute_evenly(S& s, int p, i64* rng) {
  int owned[T], n = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == p) owned[n++] = t;
  if (n == 0) { s.atp[p] = 0; return; }
  int i = mb_int(rng, n);
  while (s.atp[p] > 0) { s.armies[owned[i % n]] += 1; s.atp[p] -= 1; i++; }
}

// distributeRandomly (autoSetup): each remaining army on a uniformly random territory of the player's
__device__ void distribute_randomly(S& s, int p, i64* rng) {
  int owned[T], n = 0;
  for (int t = 0; t < T; t++) if (s.owner[t] == p) owned[n++] = t;
  if (n == 0) { s.atp[p] = 0; return; }
  while (s.atp[p] > 0) { s.armies[owned[mb_int(rng, n)]] += 1; s.atp[p] -= 1; }
}

__device__ __forceinline__ bool any_unclaimed(S& s) {
  for (int t = 0; t < T; t++) if (s.owner[t] < 0 && !s.bliz[t]) return true;
  return false;
}

__device__ void advance_setup(S& s) {
  if (HAS_NEUTRAL && s.atp[NEU] > 0 && !any_unclaimed(s)) distribute_evenly(s, NEU, s.rng);
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
__device__ void shuffle_int(int* arr, int n, i64* rng) {
  for (int i = n - 1; i > 0; i--) {
    int j = mb_int(rng, i + 1);
    int x = arr[i]; arr[i] = arr[j]; arr[j] = x;
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

// rollBattle as a full blitz (stopAt 1): armies left on both sides and the attacker's dice in the last roll
__device__ void blitz(i64* rng, int fa, int ta, int dlim, int* ofa, int* ota, int* olast) {
  int last = 0;
  while (fa >= 2 && ta > 0) {
    int ad = fa - 1 < 3 ? fa - 1 : 3, dd = ta < dlim ? ta : dlim;
    int a[3] = {0, 0, 0}, d[3] = {0, 0, 0};
    for (int q = 0; q < ad; q++) a[q] = 1 + mb_int(rng, 6);
    for (int q = 0; q < dd; q++) d[q] = 1 + mb_int(rng, 6);
    if (a[0] < a[1]) { int x = a[0]; a[0] = a[1]; a[1] = x; }
    if (a[1] < a[2]) { int x = a[1]; a[1] = a[2]; a[2] = x; }
    if (a[0] < a[1]) { int x = a[0]; a[0] = a[1]; a[1] = x; }
    if (d[0] < d[1]) { int x = d[0]; d[0] = d[1]; d[1] = x; }
    if (d[1] < d[2]) { int x = d[1]; d[1] = d[2]; d[2] = x; }
    if (d[0] < d[1]) { int x = d[0]; d[0] = d[1]; d[1] = x; }
    int pairs = ad < dd ? ad : dd;
    for (int q = 0; q < pairs; q++) { if (a[q] > d[q]) ta--; else fa--; }
    last = ad;
  }
  *ofa = fa; *ota = ta; *olast = last;
}

__device__ void attack(S& s, int e) {
  int from = EFROM[e], to = ETO[e], p = cur(s);
  int dlim = OPT_CAPITALS && is_capital(s, to) ? 3 : 2;
  int fa, ta, last;
  if (BALANCED) {
    // balanced blitz: 5 full blitzes with real dice, the median run (stable sort by how well it went) is played
    int rf[5], rt[5], rl[5];
    long long sc[5];
    for (int r = 0; r < 5; r++) {
      blitz(s.rng, (int)s.armies[from], (int)s.armies[to], dlim, &rf[r], &rt[r], &rl[r]);
      sc[r] = rt[r] == 0 ? 1000000LL + rf[r] : -(long long)rt[r];
    }
    int pick = 0;
    for (int r = 0; r < 5; r++) {
      int rank = 0;
      for (int q = 0; q < 5; q++) if (sc[q] < sc[r] || (sc[q] == sc[r] && q < r)) rank++;
      if (rank == 2) pick = r;
    }
    fa = rf[pick]; ta = rt[pick]; last = rl[pick];
  } else {
    blitz(s.rng, (int)s.armies[from], (int)s.armies[to], dlim, &fa, &ta, &last);
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
  s.elim_by[def] = p;  // eliminatedBy, and the elimination order (finalPlacements)
  s.elim_seq[def] = (*s.elim_n)++;
  int dn = (int)s.hand_n[def];
  if (dn > 0) {
    for (int q = 0; q < dn; q++) append_hand(s, p, s.hand[def * H + q]);
    for (int q = 0; q < dn; q++) s.hand[def * H + q] = -1;
    s.hand_n[def] = 0;
    auto_trade(s, p);
  }
}

// doOccupy + checkVictory: one real player left, or (capitals) every capital held by the mover
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
  if (alive == 1) { *s.phase = FINISHED; *s.winner = who; return; }
  if (OPT_CAPITALS) {
    int p = cur(s), ncap = 0;
    bool all = true;
    for (int q = 0; q < NS; q++) {
      int t = (int)s.capital[q];
      if (t < 0) continue;
      ncap++;
      if (s.owner[t] != p) all = false;
    }
    if (ncap > 1 && all) { *s.phase = FINISHED; *s.winner = p; }
  }
}

__device__ void place(S& s, int t, int slot) {
  int p = cur(s);
  int a = (int)s.atp[p], ph = (int)*s.phase;
  if (ph == SETUP && s.owner[t] < 0) {  // claiming phase: one army on an unclaimed territory
    s.owner[t] = p;
    s.armies[t] = 1;
    s.atp[p] = a - 1;
    advance_setup(s);
    return;
  }
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
  else if (a == END) end_turn(s);
  else choose_capital(s, a - CAP);
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

// An owned neighbour of t (adjacent fortify).
__device__ __forceinline__ bool own_neighbour(S& s, int t, int me) {
  for (int k = 0; k < DEG[t]; k++) if (s.owner[NBR[t][k]] == me) return true;
  return false;
}

// candidates() of actions.ts over the fixed action space; returns how many moves are legal.
__device__ int legal(S& s, u8* m) {
  for (int a = 0; a < A; a++) m[a] = 0;
  if (*s.done) return 0;
  int me = cur(s), ph = (int)*s.phase, atp = (int)s.atp[me], hn = (int)s.hand_n[me], cnt = 0;
  if (ph == CAPITALS) {
    for (int t = 0; t < T; t++) if (s.owner[t] == me && !is_capital(s, t)) { m[CAP + t] = 1; cnt++; }
    return cnt;
  }
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
    int fmax = (int)s.armies[src] - 1;
    bool ok0 = fmax >= 1, ok1 = (fmax + 1) / 2 != fmax;
    if (FORT_ADJ) {
      for (int k = 0; k < DEG[src]; k++) {
        int t = NBR[src][k];
        if (s.owner[t] != me) continue;
        if (ok0) { m[FTO + 2 * t] = 1; cnt++; }
        if (ok1) { m[FTO + 2 * t + 1] = 1; cnt++; }
      }
      return cnt;
    }
    components(s, lab, size);
    for (int t = 0; t < T; t++) if (t != src && lab[t] == lab[src] && s.owner[t] == me) {
      if (ok0) { m[FTO + 2 * t] = 1; cnt++; }
      if (ok1) { m[FTO + 2 * t + 1] = 1; cnt++; }
    }
    return cnt;
  }
  if (ph == SETUP && any_unclaimed(s)) {  // claiming phase: one army on any unclaimed territory
    for (int t = 0; t < T; t++) if (s.owner[t] < 0 && !s.bliz[t]) { m[3 * t] = 1; cnt++; }
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
      for (int k = 0; k < DEG[t]; k++) { int n = NBR[t][k]; if (s.owner[n] != me && !s.bliz[n]) { m[ATTACK + EBASE[t] + k] = 1; cnt++; } }
  }
  if ((att || fph) && !*s.fortified) {
    if (FORT_ADJ) {
      for (int t = 0; t < T; t++) if (s.owner[t] == me && s.armies[t] >= 2 && own_neighbour(s, t, me)) { m[FFROM + t] = 1; cnt++; }
    } else {
      components(s, lab, size);
      for (int t = 0; t < T; t++) if (s.owner[t] == me && s.armies[t] >= 2 && size[t] >= 2) { m[FFROM + t] = 1; cnt++; }
    }
  }
  if (att || fph) { m[END] = 1; cnt++; }
  return cnt;
}

// openNetworkConnected: every open territory reachable from the first open one
__device__ bool open_connected(const u8* blocked) {
  u8 seen[T];
  int stack[T], sp = 0, first = -1, nopen = 0, nseen = 0;
  for (int t = 0; t < T; t++) { seen[t] = 0; if (!blocked[t]) { nopen++; if (first < 0) first = t; } }
  if (first < 0) return false;
  seen[first] = 1; stack[sp++] = first; nseen = 1;
  while (sp) {
    int u = stack[--sp];
    for (int k = 0; k < DEG[u]; k++) { int v = NBR[u][k]; if (!blocked[v] && !seen[v]) { seen[v] = 1; nseen++; stack[sp++] = v; } }
  }
  return nseen == nopen;
}

// pickBlizzards: territories in a shuffled order, each kept if its continent keeps 2 open and the open map stays connected
__device__ void pick_blizzards(S& s, i64* st) {
  int sh[T];
  u8 chosen[T];
  for (int t = 0; t < T; t++) { sh[t] = t; chosen[t] = 0; }
  shuffle_int(sh, T, st);
  int cnt = 0;
  for (int i = 0; i < T; i++) {
    if (cnt >= NBLIZ) break;
    int t = sh[i], c = CONT_OF[t], others = 0;
    for (int q = 0; q < CSIZE[c]; q++) { int x = CMEM[c][q]; if (x != t && !chosen[x]) others++; }
    if (others < 2) continue;
    chosen[t] = 1; cnt++;
    if (!open_connected(chosen)) { chosen[t] = 0; cnt--; }
  }
  for (int t = 0; t < T; t++) s.bliz[t] = chosen[t];
}

// createGame(seed) + addPlayer per seat + startGame (engine.ts), every setting of this configuration.
__device__ void reset_game(S& s, unsigned int seed) {
  i64 st = (i64)seed;
  for (int i = 0; i < NS; i++) s.order[i] = i;
  shuffle(s.order, NS, &st);
  for (int i = 0; i < NC; i++) s.deck[i] = i;
  shuffle(s.deck, NC, &st);
  for (int t = 0; t < T; t++) { s.owner[t] = -1; s.armies[t] = 0; s.bliz[t] = 0; }
  for (int q = 0; q < NS; q++) s.capital[q] = -1;
  if (NBLIZ > 0) pick_blizzards(s, &st);
  int list[T], L = 0;
  for (int t = 0; t < T; t++) if (!s.bliz[t]) list[L++] = t;  // playable, map order
  for (int p = 0; p < P; p++) { s.alive[p] = 1; s.hand_n[p] = 0; s.trades_made[p] = 0; for (int h = 0; h < H; h++) s.hand[p * H + h] = -1; }
  s.alive[NEU] = HAS_NEUTRAL;
  for (int p = 0; p < P; p++) { s.elim_by[p] = -1; s.elim_seq[p] = -1; }
  *s.elim_n = 0;
  for (int q = 0; q < NS; q++) s.atp[q] = START_ARMIES;
  s.atp[NEU] = HAS_NEUTRAL && NEUTRAL_TERR == 0 ? START_ARMIES : 0;
  if (NEUTRAL_TERR > 0) {  // neutral territories set aside at random from the playable ones, each with a fixed garrison
    int sh[T];
    for (int i = 0; i < L; i++) sh[i] = list[i];
    shuffle_int(sh, L, &st);
    int k = NEUTRAL_TERR < L - NS ? NEUTRAL_TERR : L - NS;
    for (int i = 0; i < k; i++) { s.owner[sh[i]] = NEU; s.armies[sh[i]] = NEUTRAL_ARMIES; }
    int w = 0;
    for (int i = 0; i < L; i++) if (s.owner[list[i]] != NEU) list[w++] = list[i];
    L = w;  // dealable
  }
  if (RANDOM_DEAL) {
    shuffle_int(list, L, &st);
    int k = NS + (NS == 2 ? 1 : 0);  // the deal order: turn order, plus the classic Neutral at 2 players
    for (int i = 0; i < L; i++) {
      int d = i % k;
      int who = d < NS ? (int)s.order[d] : NEU;
      s.owner[list[i]] = who;
      s.armies[list[i]] = 1;
      s.atp[who] -= 1;
    }
    if (HAS_NEUTRAL) distribute_evenly(s, NEU, &st);
  }
  *s.trade_count = 0; *s.deck_n = NC; *s.discard_n = 0; *s.cur_pos = 0; *s.phase = SETUP; *s.turn = 0; *s.round = 0;
  *s.pend_from = -1; *s.pend_to = -1; *s.pend_min = 0; *s.pend_max = 0; *s.conquered = 0; *s.fortified = 0;
  *s.fort_src = -1; *s.winner = -1; *s.done = 0;
  if (AUTO_SETUP) {
    for (int q = 0; q < NS; q++) distribute_randomly(s, q, &st);
    *s.rng = st;
    begin_first_turn(s);
    return;
  }
  *s.rng = st;
  bool all0 = true;
  for (int p = 0; p < P; p++) if ((p < NS || HAS_NEUTRAL) && s.atp[p] != 0) all0 = false;
  if (all0) begin_first_turn(s);
}

// The legal moves in actions.ts candidate order (capitals, trades, placements, attacks, occupy, fortify sources, end
// turn; fortify destinations in legalMoves' order: the engine's connected search, or adjacency order with adjacent
// fortify). Returns how many; o[i] = action index.
__device__ int ordered_moves(S& s, u8* m, i64* o) {
  int n = legal(s, m), k = 0;
  if (*s.fort_src >= 0 && n > 0 && FORT_ADJ) {
    int src = (int)*s.fort_src;
    for (int q = 0; q < DEG[src]; q++) {
      int v = NBR[src][q];
      for (int sl = 0; sl < 2; sl++) if (m[FTO + 2 * v + sl]) o[k++] = FTO + 2 * v + sl;
    }
  } else if (*s.fort_src >= 0 && n > 0) {
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
  } else {
    for (int a = CAP; a < A; a++) if (m[a]) o[k++] = a;
    for (int a = TRADE; a < ATTACK; a++) if (m[a]) o[k++] = a;
    for (int a = 0; a < TRADE; a++) if (m[a]) o[k++] = a;
    for (int a = ATTACK; a < CAP; a++) if (m[a]) o[k++] = a;
  }
  return k;
}

// A move as the decision log's candidate: [kind (CANDIDATE_KINDS index), x, y, z] (place t n, trade ids sorted,
// capital t, attack from to, occupy n, end_turn, fortify_from t, fortify_to t n).
__device__ void cand_tuple(S& s, int a, int* c) {
  c[1] = 0; c[2] = 0; c[3] = 0;
  int me = cur(s);
  if (a < TRADE) {
    int t = a / 3, sl = a % 3, atp = (int)s.atp[me], ph = (int)*s.phase;
    int lim = ph == SETUP ? (atp < SETUP_BATCH ? atp : SETUP_BATCH) : atp;
    int n = (ph == SETUP && s.owner[t] < 0) ? 1 : (sl == 0 ? lim : (sl == 1 ? (lim + 1) / 2 : 1));
    c[0] = 0; c[1] = t; c[2] = n;
  } else if (a < ATTACK) {
    int k = a - TRADE;
    i64* h = s.hand + me * H;
    int x = (int)h[TRI5[k][0]], y = (int)h[TRI5[k][1]], z = (int)h[TRI5[k][2]], w;
    if (x > y) { w = x; x = y; y = w; }
    if (y > z) { w = y; y = z; z = w; }
    if (x > y) { w = x; x = y; y = w; }
    c[0] = 1; c[1] = x; c[2] = y; c[3] = z;
  } else if (a < OCCUPY) {
    c[0] = 3; c[1] = EFROM[a - ATTACK]; c[2] = ETO[a - ATTACK];
  } else if (a < FFROM) {
    int mx = (int)*s.pend_max, mn = (int)*s.pend_min, mid = (mx + 1) / 2, sl = a - OCCUPY;
    if (mid < mn) mid = mn;
    c[0] = 4; c[1] = sl == 0 ? mx : (sl == 1 ? mid : mn);
  } else if (a < FTO) {
    c[0] = 7; c[1] = a - FFROM;
  } else if (a < END) {
    int t = (a - FTO) / 2, sl = (a - FTO) % 2, mx = (int)s.armies[*s.fort_src] - 1;
    c[0] = 8; c[1] = t; c[2] = sl == 0 ? mx : (mx + 1) / 2;
  } else if (a == END) {
    c[0] = 6;
  } else {
    c[0] = 2; c[1] = a - CAP;
  }
}

extern "C" __global__ void k_cand_order(STATE_ARGS, i64* ord, i64* cnt, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  u8 m[A];
  cnt[b] = ordered_moves(s, m, ord + (i64)b * A);
}

// ordered_moves plus each move as a candidate tuple (tup[b, i, 0..3], up to W per game; cnt may exceed W).
extern "C" __global__ void k_cand_tuples(STATE_ARGS, i64* ord, int* tup, i64* cnt, int B, int W) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  u8 m[A];
  i64* o = ord + (i64)b * A;
  int n = ordered_moves(s, m, o);
  cnt[b] = n;
  for (int i = 0; i < n && i < W; i++) cand_tuple(s, (int)o[i], tup + ((i64)b * W + i) * 4);
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
  if (action[b] < 0) return;  // no move for this game this step
  MAKE_S(b);
  apply(s, (int)action[b], max_turns);
}

extern "C" __global__ void k_reset(STATE_ARGS, i64* seeds, u8* which, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B || !which[b]) return;
  MAKE_S(b);
  reset_game(s, (unsigned int)seeds[b]);
}

// Every seat's reinforcementsFor(seat).total (out[b, seat]) and continents held (out2[b, seat]).
extern "C" __global__ void k_income(STATE_ARGS, i64* out, i64* out2, int B) {
  int b = blockIdx.x * blockDim.x + threadIdx.x;
  if (b >= B) return;
  MAKE_S(b);
  for (int q = 0; q < NS; q++) { out[(i64)b * NS + q] = reinforcements(s, q); out2[(i64)b * NS + q] = continents_held(s, q); }
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


def compile_kernels(src: str, names, options: list[str] | None = None) -> dict:
    """Compile `names` from `src` with NVRTC (cached per source). `options` go to NVRTC, e.g. --fmad=false so double
    arithmetic rounds exactly like JavaScript's (no fused multiply-adds)."""
    key = (src, tuple(names), tuple(options or ()))
    if key in _cache:
        return _cache[key]
    import torch.utils.cpp_extension as cpp

    if cpp.CUDA_HOME is None:  # NVRTC needs no headers here; torch only wants an include dir to pass along
        (_INCLUDE_STUB / "include").mkdir(parents=True, exist_ok=True)
        cpp.CUDA_HOME = str(_INCLUDE_STUB)
        os.environ.setdefault("CUDA_HOME", str(_INCLUDE_STUB))
    # One NVRTC compile for all the (extern "C") kernels of a source, the binary cached on disk by source hash.
    import hashlib

    from torch.cuda._utils import _cuda_load_module, _nvrtc_compile

    cc = "".join(map(str, torch.cuda.get_device_capability()))
    h = hashlib.sha256("\0".join([src, *(options or ()), cc, torch.__version__]).encode()).hexdigest()[:24]
    disk = _INCLUDE_STUB.parent / "_cache" / f"kernels-{h}.cubin"
    if disk.exists():
        binary = disk.read_bytes()
    else:
        binary, _ = _nvrtc_compile(src, names[0], None, None, list(options or []))
        disk.parent.mkdir(exist_ok=True)
        disk.write_bytes(binary)
    ks = _cuda_load_module(binary, list(names))
    _cache[key] = ks
    return ks


RULE_KERNELS = ("k_legal", "k_step", "k_reset", "k_income", "k_random_play", "k_cand_order", "k_cand_tuples")


class FusedEngine(State):
    """The rules as CUDA kernels for any configuration (cfg: GameConfig; default Classic 2-player)."""

    BLOCK = 128
    MIRROR = "fused.py"

    def __init__(self, B: int, cfg=None, compile_rules: bool = True, **kw):
        super().__init__(B, cfg, **kw)
        self.k = compile_kernels(_source(self), RULE_KERNELS) if compile_rules else None
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

    def cand_order(self) -> tuple[torch.Tensor, torch.Tensor]:
        """Legal moves in actions.ts candidate order: ord[b, :cnt[b]]."""
        ord_ = torch.full((self.B, self.L.A), -1, dtype=torch.long, device=self.dev)
        cnt = torch.zeros(self.B, dtype=torch.long, device=self.dev)
        self._launch("k_cand_order", ord_, cnt, self.B)
        return ord_, cnt

    def cand_tuples(self, W: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """cand_order() plus each move as the log's candidate tuple [kind, x, y, z] (int32 [B, W, 4])."""
        ord_ = torch.full((self.B, self.L.A), -1, dtype=torch.long, device=self.dev)
        cnt = torch.zeros(self.B, dtype=torch.long, device=self.dev)
        tup = torch.zeros(self.B, W, 4, dtype=torch.int32, device=self.dev)
        self._launch("k_cand_tuples", ord_, tup, cnt, self.B, W)
        return ord_, tup, cnt

    def income_and_continents(self) -> tuple[torch.Tensor, torch.Tensor]:
        out = torch.empty(self.B, self.n, dtype=torch.long, device=self.dev)
        out2 = torch.empty(self.B, self.n, dtype=torch.long, device=self.dev)
        self._launch("k_income", out, out2, self.B)
        return out, out2

    def income(self) -> torch.Tensor:
        return self.income_and_continents()[0]

    def play_random(self, steps: int, stats: torch.Tensor, seed_counter: torch.Tensor, seed_base: int = 0x9E3779B9):
        """`steps` random-move decisions in every game, restarting finished games; stats (uint64 [4]) accumulates
        finished games, their decisions, their turns and how many had a winner."""
        self._launch("k_random_play", self.agent_rng, self.dec, stats, seed_counter, self.B, steps, self.max_turns, seed_base & 0x7FFFFFFF)
