"""The training pod's side of `remote.py train` (runs on a RunPod pod with the network volume at /workspace).

TRAINING ONLY. cloud/trainer.sh sets the pod up (the commit, PyTorch) and runs this with the uploaded JOB/job.json:

    {"name": "c9", "candidate": "c9-candidate", "init": "delove@5" or null, "train": true,
     "train_args": ["--epochs", "1.5", ...],
     "data": [{"dataset": "c9-a1", "map": "classic", "suffix": ":value#0.3"}, ...]}   # train.py's --data, in order

0. earlier cycles' datasets (every "data" entry not named <name>-...) are unpacked first, while generation may still
   be playing; then the trainer waits for JOB/go.json, which remote.py writes once generation is done:
     {"steps": {"a1": {"dataset": "c9-a1", "maps": ["classic"], "parts": [{"tar": "incoming/c9/<pod>.tar.gz", "lane": 0}, ...]}}}
   or {"abort": "<why>"}.
1. merge: every step of "steps" whose datasets are not on the volume yet is merged from the generation pods' archives
   (VOLUME/incoming/<name>/<pod>.tar.gz, lane after lane in the order remote.py merged them at home, so the folder is
   the one a home merge writes), and each of its maps is kept on the volume as VOLUME/datasets/<dataset>/<map>.tar.gz
   for later cycles; the incoming archives are then deleted.
2. fetch: every dataset of "data" is unpacked from the volume onto the pod's own disk (WORK/data/<dataset>/<map>).
3. train: train.py with the cycle's arguments (cycle.sh's), then export_onnx.py; JOB/result.tar.gz holds only
   <candidate>.pt, .json, .onnx, .value.onnx and train.log (the arrays never leave the volume and the pod).

JOB/status: preparing, training, packing, done, or failed: <why>. Standard library and NumPy (and train.py's PyTorch).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def fast() -> bool:
    return bool(shutil.which("pigz") and shutil.which("tar"))


def unpack(tar: Path, dest: Path, members: list[str] | None = None):
    """Extract `tar` (gzip) into dest; `members`: only these paths (directories with everything under them)."""
    dest.mkdir(parents=True, exist_ok=True)
    if fast():
        cmd = f"pigz -dc {sh(tar)} | tar -xf - -C {sh(dest)}" + "".join(" " + sh(m) for m in members or [])
        subprocess.run(["bash", "-o", "pipefail", "-c", cmd], check=True)
        return
    with tarfile.open(tar, "r:gz") as t:
        picked = [m for m in t.getmembers() if not members or any(m.name == x or m.name.startswith(x.rstrip("/") + "/") for x in members)]
        for m in picked:
            if m.name.startswith(("/", "..")) or ".." in Path(m.name).parts or not (m.isfile() or m.isdir()):
                raise SystemExit(f"{tar}: unexpected member {m.name}")
        t.extractall(dest, members=picked)


def pack(parent: Path, name: str, out: Path):
    """parent/name as out (tar, gzip -1), written to out.part and renamed, so a half-written archive is never used."""
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    if fast():
        subprocess.run(["bash", "-o", "pipefail", "-c", f"tar -cf - -C {sh(parent)} {sh(name)} | pigz -1 > {sh(part)}"], check=True)
    else:
        with tarfile.open(part, "w:gz", compresslevel=1) as t:
            t.add(parent / name, arcname=name)
    part.replace(out)


def sh(p) -> str:
    import shlex

    return shlex.quote(str(p))


def merge_steps(job: dict, volume: Path, work: Path) -> list[str]:
    """Step 1: the steps whose datasets are not on the volume yet, merged from the incoming archives. Returns the
    datasets it wrote."""
    from merge import merge_step

    done = []
    for step, s in job.get("steps", {}).items():
        ds = s["dataset"]
        if all((volume / "datasets" / ds / f"{m}.tar.gz").exists() for m in s["maps"]):
            log(f"{step}: {ds} already on the volume")
            continue
        inc = work / "incoming" / step
        shutil.rmtree(inc, ignore_errors=True)
        by_tar: dict[str, list[str]] = {}
        for p in s["parts"]:
            by_tar.setdefault(p["tar"], []).append(f"lanes/{p['lane']}/{step}")
        for tar, members in by_tar.items():
            src = volume / tar
            if not src.exists():
                raise SystemExit(f"{step}: {src} is missing (generation's archive)")
            unpack(src, inc / Path(tar).name, members)
        parts = []
        for p in s["parts"]:
            d = inc / Path(p["tar"]).name / "lanes" / str(p["lane"]) / step
            parts.append((json.loads((d / "gpu.json").read_text(encoding="utf8")), d / "data"))
        out = work / "data" / ds
        shutil.rmtree(out, ignore_errors=True)
        merged = merge_step(parts, out)
        shutil.rmtree(inc, ignore_errors=True)
        maps = sorted(e["map"] for e in merged.get("export", []))
        if maps != sorted(s["maps"]):
            raise SystemExit(f"{step}: merged maps {maps}, the training PC merged {sorted(s['maps'])}")
        for m in maps:
            pack(out, m, volume / "datasets" / ds / f"{m}.tar.gz")
        log(f"{step}: {merged['games']} games merged into {ds} ({', '.join(maps)}) and kept on the volume")
        done.append(ds)
    names = {Path(p["tar"]).parent for s in job.get("steps", {}).values() for p in s["parts"]}
    if all(all((volume / "datasets" / s["dataset"] / f"{m}.tar.gz").exists() for m in s["maps"]) for s in job.get("steps", {}).values()):
        for n in names:  # every step is kept as datasets/; the per-pod archives (and failed pods' leftovers) go
            shutil.rmtree(volume / n, ignore_errors=True)
    return done


def fetch(job: dict, volume: Path, work: Path, only=lambda d: True) -> list[str]:
    """Step 2: train.py's --data arguments, each dataset unpacked from the volume onto the pod's disk (`only`: these)."""
    args, have = [], set()
    for d in filter(only, job["data"]):
        folder = work / "data" / d["dataset"] / d["map"]
        key = (d["dataset"], d["map"])
        if key not in have and not (folder / "features.json").exists():
            src = volume / "datasets" / d["dataset"] / f"{d['map']}.tar.gz"
            if not src.exists():
                raise SystemExit(f"{d['dataset']}/{d['map']} is not on the volume ({src})")
            unpack(src, work / "data" / d["dataset"])
            log(f"fetched {d['dataset']}/{d['map']}")
        have.add(key)
        args += ["--data", f"{folder}{d.get('suffix', '')}"]
    return args


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--job", required=True, help="JOB: job.json, models/, where status and result.tar.gz go")
    ap.add_argument("--volume", default="/workspace/delove")
    ap.add_argument("--work", default="/root/work", help="the pod's own disk (the datasets are unpacked here)")
    ap.add_argument("--repo", default=str(HERE.parents[2]))
    args = ap.parse_args(argv)
    jobdir, volume, work = Path(args.job), Path(args.volume), Path(args.work)
    job = json.loads((jobdir / "job.json").read_text(encoding="utf8"))

    def status(s: str):
        (jobdir / "status.tmp").write_text(s + "\n", encoding="utf8")
        (jobdir / "status.tmp").replace(jobdir / "status")

    try:
        status("preparing")
        mine = lambda d: d["dataset"].startswith(f"{job['name']}-")  # noqa: E731
        if job.get("train"):
            fetch(job, volume, work, lambda d: not mine(d))
        status("waiting")
        go = jobdir / "go.json"
        while not go.exists():
            time.sleep(5)
        go = json.loads(go.read_text(encoding="utf8"))
        if go.get("abort"):
            raise SystemExit(f"aborted: {go['abort']}")
        status("preparing")
        merge_steps({"steps": go.get("steps", {})}, volume, work)
        data_args = fetch(job, volume, work) if job.get("train") else []
        if job.get("train"):
            status("training")
            out = jobdir / "out"
            out.mkdir(exist_ok=True)
            cand = out / job["candidate"]
            py = sys.executable
            train = [py, "train.py", *data_args, "--out", str(cand), *job.get("train_args", [])]
            if job.get("init"):
                train += ["--init", str(jobdir / "models" / f"{job['init']}.pt")]
            pydir = Path(args.repo) / "packages" / "delove" / "python"
            with open(jobdir / "train.log", "w", encoding="utf8") as f:
                f.write("train.py " + " ".join(train[2:]) + "\n")
                f.flush()
                t0 = time.time()
                r = subprocess.run(train, cwd=pydir, stdout=f, stderr=subprocess.STDOUT)
                f.write(f"\ntrain.py: {time.time() - t0:.0f} s, exit {r.returncode}\n")
                f.flush()
                if r.returncode:
                    raise SystemExit("train.py failed (see train.log)")
                r = subprocess.run([py, "export_onnx.py", str(cand)], cwd=pydir, stdout=f, stderr=subprocess.STDOUT)
                if r.returncode:
                    raise SystemExit("export_onnx.py failed (see train.log)")
            status("packing")
            with tarfile.open(jobdir / "result.tar.gz.part", "w:gz") as t:
                for suffix in (".pt", ".json", ".onnx", ".value.onnx"):
                    t.add(Path(f"{cand}{suffix}"), arcname=f"{job['candidate']}{suffix}")
                t.add(jobdir / "train.log", arcname="train.log")
            (jobdir / "result.tar.gz.part").replace(jobdir / "result.tar.gz")
        shutil.rmtree(jobdir / "models", ignore_errors=True)  # the private init model
        status("done")
        return 0
    except BaseException as e:  # noqa: BLE001 - the status is how remote.py learns of it
        shutil.rmtree(jobdir / "models", ignore_errors=True)
        status(f"failed: {e}"[:300].replace("\n", " "))
        return 1


if __name__ == "__main__":
    sys.exit(main())
