"""Play a cycle's GPU steps on rented cloud GPUs (RunPod), and leave their training arrays and gpu.json exactly where a
local GPU step leaves them (DATA/<name>-<step>/<map>/, OUT/<step>/gpu.json and gpu.log).

TRAINING ONLY, run from the training PC. The tables are split by configuration (map, seats, settings: the unit
`delove_gpu.generate` plays in one engine) over lanes, a lane being one generate process on one GPU (pods x GPUs per
pod x processes per GPU). Each configuration plays whole on one lane, with the same tables, seed and branch settings as
at home, so its games are the same games (tests/dataset_compare.py checks it); configurations are assigned
longest-first by their measured cost (the "games in s (batch B)" lines of earlier gpu.log files).

    # the plan and its estimated cost (no pods, no key needed)
    python cloud/remote.py plan --name c7 --step big=packages/delove/scripts/cycles/c7-big.jobs --lanes 6 \\
        --timings runs/delove/c6/big/gpu.log
    # the same, then launch, wait, download, merge and terminate (needs RUNPOD_API_KEY in the environment)
    python cloud/remote.py run --name c7 --step big=... --pods 6 --models models/delove --data data/delove \\
        --out runs/delove/c7 --max-gpu-hours 6 --yes -- --seed 307 --ranker delove@3 --teacher jacob-sensei@1 ...
    python cloud/remote.py pods                   # this account's delove-* pods, running or not
    python cloud/remote.py terminate --all        # terminate every delove-* pod (after a crash of this script)

Everything after `--` goes to delove_gpu.generate unchanged (cycle.sh builds it as for a local GPU step).

Pods end on every path: this script terminates each pod as soon as its arrays are downloaded, and every pod it
created on failure, timeout or Ctrl+C (and the ids are kept in OUT/remote/pods.json for `terminate`). Inside each pod
a watchdog terminates it at the run's deadline even if this script dies (runpodctl, with the pod's own key). The
API key is read from RUNPOD_API_KEY and only ever sent in the Authorization header: never printed or written.
The models are uploaded only to these pods; the worker deletes them once its games are played and terminating a pod
destroys its disk.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(HERE))
from delove_gpu.fingerprint import REPO  # noqa: E402

API = "https://rest.runpod.io/v1"
PREFIX = "delove-"
GPU_4090 = "NVIDIA GeForce RTX 4090"
IMAGE = "runpod/pytorch:1.4.1-cu1281-torch291-ubuntu2204"  # the worker installs the training PC's torch on top
SETUP_MIN = 10.0  # pod start, npm, pip and upload, before the first game (minutes; measure and adjust)
COMPILE_S = 60.0  # one NVRTC compile per configuration when its kernel is not in the uploaded cache
WAVE_EXP = 0.3  # a configuration's time grows ~games^0.3 (a lockstep step costs far less than in proportion to its games)
TIMING = re.compile(r"^\s{2}(\S+/\d+p(?: \{.*\})?): (\d+) games in ([\d.]+)s \(batch (\d+)\)\s*$")


# ---- the plan -------------------------------------------------------------------------------------------------------
@dataclass
class Unit:
    """One configuration of one step: generate plays its tables in one engine."""
    step: str
    label: str
    tables: list
    games: int
    minutes: float
    measured: bool


@dataclass
class Lane:
    index: int
    pod: int
    gpu: int
    units: list = field(default_factory=list)

    @property
    def minutes(self) -> float:
        return sum(u.minutes for u in self.units)


def read_timings(paths: list[str]) -> dict[str, tuple[int, float]]:
    """{config label: (games, seconds)} from gpu.log files (later files win)."""
    out = {}
    for p in paths:
        for line in Path(p).read_text(encoding="utf8", errors="replace").splitlines():
            m = TIMING.match(line)
            if m:
                out[m.group(1)] = (int(m.group(2)), float(m.group(3)))
    return out


def estimate(label: str, games: int, timings: dict, cached: bool) -> tuple[float, bool]:
    """Minutes for `games` games of a configuration on one lane (the training PC's RTX 4060 speed)."""
    from delove_gpu.config import engine_facts

    extra = 0 if cached else COMPILE_S
    if label in timings:
        g0, s0 = timings[label]
        return (s0 * (games / g0) ** WAVE_EXP + extra) / 60, True
    base = label.split(" ")[0]  # same map and table size, other settings
    near = [s * (games / g) ** WAVE_EXP for k, (g, s) in timings.items() if k.split(" ")[0] == base]
    if near:
        return (sum(near) / len(near) + extra) / 60, False
    m, seats = base.split("/")
    T = engine_facts()["maps"][m]["territories"]
    return (60 + 2.5 * T * int(seats[:-1]) * (games / 500) ** WAVE_EXP + extra) / 60, False  # a guess from the board size


def make_units(steps: list[tuple[str, str]], only: set[str] | None, timings: dict, cached: bool) -> list[Unit]:
    from delove_gpu.generate import read_jobs

    units = []
    for step, jobs in steps:
        groups: dict[str, list] = {}
        for t in read_jobs(jobs):
            if only and t.name not in only:
                continue
            groups.setdefault(t.config.label(), []).append(t)
        for label, tables in groups.items():
            games = sum(t.games for t in tables)
            mins, measured = estimate(label, games, timings, cached)
            units.append(Unit(step, label, tables, games, mins, measured))
    return units


def assign(units: list[Unit], pods: int, gpus: int, procs: int, share: float) -> list[Lane]:
    """Longest configuration first onto the least-loaded lane. `share`: how much slower each of `procs` lanes sharing a
    GPU runs than one alone (1 = no slowdown; procs = full time-slicing)."""
    lanes = [Lane(i, i // (gpus * procs), (i // procs) % gpus) for i in range(pods * gpus * procs)]
    slow = 1 + (share - 1) * (procs > 1)
    for u in sorted(units, key=lambda u: -u.minutes):
        u.minutes *= slow
        min(lanes, key=lambda lane: lane.minutes).units.append(u)
    return lanes


def print_plan(lanes: list[Lane], pods: int, gpus: int, price: float, speed: float) -> tuple[float, float]:
    """Prints the lanes; returns (estimated wall minutes, GPU-hours)."""
    for lane in lanes:
        print(f"lane {lane.index} (pod {lane.pod}, GPU {lane.gpu}): {lane.minutes / speed:.0f} min")
        for u in lane.units:
            print(f"    {u.step:10s} {u.label:70s} {u.games:6d} games  {u.minutes / speed:6.1f} min{'' if u.measured else ' (guess)'}"
                  f"  [{','.join(t.name for t in u.tables)}]")
    play = max(lane.minutes for lane in lanes) / speed
    wall = SETUP_MIN + play + 5  # + packing and download
    gpu_hours = pods * gpus * wall / 60
    print(f"\n{pods} pod(s) x {gpus} GPU(s): about {wall:.0f} min wall ({play:.0f} min of games, the longest lane), "
          f"{gpu_hours:.2f} GPU-hours, about ${gpu_hours * price:.2f} at ${price:.2f}/GPU-hour")
    return wall, gpu_hours


# ---- RunPod -----------------------------------------------------------------------------------------------------------
class RunPodError(RuntimeError):
    pass


def api(method: str, path: str, body: dict | None = None):
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        raise SystemExit("RUNPOD_API_KEY is not set (the RunPod API key, in the environment only)")
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
    except urllib.error.HTTPError as e:
        raise RunPodError(f"RunPod {method} {path}: HTTP {e.code} {e.read()[:400].decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise RunPodError(f"RunPod {method} {path}: {e.reason}") from None
    return json.loads(text) if text.strip() else {}


def watchdog_cmd(deadline_s: int) -> list[str]:
    """The pod's start command: a watchdog that terminates the pod at the deadline (with runpodctl and the pod's own
    key, so it works even if the training PC is gone), then the image's own start script (sshd with PUBLIC_KEY)."""
    w = (f"(sleep {deadline_s}; echo \"deadline $(date)\"; runpodctl remove pod \"$RUNPOD_POD_ID\" || runpodctl pod delete \"$RUNPOD_POD_ID\")"
         " >> /root/watchdog.log 2>&1 &"
         " echo \"watchdog: runpodctl $(command -v runpodctl || echo MISSING), pod key ${RUNPOD_API_KEY:+set}\" >> /root/watchdog.log;"
         " if [ -x /start.sh ]; then exec /start.sh; else exec sleep infinity; fi")
    return ["bash", "-c", w]


@dataclass
class Pod:
    id: str
    name: str
    cost: float = 0.0
    ip: str = ""
    port: int = 0
    started: float = 0.0
    ended: float = 0.0
    state: str = "starting"
    gone: bool = False  # terminated
    dead: int = 0  # polls in a row that found no worker process
    lanes: list = field(default_factory=list)


def create_pod(name: str, args, pub: str, deadline_s: int) -> Pod:
    body = {"name": name, "imageName": args.image, "gpuTypeIds": [args.gpu_type], "gpuCount": args.gpus, "cloudType": args.cloud,
            "containerDiskInGb": args.disk_gb, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True,
            "env": {"PUBLIC_KEY": pub, "SSH_PUBLIC_KEY": pub}, "allowedCudaVersions": ["12.8", "12.9", "13.0"],
            "dockerStartCmd": watchdog_cmd(deadline_s)}
    r = api("POST", "/pods", body)
    return Pod(r["id"], name, float(r.get("costPerHr") or 0), started=time.time())


def terminate(pod: Pod):
    if pod.gone:
        return
    try:
        api("DELETE", f"/pods/{pod.id}")
        pod.gone, pod.ended = True, time.time()
        print(f"  pod {pod.name} ({pod.id}) terminated", flush=True)
    except RunPodError as e:
        print(f"  WARNING: could not terminate pod {pod.id}: {e} -- run `remote.py terminate --all`", flush=True)


# ---- SSH ------------------------------------------------------------------------------------------------------------
class Ssh:
    def __init__(self, work: Path):
        self.key = work / "ssh_key"
        self.known = work / "known_hosts"
        self.exe = os.environ.get("SSH", "ssh")
        self.scp = os.environ.get("SCP", "scp")
        if not self.key.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "delove-cloud", "-f", str(self.key)], check=True)

    @property
    def pub(self) -> str:
        return (self.key.with_suffix(".pub")).read_text().strip()

    def opts(self, port_flag: str, pod: Pod) -> list[str]:
        return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", f"UserKnownHostsFile={self.known}", "-o", "ConnectTimeout=20",
                "-o", "ServerAliveInterval=30", "-o", "LogLevel=ERROR", "-i", str(self.key), port_flag, str(pod.port)]

    def run(self, pod: Pod, cmd: str, timeout: float = 300, check: bool = True) -> str:
        r = subprocess.run([self.exe, *self.opts("-p", pod), f"root@{pod.ip}", cmd], capture_output=True, text=True, timeout=timeout)
        if check and r.returncode:
            raise RuntimeError(f"ssh {pod.name}: {cmd[:80]!r} failed: {r.stderr.strip()[:300]}")
        return r.stdout

    def put(self, pod: Pod, local: Path, remote: str, timeout: float = 3600):
        subprocess.run([self.scp, *self.opts("-P", pod), str(local), f"root@{pod.ip}:{remote}"], check=True, timeout=timeout)

    def get(self, pod: Pod, remote: str, local: Path, timeout: float = 4 * 3600):
        subprocess.run([self.scp, *self.opts("-P", pod), f"root@{pod.ip}:{remote}", str(local)], check=True, timeout=timeout)

    def forget(self):
        for f in (self.key, self.key.with_suffix(".pub"), self.known):
            f.unlink(missing_ok=True)


def wait_ready(pod: Pod, ssh: Ssh, timeout_s: float):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        r = api("GET", f"/pods/{pod.id}")
        ports = r.get("portMappings") or {}
        if r.get("publicIp") and ports.get("22"):
            pod.ip, pod.port = r["publicIp"], int(ports["22"])
            pod.cost = float(r.get("costPerHr") or pod.cost)
            try:
                if ssh.run(pod, "echo ok", timeout=40).strip() == "ok":
                    return
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
        time.sleep(10)
    raise RuntimeError(f"pod {pod.name} not reachable over SSH after {timeout_s / 60:.0f} min")


# ---- the job a pod gets --------------------------------------------------------------------------------------------------
def table_line(t) -> str:
    return " ".join([t.name, str(t.games), ",".join(t.agents), *([str(t.start)] if t.start else []), json.dumps(t.options, separators=(",", ":"))])


def needed_models(units: list[Unit], gen_args: list[str], models: Path) -> list[Path]:
    """The .pt of every network seat and the ranker, and every teacher's .json (delove-teacher@N, jacob-sensei@N: small;
    generate picks the newest delove-teacher@N.json as rollout teacher when --teacher is not given). Nothing else of the
    models folder leaves the training PC."""
    from delove_gpu.teacher import is_teacher

    agents = {a for u in units for t in u.tables for a in t.agents}
    ranker = gen_args[gen_args.index("--ranker") + 1] if "--ranker" in gen_args else "delove@2"
    nets = {a for a in agents | {ranker} if a != "delove-branch@1" and not is_teacher(a)}
    files = [models / f"{a}.pt" for a in sorted(nets)] + sorted(p for p in models.glob("*.json") if is_teacher(p.stem))
    missing = [str(f) for f in files if not f.exists()]
    if missing:
        raise SystemExit(f"missing model files: {missing}")
    return files


def lane_script(lane: Lane, gen_args: list[str]) -> str:
    lines = ["#!/usr/bin/env bash", "set -uo pipefail", f"export CUDA_VISIBLE_DEVICES={lane.gpu}"]
    for step in dict.fromkeys(u.step for u in lane.units):
        d = f"$JOB/lanes/{lane.index}/{step}"
        args = " ".join(shlex.quote(a) for a in gen_args)
        lines += [f'd="{d}"; mkdir -p "$d"',
                  'if [[ ! -f $d/gpu.json ]]; then',
                  f'  (cd "$REPO/packages/delove-gpu" && "$PY" -m delove_gpu.generate --models "$JOB/models" --jobs "$JOB/lanes/{lane.index}.{step}.jobs" {args}'
                  ' --out "$d/data" --summary "$d/gpu.json.tmp" --results "$d/results.jsonl") > "$d/gpu.log" 2>&1 || exit 1',
                  '  mv "$d/gpu.json.tmp" "$d/gpu.json"', 'fi']
    return "\n".join(lines) + "\n"


def build_upload(work: Path, pod_index: int, lanes: list[Lane], gen_args: list[str], model_files: list[Path], cache: Path | None,
                 commit: str, torch_version: str, verify: list[str] | None) -> Path:
    stage = work / f"stage-{pod_index}"
    shutil.rmtree(stage, ignore_errors=True)
    (stage / "lanes").mkdir(parents=True)
    (stage / "models").mkdir()
    with open(stage / "src.tar", "wb") as f:
        subprocess.run(["git", "-c", "core.autocrlf=false", "archive", "--format=tar", commit], cwd=REPO, stdout=f, check=True)
    for m in model_files:
        shutil.copyfile(m, stage / "models" / m.name)
    if cache and cache.is_dir():
        (stage / "cache").mkdir()
        for c in list(cache.glob("*.cubin")) + list(cache.glob("*.npz")):
            shutil.copyfile(c, stage / "cache" / c.name)
    (stage / "worker.sh").write_bytes((HERE / "worker.sh").read_bytes().replace(b"
", b"
"))  # a CRLF checkout
    (stage / "job.json").write_text(json.dumps({"torch": torch_version, "verify": verify}), encoding="utf8")
    for lane in lanes:
        for step in dict.fromkeys(u.step for u in lane.units):
            lines = [table_line(t) for u in lane.units if u.step == step for t in u.tables]
            (stage / "lanes" / f"{lane.index}.{step}.jobs").write_text("\n".join(lines) + "\n", encoding="utf8", newline="\n")
        (stage / f"lane-{lane.index}.sh").write_text(lane_script(lane, gen_args), encoding="utf8", newline="\n")
    tar = work / f"upload-{pod_index}.tar"
    with tarfile.open(tar, "w") as t:
        for p in sorted(stage.iterdir()):
            t.add(p, arcname=p.name)
    shutil.rmtree(stage)  # the staged copy of the models
    return tar


def extract(tar: Path, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar, "r:gz") as t:
        if sys.version_info >= (3, 12):
            t.extractall(dest, filter="data")
        else:
            for m in t.getmembers():
                if m.name.startswith(("/", "..")) or ".." in Path(m.name).parts or not (m.isfile() or m.isdir()):
                    raise SystemExit(f"{tar}: unexpected member {m.name}")
            t.extractall(dest)


# ---- run --------------------------------------------------------------------------------------------------------------
def git_check(commit: str):
    dirty = subprocess.run(["git", "status", "--porcelain", "--", "packages/delove-gpu", "packages/engine/src", "packages/selfplay/src"],
                           cwd=REPO, capture_output=True, text=True).stdout.strip()
    if dirty and commit == "HEAD":
        print(f"WARNING: uncommitted changes the pods will not have (they run {commit}):\n{dirty}")


def run(args, gen_args: list[str]):
    out = Path(args.out)
    work = out / "remote"
    work.mkdir(parents=True, exist_ok=True)
    steps = [(s, j) for s, j in args.step if not (out / s / "gpu.json").exists()]
    if not steps:
        print("every step already has its gpu.json")
        return 0
    cache = Path(args.cache) if args.cache else PKG / "_cache"
    timings = read_timings(args.timings)
    units = make_units(steps, set(args.only.split(",")) if args.only else None, timings, cached=cache.is_dir() and any(cache.glob("*.cubin")))
    lanes = assign(units, args.pods, args.gpus, args.procs, args.share)
    lanes = [lane for lane in lanes if lane.units]
    pods_used = sorted({lane.pod for lane in lanes})
    wall, gpu_hours = print_plan(lanes, len(pods_used), args.gpus, args.price, args.speed)
    if gpu_hours > args.max_gpu_hours:
        raise SystemExit(f"estimated {gpu_hours:.2f} GPU-hours is over the cap --max-gpu-hours {args.max_gpu_hours}; nothing launched")
    if not args.yes:
        print("dry run: add --yes to launch")
        return 0
    commit = subprocess.run(["git", "rev-parse", args.commit], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    git_check(args.commit)
    import importlib.metadata as md

    torch_version = args.torch or md.version("torch")
    model_files = needed_models(units, gen_args, Path(args.models))
    # The hard limit: every pod is terminated when the cap's share of wall time is spent, whatever the plan said.
    timeout_s = args.max_gpu_hours * 3600 / (len(pods_used) * args.gpus)
    deadline_s = int(timeout_s + 900)
    ssh = Ssh(work)
    pods: list[Pod] = []
    ledger = work / "pods.json"
    t0 = time.time()

    def save():
        ledger.write_text(json.dumps([p.__dict__ for p in pods], indent=1), encoding="utf8")

    failed = []
    try:
        stamp = dt.datetime.now().strftime("%m%d-%H%M")
        for k in pods_used:
            p = create_pod(f"{PREFIX}{args.name}-{stamp}-{k}", args, ssh.pub, deadline_s)
            p.lanes = [lane.index for lane in lanes if lane.pod == k]
            pods.append(p)
            save()
            print(f"pod {p.name} ({p.id}) created, ${p.cost:.2f}/h", flush=True)
        for k, p in zip(pods_used, pods):
            wait_ready(p, ssh, 900)
            print(f"pod {p.name} ready at {p.ip}:{p.port} (${p.cost:.2f}/h)", flush=True)
            tar = build_upload(work, k, [lane for lane in lanes if lane.pod == k], gen_args, model_files, cache, commit, torch_version,
                               shlex.split(args.verify) if args.verify else None)
            try:
                ssh.put(p, tar, "/root/upload.tar")
            finally:
                tar.unlink(missing_ok=True)  # it holds the models
            ssh.run(p, "mkdir -p /root/job && tar -xf /root/upload.tar -C /root/job && rm /root/upload.tar && "
                       "(setsid nohup bash /root/job/worker.sh /root/job > /root/job/worker.out 2>&1 < /dev/null &)")
            p.state = "running"
            save()
        last = 0.0
        while any(p.state == "running" for p in pods):
            if time.time() - t0 > timeout_s:
                raise TimeoutError(f"the run reached its limit ({timeout_s / 60:.0f} min, --max-gpu-hours {args.max_gpu_hours})")
            for k, p in zip(pods_used, pods):
                if p.state != "running":
                    continue
                try:
                    status = ssh.run(p, "cat /root/job/status 2>/dev/null || echo missing; pgrep -f '[w]orker.sh' >/dev/null && echo alive || echo dead; for f in /root/job/lanes/*/*/gpu.log; do [ -f \"$f\" ] &&"
                                        " echo \"$f: $(grep -a ' step \\| games in ' \"$f\" | tail -n1 | cut -c1-160)\"; done", timeout=60)
                except (RuntimeError, subprocess.TimeoutExpired) as e:
                    print(f"  {p.name}: {e}", flush=True)
                    continue
                lines = status.splitlines()
                state = lines[0] if lines else "?"
                if state != "done" and not state.startswith("failed") and len(lines) > 1 and lines[1] == "dead":
                    p.dead += 1  # twice in a row (a minute): the worker is gone without a status
                    if p.dead >= 2:
                        state = f"failed: the worker stopped while {state}"
                else:
                    p.dead = 0
                if time.time() - last > 120:
                    print(f"[{dt.datetime.now():%H:%M:%S}] {p.name}: {state}", flush=True)
                    for line in lines[2:]:
                        print("    " + line.replace("/root/job/lanes/", "lane "), flush=True)
                if state in ("done",) or state.startswith("failed"):
                    dest = work / f"pod-{k}.tar.gz"
                    try:
                        ssh.get(p, "/root/job/out.tar.gz", dest)
                    except subprocess.CalledProcessError:
                        print(f"  {p.name}: no out.tar.gz to download")
                    ssh.run(p, "rm -rf /root/job/models", check=False)
                    terminate(p)
                    p.state = "done" if state == "done" else "failed"
                    if state != "done":
                        failed.append(f"{p.name}: {state}")
                    save()
                    if dest.exists():
                        extract(dest, work / f"pod-{k}")
                        dest.unlink()
            if time.time() - last > 120:
                last = time.time()
            time.sleep(30)
    except BaseException as e:
        failed.append(f"{type(e).__name__}: {e}")
        raise
    finally:
        for p in pods:
            if not p.gone:
                if p.ip and p.state == "running":
                    try:
                        ssh.run(p, "rm -rf /root/job/models", timeout=30, check=False)
                    except Exception:  # noqa: BLE001 - terminating matters more
                        pass
                terminate(p)
        save()
        hours = sum(((p.ended or time.time()) - p.started) / 3600 for p in pods)
        print(f"pods: {len(pods)}, {hours:.2f} pod-hours, about ${sum(((p.ended or time.time()) - p.started) / 3600 * p.cost for p in pods):.2f}")
        ssh.forget()
    if failed:
        print("FAILED:\n  " + "\n  ".join(failed))
        return 1
    return merge_all(args, steps, lanes, work, pods, time.time() - t0)


def merge_all(args, steps, lanes: list[Lane], work: Path, pods: list[Pod], seconds: float) -> int:
    from merge import merge_step

    out, data = Path(args.out), Path(args.data)
    env = {}
    for k in sorted({lane.pod for lane in lanes}):
        f = work / f"pod-{k}" / "env.json"
        if f.exists():
            env[f"pod {k}"] = json.loads(f.read_text(encoding="utf8"))
    for step, _ in steps:
        parts, logs = [], []
        for lane in lanes:
            d = work / f"pod-{lane.pod}" / "lanes" / str(lane.index) / step
            if (d / "gpu.json").exists():
                parts.append((json.loads((d / "gpu.json").read_text(encoding="utf8")), d / "data"))
                logs.append((lane, d / "gpu.log"))
        if not parts:
            continue
        extra = {"lanes": [lane.index for lane, _ in logs], "pods": len(pods), "gpuType": args.gpu_type, "gpus": env,
                 "wallSeconds": round(seconds, 1), "costPerHour": [p.cost for p in pods]}
        merged = merge_step(parts, data / f"{args.name}-{step}", extra)
        with open(out / step / "gpu.log", "w", encoding="utf8", newline="\n") as f:
            for lane, log in logs:
                f.write(f"==== lane {lane.index} (pod {lane.pod}, GPU {lane.gpu}) ====\n")
                f.write(log.read_text(encoding="utf8", errors="replace"))
        (out / step / "gpu.json").write_text(json.dumps(merged, indent=2) + "\n", encoding="utf8")
        print(f"{step}: {merged['games']} games -> {data / f'{args.name}-{step}'} ({', '.join(e['map'] for e in merged.get('export', []))})")
    if not args.keep:
        for lane in lanes:
            shutil.rmtree(work / f"pod-{lane.pod}" / "lanes" / str(lane.index), ignore_errors=True)
    return 0


def our_pods() -> list[dict]:
    r = api("GET", "/pods")
    pods = r.get("pods", r.get("data", [])) if isinstance(r, dict) else r
    return [p for p in pods if p.get("name", "").startswith(PREFIX)]


def list_pods(_args):
    for p in our_pods():
        print(f"{p['id']}  {p['name']:40s} {p.get('desiredStatus')}  ${p.get('costPerHr')}/h")


def terminate_cmd(args):
    ids = [p["id"] for p in our_pods()] if args.all else args.ids
    for i in ids:
        terminate(Pod(i, i))
    if not ids:
        print("no delove-* pods")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    gen_args = []
    if "--" in argv:
        k = argv.index("--")
        argv, gen_args = argv[:k], argv[k + 1:]
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "run"):
        p = sub.add_parser(name)
        p.add_argument("--name", required=True, help="the cycle's name (data goes to DATA/<name>-<step>)")
        p.add_argument("--step", action="append", required=True, type=lambda s: tuple(s.split("=", 1)), help="STEP=JOBS_FILE (repeat)")
        p.add_argument("--only", help="only these tables (comma-separated names), e.g. for a test slice")
        p.add_argument("--timings", action="append", default=[], help="gpu.log of earlier runs (measured seconds per configuration)")
        p.add_argument("--pods", type=int, default=4)
        p.add_argument("--gpus", type=int, default=1, help="GPUs per pod")
        p.add_argument("--procs", type=int, default=1, help="generate processes per GPU (lanes sharing a GPU)")
        p.add_argument("--share", type=float, default=1.6, help="how much slower each of --procs lanes on one GPU runs (estimate only)")
        p.add_argument("--speed", type=float, default=1.0, help="GPU speed vs the training PC's RTX 4060 (estimate only)")
        p.add_argument("--price", type=float, default=0.69, help="$ per GPU-hour for the estimate (the pods report their real price)")
        p.add_argument("--max-gpu-hours", type=float, default=4.0, help="hard cap: refuse a bigger estimate, terminate everything at it")
        p.add_argument("--cache", help="NVRTC kernels and odds tables to upload (default: packages/delove-gpu/_cache)")
        if name == "run":
            p.add_argument("--models", required=True)
            p.add_argument("--data", default="data/delove")
            p.add_argument("--out", required=True, help="the cycle's runs folder (OUT): OUT/<step>/gpu.json, OUT/remote/")
            p.add_argument("--commit", default="HEAD", help="the commit the pods run (git archive; need not be pushed)")
            p.add_argument("--torch", help="PyTorch version for the pods (default: this Python's, e.g. 2.11.0+cu128)")
            p.add_argument("--gpu-type", default=GPU_4090)
            p.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
            p.add_argument("--image", default=IMAGE)
            p.add_argument("--disk-gb", type=int, default=80)
            p.add_argument("--verify", help="also run verify.py on each pod first, with these arguments (e.g. '--ranker delove@3')")
            p.add_argument("--keep", action="store_true", help="keep the downloaded per-lane arrays after merging")
            p.add_argument("--yes", action="store_true", help="launch (without it: print the plan and cost only)")
    sub.add_parser("pods")
    t = sub.add_parser("terminate")
    t.add_argument("ids", nargs="*")
    t.add_argument("--all", action="store_true", help="every delove-* pod of the account")
    args = ap.parse_args(argv)
    if args.cmd == "plan":
        cache = Path(args.cache) if args.cache else PKG / "_cache"
        units = make_units(args.step, set(args.only.split(",")) if args.only else None, read_timings(args.timings),
                           cached=cache.is_dir() and any(cache.glob("*.cubin")))
        lanes = [lane for lane in assign(units, args.pods, args.gpus, args.procs, args.share) if lane.units]
        print_plan(lanes, len({lane.pod for lane in lanes}), args.gpus, args.price, args.speed)
        return 0
    if args.cmd == "run":
        for bad in ("--jobs", "--out", "--summary", "--results", "--models", "--table"):
            if bad in gen_args:
                raise SystemExit(f"{bad} is set by remote.py, not after --")
        return run(args, gen_args)
    if args.cmd == "pods":
        list_pods(args)
    elif args.cmd == "terminate":
        terminate_cmd(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
