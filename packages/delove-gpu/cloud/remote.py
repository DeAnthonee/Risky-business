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
    # train a candidate on one cloud GPU from a network volume (README "Cloud training"; train.py's arguments after --)
    python cloud/remote.py train --name c9 --candidate c9-candidate --init delove@5 --models models/delove --out runs/delove/c9 \
        --volume <id> --data c9-a1/classic --data c6-big/world#0.3 --yes -- --epochs 1.5 --amp
    python cloud/remote.py volume info <id>       # or: volume create --dc EU-RO-1 --size 50 [--yes]

Everything after `--` goes to delove_gpu.generate unchanged (cycle.sh builds it as for a local GPU step).

One bad pod never sinks the run: a pod that is not reachable in time, fails its upload or start, or ends with lanes
unplayed is terminated and replaced (--replacements, --ready-minutes). Every configuration is its own generate run
with its own gpu.json, and each one that finishes is kept (OUT/remote/units/<step>/<key>/), also from a pod cut at its
time limit (it is told to pack what it finished first): a step is merged once all its configurations are kept, and
running the same command again plays only the missing ones (OUT/<step>/gpu.partial.json lists them;
--accept-partial merges what there is). The run exits 1 when a step is left incomplete.

The time limit is per planned pod (a slot): --max-gpu-hours / (pods x GPUs) of billed pod time, counted from the
moment each pod is rented (a pod that RunPod only places late loses nothing); a replacement gets what its slot has
left. Before launching, RunPod's stock of the GPU type is read (--capacity-wait: wait for it; nothing is billed
while waiting); a pod RunPod cannot place is asked for again every minute for up to --capacity-wait minutes.

Pods end on every path: this script terminates each pod as soon as its arrays are downloaded, and every pod it
created on failure, timeout or Ctrl+C (and the ids are kept in OUT/remote/pods.json for `terminate`). Inside each pod
a watchdog terminates it at its slot's deadline even if this script dies (runpodctl, with the pod's own key). The
API key is read from RUNPOD_API_KEY and only ever sent in the Authorization header: never printed or written.
The models are uploaded only to these pods; the worker deletes them once its games are played and terminating a pod
destroys its disk.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
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
USER_AGENT = "delove-gpu-cloud/1"  # RunPod's Cloudflare refuses urllib's own (403, error 1010)
GPU_4090 = "NVIDIA GeForce RTX 4090"
MOUNT = "/workspace"  # where a pod mounts the network volume
VOL = MOUNT + "/delove"  # this tooling's folder on it: incoming/<name>/<pod>.tar.gz, datasets/<dataset>/<map>.tar.gz
IMAGE = "runpod/pytorch:1.4.1-cu1281-torch291-ubuntu2204"  # the worker installs the training PC's torch on top
SETUP_MIN = 10.0  # pod start, npm, pip and upload, before the first game (minutes; measure and adjust)
COMPILE_S = 60.0  # one NVRTC compile per configuration when its kernel is not in the uploaded cache
WAVE_EXP = 0.3  # a configuration's time grows ~games^0.3 (a lockstep step costs far less than in proportion to its games)
TIMING = re.compile(r"^\s{2}(\S+/\d+p(?: \{.*\})?(?: \[[^\]]*\])?): (\d+) games in ([\d.]+)s \(batch (\d+)\)\s*$")


# ---- the plan -------------------------------------------------------------------------------------------------------
@dataclass
class Unit:
    """One configuration of one step (generate.engine_group): generate plays its tables in one engine."""
    step: str
    label: str
    tables: list
    games: int
    minutes: float
    measured: bool
    key: str = ""  # what the unit plays (tables, generate arguments, mirror code): its folder name on the pod and at home


