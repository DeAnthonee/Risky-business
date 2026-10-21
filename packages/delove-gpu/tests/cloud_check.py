"""Offline checks of the cloud tooling (cloud/merge.py, cloud/remote.py): no GPU, no pods, no API key.

1. merge: a real training-array folder is cut into K worker folders (games dealt round-robin, each written as
   generate.py would: rows in order, cand_offset from 0, games numbered from 0) and merged back with cloud/merge.py;
   the merged folder must hold exactly the same games, bit for bit (tests/dataset_compare.py's game hashes), and the
   same row and candidate counts. Also checks the merged gpu.json tables and branch statistics.
2. plan: remote.py's split puts every configuration of the jobs files on exactly one lane, and the lane scripts and
   jobs lines it uploads parse back to the same tables (parse_table).
3. run: remote.py end to end against a fake RunPod API, fake pods and a fake clock: every pod is terminated on every
   path and no upload tar (it holds the models) is left behind; a pod that is never reachable, an upload that fails,
   a worker that fails and a lane that delivers nothing are each replaced, and the run still merges every game into
   DATA/<name>-<step>/ and OUT/<step>/; a slot that never gets a working pod exits 1 after the healthy pod's lanes
   were downloaded; Ctrl+C mid-upload terminates everything (with --data and --jobs).

    python tests/cloud_check.py --data data/delove/c6-micro/skirmish [--games 600] [--jobs packages/delove/scripts/cycles/c6-big.jobs]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "cloud"))
sys.path.insert(0, str(HERE))
from dataset_compare import game_hashes  # noqa: E402
from merge import CAND_ARRAYS, merge_map, merge_summaries  # noqa: E402

from delove_gpu.npy import NpyWriter  # noqa: E402


def cut(src: Path, games: list[int], dst: Path, sources: list[str]):
    """The rows of `games` (in their order in src) as a folder of their own, numbered from 0 like a fresh writer."""
    L = lambda n: np.load(src / f"{n}.npy", mmap_mode="r")  # noqa: E731
    game, off = np.asarray(L("game")), np.asarray(L("cand_offset"))
    keep = np.isin(game, games)
    rows = np.nonzero(keep)[0]
    order = {g: i for i, g in enumerate(dict.fromkeys(game[rows].tolist()))}
    dst.mkdir(parents=True)
    counts = np.diff(off)[rows]
    for p in sorted(src.glob("*.npy")):
        n = p.stem
        a = L(n)
        w = NpyWriter(dst / p.name, a.dtype.str, list(a.shape[1:]))
        if n == "cand_offset":
            w.append(np.concatenate([[0], np.cumsum(counts)]).astype(a.dtype))
        elif n == "game":
            w.append(np.array([order[g] for g in game[rows].tolist()], dtype=a.dtype))
        elif n in CAND_ARRAYS:
            for r in rows.tolist():
                w.append(np.asarray(a[off[r]:off[r + 1]]))
        else:
            w.append(np.asarray(a[rows]))
        w.close()
    info = json.loads((src / "features.json").read_text(encoding="utf8"))
    info.update({"decisions": int(rows.size), "candidates": int(counts.sum()), "games": len(order), "sources": sources})
    (dst / "features.json").write_text(json.dumps(info, indent=1) + "\n", encoding="utf8")


def check_merge(data: Path, n_games: int, k: int) -> bool:
    game = np.load(data / "game.npy", mmap_mode="r")
    all_games = list(dict.fromkeys(np.asarray(game).tolist()))[:n_games]
    tmp = Path(tempfile.mkdtemp(prefix="cloud-check-"))
    try:
        whole = tmp / "whole"
        cut(data, all_games, whole, ["gpu:all"])
        parts = []
        for i in range(k):
            d = tmp / f"w{i}"
            cut(whole, [g for j, g in enumerate(range(len(all_games))) if j % k == i], d, [f"gpu:t{i}"])
            parts.append(d)
        merged = tmp / "merged"
        counts = merge_map(parts, merged)
        hw, hm = game_hashes(whole), game_hashes(merged)
        fw = json.loads((whole / "features.json").read_text(encoding="utf8"))
        ok = hw == hm and all(counts[c] == fw[c] for c in ("decisions", "candidates", "games"))
        off = np.load(merged / "cand_offset.npy")
        ok = ok and int(off[-1]) == fw["candidates"] and np.load(merged / "cand.npy", mmap_mode="r").shape[0] == fw["candidates"]
        print(f"merge: {len(all_games)} games of {data} cut into {k} workers and merged: {sum(hm.values())} games, "
              f"{sum((hw & hm).values())} identical, {counts['decisions']} rows, {counts['candidates']} candidates -> {'OK' if ok else 'MISMATCH'}")
        return ok
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_summaries() -> bool:
    a = {"games": 3, "seconds": 10.0, "groups": [{"config": "x"}], "config": {"seed": 1},
         "branch": {"decisions": 5, "gain": 1.5, "changedByKind": {"place": 1}, "chosen": {"a": 1.0}},
         "tables": [{"table": "t1", "agents": ["a", "b"], "games": 3, "wins": [2, 1], "turnLimit": 0, "turns": 30, "decisions": 50, "meanTurns": 10.0}]}
    b = {"games": 2, "seconds": 20.0, "groups": [{"config": "y"}], "config": {"seed": 1},
         "branch": {"decisions": 7, "gain": 0.5, "changedByKind": {"attack": 2}, "chosen": {"a": 2.0}},
         "tables": [{"table": "t2", "agents": ["a", "b"], "games": 2, "wins": [0, 1], "turnLimit": 1, "turns": 50, "decisions": 40, "meanTurns": 25.0}]}
    m = merge_summaries([a, b], [])
    ok = (m["games"] == 5 and m["seconds"] == 20.0 and len(m["groups"]) == 2 and m["branch"]["decisions"] == 12
          and m["branch"]["changedByKind"] == {"place": 1, "attack": 2} and m["branch"]["chosen"]["a"] == 3.0
          and [t["table"] for t in m["tables"]] == ["t1", "t2"])
    print(f"summaries: {'OK' if ok else 'MISMATCH'}")
    return ok


def check_plan(jobs: str) -> bool:
    import remote
    from delove_gpu.generate import parse_table, read_jobs

    units = remote.make_units([("big", jobs)], None, {}, cached=True)
    lanes = remote.assign(units, 3, 2, 1, 1.0)
    tables = read_jobs(jobs)
    placed = [t.name for lane in lanes for u in lane.units for t in u.tables]
    ok = sorted(placed) == sorted(t.name for t in tables)
    lines = [remote.table_line(t) for lane in lanes for u in lane.units for t in u.tables]
    back = {t.name: t for t in map(parse_table, lines)}
    ok = ok and all(back[t.name].games == t.games and back[t.name].agents == t.agents and back[t.name].options == t.options for t in tables)
    ok = ok and all(f"CUDA_VISIBLE_DEVICES={lane.gpu}" in remote.lane_script(lane, ["--seed", "1"]) for lane in lanes if lane.units)
    print(f"plan: {len(tables)} tables in {len(units)} configurations over {sum(1 for lane in lanes if lane.units)} lanes, "
          f"each table once, jobs lines round-trip -> {'OK' if ok else 'MISMATCH'}")
    return ok


def check_run(data: Path, jobs: str) -> bool:
    """remote.run end to end against a fake RunPod API, fake pods and a fake clock (no network, no waiting): each pod
    'plays' its lanes by returning a cut of `data` per lane and step. In every scenario every pod created is terminated
    and no upload tar (it holds the models) is left behind. One bad pod never sinks the others: a pod that is never
    reachable, an upload that fails, a worker that fails and a lane that delivers nothing are each replaced and the run
    still merges all 20 games; a slot that never gets a working pod ends the run with exit 1 after the healthy pod's
    lanes were downloaded; Ctrl+C mid-upload terminates everything."""
    import subprocess as sp
    import tarfile as tf

    import remote

    game = np.load(data / "game.npy", mmap_mode="r")
    pool = list(dict.fromkeys(np.asarray(game[:20000]).tolist()))
    ok = True
    # scenario: (pods expected, exit expected, merged games expected)
    scenarios = {"success": (2, 0, 20), "unreachable pod": (3, 0, 20), "upload fails": (3, 0, 20), "worker fails": (3, 0, 20),
                 "lane delivers nothing": (3, 0, 20), "slot never works": (4, 1, 0), "crash": (2, "interrupted", 0)}
    for scenario, (want_pods, want_rc, want_games) in scenarios.items():
        tmp = Path(tempfile.mkdtemp(prefix="cloud-run-"))
        calls, pods = [], {}

        class Clock:  # remote.time: time() and sleep() on a fake clock, so the 15-minute ready limit passes at once
            now = 1.0e9

            @classmethod
            def time(cls):
                return cls.now

            @classmethod
            def sleep(cls, s):
                cls.now += s

        def bad(pod_id):  # the first pod of slot 1 (pod1) is the bad one; "slot never works" makes every slot-1 pod bad
            return pod_id == "pod1" or (scenario == "slot never works" and pods.get(pod_id, {}).get("name", "").split("-")[-1].startswith("1"))

        def api(method, path, body=None):
            calls.append((method, path))
            if method == "POST":
                i = f"pod{len(pods)}"
                pods[i] = body
                return {"id": i, "costPerHr": 0.89}
            if method == "GET":
                i = path.rsplit("/", 1)[-1]
                if scenario in ("unreachable pod", "slot never works") and bad(i):
                    return {"publicIp": "", "portMappings": None, "costPerHr": 0.89}
                return {"publicIp": "203.0.113.1", "portMappings": {"22": 22000}, "costPerHr": 0.89}
            return {}

        class FakeSsh:
            def __init__(self, work):
                self.pub = "ssh-ed25519 AAAA test"
                self.lanes = {}

            def run(self, pod, cmd, timeout=0, check=True):
                if cmd.startswith("cat /root/job/status"):
                    if scenario in ("worker fails", "lane delivers nothing") and pod.id == "pod1":
                        return "failed: a lane failed\n"
                    return "done\n"
                return "ok\n"

            def put(self, pod, local, remote_path, timeout=0):
                if scenario == "crash":
                    raise KeyboardInterrupt("simulated Ctrl+C during upload")
                if scenario == "upload fails" and pod.id == "pod1":
                    raise sp.CalledProcessError(255, "ssh")
                with tf.open(local) as t:
                    self.lanes[pod.id] = sorted(int(m.name[5:-3]) for m in t.getmembers() if m.name.startswith("lane-") and m.name.endswith(".sh"))

            def get(self, pod, remote_path, local, timeout=0):
                if scenario == "worker fails" and pod.id == "pod1":
                    raise sp.CalledProcessError(1, "ssh")  # the worker left nothing
                stage = tmp / f"stage-{pod.id}"
                for li in self.lanes[pod.id]:
                    if scenario == "lane delivers nothing" and pod.id == "pod1" and li == self.lanes[pod.id][-1]:
                        continue  # this lane failed on this pod; the others delivered
                    d = stage / "lanes" / str(li) / "big"
                    games = pool[li * 5:(li + 1) * 5]
                    cut(data, games, d / "data" / data.name, [f"gpu:lane{li}"])
                    summary = {"games": len(games), "seconds": 1.0, "groups": [], "branch": {"decisions": 1}, "config": {},
                               "tables": [{"table": f"t{li}", "agents": ["a"], "games": len(games), "wins": [1], "turnLimit": 0,
                                           "turns": 10, "decisions": 1, "meanTurns": 1}]}
                    (d / "gpu.json").write_text(json.dumps(summary), encoding="utf8")
                    (d / "gpu.log").write_text("log\n", encoding="utf8")
                stage.mkdir(parents=True, exist_ok=True)
                (stage / "env.json").write_text("{}", encoding="utf8")
                with tf.open(local, "w:gz") as t:
                    for p in stage.iterdir():
                        t.add(p, arcname=p.name)
                shutil.rmtree(stage)

            def forget(self):
                pass

        fake_ssh = {}

        def make_ssh(work):
            fake_ssh["s"] = FakeSsh(work)
            return fake_ssh["s"]

        saved = remote.api, remote.Ssh, remote.time
        remote.api, remote.Ssh, remote.time = api, make_ssh, Clock
        models = tmp / "models"
        models.mkdir()
        for m in ("delove@2", "delove@3"):
            (models / f"{m}.pt").write_bytes(b"x")
        (models / "jacob-sensei@1.json").write_text("{}")
        out, dat = tmp / "runs", tmp / "data"
        (out / "big").mkdir(parents=True)
        # 2 pods x 2 processes: 4 lanes, one configuration each (w10a, w10b, ge6a, ge6b), 5 games per lane
        argv = ["run", "--name", "t", "--step", f"big={jobs}", "--only", "w10a,w10b,ge6a,ge6b", "--pods", "2", "--procs", "2",
                "--models", str(models), "--data", str(dat), "--out", str(out), "--max-gpu-hours", "10", "--cache", str(tmp / "nocache"),
                "--yes", "--", "--seed", "1", "--ranker", "delove@3"]
        try:
            rc = remote.main(argv)
        except KeyboardInterrupt:
            rc = "interrupted"
        finally:
            remote.api, remote.Ssh, remote.time = saved
        deleted = sorted(p for m, p in calls if m == "DELETE")
        terminated = deleted == sorted(f"/pods/{i}" for i in pods)
        good = terminated and len(pods) == want_pods and rc == want_rc and not list(tmp.glob("runs/remote/upload-*.tar"))
        res = json.loads((out / "big" / "gpu.json").read_text(encoding="utf8")) if (out / "big" / "gpu.json").exists() else {}
        merged = dat / "t-big" / data.name
        got = sum(game_hashes(merged).values()) if merged.exists() else 0
        good = good and res.get("games", 0) == want_games and got == want_games
        s = fake_ssh.get("s")
        if scenario == "lane delivers nothing" and s:  # the replacement got only the lane that delivered nothing
            good = good and s.lanes.get("pod2") == s.lanes.get("pod1", [None])[-1:]
        if scenario == "slot never works" and s:  # the healthy pod still played and was downloaded
            good = good and "pod0" in s.lanes and ("DELETE", "/pods/pod0") in calls
        if scenario == "success":
            good = good and "watchdog" in json.dumps(pods["pod0"]["dockerStartCmd"])
        print(f"run ({scenario}): {len(pods)} pods created, {len(deleted)} terminated, exit {rc}, {got} games merged -> {'OK' if good else 'MISMATCH'}")
        ok = ok and good
        shutil.rmtree(tmp, ignore_errors=True)
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", help="a training-array map folder (e.g. data/delove/c6-micro/skirmish)")
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--jobs", help="a jobs file for the plan check")
    args = ap.parse_args()
    ok = check_summaries()
    if args.data:
        ok = check_merge(Path(args.data), args.games, args.workers) and ok
    if args.jobs:
        ok = check_plan(args.jobs) and ok
    if args.jobs and args.data:
        ok = check_run(Path(args.data), args.jobs) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
