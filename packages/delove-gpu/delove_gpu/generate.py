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

Stage tables (the range specialists, delove_gpu/stage.py): agents `A,B,C,D,E,F>X,Y,Z` play a lead-in until 3 players
are left, then X,Y,Z take over and only that part is recorded; `pos:FILE>X,Y` starts every game from a positions
file's 2-alive moments; `split:60/40>X,Y` (options with maxPlayers: the table size) starts every game from a ratio
scenario drawn from its seed (packages/selfplay/src/scenario.ts, asked for through node).
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

from .branch import SCORE_PARTS, SCORES, BranchEngine, GpuBranch, cpu_order, default_branch, first_max, net_ranker
from .config import GameConfig
from .encode import Encoder
from .engine import FINISHED, KIND_NAMES
from .fingerprint import REPO
from .npy import NpyWriter
from .outcome import game_outcome
from .play import load_delove
from .stage import SplitSource, load_positions, parse_agents, parse_split, position_config, read_positions, stage_seats
from .teacher import agent_params, is_teacher, mix_seed

TEACHER, BRANCH, NET = 0, 1, 2
GROUP_STATS = ("decisions", "branched", "simulations", "simulatedMoves", "changed", "rolloutNetSteps")  # per engine group in the summary
BRANCH_ID = "delove-branch@1"


# GPU-only comparison seats: delove-branch@1 followed by any of these ':' tokens (several kinds can sit at one table)
ROLLOUT_TOKENS = {"teacher": "teacher", "net": "all", "netself": "self"}


def branch_variant(agent: str) -> dict:
    """For a branch seat, what it changes from the run's branch settings: {} for delove-branch@1; for a comparison seat
    `delove-branch@1:<token>[:<token>...]` the score (any of SCORES: share, points, kills or the range scores long / mid /
    close / range, e.g. `:range` on one jobs line; branch-env.ts registers delove-branch@1:<score> on the CPU), who plays
    the rollouts (teacher, net: the --rollout-net network in every seat, netself: in the decider's seat) and the options
    (o4: 4 options).
    Not a branch seat: raises ValueError."""
    if agent == BRANCH_ID:
        return {}
    if not agent.startswith(BRANCH_ID + ":"):
        raise ValueError(agent)
    out = {}
    for tok in agent.split(":")[1:]:
        if tok in SCORES:
            out["score"] = tok
        elif tok in ROLLOUT_TOKENS:
            out["rollout"] = ROLLOUT_TOKENS[tok]
        elif tok[:1] == "o" and tok[1:].isdigit() and int(tok[1:]) >= 1:
            out["options"] = int(tok[1:])
        elif tok in ("gumbel", "top"):
            out["root"] = tok
        elif tok[:1] == "k" and tok[1:].isdigit() and int(tok[1:]) >= 2:
            out["gumbel_k"] = int(tok[1:])
        else:
            raise ValueError(agent)
    return out


def is_branch(agent: str) -> bool:
    try:
        branch_variant(agent)
        return True
    except ValueError:
        return False


def engine_group(t: "Table") -> str:
    """The tables that share one engine (and one cloud lane): those of the same configuration, and with comparison seats
    (delove-branch@1:<...>) of the same ones, so each variant of a comparison runs (and is timed) on its own. A cycle's
    tables (plain delove-branch@1) group by configuration alone, as before."""
    kinds = sorted({a for a in t.agents + (t.stage or []) if is_branch(a) and a != BRANCH_ID})
    return t.config.label() + (f" [{' '.join(kinds)}]" if kinds else "")