def unit_keys(units: list, gen_args: list[str], commit: str):
    """Each unit's key: a hash of its step, tables, the generate arguments and the code the pods run (the trees of the
    packages generate reads), so a unit kept by an earlier run is reused only for exactly the same games."""
    import hashlib

    trees = subprocess.run(["git", "rev-parse", *(f"{commit}:packages/{p}" for p in ("delove-gpu", "engine", "selfplay", "delove"))],
                           cwd=REPO, capture_output=True, text=True, check=True).stdout.split()
    for u in units:
        text = json.dumps([u.step, [table_line(t) for t in u.tables], gen_args, trees])
        u.key = hashlib.sha256(text.encode()).hexdigest()[:16]


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
    from delove_gpu.generate import engine_group, read_jobs

    units = []
    for step, jobs in steps:
        groups: dict[str, list] = {}
        for t in read_jobs(jobs):
            if only and t.name not in only:
                continue
            if t.positions is not None:
                raise SystemExit(f"{jobs}: table {t.name} starts from a positions file: play it at home (generate.py), not on rented GPUs")
            groups.setdefault(engine_group(t), []).append(t)
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
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          # RunPod's Cloudflare refuses urllib's default agent (HTTP 403, error code 1010)
                                          "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
    except urllib.error.HTTPError as e:
        raise RunPodError(f"RunPod {method} {path}: HTTP {e.code} {e.read()[:400].decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise RunPodError(f"RunPod {method} {path}: {e.reason}") from None
    return json.loads(text) if text.strip() else {}


GRAPHQL = "https://api.runpod.io/graphql"


def gpu_stock(gpu_types: list[str], cloud: str, gpus: int) -> dict[str, dict | None]:
    """RunPod's stock of each GPU type ({"stockStatus": "High" | "Medium" | "Low" | None, ...}) for a pod of `gpus`
    GPUs in `cloud`, from its GraphQL API (the REST API has no stock); None for a type it does not report. Read-only:
    nothing is rented. (Checked 2026-10-21: typed GraphQL variables get HTTP 400 here, so the values are inline, and
    maxUnreservedGpuCount comes back null: stockStatus is what counts.)"""
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        raise SystemExit("RUNPOD_API_KEY is not set (the RunPod API key, in the environment only)")
    q = (f"query {{ gpuTypes {{ id lowestPrice(input: {{gpuCount: {int(gpus)}, secureCloud: {'true' if cloud == 'SECURE' else 'false'}}}) "
         "{ stockStatus maxUnreservedGpuCount } } }")
    req = urllib.request.Request(GRAPHQL, data=json.dumps({"query": q}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            r = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RunPodError(f"RunPod stock: HTTP {e.code} {e.read()[:300].decode(errors='replace')}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise RunPodError(f"RunPod stock: {getattr(e, 'reason', e)}") from None
    if r.get("errors"):
        raise RunPodError(f"RunPod stock: {str(r['errors'])[:300]}")
    found = {t["id"]: t.get("lowestPrice") for t in (r.get("data") or {}).get("gpuTypes") or []}
    return {g: found.get(g) for g in gpu_types}


def in_stock(stock: dict[str, dict | None]) -> bool:
    return any(v and v.get("stockStatus") for v in stock.values())


def wait_for_stock(args) -> bool:
    """Before renting anything: is any of --gpu-type in stock? Waits up to --capacity-wait minutes (polling each
    minute, nothing billed). A stock read that fails is reported and the run goes on (creating a pod is the real test)."""
    types = [g.strip() for g in args.gpu_type.split(",")]
    t0 = time.time()
    said = 0.0
    while True:
        try:
            stock = gpu_stock(types, args.cloud, args.gpus)
        except RunPodError as e:
            print(f"capacity check skipped ({e})", flush=True)
            return True
        if not said or time.time() - said >= 600 or in_stock(stock):  # every 10 minutes while waiting
            said = time.time()
            print("RunPod stock: " + ", ".join(f"{g}: {(v or {}).get('stockStatus') or 'none'}" for g, v in stock.items()), flush=True)
        if in_stock(stock):
            return True
        if time.time() - t0 >= args.capacity_wait * 60:
            return False
        time.sleep(60)


def volume_info(volume_id: str) -> dict:
    """{id, name, size, dataCenterId} of a network volume of this account."""
    r = api("GET", f"/networkvolumes/{volume_id}")
    if not r.get("dataCenterId"):
        raise SystemExit(f"network volume {volume_id}: no data center in RunPod's answer")
    return r


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


def create_pod(name: str, args, pub: str, deadline_s: int, volume: dict | None = None) -> Pod:
    body = {"name": name, "imageName": args.image, "gpuTypeIds": [g.strip() for g in args.gpu_type.split(",")], "gpuTypePriority": "custom",
            "gpuCount": args.gpus, "cloudType": args.cloud,
            "containerDiskInGb": args.disk_gb, "volumeInGb": 0, "ports": ["22/tcp"], "supportPublicIp": True,
            "env": {"PUBLIC_KEY": pub, "SSH_PUBLIC_KEY": pub},  # no allowedCudaVersions: any value refuses every placement (worker.sh checks the driver)
            "dockerStartCmd": watchdog_cmd(deadline_s)}
    if volume:  # the network volume (mounted at /workspace) pins the pod to the volume's data center
        body.update({"networkVolumeId": volume["id"], "dataCenterIds": [volume["dataCenterId"]], "volumeMountPath": MOUNT})
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

    # Files go through a plain ssh stream, not scp: OpenSSH 9's scp speaks SFTP, and RunPod's PyTorch image closed the
    # channel mid-upload ("Couldn't send packet: Broken pipe"). The size is checked on the other side.
    def put(self, pod: Pod, local: Path, remote: str, timeout: float = 3600):
        q = shlex.quote(remote)
        # A pod's sshd can drop the first connections while it finishes starting (ssh exits 255): retry the whole
        # upload a few times before giving up on the run.
        for attempt in range(4):
            try:
                with open(local, "rb") as f:
                    subprocess.run([self.exe, *self.opts("-p", pod), f"root@{pod.ip}", f"cat > {q}.part && mv {q}.part {q}"],
                                   stdin=f, check=True, timeout=timeout)
                size = int(self.run(pod, f"stat -c %s {q}").strip())
                if size != local.stat().st_size:
                    raise RuntimeError(f"upload to {pod.name}: {size} bytes arrived of {local.stat().st_size}")
                return
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, ValueError) as e:
                if attempt == 3:
                    raise
                print(f"upload to {pod.name} failed ({e.__class__.__name__}); retrying in 15 s", flush=True)
                time.sleep(15)

    def get(self, pod: Pod, remote: str, local: Path, timeout: float = 4 * 3600):
        q = shlex.quote(remote)
        size = int(self.run(pod, f"stat -Lc %s {q}").strip())  # -L: out.tar.gz may link to the network volume
        with open(local, "wb") as f:
            subprocess.run([self.exe, *self.opts("-p", pod), f"root@{pod.ip}", f"cat {q}"], stdout=f, check=True, timeout=timeout)
        if local.stat().st_size != size:
            raise RuntimeError(f"download from {pod.name}: {local.stat().st_size} bytes of {size}")

    def forget(self):
        for f in (self.key, self.key.with_suffix(".pub"), self.known):
            f.unlink(missing_ok=True)


def ready(pod: Pod, ssh: Ssh) -> bool:
    """One look (no waiting): the pod has a public IP and port 22 mapped, and its sshd answers."""
    try:
        r = api("GET", f"/pods/{pod.id}")
    except RunPodError:
        return False
    ports = r.get("portMappings") or {}
    if not (r.get("publicIp") and ports.get("22")):
        return False
    pod.ip, pod.port = r["publicIp"], int(ports["22"])
    pod.cost = float(r.get("costPerHr") or pod.cost)
    try:
        return ssh.run(pod, "echo ok", timeout=40).strip() == "ok"
    except (RuntimeError, subprocess.TimeoutExpired):
        return False


# ---- the job a pod gets --------------------------------------------------------------------------------------------------
def table_line(t) -> str:
    agents = ",".join(t.agents) + (">" + ",".join(t.stage) if t.stage else "")  # a stage table's lead-in>stage agents
    if t.split:  # a ratio-scenario table: split:SHARES>stage agents (the table size is maxPlayers in its options)
        agents = "split:" + "/".join(map(str, t.split)) + ">" + ",".join(t.stage)
    return " ".join([t.name, str(t.games), agents, *([str(t.start)] if t.start else []), json.dumps(t.options, separators=(",", ":"))])


def needed_models(units: list[Unit], gen_args: list[str], models: Path) -> list[Path]:
    """The .pt of every network seat and the ranker, and every teacher's .json (delove-teacher@N, jacob-sensei@N: small;
    generate picks the newest delove-teacher@N.json as rollout teacher when --teacher is not given). Nothing else of the
    models folder leaves the training PC."""
    from delove_gpu.generate import is_branch
    from delove_gpu.teacher import is_teacher

    agents = {a for u in units for t in u.tables for a in t.agents + (t.stage or [])}
    arg = lambda k: gen_args[gen_args.index(k) + 1] if k in gen_args else None  # noqa: E731
    ranker = arg("--ranker") or "delove@2"
    # the network playing the rollouts (--rollout MODEL[:self], or --rollout-net MODEL for the comparison seats)
    rollout = (arg("--rollout") or "").partition(":")[0] or arg("--rollout-net")
    nets = {a for a in agents | {ranker} | ({rollout} if rollout else set()) if not is_branch(a) and not is_teacher(a)}
    files = [models / f"{a}.pt" for a in sorted(nets)] + sorted(p for p in models.glob("*.json") if is_teacher(p.stem))
    missing = [str(f) for f in files if not f.exists()]
    if missing:
        raise SystemExit(f"missing model files: {missing}")
    return files


def lane_script(lane: Lane, gen_args: list[str]) -> str:
    """One generate run per configuration (unit), each with its own folder and gpu.json, so a lane cut at its time
    limit still delivers every configuration it finished."""
    lines = ["#!/usr/bin/env bash", "set -uo pipefail", f"export CUDA_VISIBLE_DEVICES={lane.gpu}"]
    args = " ".join(shlex.quote(a) for a in gen_args)
    for u in lane.units:
        d = f"$JOB/lanes/{lane.index}/{u.step}/{u.key}"
        lines += [f'd="{d}"; mkdir -p "$d"',
                  'if [[ ! -f $d/gpu.json ]]; then',
                  f'  (cd "$REPO/packages/delove-gpu" && "$PY" -m delove_gpu.generate --models "$JOB/models" --jobs "$JOB/lanes/{lane.index}.{u.step}.{u.key}.jobs" {args}'
                  ' --out "$d/data" --summary "$d/gpu.json.tmp" --results "$d/results.jsonl") > "$d/gpu.log" 2>&1 || exit 1',
                  '  mv "$d/gpu.json.tmp" "$d/gpu.json"', 'fi']
    return "\n".join(lines) + "\n"


def build_upload(work: Path, pod_index: int, lanes: list[Lane], gen_args: list[str], model_files: list[Path], cache: Path | None,
                 commit: str, torch_version: str, verify: list[str] | None, volume_tar: str | None = None, home: str = "full") -> Path:
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
        for c in cache.glob("*.cubin"):  # the odds tables (240 MB) are built on the pod, once, in about two minutes
            shutil.copyfile(c, stage / "cache" / c.name)
    (stage / "worker.sh").write_bytes((HERE / "worker.sh").read_bytes().replace(b"\r\n", b"\n"))  # a CRLF checkout
    (stage / "job.json").write_text(json.dumps({"torch": torch_version, "verify": verify, "allowUnverified": "--allow-unverified" in gen_args,
                                                "commit": commit, "volume": volume_tar and f"{VOL}/{volume_tar}", "home": home}),
                                    encoding="utf8")
    for lane in lanes:
        for u in lane.units:
            lines = [table_line(t) for t in u.tables]
            (stage / "lanes" / f"{lane.index}.{u.step}.{u.key}.jobs").write_text("\n".join(lines) + "\n", encoding="utf8", newline="\n")
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


# worker.sh's status when every lane failed within seconds and none delivered anything: the code, the models or the
# arguments, not the host, so a replacement would fail the same way (2026-10-22: 14 replacements for nothing)
SYSTEMATIC = "failed: systematic:"


@dataclass
class Slot:
    """One planned pod's share of the lanes. A pod that never becomes reachable, fails its upload or start, or ends
    with lanes unplayed is terminated and a replacement takes over what is left (at most --replacements times)."""
    k: int
    lanes: list
    tries: int = 0
    pod: Pod | None = None
    retry_at: float = 0.0
    create_fails: int = 0
    no_pod_since: float = 0.0  # when RunPod first could not place this slot's pod (0: it could)
    billed: float = 0.0  # seconds of the slot's earlier pods (each billed from its creation)
    done: bool = False
    failed: str = ""


def unit_dir(work: Path, u: Unit) -> Path:
    """Where a delivered configuration is kept (its data/, gpu.json, gpu.log; member.txt and volume.txt for a volume
    run): OUT/remote/units/<step>/<key>, across runs, until its step is merged."""
    return work / "units" / u.step / u.key


def delivered(work: Path, u: Unit) -> bool:
    return (unit_dir(work, u) / "gpu.json").exists()


def todo(work: Path, lane: Lane) -> Lane | None:
    """The lane with only the configurations it has not delivered yet (None when it has delivered all of them)."""
    units = [u for u in lane.units if not delivered(work, u)]
    return Lane(lane.index, lane.pod, lane.gpu, units) if units else None


def collect(work: Path, slot: Slot, tar: Path, volume_tar: str | None = None) -> int:
    """Keep every configuration of a pod's out.tar.gz that delivered its gpu.json, as work/units/<step>/<key> (with a
    network volume, volume.txt names the archive on it that holds its arrays and member.txt its path in there).
    Returns how many were kept."""
    tmp = work / f"attempt-{slot.k}-{slot.tries}"
    shutil.rmtree(tmp, ignore_errors=True)
    extract(tar, tmp)
    dest = work / f"pod-{slot.k}"
    dest.mkdir(parents=True, exist_ok=True)
    for f in ("env.json", "setup.log", "verify.log", "verify-fingerprint.json"):
        if (tmp / f).exists():
            shutil.copyfile(tmp / f, dest / f)
    kept = 0
    for d in sorted((tmp / "lanes").glob("*/*/*")):  # lanes/<lane>/<step>/<key>
        if d.is_dir() and (d / "gpu.json").exists():
            target = work / "units" / d.parent.name / d.name
            shutil.rmtree(target, ignore_errors=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(d), str(target))
            (target / "member.txt").write_text(d.relative_to(tmp).as_posix(), encoding="utf8")
            if volume_tar:
                (target / "volume.txt").write_text(volume_tar, encoding="utf8")
            kept += 1
    shutil.rmtree(tmp, ignore_errors=True)
    return kept


def run(args, gen_args: list[str]):
    out = Path(args.out)
    work = out / "remote"
    work.mkdir(parents=True, exist_ok=True)
    steps = [(s, j) for s, j in args.step if not (out / s / "gpu.json").exists()]
    if not steps:
        print("every step already has its gpu.json")
        return 0
    cache = Path(args.cache) if args.cache else PKG / "delove_gpu" / "_cache"
    timings = read_timings(args.timings)
    all_units = make_units(steps, set(args.only.split(",")) if args.only else None, timings, cached=cache.is_dir() and any(cache.glob("*.cubin")))
    commit = subprocess.run(["git", "rev-parse", args.commit], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    unit_keys(all_units, gen_args, commit)
    units = [u for u in all_units if not delivered(work, u)]
    if len(units) < len(all_units):
        print(f"{len(all_units) - len(units)} of {len(all_units)} configurations were delivered by an earlier run (OUT/remote/units/); "
              f"planning the {len(units)} left", flush=True)
    if not units:
        return merge_all(args, steps, all_units, work, [], 0.0, volume_info(args.volume) if args.volume else None,
                         "small" if args.volume and not args.home_copy else "full")
    lanes = assign(units, args.pods, args.gpus, args.procs, args.share)
    lanes = [lane for lane in lanes if lane.units]
    pods_used = sorted({lane.pod for lane in lanes})
    wall, gpu_hours = print_plan(lanes, len(pods_used), args.gpus, args.price, args.speed)
    if gpu_hours > args.max_gpu_hours:
        raise SystemExit(f"estimated {gpu_hours:.2f} GPU-hours is over the cap --max-gpu-hours {args.max_gpu_hours}; nothing launched")
    if not args.yes:
        print("dry run: add --yes to launch")
        return 0
    git_check(args.commit)
    if args.capacity_check and not wait_for_stock(args):
        print(f"no {args.gpu_type} in stock after {args.capacity_wait:.0f} min: nothing launched (try --gpu-type with a fallback, "
              "--cloud COMMUNITY, or later)", flush=True)
        return 1
    import importlib.metadata as md

    torch_version = args.torch or md.version("torch")
    model_files = needed_models(units, gen_args, Path(args.models))
    if args.verify:  # verify.py's CPU side plays the rankers' ONNX exports (and the GPU side their .pt): its --ranker, and
        # the matrix suites' own (tests/matrix.py NETP)
        va = shlex.split(args.verify)
        netp = re.search(r'NETP = "[^"]*", "([^"]+)"', (PKG / "tests" / "matrix.py").read_text(encoding="utf8")).group(1)
        # and verify.py --model's network (give it as /root/job/models/<id>.pt): its .pt, .onnx and .json (fog inputs)
        vm = [Path(va[va.index("--model") + 1]).stem] if "--model" in va else []
        for vr in dict.fromkeys([va[va.index("--ranker") + 1] if "--ranker" in va else "delove@2", netp, *vm]):
            model_files += [Path(args.models) / f"{vr}{ext}" for ext in (".onnx", ".pt") if Path(args.models, f"{vr}{ext}") not in model_files]
        model_files += [p for p in (Path(args.models) / f"{m}.json" for m in vm) if p.exists() and p not in model_files]
    vol = volume_info(args.volume) if args.volume else None
    home = "small" if vol and not args.home_copy else "full"
    vtar = (lambda p, suffix="": f"incoming/{args.name}/{p.name}{suffix}.tar.gz") if vol else (lambda p, suffix="": None)
    if vol:
        print(f"network volume {vol['id']} in {vol['dataCenterId']}: the arrays go to {VOL}/incoming/{args.name}/"
              + ("" if home == "small" else " and are downloaded too"), flush=True)
    for old in list(work.glob("pod-*")) + list(work.glob("attempt-*")):  # a previous run's pods (its kept units are in units/)
        shutil.rmtree(old, ignore_errors=True)
    # The hard limit: no more pods run at once than the plan has, and each slot (planned pod) gets the cap's share of
    # billed pod time, counted from each pod's creation: a pod RunPod places late loses nothing, a replacement gets only
    # what its slot has left, and the pod's own watchdog ends it 15 minutes after its share, whatever happens here.
    share_s = args.max_gpu_hours * 3600 / (len(pods_used) * args.gpus)
    ssh = Ssh(work)
    pods: list[Pod] = []
    slots = [Slot(k, [lane for lane in lanes if lane.pod == k]) for k in pods_used]
    ledger = work / "pods.json"
    t0 = time.time()
    stamp = dt.datetime.now().strftime("%m%d-%H%M")
    verify = shlex.split(args.verify) if args.verify else None
    eta_file = work / "eta"  # the estimated end, for `remote.py train --eta` (it rents its pod a little before)
    eta_file.write_text(f"{t0 + wall * 60:.0f}\n", encoding="utf8")

    def eta():
        ends = [time.time()]
        for s in slots:
            left = [lane for lane in (todo(work, lane) for lane in s.lanes) if lane] if not (s.done or s.failed) else []
            if left:
                begun = s.pod.started if s.pod else time.time()
                ends.append(begun + (SETUP_MIN + max(lane.minutes for lane in left) / args.speed + 5) * 60)
        eta_file.write_text(f"{max(ends):.0f}\n", encoding="utf8")

    def save():
        ledger.write_text(json.dumps([p.__dict__ for p in pods], indent=1), encoding="utf8")

    systematic: list[str] = []  # a pod whose every lane failed at once (worker.sh): no more pods for this run

    def give_up(slot: Slot, why: str):
        slot.failed = why
        print(f"  slot {slot.k}: giving up ({why})", flush=True)

    def left_s(slot: Slot) -> float:
        """The slot's billed time still to spend (its current pod counts from its creation)."""
        return share_s - slot.billed - (time.time() - slot.pod.started if slot.pod else 0.0)

    def retire(slot: Slot):
        """The slot's pod is gone: its billed time counts against the slot."""
        p = slot.pod
        slot.billed += (p.ended or time.time()) - p.started
        slot.pod = None

    def cut(slot: Slot):
        """The slot's time is spent: the pod packs the configurations it finished (worker.sh --salvage), they are
        downloaded and kept, and the pod is terminated."""
        p = slot.pod
        kept = 0
        if p.state == "running" and p.ip:
            try:
                ssh.run(p, "bash /root/job/worker.sh /root/job --salvage", timeout=600)
                dest = work / f"pod-{slot.k}.tar.gz"
                ssh.get(p, "/root/job/out.tar.gz", dest)
                kept = collect(work, slot, dest, vtar(p, "-salvage"))
                dest.unlink()
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, ValueError, OSError, tarfile.TarError) as e:
                print(f"  {p.name}: could not salvage its finished configurations ({type(e).__name__}: {str(e)[:200]})", flush=True)
        try:
            ssh.run(p, "rm -rf /root/job/models", timeout=30, check=False) if p.ip else None
        except Exception:  # noqa: BLE001 - terminating matters more
            pass
        terminate(p)
        if p.gone:
            p.state = "cut"
            retire(slot)
        save()
        give_up(slot, f"its time is spent ({share_s / 60:.0f} min of pod time, --max-gpu-hours {args.max_gpu_hours}); "
                      f"{kept} finished configuration(s) kept")

    def drop(slot: Slot, why: str):
        """The slot's pod failed: terminate it; a replacement takes over what is left at a later pass, and only once the
        old pod is really gone (a DELETE that failed is retried each pass), so no slot ever pays for two pods."""
        p = slot.pod
        print(f"  pod {p.name}: {why}", flush=True)
        if p.ip and not p.gone:
            try:
                ssh.run(p, "rm -rf /root/job/models", timeout=30, check=False)
            except Exception:  # noqa: BLE001 - terminating matters more
                pass
        p.state = "terminating"
        release(slot)

    def release(slot: Slot):
        p = slot.pod
        terminate(p)
        if p.gone:
            p.state = "failed"
            retire(slot)
            slot.retry_at = 0.0
        save()

    def launch(slot: Slot):
        left = [lane for lane in (todo(work, lane) for lane in slot.lanes) if lane]
        if not left:
            slot.done = True
            return
        if systematic:
            give_up(slot, f"not rented: another pod failed systematically ({systematic[0]})")
            return
        if slot.tries > args.replacements:
            give_up(slot, f"{slot.tries} pods tried")
            return
        remaining = left_s(slot)
        need = (SETUP_MIN + max(lane.minutes for lane in left) / args.speed + 5) * 60
        if remaining <= 0 or (slot.tries and remaining < need):
            give_up(slot, f"{remaining / 60:.0f} min of its pod time left, its lanes need about {need / 60:.0f}")
            return
        slot.tries += 1
        try:
            p = create_pod(f"{PREFIX}{args.name}-{stamp}-{slot.k}" + (f"r{slot.tries - 1}" if slot.tries > 1 else ""), args, ssh.pub,
                           int(remaining + 900), vol)
        except RunPodError as e:
            # Nothing was rented, so nothing is billed: ask again each minute, up to --capacity-wait minutes.
            slot.tries -= 1
            slot.create_fails += 1
            slot.no_pod_since = slot.no_pod_since or time.time()
            if time.time() - slot.no_pod_since >= args.capacity_wait * 60:
                give_up(slot, f"no pod after {slot.create_fails} tries over {args.capacity_wait:.0f} min ({e})")
            else:
                print(f"  slot {slot.k}: no pod ({e}); trying again in a minute", flush=True)
                slot.retry_at = time.time() + 60
            return
        slot.no_pod_since = 0.0
        p.lanes = [lane.index for lane in left]
        slot.pod = p
        pods.append(p)
        save()
        print(f"pod {p.name} ({p.id}) created for lanes {p.lanes}{' (replacement)' if slot.tries > 1 else ''}, ${p.cost:.2f}/h", flush=True)

    def start(slot: Slot):
        p = slot.pod
        left = [lane for lane in (todo(work, lane) for lane in slot.lanes) if lane]
        tar = build_upload(work, slot.k, left, gen_args, model_files, cache, commit, torch_version, verify, vtar(p), home)
        try:
            ssh.put(p, tar, "/root/upload.tar")
        finally:
            tar.unlink(missing_ok=True)  # it holds the models
        ssh.run(p, "mkdir -p /root/job && tar -xf /root/upload.tar -C /root/job && rm /root/upload.tar && "
                   "(setsid nohup bash /root/job/worker.sh /root/job > /root/job/worker.out 2>&1 < /dev/null &)")
        p.state = "running"
        save()

    def finish(slot: Slot, state: str):
        p = slot.pod
        dest = work / f"pod-{slot.k}.tar.gz"
        try:
            ssh.get(p, "/root/job/out.tar.gz", dest)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, ValueError):
            print(f"  {p.name}: no out.tar.gz to download")
        if dest.exists():
            collect(work, slot, dest, vtar(p))
            dest.unlink()
        if all(todo(work, lane) is None for lane in slot.lanes):
            ssh.run(p, "rm -rf /root/job/models", check=False)
            terminate(p)
            p.state = "done"
            retire(slot)
            slot.done = True
            save()
        else:
            drop(slot, state if state != "done" else "done, but some lanes delivered nothing")
            if state.startswith(SYSTEMATIC):  # the same cause would sink every replacement: stop renting
                systematic.append(state)
                give_up(slot, f"no replacement: {state}")

    try:
        last = 0.0
        while any(not s.done and not s.failed for s in slots):
            loud = time.time() - last > 120
            for s in slots:
                if s.done or s.failed:
                    continue
                if s.pod is not None and s.pod.state != "terminating" and left_s(s) <= 0:
                    cut(s)
                    continue
                p = s.pod
                if p is None:
                    if time.time() >= s.retry_at:
                        launch(s)
                    continue
                if p.state == "terminating":
                    release(s)
                    continue
                if p.state == "starting":
                    if ready(p, ssh):
                        print(f"pod {p.name} ready at {p.ip}:{p.port} (${p.cost:.2f}/h)", flush=True)
                        try:
                            start(s)
                        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, ValueError, OSError) as e:
                            drop(s, f"upload or start failed ({type(e).__name__}: {str(e)[:200]})")
                    elif time.time() - p.started > args.ready_minutes * 60:
                        drop(s, f"not reachable over SSH after {args.ready_minutes:.0f} min")
                    continue
                try:
                    status = ssh.run(p, "cat /root/job/status 2>/dev/null || echo missing; pgrep -f '[w]orker.sh' >/dev/null && echo alive || echo dead; for f in /root/job/lanes/*/*/*/gpu.log; do [ -f \"$f\" ] &&"
                                        " echo \"$f: $(grep -a ' step \\| games in ' \"$f\" | tail -n1 | cut -c1-160)\"; done; true", timeout=60)  # true: no gpu.log yet is not a failed poll
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
                if loud:
                    print(f"[{dt.datetime.now():%H:%M:%S}] {p.name}: {state}", flush=True)
                    for line in lines[2:]:
                        print("    " + line.replace("/root/job/lanes/", "lane "), flush=True)
                if state == "done" or state.startswith("failed"):
                    finish(s, state)
            if loud:
                last = time.time()
                eta()
            time.sleep(15)
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
        print(f"pods: {len(pods)} ({len(pods) - len(slots)} replacements), {hours:.2f} pod-hours, "
              f"about ${sum(((p.ended or time.time()) - p.started) / 3600 * p.cost for p in pods):.2f}")
        ssh.forget()
    rc = merge_all(args, steps, all_units, work, pods, time.time() - t0, vol, home)
    failed = [f"slot {s.k} (lanes {[lane.index for lane in s.lanes]}): {s.failed}" for s in slots if s.failed]
    if failed:
        if args.accept_partial and all((Path(args.out) / st / "gpu.json").exists() for st, _ in steps):
            print("INCOMPLETE, merged anyway (--accept-partial; each step's gpu.json lists what is missing):\n  " + "\n  ".join(failed))
            return rc
        print("FAILED (configurations they finished are kept in OUT/remote/units/; run the same command again to play the rest):\n  "
              + "\n  ".join(failed))
        return 1
    return rc


def merge_all(args, steps, units: list[Unit], work: Path, pods: list[Pod], seconds: float, vol: dict | None = None,
              home: str = "full") -> int:
    """Each step whose configurations are all kept (OUT/remote/units/): its gpu.json and gpu.log in OUT/<step>/, its
    arrays in DATA/<name>-<step>/ (home "full"), configurations in plan order. A step with configurations missing
    gets OUT/<step>/gpu.partial.json (what is kept, what is missing) and is not merged, unless --accept-partial: then
    it is merged from what there is and its gpu.json says what is missing ("partial"). With a network volume,
    OUT/remote/volume.json records which archive on it holds each configuration's arrays (and where in it), in merge
    order, for `remote.py train` (cloud/trainer.py merges them there exactly as merge_step does here)."""
    from merge import merge_step

    manifest_file = work / "volume.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf8")) if manifest_file.exists() else {}
    if vol and manifest.get("volume") not in (None, vol["id"]):
        manifest = {}  # another volume's archives

    out, data = Path(args.out), Path(args.data)
    env = {}
    for f in sorted(work.glob("pod-*/env.json")):
        env[f.parent.name.replace("-", " ")] = json.loads(f.read_text(encoding="utf8"))
    describe = lambda u: {"config": u.label, "tables": [t.name for t in u.tables], "games": u.games}  # noqa: E731
    rc = 0
    for step, _ in steps:
        su = [u for u in units if u.step == step]
        got = [u for u in su if delivered(work, u)]
        missing = [u for u in su if not delivered(work, u)]
        (out / step).mkdir(parents=True, exist_ok=True)  # cycle.sh makes it; a run by hand may not have
        if missing:
            (out / step / "gpu.partial.json").write_text(json.dumps({"kept": [describe(u) for u in got], "missing": [describe(u) for u in missing]},
                                                                    indent=1) + "\n", encoding="utf8")
            if not args.accept_partial or not got:
                print(f"{step}: {len(missing)} of {len(su)} configurations missing ({', '.join(t.name for u in missing for t in u.tables)}); "
                      f"the step is not merged (the {len(got)} kept are in OUT/remote/units/; run again to play the rest, "
                      "or --accept-partial)")
                rc = 1
                continue
        if not got:
            continue
        parts = [(json.loads((unit_dir(work, u) / "gpu.json").read_text(encoding="utf8")), unit_dir(work, u) / "data") for u in got]
        extra = {"configs": [u.label for u in got], "pods": len(pods), "gpuType": args.gpu_type, "gpus": env,
                 "wallSeconds": round(seconds, 1), "costPerHour": [p.cost for p in pods]}
        if missing:
            extra["partial"] = {"missing": [describe(u) for u in missing]}
        merged = merge_step(parts, data / f"{args.name}-{step}" if home == "full" else None, extra)
        if missing:
            merged["partial"] = extra["partial"]
            print(f"{step}: merged WITHOUT {len(missing)} missing configuration(s) (--accept-partial)")
        if vol:
            manifest.update({"volume": vol["id"], "dataCenter": vol["dataCenterId"]})
            manifest.setdefault("steps", {})[step] = {
                "dataset": f"{args.name}-{step}", "maps": [e["map"] for e in merged.get("export", [])],
                "parts": [{"tar": (unit_dir(work, u) / "volume.txt").read_text(encoding="utf8"),
                           "member": (unit_dir(work, u) / "member.txt").read_text(encoding="utf8")} for u in got]}
            manifest_file.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf8")
        with open(out / step / "gpu.log", "w", encoding="utf8", newline="\n") as f:
            for u in got:
                f.write(f"==== {u.label} [{','.join(t.name for t in u.tables)}] ====\n")
                f.write((unit_dir(work, u) / "gpu.log").read_text(encoding="utf8", errors="replace"))
        (out / step / "gpu.json").write_text(json.dumps(merged, indent=2) + "\n", encoding="utf8")
        # every game's result (generate --results: placements, kills, points), configuration after configuration
        with open(out / step / "results.jsonl", "w", encoding="utf8", newline="\n") as f:
            for u in got:
                if (unit_dir(work, u) / "results.jsonl").exists():
                    f.write((unit_dir(work, u) / "results.jsonl").read_text(encoding="utf8"))
        if not missing:
            (out / step / "gpu.partial.json").unlink(missing_ok=True)
        where = data / f"{args.name}-{step}" if home == "full" else f"the volume ({VOL}/incoming/{args.name}/)"
        print(f"{step}: {merged['games']} games -> {where} ({', '.join(e['map'] for e in merged.get('export', []))})")
        if not args.keep:
            shutil.rmtree(work / "units" / step, ignore_errors=True)
    return rc


