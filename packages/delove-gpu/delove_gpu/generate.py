"""Play self-play tables on the GPU (branch and score, the teacher, Delove networks) and write the training arrays
`train.py` reads straight from the GPU: the format of `npm run delove -- export` (packages/selfplay/src/export.ts),
no JSONL logs and no export step.

TRAINING ONLY. Every piece is a mirror checked by a replay test: the rules (tests/replay.py), the teacher
(tests/teacher_replay.py), branch and score (tests/branch_replay.py) and the encoder (tests/export_check.py). Games
are numbered and seeded as `play` does (game i of a table: gameSeed(seed, i), seats in the listed order, each seat's
stream mixSeed(seed, 0x5eed + seat)), so a table here is the same set of games as on the CPU.

    python -m delove_gpu.generate --models models/delove --ranker c2-candidate --horizon 1 --margin 0.01 \\
        --table "c2d 2000 delove-branch@1,delove@2" --table "c2t 2000 delove-branch@1,delove-teacher@2" \\
        --seed 303 --out data/delove/g3-classic2
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .branch import SCORE_PARTS, BranchEngine, GpuBranch, cpu_order, default_branch, first_max, net_ranker
from .encode import Encoder
from .engine import FINISHED, KIND_NAMES
from .fingerprint import REPO
from .npy import NpyWriter
from .play import load_delove
from .teacher import load_params, mix_seed

TEACHER, BRANCH, NET = 0, 1, 2
BRANCH_ID = "delove-branch@1"


@dataclass
class Table:
    name: str
    games: int
    agents: list[str]
    start: int = 0


def parse_table(s: str) -> Table:
    parts = s.split()
    if len(parts) not in (3, 4):
        raise argparse.ArgumentTypeError(f"table {s!r}: want 'NAME GAMES AGENT,AGENT [START]'")
    return Table(parts[0], int(parts[1]), parts[2].split(","), int(parts[3]) if len(parts) == 4 else 0)


def ts_constants() -> dict:
    """Feature names and format versions from the built self-play package (single source: encode.ts / log.ts)."""
    js = ("import * as s from './packages/selfplay/dist/index.js'; console.log(JSON.stringify({encoderVersion: s.ENCODER_VERSION,"
          " logVersion: s.LOG_VERSION, territoryFeatures: s.TERRITORY_FEATURES, globalFeatures: s.GLOBAL_FEATURES,"
          " candidateFeatures: s.CANDIDATE_FEATURES}))")
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        raise RuntimeError(f"reading the self-play constants failed (npm run build first?): {r.stderr}")
    return json.loads(r.stdout)


class Recorder:
    """Training arrays for one map folder, as export.ts writes them."""

    def __init__(self, out: Path, e):
        from .encode import ENCODER_VERSION, F_CAND, F_GLOBAL, F_TERRITORY

        self.c = ts_constants()
        if self.c["encoderVersion"] != ENCODER_VERSION:
            raise RuntimeError(f"encode.ts is v{self.c['encoderVersion']}, the GPU encoder v{ENCODER_VERSION}")
        self.dir = out / e.m.id
        self.dir.mkdir(parents=True, exist_ok=True)
        T = e.m.T
        w = lambda name, dt, shape: NpyWriter(self.dir / f"{name}.npy", dt, shape)  # noqa: E731
        self.territory = w("territory", "<f4", [T, F_TERRITORY])
        self.glob = w("global", "<f4", [F_GLOBAL])
        self.cand = w("cand", "<f4", [F_CAND])
        self.cand_from = w("cand_from", "<i4", [])
        self.cand_to = w("cand_to", "<i4", [])
        self.offset = w("cand_offset", "<i8", [])
        self.choice = w("choice", "<i4", [])
        self.game = w("game", "<i4", [])
        self.seat = w("seat", "<i4", [])
        self.offset.append(np.array([0], dtype=np.int64))
        self.ncand = 0
        self.uids: list[np.ndarray] = []  # game uid of each row, for z at the end
        self.game_index: dict[int, int] = {}
        self.z_of: dict[tuple[int, int], float] = {}
        self.m = e.m
        self.keys: list = []

    def add(self, enc: Encoder, terr, glob, games: torch.Tensor, ordered: torch.Tensor, cnt: torch.Tensor, chosen: torch.Tensor,
            uid: torch.Tensor, seat: torch.Tensor, keys: list | None = None):
        """Rows for decisions in `games`: candidates ordered[g, :cnt[g]] (actions.ts order), chosen action. `keys`
        (one per game, optional) are kept in self.keys in row order, for tests that compare rows with export's."""
        if games.numel() == 0:
            return
        if keys is not None:
            self.keys.extend(keys)
        c = cnt[games]
        o = ordered[games]
        valid = torch.arange(o.shape[1], device=o.device)[None, :] < c[:, None]
        bi, col = valid.nonzero(as_tuple=True)
        acts = o[bi, col]
        rows = enc.row_of[games]
        cand, cf, ct = enc.candidates(rows[bi], acts)
        choice = (o == chosen[games][:, None]) & valid
        if not bool(choice.any(1).all()):
            raise RuntimeError("a chosen move is not among the candidates")
        ch = choice.long().argmax(1)
        self.territory.append(terr[rows].cpu().numpy())
        self.glob.append(glob[rows].cpu().numpy())
        self.cand.append(cand.cpu().numpy())
        self.cand_from.append(cf.to(torch.int32).cpu().numpy())
        self.cand_to.append(ct.to(torch.int32).cpu().numpy())
        offs = self.ncand + torch.cumsum(c, 0).cpu().numpy()
        self.ncand = int(offs[-1])
        self.offset.append(offs.astype(np.int64))
        self.choice.append(ch.to(torch.int32).cpu().numpy())
        u = uid[games].cpu().numpy()
        for x in u.tolist():
            if x not in self.game_index:
                self.game_index[x] = len(self.game_index)
        self.game.append(np.array([self.game_index[x] for x in u.tolist()], dtype=np.int32))
        self.seat.append(seat[games].to(torch.int32).cpu().numpy())
        self.uids.append(np.stack([u, seat[games].cpu().numpy()], 1))

    def finish_game(self, uid: int, z: list[float]):
        for s, v in enumerate(z):
            self.z_of[(uid, s)] = v

    def close(self, sources: list[str]) -> dict:
        for w in (self.territory, self.glob, self.cand, self.cand_from, self.cand_to, self.offset, self.choice, self.game, self.seat):
            w.close()
        us = np.concatenate(self.uids) if self.uids else np.zeros((0, 2), dtype=np.int64)
        z = np.array([self.z_of[(int(u), int(s))] for u, s in us], dtype=np.float32)
        zw = NpyWriter(self.dir / "z.npy", "<f4", [])
        zw.append(z)
        zw.close()
        m = self.m
        result = {"map": m.id, "decisions": int(self.choice.rows), "candidates": self.ncand, "games": len(self.game_index),
                  "skipped": 0, "fogSkipped": 0}
        info = {"encoderVersion": self.c["encoderVersion"], "logVersion": self.c["logVersion"], **result,
                "territoryFeatures": self.c["territoryFeatures"], "globalFeatures": self.c["globalFeatures"],
                "candidateFeatures": self.c["candidateFeatures"], "territoryIds": m.territory_ids, "adjacency": m.adj,
                "sources": sources}
        (self.dir / "features.json").write_text(json.dumps(info, indent=1) + "\n", encoding="utf8", newline="\n")
        return result