@dataclass
class Table:
    name: str
    games: int
    agents: list[str]
    start: int = 0
    options: dict = field(default_factory=dict)
    seed: int | None = None  # this table's base seed (default: the run's); ladder.py gives every match its own
    stage: list[str] | None = None  # stage agents (stage.py): they take the survivors' seats when this many are left
    positions: list[dict] | None = None  # a positions table: game i starts from positions[i % len]
    index: list[int] | None = None  # the game numbers this table plays (default start .. start + games - 1)
    split: list[int] | None = None  # a ratio-scenario table (stage.py SplitSource): the survivors' shares, e.g. [60, 40]

    @property
    def indexes(self) -> list[int]:
        return self.index if self.index is not None else [self.start + i for i in range(self.games)]

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
    shares, split_stage = parse_split(parts[2])
    if shares is not None:
        seats = options.get("maxPlayers")
        if not isinstance(seats, int):
            raise argparse.ArgumentTypeError(f"table {s!r}: a split table needs its table size as maxPlayers in the options")
        return Table(parts[0], int(parts[1]), [split_stage[0]] * seats, start, options, stage=split_stage, split=shares)
    lead, pos_file, stage = parse_agents(parts[2])
    if pos_file is None:
        return Table(parts[0], int(parts[1]), lead, start, options, stage=stage)
    if options:
        raise argparse.ArgumentTypeError(f"table {s!r}: a positions file carries its own settings")
    return Table(parts[0], int(parts[1]), [stage[0]], start, stage=stage, positions=read_positions(pos_file, len(stage)))