# ---- train on a cloud GPU -------------------------------------------------------------------------------------------
TRAIN_SETUP_MIN = 8.0  # pod start, the commit, PyTorch (minutes; measure and adjust)
TRAIN_PREP_MIN = 8.0  # merging the cycle's arrays and unpacking every dataset on the pod (about 120 GB for cycle 8)
MISSING = 3  # `train` exit code: a dataset is not on the volume (nothing trained; cycle.sh trains at home instead)
MODES = ("imitate", "winners", "advantage", "value")


def parse_data(spec: str) -> dict:
    """'<dataset>/<map>[:mode][#F]' (cycle.sh's resolved train_data entry) as trainer.py's {dataset, map, suffix}."""
    rest, suffix = spec, ""
    if "#" in rest:
        rest, f = rest.rsplit("#", 1)
        suffix = f"#{f}"
    for m in MODES:
        if rest.endswith(":" + m):
            rest, suffix = rest[: -len(m) - 1], f":{m}{suffix}"
    parts = rest.replace("\\", "/").strip("/").split("/")
    if len(parts) != 2 or not all(parts) or any(p in (".", "..") for p in parts):
        raise SystemExit(f"--data {spec!r}: not <dataset>/<map> (a path outside DATA cannot train in the cloud)")
    return {"dataset": parts[0], "map": parts[1], "suffix": suffix}