class Generator:
    def __init__(self, tables: list[Table], seed: int, models: Path, ranker: str, teacher: str, cfg, B: int,
                 export_agents: list[str], out: Path | None, max_turns: int = 500, precision: str = "fp32", device="cuda",
                 allow_unverified: bool = False):
        self.tables, self.seed, self.cfg = tables, seed, cfg
        tpath = models / f"{teacher}.json"
        self.teacher_id = teacher
        params = load_params(tpath if tpath.exists() else None)
        self.e = e = BranchEngine(B, params=params, device=device, max_turns=max_turns, allow_unverified=allow_unverified)
        self.enc = Encoder(e)
        self.adj = e.m.adj_matrix
        self.cpu_order = cpu_order(e.L, e.dev)
        self.B, self.dev = B, e.dev
        # agents
        ids = sorted({a for t in tables for a in t.agents} | {ranker})
        self.agent_ids = ids
        self.nets: dict[str, object] = {}
        types = []
        for a in ids:
            if a == BRANCH_ID:
                types.append(BRANCH)
            elif a.startswith("delove-teacher@"):
                if a != teacher:
                    raise SystemExit(f"{a} at the table but the rollout teacher is {teacher}: one teacher version per run")
                types.append(TEACHER)
            else:
                pt = models / f"{a}.pt"
                if not pt.exists():
                    raise SystemExit(f"{pt} missing (a network seat needs its PyTorch weights)")
                self.nets[a] = net_ranker(self.enc, load_delove(pt, e.dev), self.adj, precision)
                types.append(NET)
        self.agent_type = torch.tensor(types, device=e.dev)
        self.branch = GpuBranch(e, self.nets[ranker], cfg) if BRANCH_ID in ids and any(BRANCH_ID in t.agents for t in tables) else None
        self.export_idx = torch.tensor([ids.index(a) for a in export_agents if a in ids], dtype=torch.long, device=e.dev)
        self.rec = Recorder(out, e) if out else None
        self.queue = [(ti, i) for ti, t in enumerate(tables) for i in range(t.games)]
        self.queue.reverse()
        self.seat_agent = torch.zeros(B, e.n, dtype=torch.long, device=e.dev)
        self.uid = torch.full((B,), -1, dtype=torch.long, device=e.dev)
        # decisions per game as game.ts counts them: one per action, a fortify (two steps here) is one
        self.decisions = torch.zeros(B, dtype=torch.long, device=e.dev)
        self.fortify_to = KIND_NAMES.index("fortify_to")
        self.slot_game: list[tuple[int, int] | None] = [None] * B
        self.occupied = torch.zeros(B, dtype=torch.bool, device=e.dev)
        self.results: list[dict] = []
        self.next_uid = 0
        self.stats = {"decisions": 0, "branched": 0, "simulations": 0, "simulatedMoves": 0, "changed": 0, "gain": 0.0,
                      "changedByKind": {}, "branchedByKind": {}, "chosen": {k: 0.0 for k in SCORE_PARTS}}

    def fill(self, slots: list[int]):
        g, seeds = [], []
        for b in slots:
            if not self.queue:
                break
            ti, i = self.queue.pop()
            t = self.tables[ti]
            g.append(b)
            seeds.append(mix_seed(self.seed, t.start + i))
            self.slot_game[b] = (ti, i)
            self.seat_agent[b] = torch.tensor([self.agent_ids.index(a) for a in t.agents], device=self.dev)
            self.uid[b] = self.next_uid
            self.decisions[b] = 0
            self.next_uid += 1
        if not g:
            return
        gt = torch.tensor(g, device=self.dev)
        st = torch.tensor(seeds, dtype=torch.long)
        self.e.reset(gt, st)
        self.e.seat_streams(gt, st)
        self.occupied[gt] = True

    def finish(self, slots: torch.Tensor):
        e = self.e
        for b in slots.tolist():
            ti, i = self.slot_game[b]
            t = self.tables[ti]
            won = int(e.phase[b]) == FINISHED
            winner = int(e.winner[b]) if won else None
            alive = [bool(e.alive[b, s]) for s in range(e.n)]
            z = [1.0 if s == winner else 0.0 for s in range(e.n)] if won else [1.0 / sum(alive) if a else 0.0 for a in alive]
            self.results.append({"table": t.name, "index": t.start + i, "winner": winner, "turns": int(e.turn[b]), "agents": t.agents,
                                 "decisions": int(self.decisions[b])})
            if self.rec:
                self.rec.finish_game(int(self.uid[b]), z)
            self.slot_game[b] = None
        self.occupied[slots] = False

    def _record(self, games, ordered, cnt, chosen, terr, glob):
        if self.rec is None or games.numel() == 0:
            return
        ag = self.seat_agent[games, self.e.cur[games]]
        keep = (ag[:, None] == self.export_idx[None, :]).any(1)
        g = games[keep]
        self.rec.add(self.enc, terr, glob, g, ordered, cnt, chosen, self.uid, self.e.cur)

    def _branch_stats(self, d, ph_kind):
        s = self.stats
        n_imp = int(d.branched.sum())
        s["decisions"] += d.games.numel()
        s["branched"] += n_imp
        if n_imp == 0:
            return
        L = self.e.L
        nopt = (d.options[d.branched] >= 0).sum(1)
        s["simulations"] += int(nopt.sum()) * self.cfg.rollouts
        s["simulatedMoves"] += d.moves
        s["changed"] += int(d.changed.sum())
        m = d.means[d.branched]
        best = d.best[d.branched]
        chosen = m.gather(1, best[:, None, None].expand(-1, 1, 8)).squeeze(1)
        s["gain"] += float((chosen[:, 0] - m[:, 0, 0]).sum())
        for k, name in enumerate(SCORE_PARTS):
            s["chosen"][name] += float(chosen[:, k].sum())
        kinds = L.kind[d.options[d.branched, 0]].tolist()
        ch = d.changed[d.branched].tolist()
        for kd, c in zip(kinds, ch):
            name = KIND_NAMES[kd]
            s["branchedByKind"][name] = s["branchedByKind"].get(name, 0) + 1
            if c:
                s["changedByKind"][name] = s["changedByKind"].get(name, 0) + 1

    @torch.inference_mode()
    def run(self, progress: bool = True) -> dict:
        e, dev, B = self.e, self.dev, self.B
        ar = torch.arange(B, device=dev)
        self.fill(list(range(B)))
        t0, it, total = time.time(), 0, sum(t.games for t in self.tables)
        self.iter_log = []
        while bool(self.occupied.any()):
            active = self.occupied & ~e.done
            mask = e.legal()
            ag = self.seat_agent[ar, e.cur]
            typ = self.agent_type[ag]
            tact = e.teacher(active & ((typ == TEACHER) | (typ == BRANCH)))
            # features only where a network decides or a decision is recorded (not for teacher seats)
            exported = (ag[:, None] == self.export_idx[None, :]).any(1) if self.rec else torch.zeros_like(active)
            terr, glob = self.enc.encode((active & ((typ != TEACHER) | exported)).nonzero(as_tuple=True)[0])
            self.enc.last = (terr, glob)
            act1 = torch.where(active & (typ == TEACHER), tact, -1)
            nlegal = mask.sum(1)
            # a network seat with one candidate plays it without scoring (net-agent.ts)
            one = active & (typ == NET) & (nlegal == 1)
            act1 = torch.where(one, mask.long().argmax(1), act1)
            for name, rank in self.nets.items():
                g = (active & (ag == self.agent_ids.index(name)) & (nlegal > 1)).nonzero(as_tuple=True)[0]
                if g.numel():
                    act1[g] = first_max(rank(g, mask), self.cpu_order)  # ties: first candidate (fortify_to: territory order)
            act2 = torch.full((B,), -1, dtype=torch.long, device=dev)
            bg = (active & (typ == BRANCH)).nonzero(as_tuple=True)[0]
            if bg.numel():
                d = self.branch.decide(bg, mask, tact)
                act1[bg] = d.act1
                act2[bg] = d.act2
                self._branch_stats(d, None)
            ordered, cnt = e.cand_order() if self.rec else (None, None)
            self._record(active.nonzero(as_tuple=True)[0], ordered, cnt, act1, terr, glob)
            counted = active & (act1 >= 0)
            self.decisions += (counted & (e.L.kind[act1.clamp(min=0)] != self.fortify_to)).long()
            e.step(act1)
            g2 = (act2 >= 0).nonzero(as_tuple=True)[0]
            if g2.numel():
                if self.rec:
                    terr2, glob2 = self.enc.encode(g2)
                    ordered2, cnt2 = e.cand_order()
                    self._record(g2, ordered2, cnt2, act2, terr2, glob2)
                e.step(act2)
            done = (self.occupied & e.done).nonzero(as_tuple=True)[0]
            if done.numel():
                self.finish(done)
                self.fill(done.tolist())
            it += 1
            self.iter_log.append((time.time() - t0, int(active.sum())))
            if progress and it % 50 == 0:
                print(f"  step {it}: {len(self.results)}/{total} games, {time.time() - t0:.0f}s", flush=True)
        secs = time.time() - t0
        out = {"games": len(self.results), "seconds": round(secs, 1), "steps": it, "branch": self.stats,
               "odds_outside_tables": int(e.tstats[0])}
        if self.rec:
            out["export"] = self.rec.close([f"gpu:{t.name}" for t in self.tables])
        return out