def expand_positions(tables: list[Table]) -> list[Table]:
    """A positions table becomes one table per configuration its positions are played at (map, seats, settings),
    each with the game numbers whose position (game i: positions[i % count]) is at that table, named NAME:MAP-Np."""
    out = []
    for t in tables:
        if t.positions is None:
            out.append(t)
            continue
        by: dict[GameConfig, list[int]] = {}
        for i in t.indexes:
            by.setdefault(position_config(t.positions[i % len(t.positions)]), []).append(i)
        for cfg, idx in by.items():
            out.append(replace(t, name=f"{t.name}:{cfg.map}-{cfg.seats}p", games=len(idx), agents=[t.stage[0]] * cfg.seats, options=cfg.options_json(), index=idx))
    return out


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
        # What branch and score did at each recorded decision (not in export.ts's arrays; train.py --branch-weights):
        # 0 the teacher's move without comparing options, 1 options compared and the teacher's move kept, 2 changed.
        self.tag = w("branch_tag", "<i1", [])
        # Per candidate row (aligned with cand.npy): the mean branch score of that candidate's option at a branched
        # decision (the score the pick is made on, float32), NaN where the candidate was not compared (unbranched
        # decisions, fortify_to steps, candidates outside the options). train.py --soft-targets; CPU logs get the same
        # array from the branch trace (packages/delove/python/branch_q.py).
        self.q = w("branch_q", "<f4", [])
        self.offset.append(np.array([0], dtype=np.int64))
        self.ncand = 0
        self.uids: list[np.ndarray] = []  # game uid of each row, for z at the end
        self.game_index: dict[int, int] = {}
        # (z, points, points01, placement, kills) per (game, seat)
        self.out_of: dict[tuple[int, int], tuple[float, float, float, int, int]] = {}
        self.m = m
        self.keys: list = []

    def add(self, enc: Encoder, terr, glob, games: torch.Tensor, ordered: torch.Tensor, cnt: torch.Tensor, chosen: torch.Tensor,
            uid: torch.Tensor, seat: torch.Tensor, keys: list | None = None, tag: torch.Tensor | None = None,
            q: tuple[torch.Tensor, torch.Tensor] | None = None):
        """Rows for decisions in `games`: candidates ordered[g, :cnt[g]] (actions.ts order), chosen action. `keys`
        (one per game, optional) are kept in self.keys in row order, for tests that compare rows with export's. `q`:
        (options [B, K] first-step actions, -1 = none; means [B, K] float64, NaN = not branched) of this step's branch
        decisions, written to branch_q.npy per candidate row."""
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
        self.tag.append((tag[games] if tag is not None else torch.zeros_like(games)).to(torch.int8).cpu().numpy())
        self.q.append(option_q(ordered, q, games)[bi, col].to(torch.float32).cpu().numpy())
        self.uids.append(np.stack([u, seat[games].cpu().numpy()], 1))

    def finish_game(self, uid: int, out: dict):
        """out: outcome.outcome() of the finished game (z, points, points01, placement, kills per seat)."""
        for s, z in enumerate(out["z"]):
            self.out_of[(uid, s)] = (z, out["points"][s], out["points01"][s], out["placement"][s], out["kills"][s])

    def close(self, sources: list[str]) -> dict:
        for w in (self.territory, self.glob, self.cand, self.cand_from, self.cand_to, self.offset, self.choice, self.game, self.seat, self.tag, self.q):
            w.close()
        us = np.concatenate(self.uids) if self.uids else np.zeros((0, 2), dtype=np.int64)
        vals = np.array([self.out_of[(int(u), int(s))] for u, s in us], dtype=np.float64).reshape(-1, 5)
        for k, name in enumerate(["z", "points", "points01"]):  # doubles rounded to float32 once, as export.ts stores them
            w = NpyWriter(self.dir / f"{name}.npy", "<f4", [])
            w.append(vals[:, k].astype(np.float32))
            w.close()
        # The decider's final place and kills (outcome.py, the engine's finalPlacements; not in export.ts's arrays):
        # the range specialists' targets (train.py --value-target top2 / --range mid) read placement.npy.
        for k, name in [(3, "placement"), (4, "kills")]:
            w = NpyWriter(self.dir / f"{name}.npy", "<i4", [])
            w.append(vals[:, k].astype(np.int32))
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
                 out: Path | None, max_turns: int, precision: str, device: str, allow_unverified: bool, rollout_net: str | None = None):
        self.tables, self.seed, self.bcfg, self.models = tables, seed, bcfg, models
        self.ranker, self.teacher_id, self.max_turns, self.precision = ranker, teacher, max_turns, precision
        self.device, self.allow_unverified = torch.device(device), allow_unverified
        # the network playing network rollouts (branch.ts rolloutNet), needed when a branch seat uses them
        self.rollout_net = rollout_net
        self.branch_cfgs = {a: replace(bcfg, **branch_variant(a)) for t in tables for a in t.agents + (t.stage or []) if is_branch(a)}
        if any(c.rollout != "teacher" for c in self.branch_cfgs.values()) and not rollout_net:
            raise SystemExit("a branch seat plays network rollouts: name the network with --rollout-net")
        self.agent_ids = sorted({a for t in tables for a in t.agents + (t.stage or [])} | {ranker} | ({rollout_net} if rollout_net else set()))
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
        self.splits = SplitSource()  # ratio scenarios, drawn by node a few hundred at a time
        self.next_uid = 0
        self.stats = {"decisions": 0, "branched": 0, "simulations": 0, "simulatedMoves": 0, "changed": 0, "gain": 0.0,
                      "changedByKind": {}, "branchedByKind": {}, "chosen": {k: 0.0 for k in SCORE_PARTS}, "rolloutNetSteps": 0}
        self.groups: list[dict] = []

    def recorder(self, m) -> Recorder | None:
        if self.out is None:
            return None
        if m.id not in self.recorders:
            self.recorders[m.id] = Recorder(self.out, m, self.consts)
        return self.recorders[m.id]

    def run(self, batch: int | None, budget: float, progress: bool = True) -> dict:
        t0 = time.time()
        groups: dict[str, list[Table]] = {}
        for t in self.tables:
            groups.setdefault(engine_group(t), []).append(t)
        for label, tables in groups.items():
            cfg = tables[0].config
            kinds = {a for t in tables for a in t.agents + (t.stage or []) if is_branch(a)}
            big = max((self.branch_cfgs[a] for a in kinds), key=lambda c: c.options * c.rollouts, default=self.bcfg)
            B = batch or auto_batch(cfg, big, len(kinds), budget)
            B = min(B, max(256, (sum(t.games for t in tables) + 255) // 256 * 256))
            g = Group(self, cfg, tables, B)
            before = {k: self.stats[k] for k in GROUP_STATS}
            info = g.run(progress)
            info.update({"config": cfg.label(), "batch": B, "tables": [t.name for t in tables],
                         "branch": {k: self.stats[k] - before[k] for k in GROUP_STATS}})
            if label != cfg.label():
                info["group"] = label
            self.groups.append(info)
            if progress:
                print(f"  {label}: {info['games']} games in {info['seconds']}s (batch {B})", flush=True)
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
        roll_net = run.net_modules.get(run.rollout_net) if run.rollout_net else None
        self.branches = {ids.index(a): GpuBranch(e, self.nets[run.ranker], run.branch_cfgs[a],
                                                 roll_net=roll_net if run.branch_cfgs[a].rollout != "teacher" else None)
                         for a in sorted({a for t in tables for a in t.agents + (t.stage or []) if is_branch(a)})}
        self.export_idx = torch.tensor([ids.index(a) for a in run.export_agents], dtype=torch.long, device=e.dev)
        self.rec = run.recorder(e.m)
        self.queue = [(ti, i) for ti, t in enumerate(tables) for i in t.indexes]  # i: the game number (its seed)
        self.queue.reverse()
        self.seat_agent = torch.zeros(B, e.n, dtype=torch.long, device=e.dev)
        self.uid = torch.full((B,), -1, dtype=torch.long, device=e.dev)
        # decisions per game as game.ts counts them: one per action, a fortify (two steps here) is one
        self.decisions = torch.zeros(B, dtype=torch.long, device=e.dev)
        self.fortify_to = KIND_NAMES.index("fortify_to")
        self.slot_game: list[tuple[int, int] | None] = [None] * B
        self.occupied = torch.zeros(B, dtype=torch.bool, device=e.dev)
        # stage games: in their lead-in (nothing recorded), the players alive at which the stage starts (0: none)
        self.lead = torch.zeros(B, dtype=torch.bool, device=e.dev)
        self.stop = torch.zeros(B, dtype=torch.long, device=e.dev)
        self.stage_at: list[dict | None] = [None] * B
        self.split_at: list[dict | None] = [None] * B  # a ratio scenario's shares per seat and who held which

    def fill(self, slots: list[int]):
        r = self.r
        g, seeds, pos = [], [], []
        for b in slots:
            if not self.queue:
                break
            ti, i = self.queue.pop()
            t = self.tables[ti]
            g.append(b)
            seeds.append(mix_seed(r.seed if t.seed is None else t.seed, i))
            pos.append(t.positions[i % len(t.positions)] if t.positions is not None else self.split_position(ti, i, seeds[-1]) if t.split else None)
            self.split_at[b] = {"shares": pos[-1]["shares"], "survivors": pos[-1]["survivors"]} if t.split else None
            self.slot_game[b] = (ti, i)
            self.seat_agent[b] = torch.tensor([r.agent_ids.index(a) for a in t.agents], device=self.dev)
            self.e.tver[b] = self.agent_tver[self.seat_agent[b]]
            self.uid[b] = r.next_uid
            self.decisions[b] = 0
            self.lead[b] = t.stage is not None
            self.stop[b] = len(t.stage) if t.stage is not None else 0
            self.stage_at[b] = None
            r.next_uid += 1
        if not g:
            return
        fresh = [k for k, p in enumerate(pos) if p is None]
        if fresh:
            self.e.reset(torch.tensor([g[k] for k in fresh], device=self.dev), torch.tensor([seeds[k] for k in fresh], dtype=torch.long))
        placed = [k for k, p in enumerate(pos) if p is not None]
        if placed:
            load_positions(self.e, [g[k] for k in placed], [pos[k] for k in placed], [seeds[k] for k in placed])
        gt = torch.tensor(g, device=self.dev)
        self.e.seat_streams(gt, torch.tensor(seeds, dtype=torch.long))
        self.occupied[gt] = True
        self.switch()

    def split_request(self, ti: int, seed: int) -> dict:
        t = self.tables[ti]
        return {"shares": t.split, "options": t.options, "seats": len(t.agents), "seed": seed}

    def split_position(self, ti: int, i: int, seed: int, ahead: int = 512) -> dict:
        """Game i's ratio scenario (stage.SplitSource), drawn together with the next `ahead` split games queued here."""
        r = self.r
        nxt = [(tj, j) for tj, j in reversed(self.queue[-ahead:]) if self.tables[tj].split]
        seed_of = lambda tj, j: mix_seed(r.seed if self.tables[tj].seed is None else self.tables[tj].seed, j)  # noqa: E731
        return r.splits.get((id(self), ti, i), self.split_request(ti, seed),
                            [((id(self), tj, j), self.split_request(tj, seed_of(tj, j))) for tj, j in nxt])

    def switch(self):
        """Stage games whose lead-in is over (`stop` or fewer real players alive): the stage agents take the
        survivors' seats (stage.stage_seats, as positions.ts) and recording starts."""
        e, r = self.e, self.r
        nalive = e.alive[:, : e.n].long().sum(1)
        ready = (self.occupied & self.lead & ~e.done & (nalive <= self.stop)).nonzero(as_tuple=True)[0].tolist()
        if not ready:
            return
        order, cur_pos, alive, turn = e.order.cpu(), e.cur_pos.cpu(), e.alive.cpu(), e.turn.cpu()
        for b in ready:
            ti, i = self.slot_game[b]
            t = self.tables[ti]
            for q, k in stage_seats(order[b].tolist(), int(cur_pos[b]), alive[b].tolist(), len(t.stage), i).items():
                self.seat_agent[b, q] = r.agent_ids.index(t.stage[k])
            e.tver[b] = self.agent_tver[self.seat_agent[b]]
            self.stage_at[b] = {"turn": int(turn[b]), "decisions": int(self.decisions[b]), "alive": int(nalive[b]),
                                "agents": [r.agent_ids[x] for x in self.seat_agent[b].tolist()]}
        ix = torch.tensor(ready, device=self.dev)
        self.lead[ix] = False
        self.stop[ix] = 0

    def finish(self, slots: torch.Tensor):
        e = self.e
        for b in slots.tolist():
            ti, i = self.slot_game[b]
            t = self.tables[ti]
            won = int(e.phase[b]) == FINISHED
            winner = int(e.winner[b]) if won else None
            out = game_outcome(e, b)
            res = {"table": t.name, "index": i, "winner": winner, "turns": int(e.turn[b]), "agents": t.agents,
                   "decisions": int(self.decisions[b]), "placement": out["placement"], "kills": out["kills"], "points": out["points"]}
            if t.stage is not None:  # when the stage began (None: the game ended in its lead-in) and who played it
                res["stage"] = self.stage_at[b]
            if t.split:  # a ratio scenario: each seat's share, and the seat of share j
                res["split"] = self.split_at[b]
            self.r.results.append(res)
            if self.rec:
                self.rec.finish_game(int(self.uid[b]), out)
            self.slot_game[b] = None
        self.occupied[slots] = False

    def _record(self, games, ordered, cnt, chosen, terr, glob, q=None):
        if self.rec is None or games.numel() == 0:
            return
        ag = self.seat_agent[games, self.e.cur[games]]
        keep = (ag[:, None] == self.export_idx[None, :]).any(1) & ~self.lead[games]
        g = games[keep]
        self.rec.add(self.enc, terr, glob, g, ordered, cnt, chosen, self.uid, self.e.cur, tag=self.btag, q=q)

    def _branch_stats(self, d):
        s = self.r.stats
        n_imp = int(d.branched.sum())
        s["decisions"] += d.games.numel()
        s["branched"] += n_imp
        if n_imp == 0:
            return
        L = self.e.L
        nopt = (d.options[d.branched] >= 0).sum(1)
        s["simulations"] += int(d.copies[d.branched].sum()) if d.copies is not None else int((nopt * d.rollouts[d.branched]).sum())
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
        self.btag = torch.zeros(B, dtype=torch.int8, device=dev)  # this step's branch tag per game (Recorder)
        kq = branch_q_width([b.cfg for b in self.branches.values()])
        self.bq_opts = torch.full((B, kq), -1, dtype=torch.long, device=dev)  # this step's branch options and mean scores
        self.bq_means = torch.full((B, kq), float("nan"), dtype=torch.float64, device=dev)
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
        is_teacher = self.agent_type == TEACHER
        while bool(self.occupied.any()):
            # a lead-in records nothing, so all its teacher seats play in place, up to the stage's players alive
            tseat = torch.where(self.lead[:, None], is_teacher[self.seat_agent], fast[self.seat_agent])  # [B, seats]
            e.teacher_run(tseat, self.occupied & ~e.done, self.decisions, stop=self.stop)
            self.switch()
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
            exported = ((ag[:, None] == self.export_idx[None, :]).any(1) & ~self.lead) if self.rec else torch.zeros_like(active)
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
            self.btag.zero_()
            self.bq_opts.fill_(-1)
            self.bq_means.fill_(float("nan"))
            for idx, branch in self.branches.items():
                bg = (active & (ag == idx)).nonzero(as_tuple=True)[0]
                if bg.numel():
                    d = branch.decide(bg, mask, tact)
                    act1[bg] = d.act1
                    act2[bg] = d.act2
                    self.btag[bg] = d.branched.to(torch.int8) + d.changed.to(torch.int8)
                    put_branch_q(self.bq_opts, self.bq_means, bg, d)
                    self._branch_stats(d)
            ordered, cnt = e.cand_order() if self.rec else (None, None)
            self._record(active.nonzero(as_tuple=True)[0], ordered, cnt, act1, terr, glob, (self.bq_opts, self.bq_means))
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
        r.stats["rolloutNetSteps"] += sum(b.roll_steps for b in self.branches.values())
        return {"games": done_games, "seconds": round(time.time() - t0, 1), "steps": it, "odds_outside_tables": int(e.tstats[0]),
                "peak_gpu_gb": round(torch.cuda.max_memory_allocated(dev) / 2**30, 2)}


def option_q(ordered: torch.Tensor, q: tuple[torch.Tensor, torch.Tensor] | None, games: torch.Tensor) -> torch.Tensor:
    """[n, L] float64: for each candidate ordered[g, j] of `games`, the mean score of the branch option that played it
    (q = (options [B, K], means [B, K]); NaN where it was not an option or there was no branch decision)."""
    o = ordered[games]
    out = torch.full(o.shape, float("nan"), dtype=torch.float64, device=o.device)
    if q is None:
        return out
    opts, means = q[0][games], q[1][games]
    hit = (o[:, :, None] == opts[:, None, :]) & (opts[:, None, :] >= 0)
    val = means.gather(1, hit.long().argmax(2))
    return torch.where(hit.any(2), val, out)


def branch_q_width(cfgs) -> int:
    """Columns of a step's branch options and mean scores (branch_q.npy): the most options any branch seat compares
    (a Gumbel root's candidates, gumbel_k, can be more than options)."""
    return max([c.gumbel_k if c.root == "gumbel" else c.options for c in cfgs] or [1])


def put_branch_q(bq_opts: torch.Tensor, bq_means: torch.Tensor, bg: torch.Tensor, d) -> None:
    """A branch seat's Decision `d` for main games `bg` into the step's options and mean scores (nan: not branched)."""
    k = d.options.shape[1]
    bq_opts[bg, :k] = torch.where(d.branched[:, None], d.options, -1)
    bq_means[bg, :k] = torch.where(d.branched[:, None], d.means[:, :, 0], float("nan"))


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
    ap.add_argument("--score", default=d.score, choices=SCORES, help="branch score (DELOVE_BRANCH_SCORE); a seat"
                    " delove-branch@1:<score> keeps its own")
    ap.add_argument("--kill-weight", type=float, default=d.kill_weight, help="score long: kill credit weight (DELOVE_BRANCH_KILL_WEIGHT)")
    ap.add_argument("--threat", type=float, default=d.threat, help="score mid: threat deflection weight (DELOVE_BRANCH_THREAT)")
    ap.add_argument("--close-rollouts", type=int, default=d.close_rollouts, help="score close: rollouts (DELOVE_BRANCH_CLOSE_ROLLOUTS)")
    ap.add_argument("--close-horizon", type=int, default=d.close_horizon, help="score close: horizon (DELOVE_BRANCH_CLOSE_HORIZON)")
    ap.add_argument("--rollout", default=None, help="who plays the rollouts of delove-branch@1 (DELOVE_BRANCH_ROLLOUT): unset the teacher;"
                    " MODEL or MODEL:all a Delove network in every seat; MODEL:self in the decider's seat only (the teacher in the"
                    " others). Comparison seats delove-branch@1:net / :netself / :teacher pick their own, with MODEL (or --rollout-net)")
    ap.add_argument("--rollout-net", default=None, help="the rollout network for :net / :netself seats when --rollout is not given")
    ap.add_argument("--root", default=d.root, choices=["top", "gumbel"], help="branch root (DELOVE_BRANCH_ROOT); seats delove-branch@1:gumbel"
                    " / :top pick their own, :k<N> their candidates")
    ap.add_argument("--gumbel-k", type=int, default=d.gumbel_k, help="Gumbel root: candidates, the teacher's move included (DELOVE_BRANCH_K)")
    ap.add_argument("--copies", type=int, default=d.copies, help="Gumbel root: copies per decision, 0 = options x rollouts (DELOVE_BRANCH_COPIES)")
    ap.add_argument("--incumbent", default=d.incumbent, choices=["teacher", "net"], help="T2: the move the margin rule protects (DELOVE_BRANCH_INCUMBENT)")
    ap.add_argument("--styles", default=d.styles, help="T2: opponent styles in the rollouts, e.g. net:0.4,aggr:0.2,turtle:0.2,zerg:0.2 (DELOVE_BRANCH_STYLES; needs --rollout)")
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
    tables = expand_positions(tables)
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
    cfg.kill_weight, cfg.threat, cfg.close_rollouts, cfg.close_horizon = args.kill_weight, args.threat, args.close_rollouts, args.close_horizon
    rollout_net = args.rollout_net
    if args.rollout:
        rollout_net, _, seats = args.rollout.partition(":")
        if seats not in ("", "all", "self"):
            ap.error(f"--rollout {args.rollout}: want MODEL, MODEL:all or MODEL:self")
        cfg.rollout = seats or "all"
    cfg.root, cfg.gumbel_k, cfg.copies = args.root, args.gumbel_k, args.copies
    cfg.incumbent, cfg.styles = args.incumbent, args.styles
    run = Run(tables, args.seed, models, args.ranker, teacher, cfg, args.export_agents.split(","), Path(args.out) if args.out else None,
              args.max_turns, args.precision, "cuda", args.allow_unverified, rollout_net)
    res = run.run(args.batch or None, args.gpu_gb * 2**30)
    res["tables"] = table_summary(run.results)
    res["config"] = {"seed": args.seed, "ranker": args.ranker, "teacher": teacher, "options": cfg.options, "rollouts": cfg.rollouts,
                     "horizon": cfg.horizon, "margin": cfg.margin, "skip": cfg.skip, "score": cfg.score, "rollout": cfg.rollout, "rolloutNet": rollout_net,
                     "root": cfg.root, "gumbelK": cfg.gumbel_k, "copies": cfg.copies,
                     "killWeight": cfg.kill_weight, "threat": cfg.threat, "closeRollouts": cfg.close_rollouts, "closeHorizon": cfg.close_horizon,
                     "weights": cfg.weights, "batch": args.batch,
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