def on_volume(inventory: set[str], steps: dict, ds: str, m: str) -> bool:
    """The dataset is on the volume already, or the incoming archives to merge it are."""
    if f"datasets/{ds}/{m}.tar.gz" in inventory:
        return True
    return any(s["dataset"] == ds and m in s["maps"] and all(p["tar"] in inventory for p in s["parts"]) for s in steps.values())


def pack_dataset(folder: Path, out: Path):
    with tarfile.open(out, "w:gz", compresslevel=1) as t:
        t.add(folder, arcname=folder.name)


def pack_key(folder: Path) -> str:
    """What a dataset folder's pack depends on: its features.json, and the total size and newest mtime of its files."""
    h = hashlib.sha256((folder / "features.json").read_bytes())
    size = newest = 0
    for f in sorted(folder.rglob("*")):
        if f.is_file():
            st = f.stat()
            size += st.st_size
            newest = max(newest, st.st_mtime_ns)
    h.update(f"{size}:{newest}".encode())
    return h.hexdigest()[:16]


def cached_pack(folder: Path, cache: Path, ds: str, m: str) -> tuple[Path, bool]:
    """The dataset folder's .tar.gz from the home pack cache, packed now only when the folder changed (or was never
    packed): (tar, packed now). Older packs of the same dataset and map are removed."""
    cache.mkdir(parents=True, exist_ok=True)
    tar = cache / f"{ds}--{m}--{pack_key(folder)}.tar.gz"
    if tar.exists():
        return tar, False
    for old in cache.glob(f"{ds}--{m}--*.tar.gz*"):
        old.unlink(missing_ok=True)
    part = tar.with_name(tar.name + ".part")
    pack_dataset(folder, part)
    part.replace(tar)
    return tar, True