def table_summary(results: list[dict]) -> list[dict]:
    out = {}
    for r in results:
        t = out.setdefault(r["table"], {"table": r["table"], "agents": r["agents"], "games": 0, "wins": [0] * len(r["agents"]), "turnLimit": 0, "turns": 0,
                                        "decisions": 0})
        t["games"] += 1
        t["turns"] += r["turns"]
        t["decisions"] += r["decisions"]
        if r["winner"] is None:
            t["turnLimit"] += 1
        else:
            t["wins"][r["winner"]] += 1
    for t in out.values():
        t["meanTurns"] = round(t["turns"] / t["games"], 1)
    return list(out.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--table", action="append", type=parse_table, required=True, help="'NAME GAMES AGENT,AGENT [START]'")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--models", default=str(REPO / "models" / "delove"))
    ap.add_argument("--ranker", default="delove@2", help="network proposing the branch options (DELOVE_BRANCH_RANKER)")
    ap.add_argument("--teacher", default=None, help="rollout teacher (default: the newest delove-teacher@N.json in --models)")
    d = default_branch()
    ap.add_argument("--options", type=int, default=d.options)
    ap.add_argument("--rollouts", type=int, default=d.rollouts)
    ap.add_argument("--horizon", type=int, default=d.horizon)
    ap.add_argument("--margin", type=float, default=d.margin)
    ap.add_argument("--skip", default=",".join(d.skip))
    ap.add_argument("--batch", type=int, default=4096, help="games in flight")
    ap.add_argument("--out", help="write training arrays here (export's format, one folder per map)")
    ap.add_argument("--export-agents", default=BRANCH_ID)
    ap.add_argument("--precision", default="fp32", choices=["fp32", "tf32", "fp16"])
    ap.add_argument("--summary", help="write the run summary JSON here")
    ap.add_argument("--results", help="write one JSON line per game here (table, index, winner seat, turns)")
    ap.add_argument("--allow-unverified", action="store_true", help="benchmarks only: run even if the mirror is not verified for this engine")
    args = ap.parse_args()
    models = Path(args.models)
    teacher = args.teacher
    if teacher is None:
        vs = sorted((int(p.stem.split("@")[1]), p.stem) for p in models.glob("delove-teacher@*.json"))
        teacher = vs[-1][1] if vs else "delove-teacher@1"
    cfg = d
    cfg.options, cfg.rollouts, cfg.horizon, cfg.margin = args.options, args.rollouts, args.horizon, args.margin
    cfg.skip = [k for k in args.skip.split(",") if k]
    gen = Generator(args.table, args.seed, models, args.ranker, teacher, cfg, args.batch, args.export_agents.split(","),
                    Path(args.out) if args.out else None, precision=args.precision, allow_unverified=args.allow_unverified)
    res = gen.run()
    res["tables"] = table_summary(gen.results)
    res["config"] = {"seed": args.seed, "ranker": args.ranker, "teacher": teacher, "options": cfg.options, "rollouts": cfg.rollouts,
                     "horizon": cfg.horizon, "margin": cfg.margin, "skip": cfg.skip, "weights": cfg.weights, "batch": args.batch,
                     "precision": args.precision}
    text = json.dumps(res, indent=2)
    print(text)
    if args.summary:
        Path(args.summary).write_text(text + "\n", encoding="utf8")
    if args.results:
        with open(args.results, "w", encoding="utf8") as f:
            for r in sorted(gen.results, key=lambda r: (r["table"], r["index"])):
                f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    sys.exit(main())
