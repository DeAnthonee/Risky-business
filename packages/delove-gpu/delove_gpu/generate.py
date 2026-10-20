"""Play self-play tables on the GPU (branch and score, the teacher, Delove networks) and write the training arrays
`train.py` reads straight from the GPU: the format of `npm run delove -- export` (packages/selfplay/src/export.ts),
no JSONL logs and no export step. Any map, table size (2-10 seats) and covered game setting.

TRAINING ONLY. Every piece is a mirror checked by a replay test: the rules and the teacher (tests/replay.py,
tests/matrix.py), branch and score (tests/branch_replay.py) and the encoder (tests/export_check.py). Games are
numbered and seeded as `play` does (game i of a table: gameSeed(seed, i), seats in the listed order, each seat's
stream mixSeed(seed, 0x5eed + seat)), so a table here is the same set of games as on the CPU.

    python -m delove_gpu.generate --models models/delove --ranker c2-candidate --horizon 1 --margin 0.01 \\
        --table "c2d 2000 delove-branch@1,delove@2" --table 'mb 600 delove-branch@1,delove-teacher@2 {"map":"skirmish"}' \\
        --seed 303 --out data/delove/g3

Tables with the same configuration (map, seats, settings) share one engine; configurations run one after another,
each map's arrays going to OUT/<map>/ (several configurations on one map append to the same folder, like export).
`--jobs FILE` reads a jobs file (`name games agents [options JSON]` per line, as generate.sh / cycle.sh take).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
import torch

from .branch import SCORE_PARTS, BranchEngine, GpuBranch, cpu_order, default_branch, first_max, net_ranker
from .config import GameConfig
from .encode import Encoder
from .engine import FINISHED, KIND_NAMES
from .fingerprint import REPO
from .npy import NpyWriter
from .outcome import game_outcome
from .play import load_delove
from .teacher import agent_params, is_teacher, mix_seed

TEACHER, BRANCH, NET = 0, 1, 2
BRANCH_ID = "delove-branch@1"


def branch_score(agent: str) -> str | None:
    """For a branch seat: None for delove-branch@1 (the run's --score), the score for a GPU-only comparison seat
    `delove-branch@1:share` / `:points` / `:kills` (several kinds can sit at one table); not a branch seat: raises."""
    if agent == BRANCH_ID:
        return None
    if agent.startswith(BRANCH_ID + ":") and agent.split(":", 1)[1] in ("share", "points", "kills"):
        return agent.split(":", 1)[1]
    raise ValueError(agent)


def is_branch(agent: str) -> bool:
    try:
        branch_score(agent)
        return True
    except ValueError:
        return False


@dataclass
class Table:
    name: str
    games: int
    agents: list[str]
    start: int = 0
    options: dict = field(default_factory=dict)
    seed: int | None = None  # this table's base seed (default: the run's); ladder.py gives every match its own

    @property
    def config(self) -> GameConfig:
        return GameConfig.make(len(self.agents), self.options)


def parse_table(s: str) -> Table:
    """'NAME GAMES AGENT,AGENT [START] [OPTIONS JSON]'."""
    parts = s.strip().split(None, 3)
    if len(parts) < 3:
        raise argparse.ArgumentTypeError(f"table {s!r}: want 'NAME GAMES AGENT,AGENT [START] [OPTIONS JSON]'")
    start, options = 0, {}
    rest = parts[3].strip() if len(parts) == 4 else ""
    if rest and not rest.startswith("{"):
        first, _, rest = rest.partition(" ")
        start = int(first)
        rest = rest.strip()
    if rest:
        options = json.loads(rest)
    return Table(parts[0], int(parts[1]), parts[2].split(","), start, options)


def read_jobs(path: str) -> list[Table]:
    out = []
    for line in Path(path).read_text(encoding="utf8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(parse_table(line))
    return out


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
    """Training arrays for one map folder, as export.ts writes them (several configurations may append)."""

    def __init__(self, out: Path, m, consts: dict):
        from .encode import ENCODER_VERSION, F_CAND, F_GLOBAL, F_TERRITORY

        self.c = consts
        if self.c["encoderVersion"] != ENCODER_VERSION:
            raise RuntimeError(f"encode.ts is v{self.c['encoderVersion']}, the GPU encoder v{ENCODER_VERSION}")
        self.dir = out / m.id
        self.dir.mkdir(parents=True, exist_ok=True)
        T = m.T
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
        self.out_of: dict[tuple[int, int], tuple[float, float, float]] = {}  # (z, points, points01) per (game, seat)
        self.m = m
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

    def finish_game(self, uid: int, out: dict):
        """out: outcome.outcome() of the finished game (z, points, points01 per seat)."""
        for s, z in enumerate(out["z"]):
            self.out_of[(uid, s)] = (z, out["points"][s], out["points01"][s])

    def close(self, sources: list[str]) -> dict:
        for w in (self.territory, self.glob, self.cand, self.cand_from, self.cand_to, self.offset, self.choice, self.game, self.seat):
            w.close()
        us = np.concatenate(self.uids) if self.uids else np.zeros((0, 2), dtype=np.int64)
        vals = np.array([self.out_of[(int(u), int(s))] for u, s in us], dtype=np.float64).reshape(-1, 3)
        for k, name in enumerate(["z", "points", "points01"]):  # doubles rounded to float32 once, as export.ts stores them
            w = NpyWriter(self.dir / f"{name}.npy", "<f4", [])
            w.append(vals[:, k].astype(np.float32))
            w.close()
        m = self.m
        result = {"map": m.id, "decisions": int(self.choice.rows), "candidates": self.ncand, "games": len(self.game_index),
                  "skipped": 0, "fogSkipped": 0}
        info = {"encoderVersion": self.c["encoderVersion"], "logVersion": self.c["logVersion"], **result,
                "territoryFeatures": self.c["territoryFeatures"], "globalFeatures": self.c["globalFeatures"],
                "candidateFeatures": self.c["candidateFeatures"], "territoryIds": m.territory_ids, "adjacency": m.adj,
                "sources": sources}
        (self.dir / "features.json").write_text(json.dumps(info, indent=1) + "\n", encoding="utf8", newline="\n")
        return result


# Bytes of GPU memory per game in flight, beyond the networks (measured on the RTX 4060 with headroom): the state, the
# masks and candidate lists, and options x rollouts copies of the board for branch and score.
def state_bytes(T: int, n: int, A: int, H: int = 12) -> int:
    P, NC = n + 1, T + 2
    return 8 * (2 * T + P * (H + 4) + 2 * NC + 2 * n + 24) + T + 9 * A


def auto_batch(cfg: GameConfig, bcfg, branch: int, budget: float) -> int:
    """Games in flight for a configuration within `budget` bytes of GPU memory (rounded down to 256). `branch`: the
    branch players at the table (each has its own rollout copies)."""
    from .engine import Layout
    from .mapdata import MapData

    m = MapData(cfg.map, "cpu")
    A = Layout(m).A
    per = state_bytes(m.T, cfg.seats, A)
    if branch:
        per += branch * (bcfg.options * bcfg.rollouts * state_bytes(m.T, cfg.seats, A) + 24 * bcfg.options * bcfg.rollouts)
    per += 8 * m.T * 27 * 2 + 64 * A  # encoder features (float64 then float32) and per-move candidate features
    # x2: measured peaks on the RTX 4060 (allocator slack, network activations, temporaries) were 1.5-2x this estimate
    return max(256, int(budget // (2 * per)) // 256 * 256)


class Run:
    """What every configuration of one run shares: the networks, the teacher, the recorders, results and stats."""

    def __init__(self, tables: list[Table], seed: int, models: Path, ranker: str, teacher: str, bcfg, export_agents: list[str],
                 out: Path | None, max_turns: int, precision: str, device: str, allow_unverified: bool):
        self.tables, self.seed, self.bcfg, self.models = tables, seed, bcfg, models
        self.ranker, self.teacher_id, self.max_turns, self.precision = ranker, teacher, max_turns, precision
        self.device, self.allow_unverified = torch.device(device), allow_unverified
        self.agent_ids = sorted({a for t in tables for a in t.agents} | {ranker})
        # teacher versions: row 0 the rollout teacher (it also makes the branch player's own teacher moves), then every
        # other teacher seated at a table (delove-teacher@N, jacob-sensei@N), each with its own numbers
        self.versions = [teacher] + [a for a in self.agent_ids if is_teacher(a) and a != teacher]
        if len(self.versions) > 255:
            raise SystemExit("more than 255 teacher versions in one run")
        self.params = [agent_params(v, models) for v in self.versions]
        self.types: dict[str, int] = {}
        self.net_modules: dict[str, torch.nn.Module] = {}
        for a in self.agent_ids:
            if is_branch(a):
                self.types[a] = BRANCH
            elif is_teacher(a):
                self.types[a] = TEACHER
            else:
                pt = models / f"{a}.pt"
                if not pt.exists():
                    raise SystemExit(f"{pt} missing (a network seat needs its PyTorch weights)")
                net = load_delove(pt, self.device)
                self.net_modules[a] = net.half() if precision == "fp16" else net
                self.types[a] = NET
        self.export_agents = [a for a in export_agents if a in self.agent_ids]
        self.out = out
        self.consts = ts_constants() if out else None
        self.recorders: dict[str, Recorder] = {}
        self.results: list[dict] = []
        self.next_uid = 0
        self.stats = {"decisions": 0, "branched": 0, "simulations": 0, "simulatedMoves": 0, "changed": 0, "gain": 0.0,
                      "changedByKind": {}, "branchedByKind": {}, "chosen": {k: 0.0 for k in SCORE_PARTS}}
        self.groups: list[dict] = []

    def recorder(self, m) -> Recorder | None:
        if self.out is None:
            return None
        if m.id not in self.recorders:
            self.recorders[m.id] = Recorder(self.out, m, self.consts)
        return self.recorders[m.id]

    def run(self, batch: int | None, budget: float, progress: bool = True) -> dict:
        t0 = time.time()
        by_cfg: dict[GameConfig, list[Table]] = {}
        for t in self.tables:
            by_cfg.setdefault(t.config, []).append(t)
        for cfg, tables in by_cfg.items():
            n_branch = len({a for t in tables for a in t.agents if is_branch(a)})
            B = batch or auto_batch(cfg, self.bcfg, n_branch, budget)
            B = min(B, max(256, (sum(t.games for t in tables) + 255) // 256 * 256))
            g = Group(self, cfg, tables, B)
            info = g.run(progress)
            info.update({"config": cfg.label(), "batch": B, "tables": [t.name for t in tables]})
            self.groups.append(info)
            if progress:
                print(f"  {cfg.label()}: {info['games']} games in {info['seconds']}s (batch {B})", flush=True)
            del g
            torch.cuda.empty_cache()
        out = {"games": len(self.results), "seconds": round(time.time() - t0, 1), "groups": self.groups, "branch": self.stats}
        if self.out:
            out["export"] = [r.close([f"gpu:{t.name}" for t in self.tables]) for r in self.recorders.values()]
        return out


class Group:
    """The tables of one configuration on one BranchEngine."""

    def __init__(self, run: Run, cfg: GameConfig, tables: list[Table], B: int):
        self.r, self.tables, self.cfg = run, tables, cfg
        self.e = e = BranchEngine(B, cfg, params=run.params, device=run.device, max_turns=run.max_turns,
                                  allow_unverified=run.allow_unverified)
        self.enc = Encoder(e)
        self.adj = e.m.adj_matrix
        self.cpu_order = cpu_order(e.L, e.dev)
        self.B, self.dev = B, e.dev
        ids = run.agent_ids
        self.agent_type = torch.tensor([run.types[a] for a in ids], device=e.dev)
        # each agent's teacher version (row of e.prm): its own for teacher seats, the rollout teacher's (0) otherwise
        self.agent_tver = torch.tensor([run.versions.index(a) if a in run.versions else 0 for a in ids], dtype=torch.uint8, device=e.dev)
        self.nets = {a: net_ranker(self.enc, mod, self.adj, run.precision) for a, mod in run.net_modules.items()}
        # one GpuBranch per branch seat kind at these tables (agent index -> its branch and score)
        self.branches = {ids.index(a): GpuBranch(e, self.nets[run.ranker], replace(run.bcfg, score=branch_score(a) or run.bcfg.score))
                         for a in sorted({a for t in tables for a in t.agents if is_branch(a)})}
        self.export_idx = torch.tensor([ids.index(a) for a in run.export_agents], dtype=torch.long, device=e.dev)
        self.rec = run.recorder(e.m)
        self.queue = [(ti, i) for ti, t in enumerate(tables) for i in range(t.games)]
        self.queue.reverse()
        self.seat_agent = torch.zeros(B, e.n, dtype=torch.long, device=e.dev)
        self.uid = torch.full((B,), -1, dtype=torch.long, device=e.dev)
        # decisions per game as game.ts counts them: one per action, a fortify (two steps here) is one
        self.decisions = torch.zeros(B, dtype=torch.long, device=e.dev)
        self.fortify_to = KIND_NAMES.index("fortify_to")
        self.slot_game: list[tuple[int, int] | None] = [None] * B
        self.occupied = torch.zeros(B, dtype=torch.bool, device=e.dev)

    def fill(self, slots: list[int]):
        r = self.r
        g, seeds = [], []
        for b in slots:
            if not self.queue:
                break
            ti, i = self.queue.pop()
            t = self.tables[ti]
            g.append(b)
            seeds.append(mix_seed(r.seed if t.seed is None else t.seed, t.start + i))
            self.slot_game[b] = (ti, i)
            self.seat_agent[b] = torch.tensor([r.agent_ids.index(a) for a in t.agents], device=self.dev)
            self.e.tver[b] = self.agent_tver[self.seat_agent[b]]
            self.uid[b] = r.next_uid
            self.decisions[b] = 0
            r.next_uid += 1
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
            out = game_outcome(e, b)
            self.r.results.append({"table": t.name, "index": t.start + i, "winner": winner, "turns": int(e.turn[b]), "agents": t.agents,
                                   "decisions": int(self.decisions[b]), "placement": out["placement"], "kills": out["kills"],
                                   "points": out["points"]})
            if self.rec:
                self.rec.finish_game(int(self.uid[b]), out)
            self.slot_game[b] = None
        self.occupied[slots] = False

    def _record(self, games, ordered, cnt, chosen, terr, glob):
        if self.rec is None or games.numel() == 0:
            return
        ag = self.seat_agent[games, self.e.cur[games]]
        keep = (ag[:, None] == self.export_idx[None, :]).any(1)
        g = games[keep]
        self.rec.add(self.enc, terr, glob, g, ordered, cnt, chosen, self.uid, self.e.cur)

    def _branch_stats(self, d):
        s = self.r.stats
        n_imp = int(d.branched.sum())
        s["decisions"] += d.games.numel()
        s["branched"] += n_imp
        if n_imp == 0:
            return
        L = self.e.L
        nopt = (d.options[d.branched] >= 0).sum(1)
        s["simulations"] += int(nopt.sum()) * self.r.bcfg.rollouts
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
        e, dev, B, r = self.e, self.dev, self.B, self.r
        ar = torch.arange(B, device=dev)
        torch.cuda.reset_peak_memory_stats(dev)
        self.fill(list(range(B)))
        t0, it, total = time.time(), 0, sum(t.games for t in self.tables)
        first = len(self.r.results)  # this configuration's games, for the turn-limit count in the progress line
        done_games = 0
        # teacher seats whose decisions are not recorded play their moves in place, inside one kernel, until a branch or
        # network seat is to move: same moves and streams as one step at a time, without a round trip per move
        fast = (self.agent_type == TEACHER).clone()
        if self.rec is not None and self.export_idx.numel():
            fast[self.export_idx] = False
        while bool(self.occupied.any()):
            tseat = fast[self.seat_agent]  # [B, seats]
            e.teacher_run(tseat, self.occupied & ~e.done, self.decisions)
            done = (self.occupied & e.done).nonzero(as_tuple=True)[0]
            if done.numel():
                self.finish(done)
                done_games += done.numel()
                self.fill(done.tolist())
                continue
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
                g = (active & (ag == r.agent_ids.index(name)) & (nlegal > 1)).nonzero(as_tuple=True)[0]
                if g.numel():
                    act1[g] = first_max(rank(g, mask), self.cpu_order)  # ties: first candidate (fortify_to: territory order)
            act2 = torch.full((B,), -1, dtype=torch.long, device=dev)
            for idx, branch in self.branches.items():
                bg = (active & (ag == idx)).nonzero(as_tuple=True)[0]
                if bg.numel():
                    d = branch.decide(bg, mask, tact)
                    act1[bg] = d.act1
                    act2[bg] = d.act2
                    self._branch_stats(d)
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
                done_games += done.numel()
                self.fill(done.tolist())
            it += 1
            if progress and it % 100 == 0:
                limit = sum(1 for r in self.r.results[first:] if r["winner"] is None)
                # The branch statistics so far (the whole run's), for scripts/dashboard.mjs.
                st = self.r.stats
                print(f"    {self.cfg.label()} step {it}: {done_games}/{total} games, {limit} at the turn limit, {time.time() - t0:.0f}s"
                      f" | branch {json.dumps({k: st[k] for k in ('decisions', 'branched', 'simulations', 'simulatedMoves', 'changed', 'gain', 'changedByKind', 'branchedByKind')})}",
                      flush=True)
        return {"games": done_games, "seconds": round(time.time() - t0, 1), "steps": it, "odds_outside_tables": int(e.tstats[0]),
                "peak_gpu_gb": round(torch.cuda.max_memory_allocated(dev) / 2**30, 2)}


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
    ap.add_argument("--table", action="append", type=parse_table, default=[], help="'NAME GAMES AGENT,AGENT [START] [OPTIONS JSON]'")
    ap.add_argument("--jobs", action="append", default=[], help="a jobs file (name games agents [options JSON] per line)")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--models", default=str(REPO / "models" / "delove"))
    ap.add_argument("--ranker", default="delove@2", help="network proposing the branch options (DELOVE_BRANCH_RANKER)")
    ap.add_argument("--teacher", default=None, help="rollout teacher, e.g. jacob-sensei@1 (DELOVE_BRANCH_TEACHER; default: the newest"
                    " delove-teacher@N.json in --models). Teacher seats at the tables play their own version")
    d = default_branch()
    ap.add_argument("--options", type=int, default=d.options)
    ap.add_argument("--rollouts", type=int, default=d.rollouts)
    ap.add_argument("--horizon", type=int, default=d.horizon)
    ap.add_argument("--margin", type=float, default=d.margin)
    ap.add_argument("--skip", default=",".join(d.skip))
    ap.add_argument("--score", default=d.score, choices=["share", "points", "kills"], help="branch score (DELOVE_BRANCH_SCORE)")
    ap.add_argument("--batch", type=int, default=0, help="games in flight per configuration (0: sized to --gpu-gb)")
    ap.add_argument("--gpu-gb", type=float, default=3.0, help="GPU memory for game states when sizing batches (networks come on top)")
    ap.add_argument("--out", help="write training arrays here (export's format, one folder per map)")
    ap.add_argument("--export-agents", default=BRANCH_ID)
    ap.add_argument("--precision", default="fp32", choices=["fp32", "tf32", "fp16"])
    ap.add_argument("--max-turns", type=int, default=500)
    ap.add_argument("--summary", help="write the run summary JSON here")
    ap.add_argument("--results", help="write one JSON line per game here (table, index, winner seat, turns)")
    ap.add_argument("--allow-unverified", action="store_true", help="benchmarks only: run even if the mirror is not verified for this engine")
    args = ap.parse_args()
    tables = list(args.table)
    for j in args.jobs:
        tables += read_jobs(j)
    if not tables:
        ap.error("no tables (--table or --jobs)")
    models = Path(args.models)
    teacher = args.teacher
    if teacher is None:
        vs = sorted((int(p.stem.split("@")[1]), p.stem) for p in models.glob("delove-teacher@*.json"))
        teacher = vs[-1][1] if vs else "delove-teacher@1"
    cfg = d
    cfg.options, cfg.rollouts, cfg.horizon, cfg.margin = args.options, args.rollouts, args.horizon, args.margin
    cfg.skip = [k for k in args.skip.split(",") if k]
    cfg.score = args.score
    run = Run(tables, args.seed, models, args.ranker, teacher, cfg, args.export_agents.split(","), Path(args.out) if args.out else None,
              args.max_turns, args.precision, "cuda", args.allow_unverified)
    res = run.run(args.batch or None, args.gpu_gb * 2**30)
    res["tables"] = table_summary(run.results)
    res["config"] = {"seed": args.seed, "ranker": args.ranker, "teacher": teacher, "options": cfg.options, "rollouts": cfg.rollouts,
                     "horizon": cfg.horizon, "margin": cfg.margin, "skip": cfg.skip, "score": cfg.score, "weights": cfg.weights, "batch": args.batch,
                     "precision": args.precision}
    text = json.dumps(res, indent=2)
    print(text)
    if args.summary:
        Path(args.summary).write_text(text + "\n", encoding="utf8")
    if args.results:
        with open(args.results, "w", encoding="utf8") as f:
            for r in sorted(run.results, key=lambda r: (r["table"], r["index"])):
                f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    sys.exit(main())