def train(args, train_args: list[str]) -> int:
    """One training pod in the volume's data center (cloud/trainer.sh, cloud/trainer.py). With --wait-for, the pod is
    rented --lead-minutes before generation's estimated end (--eta), sets up and unpacks the earlier cycles' datasets
    while generation finishes, and gets this cycle's steps (go.json) once every --wait-for file exists. Exit 0: the
    candidate's files are in --models and train.log in OUT; 3 (MISSING): a dataset is not in the cloud, nothing was
    trained; 1: a failure. Every pod is terminated on every path."""
    out = Path(args.out)
    work = out / "remote-train"
    data = [parse_data(d) for d in args.data]
    mine = lambda ds: ds.startswith(f"{args.name}-")  # noqa: E731 - this cycle's datasets (merged on the pod)
    train_min = 0 if args.no_train else args.home_minutes / args.speed
    minutes = TRAIN_SETUP_MIN + TRAIN_PREP_MIN + train_min + 3
    gpu_hours = minutes / 60
    print(f"train {args.candidate or '(no training)'} on one cloud GPU: {len({(d['dataset'], d['map']) for d in data})} datasets; about {minutes:.0f} min "
          f"of pod ({TRAIN_SETUP_MIN:.0f} setup + {TRAIN_PREP_MIN:.0f} data + {train_min:.0f} training at {args.speed}x the home GPU "
          f"+ 3 export and download), about ${gpu_hours * args.price:.2f} at ${args.price:.2f}/GPU-hour"
          + (f"; the setup and earlier datasets overlap generation's last {args.lead_minutes:.0f} min" if args.wait_for else ""), flush=True)
    if gpu_hours > args.max_gpu_hours:
        raise SystemExit(f"estimated {gpu_hours:.2f} GPU-hours is over the cap --max-gpu-hours {args.max_gpu_hours}; nothing launched")
    if not args.yes:
        print("dry run: add --yes to launch")
        return 0
    work.mkdir(parents=True, exist_ok=True)
    models = Path(args.models)
    init = models / f"{args.init}.pt" if args.init else None
    if init and not init.exists():
        raise SystemExit(f"missing init model {init}")
    commit = subprocess.run(["git", "rev-parse", args.commit], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    import importlib.metadata as md

    torch_version = args.torch or md.version("torch")
    abort_file = Path(args.abort_file) if args.abort_file else work / "abort"
    wait_for = [Path(f) for f in args.wait_for]
    launched = time.time()
    manifest_file = Path(args.manifest) if args.manifest else out / "remote" / "volume.json"
    data_root = Path(args.data_root) if args.data_root else None
    # --push-missing packs come from a home cache beside DATA (kept across cycles), packed before any pod is rented
    pack_cache = Path(args.pack_cache) if args.pack_cache else (data_root.with_name(data_root.name + "-push-cache") if data_root else None)

    def pushable(ds: str, m: str) -> Path | None:
        """The home folder of a dataset --push-missing may push, else None."""
        home = data_root / ds / m if data_root else None
        if (args.push_missing == "all" or (args.push_missing == "cycle" and mine(ds))) and home and (home / "features.json").exists():
            return home
        return None

    # Every earlier dataset a push might need is packed now, before renting (this cycle's own are packed on demand once
    # generation has written them): a pod never waits on gzip. Unchanged folders are not packed again.
    if args.push_missing != "none" and pack_cache:
        for ds, m in sorted({(d["dataset"], d["map"]) for d in data if not mine(d["dataset"])}):
            home = pushable(ds, m)
            if home:
                t_pack = time.time()
                tar, packed = cached_pack(home, pack_cache, ds, m)
                print(f"  {'packed' if packed else 'cached'} {ds}/{m} for a possible push: {tar.name}"
                      + (f" ({time.time() - t_pack:.0f}s)" if packed else ""), flush=True)

    def generated() -> bool:
        return all(f.exists() for f in wait_for)

    def waited_too_long() -> bool:
        return time.time() - launched > args.wait_minutes * 60

    # No pod while generation still has more than --lead-minutes to go (its estimated end: remote.py run's eta file).
    while wait_for and not generated():
        if abort_file.exists():
            print(f"{abort_file}: generation failed; nothing rented", flush=True)
            return 1
        if waited_too_long():
            print(f"generation not done after {args.wait_minutes:.0f} min; nothing rented", flush=True)
            return 1
        try:
            eta = float(Path(args.eta).read_text(encoding="utf8").strip()) if args.eta else None
        except (OSError, ValueError):
            eta = None
        if eta is not None and time.time() >= eta - args.lead_minutes * 60:
            break
        time.sleep(30)

    vol = volume_info(args.volume)
    ssh = Ssh(work)
    pods: list[Pod] = []
    ledger = work / "pods.json"
    t0 = time.time()
    limit = args.max_gpu_hours * 3600  # one pod at a time, so the wall time is the GPU time
    stamp = dt.datetime.now().strftime("%m%d-%H%M")

    def save():
        ledger.write_text(json.dumps([p.__dict__ for p in pods], indent=1), encoding="utf8")

    def left() -> float:
        return limit - (time.time() - t0)

    def end(p: Pod):
        """Terminate p and wait until RunPod confirms it (a failed DELETE is retried), so two pods never run at once."""
        if p.ip and not p.gone:
            try:
                ssh.run(p, "rm -rf /root/job/models /root/job/out", timeout=30, check=False)
            except Exception:  # noqa: BLE001 - terminating matters more
                pass
        while not p.gone:
            terminate(p)
            if not p.gone:
                if left() < -600:
                    break  # the pod's own watchdog ends it at the deadline
                time.sleep(15)
        if p.state != "done":
            p.state = "failed"
        save()

    def tail(p: Pod) -> str:
        try:
            return ssh.run(p, "tail -n 25 /root/job/setup.log /root/job/prep.log /root/job/train.log 2>/dev/null; true", timeout=60, check=False)
        except Exception:  # noqa: BLE001
            return ""

    def inventory(p: Pod) -> set[str]:
        return set(ssh.run(p, f"cd {VOL} 2>/dev/null && find datasets incoming -name '*.tar.gz' 2>/dev/null; true", timeout=120).split())

    def have(p: Pod, inv: set[str], steps: dict, which) -> bool:
        """The datasets of `data` that `which` picks are on the volume (or their archives are), after pushing the ones
        --push-missing allows; False (and why) when one cannot be had in the cloud."""
        missing = sorted({(d["dataset"], d["map"]) for d in data if which(d["dataset"]) and not on_volume(inv, steps, d["dataset"], d["map"])})
        push, stuck = [], []
        for ds, m in missing:
            home = pushable(ds, m)
            if home:
                push.append((ds, m, home))
            else:
                stuck.append(f"{ds}/{m}")
        if stuck:
            print(f"not on the volume {vol['id']}: {', '.join(stuck)} (--push-missing {args.push_missing}); nothing trained in the cloud", flush=True)
            return False
        for ds, m, home in push:
            print(f"  pushing {ds}/{m} from {home} to the volume (once: later cycles find it there)", flush=True)
            local, _ = cached_pack(home, pack_cache, ds, m)  # packed before renting (earlier datasets), else now
            ssh.run(p, f"mkdir -p {VOL}/datasets/{shlex.quote(ds)}")
            ssh.put(p, local, f"{VOL}/datasets/{ds}/{m}.tar.gz", timeout=6 * 3600)
        return True

    def start(p: Pod) -> bool:
        """Earlier datasets checked (and pushed), the job uploaded and the trainer started. False: a dataset is missing
        (nothing private was uploaded)."""
        if not have(p, inventory(p), {}, lambda ds: not mine(ds)):
            return False
        stage = work / "stage"
        shutil.rmtree(stage, ignore_errors=True)
        (stage / "models").mkdir(parents=True)
        with open(stage / "src.tar", "wb") as f:
            subprocess.run(["git", "-c", "core.autocrlf=false", "archive", "--format=tar", commit], cwd=REPO, stdout=f, check=True)
        if init:
            shutil.copyfile(init, stage / "models" / init.name)
        (stage / "trainer.sh").write_bytes((HERE / "trainer.sh").read_bytes().replace(b"\r\n", b"\n"))
        job = {"torch": torch_version, "name": args.name, "candidate": args.candidate, "init": args.init or None,
               "train": not args.no_train, "train_args": train_args, "data": data}
        (stage / "job.json").write_text(json.dumps(job, indent=1), encoding="utf8")
        tar = work / "upload.tar"
        with tarfile.open(tar, "w") as t:
            for x in sorted(stage.iterdir()):
                t.add(x, arcname=x.name)
        shutil.rmtree(stage)  # the staged copy of the init model
        try:
            ssh.put(p, tar, "/root/upload.tar")
        finally:
            tar.unlink(missing_ok=True)  # it holds the init model
        ssh.run(p, "mkdir -p /root/job && tar -xf /root/upload.tar -C /root/job && rm /root/upload.tar && "
                   "(setsid nohup bash /root/job/trainer.sh /root/job > /root/job/trainer.out 2>&1 < /dev/null &)")
        p.state = "running"
        save()
        return True

    def send(p: Pod, go: dict):
        f = work / "go.json"
        f.write_text(json.dumps(go, indent=1), encoding="utf8")
        ssh.put(p, f, "/root/job/go.json")
        f.unlink()

    def go_steps(p: Pod) -> dict | None:
        """This cycle's steps for go.json (generation's volume.json), or None when a dataset of this cycle is missing."""
        manifest = json.loads(manifest_file.read_text(encoding="utf8")) if manifest_file.exists() else {}
        if manifest and manifest.get("volume") != vol["id"]:
            print(f"{manifest_file} is for volume {manifest.get('volume')}, not {vol['id']}: its steps are ignored", flush=True)
            manifest = {}
        inv = inventory(p)
        steps = {k: s for k, s in manifest.get("steps", {}).items()
                 if all(f"datasets/{s['dataset']}/{m}.tar.gz" in inv for m in s["maps"]) or all(x["tar"] in inv for x in s["parts"])}
        for k in sorted(set(manifest.get("steps", {})) - set(steps)):
            print(f"  step {k}: its archives are not on the volume: not merged", flush=True)
        return steps if have(p, inv, steps, mine) else None

    def deliver(p: Pod) -> bool:
        dest = work / "result.tar.gz"
        ssh.get(p, "/root/job/result.tar.gz", dest)
        res = work / "result"
        shutil.rmtree(res, ignore_errors=True)
        extract(dest, res)
        dest.unlink()
        names = [f"{args.candidate}{s}" for s in (".pt", ".json", ".value.onnx", ".onnx")]  # .onnx last: cycle.sh's "trained"
        lacking = [n for n in names + ["train.log"] if not (res / n).exists()]
        if lacking:
            print(f"  the result lacks {lacking}", flush=True)
            return False
        shutil.copyfile(res / "train.log", out / "train.log")
        models.mkdir(parents=True, exist_ok=True)
        for n in names:
            shutil.copyfile(res / n, models / n)
        shutil.rmtree(res)
        print(f"trained {args.candidate} -> {models} (train.log in {out})", flush=True)
        return True

    errors = (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, ValueError, OSError)
    rc = 1
    try:
        tries = refused = 0
        while tries <= args.replacements:
            if left() < (TRAIN_SETUP_MIN + 5) * 60:
                print("too little of --max-gpu-hours is left for another pod; giving up", flush=True)
                break
            try:
                p = create_pod(f"{PREFIX}{args.name}-train-{stamp}" + (f"r{tries}" if tries else ""), args, ssh.pub, int(left() + 900), vol)
            except RunPodError as e:
                refused += 1
                if refused >= 10:
                    print(f"no pod in {vol['dataCenterId']} after 10 tries ({e})", flush=True)
                    break
                print(f"  no pod ({e}); trying again in a minute", flush=True)
                time.sleep(60)
                continue
            tries += 1
            pods.append(p)
            save()
            print(f"pod {p.name} ({p.id}) created in {vol['dataCenterId']}, ${p.cost:.2f}/h", flush=True)
            up = False
            while time.time() - p.started < args.ready_minutes * 60:
                if ready(p, ssh):
                    up = True
                    break
                time.sleep(15)
            if not up:
                print(f"  pod {p.name}: not reachable over SSH after {args.ready_minutes:.0f} min", flush=True)
                end(p)
                continue
            print(f"pod {p.name} ready at {p.ip}:{p.port}", flush=True)
            try:
                if not start(p):
                    rc = MISSING
                    break
            except errors as e:
                print(f"  pod {p.name}: upload or start failed ({type(e).__name__}: {str(e)[:200]})", flush=True)
                end(p)
                continue
            replace, sent, last = False, False, 0.0
            while True:
                if left() < 0:
                    print(f"the run reached its limit ({limit / 60:.0f} min, --max-gpu-hours {args.max_gpu_hours})", flush=True)
                    break
                if not sent and (abort_file.exists() or waited_too_long()):
                    why = "generation failed" if abort_file.exists() else f"generation not done after {args.wait_minutes:.0f} min"
                    print(f"  {why}; ending {p.name}", flush=True)
                    try:
                        send(p, {"abort": why})
                    except errors:
                        pass
                    break
                try:
                    st = ssh.run(p, "cat /root/job/status 2>/dev/null || echo missing; pgrep -f '[t]rainer' >/dev/null && echo alive || echo dead;"
                                    " tail -n 1 /root/job/prep.log 2>/dev/null; tail -n 1 /root/job/train.log 2>/dev/null; true", timeout=60)
                except (RuntimeError, subprocess.TimeoutExpired) as e:
                    print(f"  {p.name}: {e}", flush=True)
                    time.sleep(15)
                    continue
                lines = st.splitlines()
                state = lines[0] if lines else "?"
                if state != "done" and not state.startswith("failed") and len(lines) > 1 and lines[1] == "dead":
                    p.dead += 1  # twice in a row: the trainer is gone without a status
                    if p.dead >= 2:
                        state = f"failed: setup: the trainer stopped while {state}"
                else:
                    p.dead = 0
                if not sent and generated() and not state.startswith("failed"):
                    try:
                        steps = go_steps(p)
                        send(p, {"steps": steps} if steps is not None else {"abort": "a dataset is not on the volume"})
                    except errors as e:
                        print(f"  {p.name}: sending go.json failed ({type(e).__name__}: {str(e)[:200]})", flush=True)
                        time.sleep(15)
                        continue
                    sent = True
                    if steps is None:
                        rc = MISSING
                        break
                    print(f"  {p.name}: generation done; {len(steps)} steps to merge", flush=True)
                if time.time() - last > 120:
                    last = time.time()
                    print(f"[{dt.datetime.now():%H:%M:%S}] {p.name}: {state}", flush=True)
                    for line in lines[2:]:
                        print("    " + line[:200], flush=True)
                if state == "done":
                    try:
                        rc = 0 if args.no_train or deliver(p) else 1
                    except errors as e:
                        print(f"  {p.name}: download failed ({type(e).__name__}: {str(e)[:200]})", flush=True)
                    p.state = "done"
                    break
                if state.startswith("failed"):
                    print(f"  {p.name}: {state}\n{tail(p)}", flush=True)
                    replace = state.startswith("failed: setup")  # the host, not the data or the training
                    break
                time.sleep(30)
            end(p)
            if not replace:
                break
    finally:
        for p in pods:
            if not p.gone:
                end(p)
        save()
        hours = sum(((p.ended or time.time()) - p.started) / 3600 for p in pods)
        print(f"pods: {len(pods)}, {hours:.2f} pod-hours, about ${sum(((p.ended or time.time()) - p.started) / 3600 * p.cost for p in pods):.2f}, "
              f"{(time.time() - t0) / 60:.1f} min from the first pod", flush=True)
        ssh.forget()
    return rc


def volume_cmd(args) -> int:
    if args.action == "info":
        v = volume_info(args.id)
        print(f"{v['id']}  {v.get('name')}  {v.get('size')} GB  {v['dataCenterId']}")
        return 0
    if not args.yes:
        print(f"would create network volume {args.label!r}, {args.size} GB in {args.dc} "
              f"(billed while it exists: about ${args.size * 0.07:.2f}/month at $0.07/GB-month); add --yes")
        return 0
    v = api("POST", "/networkvolumes", {"name": args.label, "size": args.size, "dataCenterId": args.dc})
    print(f"created network volume {v['id']} ({args.size} GB in {v.get('dataCenterId', args.dc)}): REMOTE_VOLUME={v['id']}")
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
        p.add_argument("--price", type=float, default=0.89, help="$ per GPU-hour for the estimate (a Secure Cloud RTX 4090, October 2026; the pods report their real price)")
        p.add_argument("--max-gpu-hours", type=float, default=4.0, help="hard cap: refuse a bigger estimate, terminate everything at it")
        p.add_argument("--cache", help="NVRTC kernels to upload (default: packages/delove-gpu/delove_gpu/_cache, where fused.py keeps them)")
        if name == "run":
            p.add_argument("--models", required=True)
            p.add_argument("--data", default="data/delove")
            p.add_argument("--out", required=True, help="the cycle's runs folder (OUT): OUT/<step>/gpu.json, OUT/remote/")
            p.add_argument("--commit", default="HEAD", help="the commit the pods run (git archive; need not be pushed)")
            p.add_argument("--torch", help="PyTorch version for the pods (default: this Python's, e.g. 2.11.0+cu128)")
            p.add_argument("--gpu-type", default=GPU_4090, help="RunPod GPU type id, or several comma-separated, tried in that order")
            p.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
            p.add_argument("--image", default=IMAGE)
            p.add_argument("--disk-gb", type=int, default=80)
            p.add_argument("--verify", help="also run verify.py on each pod first, with these arguments (e.g. '--ranker delove@3')")
            p.add_argument("--replacements", type=int, default=2, help="pods that may replace one that fails (per planned pod)")
            p.add_argument("--ready-minutes", type=float, default=15, help="a pod not reachable over SSH by then is replaced")
            p.add_argument("--capacity-wait", type=float, default=30,
                           help="minutes to wait for RunPod stock before launching, and for a pod it cannot place (nothing is billed meanwhile)")
            p.add_argument("--no-capacity-check", dest="capacity_check", action="store_false", help="skip the stock read before launching")
            p.add_argument("--accept-partial", action="store_true",
                           help="merge a step from the configurations that were delivered even if some are missing (gpu.json says which)")
            p.add_argument("--keep", action="store_true", help="keep the delivered configurations' arrays (OUT/remote/units/) after merging")
            p.add_argument("--volume", help="RunPod network volume id: the pods run in its data center and write their arrays to it, "
                                            "for `remote.py train` (only the small files come home, unless --home-copy)")
            p.add_argument("--home-copy", action="store_true", help="with --volume: download and merge the arrays at home too")
            p.add_argument("--yes", action="store_true", help="launch (without it: print the plan and cost only)")
    p = sub.add_parser("train", help="train a cycle's candidate on one cloud GPU, from datasets on a network volume (train.py's "
                                      "arguments after --)")
    p.add_argument("--name", required=True, help="the cycle's name (its datasets are <name>-<step>)")
    p.add_argument("--candidate", help="the model to train (e.g. c9-candidate): <models>/<candidate>.pt, .json, .onnx, .value.onnx")
    p.add_argument("--init", help="start from <models>/<init>.pt (the only model uploaded)")
    p.add_argument("--models", required=True)
    p.add_argument("--out", required=True, help="the cycle's runs folder: OUT/train.log, OUT/remote-train/, OUT/remote/volume.json")
    p.add_argument("--data", action="append", default=[], help="<dataset>/<map>[:mode][#F] (repeat; in train.py's order, repeats included)")
    p.add_argument("--volume", required=True, help="the RunPod network volume id (the pod runs in its data center)")
    p.add_argument("--manifest", help="generation's volume.json (default OUT/remote/volume.json): this cycle's archives to merge")
    p.add_argument("--data-root", help="the training PC's DATA, for --push-missing")
    p.add_argument("--pack-cache", help="home cache of --push-missing packs (default: <data-root>-push-cache, beside DATA); a "
                   "dataset is packed again only when its folder changed")
    p.add_argument("--push-missing", choices=["none", "cycle", "all"], default="none",
                   help="upload datasets the volume lacks from DATA (cycle: only this cycle's, e.g. CPU steps); else exit 3")
    p.add_argument("--wait-for", action="append", default=[], help="files generation writes when done (each GPU step's gpu.json): "
                   "the pod sets up and unpacks the earlier datasets first, and merges and trains once they all exist")
    p.add_argument("--eta", help="generation's estimated end (remote.py run writes OUT/remote/eta): no pod before --lead-minutes before it")
    p.add_argument("--lead-minutes", type=float, default=12, help="rent the pod this long before --eta")
    p.add_argument("--wait-minutes", type=float, default=240, help="give up (and terminate) if --wait-for is not there by then")
    p.add_argument("--abort-file", help="cycle.sh touches it when generation failed (default OUT/remote-train/abort)")
    p.add_argument("--no-train", action="store_true", help="only merge and push onto the volume (e.g. to seed older datasets once)")
    p.add_argument("--home-minutes", type=float, default=30, help="the same training on the home GPU (estimate only)")
    p.add_argument("--speed", type=float, default=2.2, help="the cloud GPU's training speed vs the home GPU (estimate only)")
    p.add_argument("--price", type=float, default=0.89)
    p.add_argument("--max-gpu-hours", type=float, default=1.5, help="hard cap: refuse a bigger estimate, terminate at it")
    p.add_argument("--gpu-type", default=GPU_4090)
    p.add_argument("--gpus", type=int, default=1)
    p.add_argument("--cloud", default="SECURE", choices=["SECURE", "COMMUNITY"])
    p.add_argument("--image", default=IMAGE)
    p.add_argument("--disk-gb", type=int, default=200, help="the pod's own disk: every dataset unpacked (cycle 8: about 120 GB)")
    p.add_argument("--replacements", type=int, default=2, help="pods that may replace one whose host fails (not the training)")
    p.add_argument("--ready-minutes", type=float, default=15)
    p.add_argument("--commit", default="HEAD")
    p.add_argument("--torch")
    p.add_argument("--yes", action="store_true")
    v = sub.add_parser("volume", help="a network volume: info ID, or create (--label --size --dc --yes)")
    v.add_argument("action", choices=["info", "create"])
    v.add_argument("id", nargs="?")
    v.add_argument("--label", default="delove-data")
    v.add_argument("--size", type=int, default=100, help="GB")
    v.add_argument("--dc", help="data center id, e.g. EU-RO-1 (one with RTX 4090 stock)")
    v.add_argument("--yes", action="store_true")
    sub.add_parser("pods")
    t = sub.add_parser("terminate")
    t.add_argument("ids", nargs="*")
    t.add_argument("--all", action="store_true", help="every delove-* pod of the account")
    args = ap.parse_args(argv)
    if args.cmd == "plan":
        cache = Path(args.cache) if args.cache else PKG / "delove_gpu" / "_cache"
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
    if args.cmd == "train":
        if not args.no_train and not args.candidate:
            raise SystemExit("--candidate is required (or --no-train)")
        for bad in ("--data", "--out", "--init"):
            if bad in gen_args:
                raise SystemExit(f"{bad} is set by remote.py, not after --")
        return train(args, gen_args)
    if args.cmd == "volume":
        if (args.action == "info") != bool(args.id) or (args.action == "create" and not args.dc):
            raise SystemExit("volume info ID | volume create --dc DC [--size GB] [--label NAME] [--yes]")
        return volume_cmd(args)
    if args.cmd == "pods":
        list_pods(args)
    elif args.cmd == "terminate":
        terminate_cmd(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
