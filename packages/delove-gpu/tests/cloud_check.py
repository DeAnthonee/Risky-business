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
   were downloaded; Ctrl+C mid-upload terminates everything; with --volume the pods run in the volume's data center,
   their archives stay on it (only gpu.json, logs and features.json come home unless --home-copy) and volume.json lists
   them in merge order (with --data and --jobs).
4. trainer: cloud/trainer.py merges those archives into the same games, keeps the dataset on the volume, unpacks it
   again for a later cycle and handles an abort (with --data and --jobs).
5. train: `remote.py train` end to end against a fake API, pod and clock (see check_train); the API key only in the
   Authorization header.

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
    still merges all 20 games; a pod whose first DELETE fails gets no replacement until a DELETE succeeds; a slot that never gets a working pod ends the run with exit 1 after the healthy pod's
    lanes were downloaded; Ctrl+C mid-upload terminates everything."""
    import subprocess as sp
    import tarfile as tf

    import remote

    game = np.load(data / "game.npy", mmap_mode="r")
    pool = list(dict.fromkeys(np.asarray(game[:20000]).tolist()))
    ok = True
    # scenario: (pods expected, exit expected, merged games expected)
    scenarios = {"success": (2, 0, 20), "unreachable pod": (3, 0, 20), "upload fails": (3, 0, 20), "worker fails": (3, 0, 20),
                 "lane delivers nothing": (3, 0, 20), "delete fails once": (3, 0, 20), "slot never works": (4, 1, 0), "crash": (2, "interrupted", 0),
                 "volume": (3, 0, 20), "volume, home copy": (2, 0, 20)}
    for scenario, (want_pods, want_rc, want_games) in scenarios.items():
        tmp = Path(tempfile.mkdtemp(prefix="cloud-run-"))
        calls, pods = [], {}
        volume = tmp / "volume"  # the network volume's /workspace/delove
        use_volume = scenario.startswith("volume")

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
            if method == "GET" and path.startswith("/networkvolumes/"):
                return {"id": "vol1", "name": "delove-data", "size": 100, "dataCenterId": "EU-RO-1"}
            if method == "GET":
                i = path.rsplit("/", 1)[-1]
                if scenario in ("unreachable pod", "delete fails once", "slot never works") and bad(i):
                    return {"publicIp": "", "portMappings": None, "costPerHr": 0.89}
                return {"publicIp": "203.0.113.1", "portMappings": {"22": 22000}, "costPerHr": 0.89}
            if scenario == "delete fails once" and path == "/pods/pod1" and calls.count(("DELETE", path)) == 1:
                raise remote.RunPodError("RunPod DELETE /pods/pod1: HTTP 500")  # the bad pod is still there, still billed
            return {}

        class FakeSsh:
            def __init__(self, work):
                self.pub = "ssh-ed25519 AAAA test"
                self.lanes, self.jobs = {}, {}

            def run(self, pod, cmd, timeout=0, check=True):
                if cmd.startswith("cat /root/job/status"):
                    if scenario in ("worker fails", "lane delivers nothing", "volume") and pod.id == "pod1":
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
                    self.jobs[pod.id] = json.loads(t.extractfile("job.json").read())

            def get(self, pod, remote_path, local, timeout=0):
                if scenario == "worker fails" and pod.id == "pod1":
                    raise sp.CalledProcessError(1, "ssh")  # the worker left nothing
                stage = tmp / f"stage-{pod.id}"
                for li in self.lanes[pod.id]:
                    if scenario in ("lane delivers nothing", "volume") and pod.id == "pod1" and li == self.lanes[pod.id][-1]:
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
                job = self.jobs[pod.id]
                if job.get("volume"):  # worker.sh: the full archive on the volume; home gets it ("full") or no arrays ("small")
                    full = volume / job["volume"][len(remote.VOL) + 1:]
                    full.parent.mkdir(parents=True, exist_ok=True)
                    with tf.open(full, "w:gz") as t:
                        for p in stage.iterdir():
                            t.add(p, arcname=p.name)
                no_npy = (lambda m: None if m.name.endswith(".npy") else m) if job.get("home") == "small" else None
                with tf.open(local, "w:gz") as t:
                    for p in stage.iterdir():
                        t.add(p, arcname=p.name, filter=no_npy)
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
                "--yes", *(["--volume", "vol1"] if use_volume else []), *(["--home-copy"] if scenario == "volume, home copy" else []),
                "--", "--seed", "1", "--ranker", "delove@3"]
        try:
            rc = remote.main(argv)
        except KeyboardInterrupt:
            rc = "interrupted"
        finally:
            remote.api, remote.Ssh, remote.time = saved
        deleted = sorted(set(p for m, p in calls if m == "DELETE"))
        terminated = deleted == sorted(f"/pods/{i}" for i in pods)
        good = terminated and len(pods) == want_pods and rc == want_rc and not list(tmp.glob("runs/remote/upload-*.tar"))
        res = json.loads((out / "big" / "gpu.json").read_text(encoding="utf8")) if (out / "big" / "gpu.json").exists() else {}
        merged = dat / "t-big" / data.name
        got = sum(game_hashes(merged).values()) if merged.exists() else 0
        good = good and res.get("games", 0) == want_games and (got == want_games or scenario == "volume")
        s = fake_ssh.get("s")
        if scenario == "lane delivers nothing" and s:  # the replacement got only the lane that delivered nothing
            good = good and s.lanes.get("pod2") == s.lanes.get("pod1", [None])[-1:]
        if scenario == "delete fails once":  # no replacement was rented while the bad pod could still be billed
            deletes = [n for n, c in enumerate(calls) if c == ("DELETE", "/pods/pod1")]
            posts = [n for n, c in enumerate(calls) if c[0] == "POST"]
            good = good and len(deletes) == 2 and len(posts) == 3 and posts[2] > deletes[1]
        if scenario == "slot never works" and s:  # the healthy pod still played and was downloaded
            good = good and "pod0" in s.lanes and ("DELETE", "/pods/pod0") in calls
        if scenario == "success":
            good = good and "watchdog" in json.dumps(pods["pod0"]["dockerStartCmd"]) and "networkVolumeId" not in pods["pod0"]
        if use_volume and s:  # pinned to the volume's data center; the archives on it are what volume.json says, in merge order
            small = scenario == "volume"
            good = good and all(b.get("networkVolumeId") == "vol1" and b.get("dataCenterIds") == ["EU-RO-1"] for b in pods.values())
            good = good and all(j["home"] == ("small" if small else "full") and j["volume"].startswith(f"{remote.VOL}/incoming/t/")
                                for j in s.jobs.values())
            man = json.loads((out / "remote" / "volume.json").read_text(encoding="utf8"))
            parts = man["steps"]["big"]["parts"]
            good = good and man["volume"] == "vol1" and [x["lane"] for x in parts] == [0, 1, 2, 3] and all((volume / x["tar"]).exists() for x in parts)
            good = good and (out / "remote" / "eta").exists()
            if small:  # no arrays came home: gpu.json counted from features.json; the merge is the trainer's, on the volume
                good = good and not (dat / "t-big").exists() and res.get("export", [{}])[0].get("games") == 20
                good = good and parts[-1]["tar"].endswith("r1.tar.gz")  # the replaced lane comes from the replacement's archive
                good = good and check_trainer(data, volume, man, pool[:20], tmp)
                got = 20 if good else 0
        print(f"run ({scenario}): {len(pods)} pods created, {len(deleted)} terminated, exit {rc}, {got} games merged -> {'OK' if good else 'MISMATCH'}")
        ok = ok and good
        shutil.rmtree(tmp, ignore_errors=True)
    return ok


def check_trainer(data: Path, volume: Path, manifest: dict, games: list[int], tmp: Path) -> bool:
    """The training pod's side (cloud/trainer.py) on the archives a volume run left: the step merged from them holds
    exactly the games a home merge would, is kept on the volume as datasets/<dataset>/<map>.tar.gz, and the incoming
    archives are gone; a later pod unpacks it again with train.py's --data suffix; merging again does nothing; an
    aborted go.json fails the job and deletes the models."""
    import trainer

    steps = manifest["steps"]
    ds, m = steps["big"]["dataset"], data.name
    work = tmp / "pod-disk"
    wrote = trainer.merge_steps({"steps": steps}, volume, work)
    whole = tmp / "whole"
    cut(data, games, whole, ["gpu:all"])
    want = game_hashes(whole)
    ok = wrote == [ds] and (volume / "datasets" / ds / f"{m}.tar.gz").exists() and not (volume / "incoming" / "t").exists()
    ok = ok and game_hashes(work / "data" / ds / m) == want
    later = tmp / "later-pod-disk"
    args = trainer.fetch({"data": [{"dataset": ds, "map": m, "suffix": ":value#0.3"}]}, volume, later)
    ok = ok and args == ["--data", f"{later / 'data' / ds / m}:value#0.3"] and game_hashes(later / "data" / ds / m) == want
    ok = ok and trainer.merge_steps({"steps": steps}, volume, tmp / "again") == []
    job = tmp / "job"
    (job / "models").mkdir(parents=True)
    (job / "models" / "delove@4.pt").write_bytes(b"x")
    (job / "job.json").write_text(json.dumps({"name": "t", "train": False, "data": []}), encoding="utf8")
    (job / "go.json").write_text(json.dumps({"abort": "generation failed"}), encoding="utf8")
    rc = trainer.main(["--job", str(job), "--volume", str(volume), "--work", str(tmp / "w")])
    ok = ok and rc == 1 and (job / "status").read_text(encoding="utf8").startswith("failed: aborted") and not (job / "models").exists()
    print(f"trainer: {sum(game_hashes(work / 'data' / ds / m).values())} games merged on the volume, kept as datasets/{ds}/{m}.tar.gz, "
          f"unpacked again by a later pod, abort handled -> {'OK' if ok else 'MISMATCH'}")
    return ok


def check_train() -> bool:
    """remote.py train end to end against a fake RunPod API, a fake pod and a fake clock: the pod is rented in the
    volume's data center, gets only the init model, sets up while generation finishes and gets go.json only once
    generation's files exist; only the candidate's files and train.log come back. Every pod is terminated on every path
    and no upload tar (it holds the init model) is left behind. A dataset the volume lacks exits 3 before anything
    private is uploaded, or is pushed with --push-missing; an unreachable pod and a failed setup are replaced (a pod
    whose DELETE fails gets no replacement until a DELETE succeeds); a failed training is not; generation failing before
    or after the pod was rented ends it with exit 1; Ctrl+C mid-upload terminates it."""
    import subprocess as sp  # noqa: F401
    import tarfile as tf

    import remote

    ok = True
    scenarios = {"success": (1, 0), "missing dataset": (1, 3), "push": (1, 0), "unreachable pod": (2, 0), "setup fails": (2, 0),
                 "training fails": (1, 1), "delete fails once": (2, 0), "abort before a pod": (0, 1), "abort while waiting": (1, 1),
                 "waits for generation": (1, 0), "crash": (1, "interrupted")}
    for scenario, (want_pods, want_rc) in scenarios.items():
        tmp = Path(tempfile.mkdtemp(prefix="cloud-train-"))
        calls, pods = [], {}

        class Clock:
            now = 1.0e9

            @classmethod
            def time(cls):
                return cls.now

            @classmethod
            def sleep(cls, s):
                cls.now += s

        def api(method, path, body=None):
            calls.append((method, path))
            if method == "POST":
                i = f"pod{len(pods)}"
                pods[i] = body
                return {"id": i, "costPerHr": 0.69}
            if method == "GET" and path.startswith("/networkvolumes/"):
                return {"id": "vol1", "name": "delove-data", "size": 100, "dataCenterId": "EU-RO-1"}
            if method == "GET":
                if scenario in ("unreachable pod", "delete fails once") and path.endswith("/pod0"):
                    return {"publicIp": "", "portMappings": None, "costPerHr": 0.69}
                return {"publicIp": "203.0.113.2", "portMappings": {"22": 22001}, "costPerHr": 0.69}
            if scenario == "delete fails once" and path == "/pods/pod0" and calls.count(("DELETE", path)) == 1:
                raise remote.RunPodError("RunPod DELETE /pods/pod0: HTTP 500")
            return {}

        out, models, data_root = tmp / "runs", tmp / "models", tmp / "data"
        (out / "remote").mkdir(parents=True)
        models.mkdir()
        for m in ("delove@4", "delove@3"):
            (models / f"{m}.pt").write_bytes(b"private")
        (data_root / "c6-big" / "world").mkdir(parents=True)
        (data_root / "c6-big" / "world" / "features.json").write_text("{}", encoding="utf8")
        (data_root / "c6-big" / "world" / "game.npy").write_bytes(b"x")
        manifest = {"volume": "vol1", "dataCenter": "EU-RO-1",
                    "steps": {"a1": {"dataset": "c9-a1", "maps": ["classic"], "parts": [{"tar": "incoming/c9/p0.tar.gz", "lane": 0}]}}}
        (out / "remote" / "volume.json").write_text(json.dumps(manifest), encoding="utf8")
        inventory = {"incoming/c9/p0.tar.gz"} | (set() if scenario in ("missing dataset", "push") else {"datasets/c6-big/world.tar.gz"})
        done_file, abort_file, eta_file = out / "a1" / "gpu.json", out / "remote-train.abort", out / "remote" / "eta"
        done_file.parent.mkdir()
        if not scenario.startswith(("abort", "waits")):
            done_file.write_text("{}", encoding="utf8")
        if scenario == "abort before a pod":
            abort_file.touch()
        eta_file.write_text(f"{Clock.now + (10_000 if scenario == 'abort before a pod' else -1):.0f}\n", encoding="utf8")

        class FakeSsh:
            def __init__(self, work):
                self.pub = "ssh-ed25519 AAAA test"
                self.puts, self.go, self.upload, self.job, self.polls = [], {}, {}, {}, 0
                self.go_at = None

            def run(self, pod, cmd, timeout=0, check=True):
                if cmd.startswith(f"cd {remote.VOL}"):
                    return "\n".join(sorted(inventory)) + "\n"
                if not cmd.startswith("cat /root/job/status"):
                    return "ok\n"
                self.polls += 1
                if scenario == "waits for generation" and self.polls == 3:
                    done_file.write_text("{}", encoding="utf8")
                if scenario == "abort while waiting" and self.polls == 1:
                    abort_file.touch()
                if scenario == "setup fails" and pod.id == "pod0":
                    return "failed: setup: host driver CUDA 12.4 < 12.8\nalive\n"
                go = self.go.get(pod.id)
                if go is None:
                    return "waiting\nalive\n"
                if "abort" in go:
                    return f"failed: aborted: {go['abort']}\nalive\n"
                if scenario == "training fails":
                    return "failed: train.py failed (see train.log)\nalive\n"
                return "done\nalive\n"

            def put(self, pod, local, remote_path, timeout=0):
                self.puts.append(remote_path)
                if remote_path == "/root/upload.tar":
                    if scenario == "crash":
                        raise KeyboardInterrupt("simulated Ctrl+C during upload")
                    with tf.open(local) as t:
                        self.upload[pod.id] = sorted(t.getnames())
                        self.job[pod.id] = json.loads(t.extractfile("job.json").read())
                if remote_path == "/root/job/go.json":
                    self.go[pod.id] = json.loads(Path(local).read_text(encoding="utf8"))
                    self.go_at = self.polls

            def get(self, pod, remote_path, local, timeout=0):
                stage = tmp / "result-stage"
                stage.mkdir()
                for suffix in (".pt", ".json", ".onnx", ".value.onnx"):
                    (stage / f"c9-candidate{suffix}").write_bytes(b"trained")
                (stage / "train.log").write_text("epoch 1\n", encoding="utf8")
                with tf.open(local, "w:gz") as t:
                    for p in stage.iterdir():
                        t.add(p, arcname=p.name)
                shutil.rmtree(stage)

            def forget(self):
                pass

        fake = {}

        def make_ssh(work):
            fake["s"] = FakeSsh(work)
            return fake["s"]

        saved = remote.api, remote.Ssh, remote.time
        remote.api, remote.Ssh, remote.time = api, make_ssh, Clock
        argv = ["train", "--name", "c9", "--candidate", "c9-candidate", "--init", "delove@4", "--models", str(models), "--out", str(out),
                "--volume", "vol1", "--data", "c9-a1/classic", "--data", "c9-a1/classic", "--data", "c6-big/world:value#0.3",
                "--data-root", str(data_root), "--wait-for", str(done_file), "--eta", str(eta_file), "--abort-file", str(abort_file),
                *(["--push-missing", "all"] if scenario == "push" else []), "--yes", "--", "--epochs", "1.5", "--amp"]
        try:
            rc = remote.main(argv)
        except KeyboardInterrupt:
            rc = "interrupted"
        finally:
            remote.api, remote.Ssh, remote.time = saved
        s = fake.get("s")
        deleted = sorted(set(p for m, p in calls if m == "DELETE"))
        good = deleted == sorted(f"/pods/{i}" for i in pods) and len(pods) == want_pods and rc == want_rc
        good = good and not list(out.glob("remote-train/upload.tar")) and not list(out.glob("remote-train/push-*"))
        good = good and all(b.get("networkVolumeId") == "vol1" and b.get("dataCenterIds") == ["EU-RO-1"] for b in pods.values())
        trained = (models / "c9-candidate.onnx").exists() and (out / "train.log").exists()
        good = good and trained == (want_rc == 0)
        if want_rc == 0:  # only the init model went up; the cycle's train.py arguments and data specs, repeats kept
            up = s.upload[f"pod{want_pods - 1}"]
            job = s.job[f"pod{want_pods - 1}"]
            good = good and [n for n in up if n.startswith("models/")] == ["models/delove@4.pt"]
            good = good and job["train_args"] == ["--epochs", "1.5", "--amp"] and job["init"] == "delove@4"
            good = good and [(d["dataset"], d["map"], d["suffix"]) for d in job["data"]] == [
                ("c9-a1", "classic", ""), ("c9-a1", "classic", ""), ("c6-big", "world", ":value#0.3")]
            good = good and list(s.go[f"pod{want_pods - 1}"]["steps"]) == ["a1"]
        if scenario == "missing dataset":
            good = good and "/root/upload.tar" not in s.puts
        if scenario == "push":
            good = good and s.puts.index(f"{remote.VOL}/datasets/c6-big/world.tar.gz") < s.puts.index("/root/upload.tar")
        if scenario == "waits for generation":
            good = good and s.go_at is not None and s.go_at >= 3
        if scenario == "abort while waiting":
            good = good and "abort" in s.go.get("pod0", {})
        if scenario == "delete fails once":
            deletes = [n for n, c in enumerate(calls) if c == ("DELETE", "/pods/pod0")]
            posts = [n for n, c in enumerate(calls) if c[0] == "POST"]
            good = good and len(deletes) == 2 and posts[1] > deletes[1]
        print(f"train ({scenario}): {len(pods)} pods created, {len(deleted)} terminated, exit {rc} -> {'OK' if good else 'MISMATCH'}")
        ok = ok and good
        shutil.rmtree(tmp, ignore_errors=True)
    return ok


def check_api_key() -> bool:
    """remote.api sends RUNPOD_API_KEY only in the Authorization header (not in the URL or the body)."""
    import os
    import urllib.request

    import remote

    seen = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"id": "v"}'

    def urlopen(req, timeout=0):
        seen["req"] = req
        return Response()

    key, real = os.environ.get("RUNPOD_API_KEY"), urllib.request.urlopen
    os.environ["RUNPOD_API_KEY"] = "test-key-0123"
    urllib.request.urlopen = urlopen
    try:
        remote.api("POST", "/networkvolumes", {"name": "delove-data", "size": 50, "dataCenterId": "EU-RO-1"})
    finally:
        urllib.request.urlopen = real
        if key is None:
            os.environ.pop("RUNPOD_API_KEY", None)
        else:
            os.environ["RUNPOD_API_KEY"] = key
    req = seen["req"]
    ok = (req.get_header("Authorization") == "Bearer test-key-0123" and "test-key-0123" not in req.full_url
          and b"test-key-0123" not in (req.data or b""))
    print(f"api key: only in the Authorization header -> {'OK' if ok else 'MISMATCH'}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", help="a training-array map folder (e.g. data/delove/c6-micro/skirmish)")
    ap.add_argument("--games", type=int, default=600)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--jobs", help="a jobs file for the plan check")
    args = ap.parse_args()
    ok = check_summaries()
    ok = check_api_key() and ok
    ok = check_train() and ok
    if args.data:
        ok = check_merge(Path(args.data), args.games, args.workers) and ok
    if args.jobs:
        ok = check_plan(args.jobs) and ok
    if args.jobs and args.data:
        ok = check_run(Path(args.data), args.jobs) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
