"""Replay logged self-play games through the GPU engine and check it plays exactly the same game.

For every decision step of every game: the board (owners, armies), every seat's alive flag, card count, armies to
place and income, the decider's hand (ids, in order), the trade count, the pending conquest, the conquered and
fortified flags, turn order, phase, turn and round must equal the logged record, and the GPU engine's legal moves
must be exactly the record's candidate list (as a set). Then the logged choice is played. The GPU engine draws its
dice and shuffles from the same seeded mulberry32 stream as the TypeScript engine, so it rolls the engine's dice.
When a game's records end, the GPU game must be over the same way (same winner, or the turn limit).

With --fused the CUDA-kernel engine (fused.py) is replayed instead of the tensor engine (engine.py, Classic 2-player
with the default settings only). Every map, table size and covered setting replays through fused.py: the game settings
come from `options.json` in the log dir (written by tests/matrix.py; the engine's defaults when absent), the map and
the table size from the records.
With --net AGENT PT the GPU network's top move is compared with AGENT's logged choices.
With --teacher AGENT[=PARAMS.json] (repeatable) the GPU teacher (teacher.py, with that version's tuned numbers; none =
the defaults: delove-teacher@1's, or jacob-sensei@1's for jacob-sensei@1 and DEFAULT_JACOB_PARAMS for later Jacobs) must pick AGENT's logged candidate at every step AGENT decided, drawing its tie-break jitter from
the seat's own stream as playGame seeds it.
With --export DIR (an `npm run delove -- export` of the same log), the GPU encoder's features are checked too.

    python tests/replay.py runs/gpu-verify/tt [more log dirs] [--batch 500] [--max-turns 500] [--export DIR]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.config import GameConfig  # noqa: E402
from delove_gpu.engine import Engine  # noqa: E402
from delove_gpu.logs import Snapshot, cand_to_action, finished_ok, first_diff, games, record_view  # noqa: E402


class EncoderCheck:
    """Compares the GPU encoder with the arrays `export` wrote from the same records (row k = k-th record)."""

    def __init__(self, export_dir: str, map_id: str = "classic"):
        d = Path(export_dir) / map_id
        self.territory = np.load(d / "territory.npy", mmap_mode="r")
        self.glob = np.load(d / "global.npy", mmap_mode="r")
        self.cand = np.load(d / "cand.npy", mmap_mode="r")
        self.cand_from = np.load(d / "cand_from.npy", mmap_mode="r")
        self.cand_to = np.load(d / "cand_to.npy", mmap_mode="r")
        self.offset = np.load(d / "cand_offset.npy", mmap_mode="r")
        self.max_err = {"territory": 0.0, "global": 0.0, "cand": 0.0}
        self.checked = 0
        self.index_mismatch = 0

    def check(self, feats, b: int, row: int, actions: list[int]) -> str | None:
        tf, gf, cf, cfrom, cto = feats
        for name, mine, ref in [("territory", tf[b], self.territory[row]), ("global", gf[b], self.glob[row])]:
            err = float(np.abs(mine - ref).max())
            self.max_err[name] = max(self.max_err[name], err)
            if err > 1e-5:
                i = np.unravel_index(np.abs(mine - ref).argmax(), mine.shape)
                return f"{name} feature {i}: gpu {mine[i]} vs ts {ref[i]}"
        lo, hi = int(self.offset[row]), int(self.offset[row + 1])
        a = np.array(actions)
        err = float(np.abs(cf[b, a] - self.cand[lo:hi]).max()) if len(a) else 0.0
        self.max_err["cand"] = max(self.max_err["cand"], err)
        if err > 1e-5:
            return f"candidate features differ by {err}"
        if not (np.array_equal(cfrom[b, a], self.cand_from[lo:hi]) and np.array_equal(cto[b, a], self.cand_to[lo:hi])):
            return "candidate from/to differ"
        self.checked += 1
        return None


def replay_batch(recs: list[list[dict]], max_turns: int, device: str, enc: EncoderCheck | None, row0: int, stats: dict, net=None, fused: bool = False,
                 cfg: GameConfig | None = None, teachers: dict | None = None) -> int:
    """Replay a batch of games; returns the export row after them."""
    from delove_gpu.encode import Encoder  # noqa: F401
    from delove_gpu.play import NetPlayer

    B = len(recs)
    if teachers:
        from delove_gpu.teacher import TeacherEngine, params_tensor

        e = TeacherEngine(B, cfg, device=device, max_turns=max_turns, allow_unverified=True)
        tprm = {a: params_tensor(p, e.dev) for a, p in teachers.items()}
    elif fused:
        from delove_gpu.fused import FusedEngine

        e = FusedEngine(B, cfg, device=device, max_turns=max_turns, allow_unverified=True)
    else:
        e = Engine(B, cfg, device=device, max_turns=max_turns, allow_unverified=True)
    e.reset(torch.arange(B, device=e.dev), torch.tensor([g[0]["seed"] for g in recs]))
    if teachers:
        e.seat_streams(torch.arange(B, device=e.dev), torch.tensor([g[0]["seed"] for g in recs]))
    encoder = Encoder(e) if enc else None
    player = NetPlayer(e, net[1]) if net else None
    lens = [len(g) for g in recs]
    # export row of each game's first record
    rows = np.cumsum([0] + lens)[:-1] + row0
    failed = [False] * B
    for i in range(max(lens)):
        mask = e.legal()
        snap = Snapshot(e)
        mask_np = mask.cpu().numpy()
        feats = None
        if encoder:
            out = encoder.encode_dense()
            feats = tuple(x.cpu().numpy() for x in out)
        lg_np = player.logits(mask).cpu().numpy() if player else None
        picks = {}
        if teachers:
            for agent, prm in tprm.items():
                act = torch.tensor([i < lens[b] and not failed[b] and recs[b][i]["agent"] == agent for b in range(B)], device=e.dev)
                if bool(act.any()):
                    picks[agent] = e.teacher(act, prm=prm).cpu().numpy()
        top = lg_np.argmax(1) if player else None
        action = torch.zeros(B, dtype=torch.long)
        fixes = []
        for b in range(B):
            if failed[b]:
                continue
            if i == lens[b]:
                why = finished_ok(snap, b, recs[b][-1]["outcome"], max_turns)
                if why:
                    failed[b] = True
                    stats["fail"].append(f"{recs[b][0]['game']} (seed {recs[b][0]['seed']}) end: {why}")
                continue
            if i > lens[b]:
                continue
            r = recs[b][i]
            why = None
            if snap.done[b]:
                why = "gpu game already over"
            else:
                why = first_diff(record_view(r), snap.encoded(b))
            acts = None
            if not why:
                acts = [cand_to_action(e, snap, b, c) for c in r["cands"]]
                legal = np.flatnonzero(mask_np[b])
                if -1 in acts or len(set(acts)) != len(acts) or sorted(acts) != legal.tolist():
                    why = f"legal moves differ: engine {len(r['cands'])} candidates, gpu {len(legal)}; " + _cand_diff(e, snap, b, r["cands"], acts, legal)
            if not why and enc:
                why = enc.check(feats, b, rows[b] + i, acts)
            if why:
                failed[b] = True
                stats["fail"].append(f"{r['game']} (seed {r['seed']}) step {i} turn {r['turn']} phase {r['phase']}: {why}")
                continue
            if r["agent"] in picks:
                stats["teacher_checked"] += 1
                pk = int(picks[r["agent"]][b])
                if pk != acts[r["choice"]]:
                    stats["teacher_mismatch"] += 1
                    failed[b] = True
                    gi = acts.index(pk) if pk in acts else -1
                    stats["fail"].append(f"{r['game']} (seed {r['seed']}) step {i} turn {r['turn']} phase {r['phase']}: {r['agent']} picks candidate {gi} "
                                         f"({r['cands'][gi] if gi >= 0 else pk}), log has {r['choice']} ({r['cands'][r['choice']]}) of {len(acts)}")
                    continue
            stats["steps"] += 1
            action[b] = acts[r["choice"]]
            if r["cands"][r["choice"]][0] == "trade":
                fix = _trade_order_fix(e, snap, b, acts[r["choice"]], r)
                if fix:
                    fixes.append((b, *fix))
            if player and r["agent"] == net[0] and len(acts) > 1:
                stats["net_total"] += 1
                agree = top[b] == acts[r["choice"]]
                stats["net_agree"] += int(agree)
                if not agree:
                    gap = float(lg_np[b, top[b]] - lg_np[b, acts[r["choice"]]])
                    stats["net_gaps"].append(gap)
                    stats["net_near"] += int(gap < NEAR_TIE)
        e.step(action.to(e.dev))
        for b, t_sorted, t_hand, cards in fixes:
            if t_sorted != t_hand:
                e.armies[b, t_sorted] -= 2
                e.armies[b, t_hand] += 2
            dn = int(e.discard_n[b])
            e.discard[b, dn - 3:dn] = torch.tensor(cards, device=e.dev)
            stats["trade_order"] += 1
    # games whose last record was the very last step
    snap = Snapshot(e)
    for b in range(B):
        if not failed[b] and lens[b] == max(lens):
            why = finished_ok(snap, b, recs[b][-1]["outcome"], max_turns)
            if why:
                failed[b] = True
                stats["fail"].append(f"{recs[b][0]['game']} (seed {recs[b][0]['seed']}) end: {why}")
    stats["games"] += B
    stats["ok_games"] += B - sum(failed)
    return row0 + sum(lens)


def replay_batch_fast(recs: list[list[dict]], max_turns: int, device: str, stats: dict, cfg: GameConfig, teachers: dict | None = None):
    """replay_batch without the encoder and network checks, vectorised (delove_gpu/packed.py): the same state fields,
    and the candidate list compared in order (the GPU's legal moves in actions.ts order against the logged list)."""
    from delove_gpu.fused import FusedEngine
    from delove_gpu.outcome import game_outcome
    from delove_gpu.packed import cand_rows, field_name, pack_record, pack_states

    B = len(recs)
    if teachers:
        from delove_gpu.teacher import TeacherEngine, params_tensor

        e = TeacherEngine(B, cfg, device=device, max_turns=max_turns, allow_unverified=True)
        tprm = {a: params_tensor(p, e.dev) for a, p in teachers.items()}
    else:
        e = FusedEngine(B, cfg, device=device, max_turns=max_turns, allow_unverified=True)
    g = torch.arange(B, device=e.dev)
    seeds = torch.tensor([r[0]["seed"] for r in recs])
    e.reset(g, seeds)
    if teachers:
        e.seat_streams(g, seeds)
    H, n, T = e.H, e.n, e.m.T
    packed = [np.stack([pack_record(r, H) for r in game]) for game in recs]
    cands = [[cand_rows(r["cands"]) for r in game] for game in recs]
    lens = [len(x) for x in recs]
    failed = [False] * B
    card_terr = e.m.card_terr.cpu().numpy()
    hand_off = 13 + 7 * n
    own_off = hand_off + H

    def fail(b, i, why):
        failed[b] = True
        r = recs[b][min(i, lens[b] - 1)]
        stats["fail"].append(f"{r['game']} (seed {r['seed']}) step {i} turn {r['turn']} phase {r['phase']}: {why}")

    for i in range(max(lens) + 1):
        live = [b for b in range(B) if not failed[b] and i <= lens[b]]
        if not live:
            break
        st = pack_states(e).cpu().numpy()
        done = e.done.cpu().numpy()
        phase, turn, winner = e.phase.cpu().numpy(), e.turn.cpu().numpy(), e.winner.cpu().numpy()
        act = [b for b in live if i < lens[b]]
        Wc = max([len(cands[b][i]) for b in act], default=1) + 1
        ord_, tup, cnt = e.cand_tuples(Wc)
        picks = {}
        if teachers:
            for agent, prm in tprm.items():
                m = torch.zeros(B, dtype=torch.bool)
                for b in act:
                    if recs[b][i]["agent"] == agent:
                        m[b] = True
                if bool(m.any()):
                    picks[agent] = e.teacher(m.to(e.dev), prm=prm).cpu().numpy()
        choice = torch.zeros(B, dtype=torch.long)
        for b in act:
            choice[b] = recs[b][i]["choice"]
        action = ord_.gather(1, choice.to(e.dev)[:, None]).squeeze(1).cpu().numpy()
        tup = tup.cpu().numpy()
        cnt = cnt.cpu().numpy()
        step = np.full(B, -1, dtype=np.int64)
        fixes = []
        for b in live:
            if i == lens[b]:  # after the last record: the GPU game must be over the same way
                out = recs[b][-1]["outcome"]
                if out["winner"] is None:
                    ok = done[b] and phase[b] != 6 and turn[b] >= max_turns
                else:
                    ok = phase[b] == 6 and winner[b] == out["winner"]
                if not ok:
                    fail(b, i, f"end: expected {'the turn limit' if out['winner'] is None else 'seat ' + str(out['winner']) + ' to win'}, "
                               f"gpu phase {phase[b]} turn {turn[b]} winner {winner[b]}")
                    continue
                if "points" in out:  # log v3: every seat's placement, kills and points (finalPlacements)
                    go = game_outcome(e, b)
                    for r in recs[b]:
                        s = r["seat"]
                        got = (go["placement"][s], go["kills"][s], go["points"][s], go["z"][s])
                        want = (r["outcome"]["placement"], r["outcome"]["kills"], r["outcome"]["points"], r["outcome"]["z"])
                        if got != want:
                            fail(b, i, f"outcome of seat {s}: engine (placement, kills, points, z) {want} vs gpu {got}")
                            break
                    else:
                        stats["outcomes"] += 1
                continue
            r = recs[b][i]
            if done[b]:
                fail(b, i, "gpu game already over")
                continue
            ref = packed[b][i]
            if not np.array_equal(st[b], ref):
                k = int(np.flatnonzero(st[b] != ref)[0])
                fail(b, i, f"{field_name(k, n, H, T)}: engine {ref[k]} vs gpu {st[b][k]}")
                continue
            c = cands[b][i]
            if cnt[b] != len(c) or not np.array_equal(tup[b, :len(c)], c):
                k = next((j for j in range(min(len(c), cnt[b])) if not np.array_equal(tup[b, j], c[j])), min(len(c), cnt[b]))
                fail(b, i, f"candidates differ: engine {len(c)}, gpu {cnt[b]}; first difference at {k}: engine "
                           f"{r['cands'][k] if k < len(c) else '-'} vs gpu {tup[b, k].tolist() if k < cnt[b] else '-'}")
                continue
            if r["agent"] in picks:
                stats["teacher_checked"] += 1
                if int(picks[r["agent"]][b]) != int(action[b]):
                    stats["teacher_mismatch"] += 1
                    pk = int(picks[r["agent"]][b])
                    gi = next((j for j in range(cnt[b]) if int(ord_[b, j]) == pk), -1)
                    fail(b, i, f"{r['agent']} picks candidate {gi} ({r['cands'][gi] if gi >= 0 else pk}), log has {r['choice']} "
                               f"({r['cands'][r['choice']]}) of {len(c)}")
                    continue
            stats["steps"] += 1
            step[b] = action[b]
            if r["agent"] in HAND_ORDER_TRADERS and r["cands"][r["choice"]][0] == "trade":
                me = int(st[b][3])
                slots = e.L.trade_tri[int(action[b]) - e.L.TRADE].tolist()
                hand = [int(st[b][hand_off + k]) for k in slots]
                if hand != sorted(hand):
                    owner = st[b][own_off:own_off + T]

                    def bonus(cs):
                        for x in cs:
                            t = int(card_terr[x])
                            if t >= 0 and owner[t] == me:
                                return t
                        return None

                    fixes.append((b, bonus(sorted(hand)), bonus(hand), hand))
        e.step(torch.from_numpy(step).to(e.dev))
        for b, t_sorted, t_hand, hand in fixes:
            if t_sorted != t_hand:
                e.armies[b, t_sorted] -= 2
                e.armies[b, t_hand] += 2
            dn = int(e.discard_n[b])
            e.discard[b, dn - 3:dn] = torch.tensor(hand, device=e.dev)
            stats["trade_order"] += 1
    stats["games"] += B
    stats["ok_games"] += B - sum(failed)


# Agents that send engine actions themselves instead of picking a self-play candidate, and list a trade's cards in
# hand order (findSets order): risky@1 plays legalMoves().tradeableSets[0] (packages/engine/src/bot.ts).
HAND_ORDER_TRADERS = {"risky@1"}

# ONNX Runtime in Node and PyTorch here compute the same fp32 network with different kernels (summation order), so two
# candidates whose logits are this close can swap places. A different top move with a larger gap is a real difference.
NEAR_TIE = 1e-4


def _trade_order_fix(e, snap, b, action, rec):
    """A trade's card order decides which owned territory gets the +2 (the first card showing one) and the order the
    cards go on the discard pile (which the next reshuffle depends on). Self-play candidates list the cards by id,
    and so does the GPU engine. The log keeps only that sorted candidate, so for agents known to send hand order
    the replay redoes the trade in hand order: returns (territory the GPU engine paid, territory to pay, cards in
    hand order), or None when nothing differs."""
    if rec["agent"] not in HAND_ORDER_TRADERS:
        return None
    me = int(snap.cur[b])
    slots = e.L.trade_tri[action - e.L.TRADE].tolist()
    hand = [int(snap.hand[b, me, k]) for k in slots]
    if hand == sorted(hand):
        return None

    def bonus(cards):
        for c in cards:
            t = int(snap.card_terr[c])
            if t >= 0 and snap.owner[b, t] == me:
                return t
        return None

    return bonus(sorted(hand)), bonus(hand), hand


def _cand_diff(e, snap, b, cands, acts, legal) -> str:
    from delove_gpu.engine import KIND_NAMES

    L = e.L
    mine = set(legal.tolist())
    theirs = {a for a in acts if a >= 0}
    extra = [f"{KIND_NAMES[int(L.kind[a])]}#{int(L.arg[a])}/{int(L.slot[a])}" for a in sorted(mine - theirs)][:5]
    missing = [cands[k] for k, a in enumerate(acts) if a < 0 or a not in mine][:5]
    return f"gpu-only {extra}, engine-only {missing}"


def run_batch(batch, args, enc, row, stats, net, cfg, teachers) -> int:
    if enc or net or args.slow or not args.fused:
        return replay_batch(batch, args.max_turns, args.device, enc, row, stats, net, args.fused, cfg, teachers)
    replay_batch_fast(batch, args.max_turns, args.device, stats, cfg, teachers)
    return row + sum(len(g) for g in batch)


def log_options(log: str) -> dict:
    """The game settings a log was played with (options.json next to the shards), or {} for the defaults."""
    import json

    f = Path(log) / "options.json"
    return json.loads(f.read_text(encoding="utf8")) if f.exists() else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--max-turns", type=int, default=500)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--export", help="export of the (single) log dir: also check the encoder")
    ap.add_argument("--net", nargs=2, metavar=("AGENT", "PT"), help="check the GPU network's top move against AGENT's logged choices (temperature 0)")
    ap.add_argument("--fused", action="store_true", help="replay through the CUDA-kernel engine (fused.py) instead of engine.py")
    ap.add_argument("--games", type=int, default=0, help="stop after this many games per log dir (0 = all)")
    ap.add_argument("--slow", action="store_true", help="the per-game replay loop (always used with --export or --net)")
    ap.add_argument("--teacher", action="append", default=[], help="AGENT[=PARAMS.json]: check the GPU teacher's pick at AGENT's steps")
    args = ap.parse_args()
    if args.export and len(args.logs) != 1:
        ap.error("--export checks one log dir")
    total = {"games": 0, "ok_games": 0, "steps": 0, "fail": [], "net_total": 0, "net_agree": 0, "trade_order": 0, "net_near": 0, "net_gaps": [],
             "teacher_checked": 0, "teacher_mismatch": 0, "outcomes": 0}
    teachers = None
    if args.teacher:
        from delove_gpu.teacher import agent_params

        teachers = {}
        for t in args.teacher:
            agent, _, path = t.partition("=")
            teachers[agent] = agent_params(agent, path=path or None)
    net = None
    if args.net:
        from delove_gpu.play import load_delove

        net = (args.net[0], load_delove(args.net[1], args.device))
    t0 = time.time()
    for log in args.logs:
        stats = {"games": 0, "ok_games": 0, "steps": 0, "fail": [], "net_total": 0, "net_agree": 0, "trade_order": 0, "net_near": 0, "net_gaps": [],
                 "teacher_checked": 0, "teacher_mismatch": 0, "outcomes": 0}
        opts = log_options(log)
        batch: list[list[dict]] = []
        cfg = None
        enc = None
        row = 0
        n = 0
        for g in games(log):
            c = GameConfig.make(g[0]["players"], {**opts, "map": g[0]["map"]})
            if cfg is not None and c != cfg:
                sys.exit(f"{log}: games of different configurations in one log ({cfg.label()} and {c.label()})")
            if cfg is None:
                cfg = c
                enc = EncoderCheck(args.export, cfg.map) if args.export else None
            batch.append(g)
            n += 1
            if len(batch) == args.batch:
                row = run_batch(batch, args, enc, row, stats, net, cfg, teachers)
                batch = []
            if args.games and n >= args.games:
                break
        if batch:
            row = run_batch(batch, args, enc, row, stats, net, cfg, teachers)
        extra = f" ({stats['trade_order']} trades replayed in the agent's hand order)" if stats["trade_order"] else ""
        print(f"{log} [{cfg.label() if cfg else '-'}]: {stats['ok_games']}/{stats['games']} games identical, {stats['steps']} steps checked, {len(stats['fail'])} failed{extra}")
        for f in stats["fail"][:10]:
            print("   ", f)
        total["net_gaps"] += stats["net_gaps"]
        for k in ("games", "ok_games", "steps", "net_total", "net_agree", "trade_order", "net_near", "teacher_checked", "teacher_mismatch", "outcomes"):
            total[k] += stats[k]
        total["fail"] += stats["fail"]
    if net:
        gaps = ", ".join(f"{g:.2g}" for g in total["net_gaps"][:10])
        print(f"network: GPU top move = {net[0]}'s logged move on {total['net_agree']}/{total['net_total']} decisions with 2+ candidates; "
              f"{total['net_near']} of the {total['net_total'] - total['net_agree']} others are near-ties (the two logits within {NEAR_TIE:g}"
              f"{', gaps ' + gaps if gaps else ''})")
    if enc:
        print(f"encoder: {enc.checked} decisions checked, max abs error {enc.max_err}")
    tch = f", teacher picks {total['teacher_checked'] - total['teacher_mismatch']}/{total['teacher_checked']} identical" if teachers else ""
    oc = f", outcomes (placement, kills, points) {total['outcomes']} games" if total["outcomes"] else ""
    print(f"TOTAL: {total['ok_games']}/{total['games']} games identical, {total['steps']} steps{tch}{oc}, {len(total['fail'])} failed, {time.time() - t0:.0f}s")
    sys.exit(1 if total["fail"] else 0)


if __name__ == "__main__":
    main()
